# Orca DAG — skill + viewer

English | [简体中文](README_zh.md)

Split "planning by chatting with an agent" from "visualizing + executing" into two independent modules:

1. **skill** (`skill/SKILL.md`): teaches **your own agent** (Claude Code / kimi / …) the project workflow — PRD → technical design → decompose into an **Orca orchestration task DAG**. It is deliberately thin about commands: it resolves the right Orca CLI, loads the **runtime-matched orchestration guide** (`orca skills get orchestration`), and delegates command syntax and lifecycle rules to that guide — installed instructions can't drift from your installed runtime. The planning "brain" stays in your agent — **no embedded Claude Agent SDK**.
2. **viewer** (`server/` + `web/`, shipped as the `orca-dag` npm package and a standalone binary): connects to Orca's orchestration state and **visualizes the DAG live**; each node **picks its own harness** (claude / kimi / opencode / grok …) and optionally a **model**; click **"▶ Run with Orca"** and the viewer's built-in **self-driven coordinator** dispatches ready tasks **in parallel** along the dependencies to autonomous workers spun up on demand, until the whole graph is done.

> Core flow: **agent builds the graph → pick a Run and per-node harnesses in the viewer → Run → the DAG executes in dependency-parallel**. To change a task or a dependency, have the agent redraw the DAG — Orca has no interface for editing a single task.
>
> ⚠️ **Requires Orca ≥ 1.4.205 to execute.** That's the supervised-worker execution floor; **1.4.160–1.4.204 stays view-only** (the DAG renders, execution controls disable themselves). Older than 1.4.160 — where the Run/Task/Dispatch contract (2026-07-29, PR #9925) landed — is unsupported.
>
> ⚠️ Why the viewer still acts as its own coordinator: not because `orca orchestration run` is buggy — that command (along with `coordinator-start`) has been **officially retired** (calling it has no side effects; it just says "go read the skill"). Orca **deliberately ships no scheduler** — the official skill's words: *"Agents still choose placement and concurrency; Orca does not schedule workers."* So the DAG loop belongs to the viewer, but **every step** inside that loop now uses Orca's own Run / Task / Dispatch primitives.

![Crayon-style viewer: full-width DAG, default-harness/max-parallel/Run toolbar, and a read-only node panel with per-node harness and model pickers](docs/screenshot.png)

## How it works

```
   your agent (loads the orca-dag skill)          orca-dag viewer (npx orca-dag)  
 ┌───────────────────────────────┐             ┌──────────────────────────────┐
 │  chat → decompose → build DAG │             │  poll task-list → draw DAG   │
 │  Bash: orca orchestration     │             │  pick harness per node       │
 │        task-create / gate-*   │             │  ▶ Run → self-driven         │
 └───────────────┬───────────────┘             └───────────────┬──────────────┘
                 │  writes orchestration state                 │  poll + worker-start (parallel)
                 ▼                                             ▼
        ┌────────────────────  Orca orchestration state  ────────────────────┐
        │  tasks / deps / gates  ·  on-demand autonomous workers (per-node   │
        │                           harness)                                 │
        └─────────────────────────────────────────────────────────────────────┘
```

1. You chat in **your own agent**. It loads the `orca-dag` skill, opens a **Run** with `orca orchestration run-create`, then builds the tasks and dependencies into that Run via `task-create --deps …`.
2. Open the viewer (`npx orca-dag`). Pick the Run in the top bar; it polls `orca orchestration task-list --run <id> --json` every 2 seconds, lays out with **dagre**, renders with **React Flow**, and recolors statuses live.
3. In the viewer, pick a harness per node (or rely on a default fallback), set "Max parallel", and click **"▶ Run with Orca"**.
4. The viewer's **coordinator loop** takes over: it binds one of its own Orca terminals as the Run's coordinator (gaining mutation authority), then on each tick finds every `ready` task and calls `orca orchestration worker-start --task <id> --agent <harness>` **in parallel** — **Orca itself** creates the worker terminal, waits for readiness, injects the dispatch, and returns a **Dispatch** (one attempt). The worker finishes with `worker_done --outcome` → Orca **automatically** marks the task and dispatch completed/failed → dependents flip to `ready` → repeat until the graph is done. Settled workers get their output archived, then the terminal is **released** by default, **reused** only for an immediate compatible follow-up (`worker-start --terminal`), or **retained** on explicit request.
5. To change the plan: go back to the agent conversation and have it redraw the DAG.

### The Run / Task / Dispatch layers

| Layer | What it is | Owned by |
|---|---|---|
| **Run** | Namespace + coordinator inbox; only one coordinator is bound at a time (`consumer_generation` does the fencing) | Orca |
| **Task** | A unit of work; `deps` define the DAG edges, `run_id` scopes it to a Run | Orca |
| **Dispatch** | **One attempt** (id shaped like `ctx_*`); carries `failure_count` (circuit-breaks at 3), heartbeats, pane identity, capability credentials. A retry mints a new Dispatch | Orca |
| Per-node launch preferences, lead stage per Run, canvas positions, defaults, current Run | The viewer's own metadata and preferences | `.orca-dag.config.json` |
| Viewer Activity records and meaningful coordinator checks | Bounded explanatory history for replies, starts, cleanup decisions, deliveries, errors, and agent-state changes; never Task-settlement authority | `.orca-dag.activity.jsonl` |

A Run is a namespace, **not a DAG** — several unrelated graphs can live in one Run. "One Run = one DAG" is a convention from `skill/SKILL.md`, not an Orca constraint.

### The authority model (why the viewer occupies a terminal)

Every Orca orchestration call goes through `resolveRunScope`:

- **Reads** (`task-list` / `gate-list`) skip the consumer check as long as they pass `--run <id>` — **any process can read**. That's all the viewer's polling needs.
- **Mutations** (`dispatch` / `gate-resolve` / `task-create` / `worker-start`) require the caller to **be the Orca terminal currently bound to that Run**, proven by resolving `--from <handle>` to a pane.

The viewer is an ordinary process with no terminal identity, so every mutation would fail with `run_required`. The fix: the viewer opens its own Orca terminal titled `orca-dag coordinator · <workspace-hash> · <instance-id>`, binds it with `run-use`, and passes `--from` on every mutation. **Binding fences the previous coordinator** (usually the agent terminal that drew your graph), so the viewer asks for explicit confirmation before starting; the agent can reclaim the Run anytime with `orca orchestration run-use --id <run>`. On stop, the viewer closes that terminal and releases the Run.

The title's `<workspace-hash>` scopes the coordinator to one workspace: two viewers pointed at **different** workspaces each get their own coordinator terminal and never touch each other's, and a second viewer started on the **same** workspace refuses with a `coordinator_conflict` error (HTTP 409) instead of silently taking over or closing the first one's terminal.

### Which Orca binary, which workspace, whether it can execute

All of this is resolved **once at startup** and then never changes for the life of the process:

- **The executable**, in this order: `ORCA_CLI_COMMAND` (exact quoted argv — parsed without a shell; pipes, redirections and `$()` are rejected rather than silently unexpanded) → `orca-dev` when `ORCA_DEV_REPO_ROOT` is set → `orca-ide` on **Linux outside an Orca terminal** (bare `orca` there is GNOME's screen reader, `/usr/bin/orca`) → plain `orca` otherwise. Every CLI call runs through that one spec with `shell: false`, in the workspace directory as cwd.
- **The workspace**: `WORKSPACE_DIR` (default: the current directory) must exist and is resolved to its **real path** — symlinks and different spellings of the same directory collapse to one identity. It becomes the exact Orca worktree selector `path:<WORKSPACE_DIR>`, so a viewer started in directory A with `WORKSPACE_DIR=/abs/B` puts its coordinator **and its workers in B**. An explicit `ORCA_WORKTREE` still wins if you set it.
- **Whether execution is allowed** (`GET /api/readiness`): **Orca ≥ 1.4.205** is required to run DAGs — that's where the supervised Dispatch contract landed. Orca **1.4.160–1.4.204 stays view-only**: the DAG, gates and statuses render fine, but the Run/gate controls disable themselves with an upgrade pointer (and the server answers `503 execution_disabled` if a mutation is forced). If the CLI can't be found at all, readiness says so with the exact resolution it tried.

## Prerequisites

- **Orca ≥ 1.4.160 for viewing, ≥ 1.4.205 for executing** (`result.runtime.appVersion` in `orca status --json`). The Run/Dispatch contract landed in 1.4.160; **execution** needs the supervised-worker contract from 1.4.205 — older runtimes work in view-only mode with the execution controls disabled. See [readiness](#which-orca-binary-which-workspace-whether-it-can-execute).
- **The orchestration experimental feature is enabled**: Settings → Experimental.
- **Orca is running**: `result.runtime.state` in `orca status --json` should be `"ready"`; otherwise run `orca open` first.
- **The project is an Orca-managed worktree**: adding workers / executing requires the current directory to be a registered repo/worktree (else `orca terminal create` fails with `selector_not_found`). Register with `orca repo add <path>` or `orca worktree …`.
- **An agent that can run the skill** (graph-building side): Claude Code, or anything that can read `SKILL.md` and run Bash.
- **The viewer side depends only on the `orca` CLI** — no `claude`, no `ANTHROPIC_API_KEY`.
- **Node.js ≥ 20** to run `npx orca-dag` — or none at all if you use a release binary. **Bun** only if you want to build a binary yourself.

## Install

One command, both halves:

```bash
cd ~/any/orca-managed/project
npx orca-dag
```

That installs the `orca-dag` **skill** into every coding agent on your machine (Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Droid, and the shared `~/.agents/skills` directory — whichever of them exist), then starts the **viewer** on <http://localhost:8787> with the current directory as the workspace. It re-runs safely: the skill is only rewritten when it actually changed, and a skill directory you symlinked yourself is left untouched.

Then just chat your requirement to the agent. It builds the DAG into Orca per `SKILL.md` and tells you to open the viewer.

Needs only **Node.js ≥ 20** — the package is a ~500 KB dependency-free bundle, and `bunx orca-dag` works too. Keep it around with `npm i -g orca-dag`.

No Node on the machine? Grab a standalone binary from the [releases page](https://github.com/ZinkLu/Orca-Orchestration/releases) — same behaviour, bundles its own runtime, needs only the `orca` CLI on PATH:

```bash
tar xzf orca-dag-darwin-arm64.tar.gz && sudo mv orca-dag /usr/local/bin/ && orca-dag
```

Switches: `PORT` (default 8787), `NO_OPEN=1` (don't open the browser), `--no-skill` / `ORCA_DAG_NO_SKILL=1` (don't touch the agent skill directories), `WORKSPACE_DIR` (use another workspace instead of the current directory — must exist, becomes the exact `path:` worktree), `ORCA_WORKTREE` (explicit Orca worktree selector, overriding the `path:` default), `ORCA_CLI_COMMAND` (exact Orca CLI to run, as quoted argv with no shell — see [CLI/workspace resolution](#which-orca-binary-which-workspace-whether-it-can-execute)), `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` (allow arbitrary custom harness commands — see [Security](#security-model)).

Want the skill *without* the viewer, or managed by the standard tooling? `npx skills add ZinkLu/Orca-Orchestration --skill orca-dag --global` — the [open agent skills CLI](https://github.com/vercel-labs/skills), the same one `orca skills install` shells out to.

## Uninstall

```bash
npx orca-dag uninstall            # add --dry-run first if you want to see the list
```

Removes the skill from every agent directory it was installed into and closes any `orca-dag coordinator` terminal a crashed viewer left bound to a Run, reporting the workspace (directory + hash) each terminal was coordinating before closing it (that cleanup matters — a stale coordinator keeps your own agent fenced out). A skill directory you symlinked yourself is unlinked, never followed, so your checkout is safe.

Workspace history is kept by default: `.orca-dag.config.json` stores launch choices and layout, while `.orca-dag.activity.jsonl` stores bounded Viewer Activity plus meaningful coordinator-check receipts (repetitive empty polls stay memory-only). Pass `--purge` to remove both. The program itself is also retained because a running process cannot remove its own binary; uninstall prints the appropriate follow-up command.

### Building and releasing it yourself

```bash
npm install
npm run check          # skill validation + typecheck + tests + web build (what CI runs)
npm run dev            # frontend :5173 + backend :8787 (vite proxies /api) → http://localhost:5173
npm run build:npm      # stage the publishable package → dist-npm/ (Node only)
npm run build:binary   # portable single binary → dist/orca-dag (~100 MB, frontend embedded; needs Bun)
npm run release 0.2.0  # tag + push; CI publishes to npm and attaches every binary to a GitHub release
```

Cross-compile a binary for another platform with `TARGET=bun-linux-x64 npm run build:binary`; `bash scripts/build-all-binaries.sh` does every target at once, which is what the release workflow runs.

## Quick start

An end-to-end pass, starting from nothing installed:

1. **Get your project under Orca** (once per repo) and make sure Orca is up:

   ```bash
   cd ~/code/my-project
   orca repo add .        # skip if already Orca-managed
   orca status --json     # runtime.state should be "ready"; otherwise `orca open`
   ```

2. **Start the viewer** from that same directory and leave it running:

   ```bash
   npx orca-dag           # installs the skill into your agents, serves :8787, opens the browser
   ```

3. **Plan in your agent.** In Claude Code (or any agent that just got the skill), describe what you want and ask for a DAG:

   > Use the orca-dag skill: break "add CSV export to the reports page" into a task DAG.

   The agent will ask a few clarifying questions, write `docs/PRD.md` / `docs/TECH_SPEC.md`, then run `orca orchestration run-create` + `task-create --deps …`. When it's done it tells you the **Run id** (like `run_ab12cd34ef56`).

4. **Pick the Run** the agent just named in the top-bar dropdown. The DAG appears and refreshes every 2 seconds — you can keep chatting with the agent to reshape it and watch nodes pop in live.

5. **Choose harnesses.** Set the toolbar's **Default harness** (fallback for every node), and optionally click individual nodes to override harness/model per node. Set **Max parallel**.

6. **Click "▶ Run with Orca"** and accept the confirmation (it explains that the viewer takes over the Run's coordinator slot, fencing your agent's terminal — that's expected). Ready tasks fire in parallel; running nodes get the crayon scribble; the graph advances as workers report `worker_done`.

7. **Resolve gates when they pop.** If the plan includes approval gates, approve/reject buttons float over the DAG at the right moment.

8. **Change the plan?** Go back to the agent conversation. It reclaims the Run with `orca orchestration run-use --id <run>` (or just opens a fresh Run and redraws), and the viewer follows along. Then hit Run again.

## What the viewer can do

- **Workspace-scoped Run picker**: Orca's Run registry is global, but the viewer shows only Runs whose Task creator identity matches this workspace (plus the workspace's persisted/current empty Run). The compact selector leads with the stable `run_*` id and keeps the objective as secondary context. **＋ Create Run** creates an empty Run from this workspace and selects it immediately.
- **Run health badge**: the selected Run always reports its ownership state — **viewer-owned** (this viewer's live coordinator), **external** (another terminal coordinates it), **unbound** (no coordinator at all), or **inconsistent** (Orca's own records disagree), plus per-source counts with a warning when a read fails (a failed read is never a silent zero). An empty Run that still has messages is explained as such instead of looking like a rendering failure.
- **Runtime capability matrix**: a read-only panel renders what the connected Orca runtime **positively advertised** against the canonical 1.4.206 capability ids — documented older aliases say so, unknown names and absent fields read "Not advertised" and stay gated off. Support is never inferred from the version string.
- **Live DAG visualization** — node statuses `pending / ready / dispatched / completed / failed / blocked` map to colors; each node wears its harness on its corner.
- **Switchable layout algorithms**: the "Layout" segment in the toolbar toggles **layered horizontal / vertical** (dagre / Sugiyama) and **force-directed** (Fruchterman–Reingold); **↻ Re-layout** reruns auto-layout (clearing manual drags). The choice persists.
- **Hierarchy vs. dependencies**: a Task's `parent_id` is preserved and drawn as a calm dotted bracket with a ring on the child — a deliberately different grammar from the pencil dependency arrows. Ownership is never a dependency: it neither gates readiness nor influences layout, and a toolbar toggle (**Hide/Show parent links**) hides it when it hurts readability.
- **Scheduler / ready-queue panel**: a compact canvas card — separate from Activity/Chat — shows the current ready wave (listed in id order; no scheduling precedence is implied), this viewer coordinator's worker capacity ("unknown" when it is not running the Run, never guessed), and one evidence-backed reason per waiting stage: unmet dependencies (naming the upstream Task and its status), a pending decision gate (naming the gate), no free worker slot, or unknown state. The selected node's card repeats the same reasons plus its parent/child relations.
- **Drag to arrange**: nodes drag freely and hold their positions across live polling refreshes (only untouched nodes follow auto-layout).
- **Execution animations**: `dispatched` (running) nodes get scribbled over and over with diagonal crayon strokes; edges flowing out of a running node start as a swimming dashed draft, then pencil strokes trace them solid toward the downstream node.
- **Explicit lead stage**: mark one Task per Run as the semantic main-agent stage. It gets a prominent indigo double outline and gold `★ Lead` badge without replacing its status color. This is viewer metadata only — Orca coordinator authority remains separate.
- **Independent Stage card + Activity / Chat center**: selecting a node opens its settings in the right-side paper card, while communication occupies a dedicated left rail and the DAG resizes into the remaining canvas. Activity preserves the live SSE timeline (with bounded-poll fallback, filters, effective runtime facts, and expandable technical evidence). Chat groups that same Run-scoped stream by stage and records both directions: a successful worker start becomes the coordinator's assignment bubble, worker reports arrive on the other side, pending questions can be answered, and proactive guidance can be durably sent to any Orca-verified live Dispatch (stale, settled, or unverifiable attempts are refused). Beneath the message bubbles, a bounded live check stream leaves one receipt for every coordinator inbox pass, including empty checks, message types, failures/replays, duration, and a compact runtime-observed agent/model/activity summary. Heartbeat/status signals update this runtime area instead of masquerading as repeated chat messages. Historical assignments created before this journal existed are clearly reconstructed from the Task spec. "Sent" means Orca accepted the durable enqueue; it does not claim the worker has read it.
- **Faithful conversation semantics**: Chat keeps Orca's thread identity (replies quote and link their originating question), renders each message's **priority** chip and **read/unread** state honestly — "Sent" only ever means Orca accepted the durable enqueue, never that a worker read it — and when the global Orca inbox window is saturated it warns **"History may be incomplete"** instead of pretending the visible rows are everything (the warning is only rendered when the boundary is actually observed; absence of the flag is not proof of completeness).
- **Coordinator group messaging (deliberate, audited broadcast)**: one message to `@all` or to an Orca-discovered worktree audience, chosen from a picker fed by fresh discovery — never a free-text recipient. The send requires the mutation token, a previewed audience, an explicit confirmation, and this viewer being the Run's **live coordinator**; lifecycle signal types (`worker_done`, `heartbeat`) are refused before any Orca call.
- **Per-node harness**: click a node and pick `claude / kimi / opencode / grok / codex` or a custom command in its panel (persisted to the workspace's `.orca-dag.config.json`; custom commands additionally need `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` — see the [security model](#security-model)); nodes without an explicit choice fall back to the toolbar's **default harness**.
- **Per-node model override**: for harnesses that support it — opencode gets a dropdown enumerated from `opencode models`; claude / codex / cursor get free-text (passed via `worker-start --model`). Others run on their default model.
- **Per-node reasoning effort**: claude / codex / cursor additionally take an effort level, passed via `worker-start --effort` — it only applies when a model is set for that node (Orca's own contract), so clearing the model clears the effort.
- **Per-node environment & exact placement**: a node can execute on a **saved connected environment** (`orca environment list`) while the Run stays on this server — the node panel offers Local (default) plus discovered environments, and for a remote one exactly the two placements Orca supports: an **exact existing workspace** (the full `id:<repo>::<path>` selector discovered on that environment) or a **new top-level worktree** (exact repo selector + explicit name). Remote `current`/`new-child` are never offered — they are ambiguous across servers, and the server refuses them before any Orca call. Model/effort controls hide for peers that don't advertise the capability.
- **Immutable launch preferences after execution**: harness, model, effort, environment, and placement freeze as soon as a Task has its first Dispatch. The lock survives viewer restarts through complete, remote-inclusive worker history; safe retry therefore preserves the original launch plan. While the selected Run's coordinator is active, launch preferences are also frozen for Tasks that have not started because the running coordinator already holds a snapshot; stopping it unlocks only those never-started Tasks.
- **▶ Run with Orca / ⏹ Stop** + **Max parallel**: start/stop the viewer's built-in self-driven coordinator; worker count follows the DAG's parallelism (whatever is ready runs together, capped by "Max parallel") — **no manual worker management**. Settled workers have their output archived, then their terminal is released by default; it is handed to an immediate compatible follow-up (same harness, no model change) via `worker-start --terminal` when one is ready, and kept alive instead with the explicit **Retain for debugging** control. While running it shows "N workers".
- **Approval gates**: gate decisions live under Activity's expandable Operational details instead of overlapping the canvas.
- **Node details (read-only spec)**: click a node to see its spec / status / result. The spec starts as a smaller one-line preview with an accessible Expand control. Structured worker results are parsed into an outcome, concise report, modified-file list, and optional report path; the complete payload stays available under collapsed technical details. To change the Task or its deps, have the agent redraw the DAG.
- **Workers panel**: Activity's Operational details contains the live fleet view per attempt — liveness (`live / unverifiable / exited`, with Orca's own reason), attention flags, agent-wait stage, execution host, terminal accounting, requested vs effective model/effort, Orca's literal next action, and bounded output reading with explicit **source badges** (`auto / terminal / transcript`, clipped/complete flags), a **search that filters only the rows already loaded** (it never fetches more transcript), a local **Download loaded rows** export, and release-**archive facts** kept visibly separate from the authoritative fleet state (archive presence is evidence, not settlement).
- **Mutation-request audit**: every viewer-originated mutation (worker-start / release / retain / stop) runs under a durable `--retry-request` id that is persisted — bounded, metadata-only — in the workspace's `.orca-dag.requests.jsonl` ledger *before* the CLI call, so the id stays inspectable even after a lost response or a viewer restart. Operational details gains a read-only **audit panel**: one row per recorded request (operation, Task/Dispatch linkage, scope), and per-row **Inspect** runs a fresh `request-show` probe rendering Orca's own state and interpretation verbatim — `completed` (green), `pending` (amber), `absent` (gray, explicitly labeled "absence is NOT proof the mutation did not happen"), and `unknown` when the probe itself fails. The audit surface never replays a mutation.
- **Hand-drawn crayon style**: 🖍️ SVG feTurbulence wobbled strokes on a cream sketchbook canvas.

## Security model

The viewer is a control plane into Orca — starting a Run fences whoever was coordinating it, and dispatch spawns real worker terminals — so it is locked down by default:

- **Loopback only.** The server binds `127.0.0.1`, never all interfaces. Nothing on your LAN can reach it; there is no remote-listen mode.
- **No CORS.** The API emits no `Access-Control-*` headers, so a page served from another origin cannot read a single byte of any response — including the token below.
- **Per-process mutation token.** Every mutating request (`POST`/`PUT` under `/api`) must carry `X-Orca-Dag-Token`, a fresh 256-bit random value minted at process start. The web client fetches it from `GET /api/session` and retries once automatically if the server restarts (new token). Read-only endpoints (`GET`) stay token-free. A rejected mutation answers `403` before any route logic runs — no Orca command, no validation-oracle probing.
- **Custom harness commands are opt-in.** Only known Orca agent ids (`claude`, `codex`, `opencode`, `gemini`, `grok`, `cursor`, `droid`, `kimi`) can be launched by default. Arbitrary commands (e.g. `aider`) are rejected with `custom_commands_disabled` unless the viewer was started with `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`; the UI hides/disables "Custom…" accordingly. A stored custom value stays visible in `.orca-dag.config.json` — it just won't run until the flag is present.
- **Strict request validation.** Run/task/gate ids, harness names, `provider/model` values, concurrency, and `{taskId: …}` maps are validated at the HTTP boundary, before anything becomes an Orca command-line argument.
- **One resolved CLI spec, no shell.** The Orca executable (from `ORCA_CLI_COMMAND` or the platform rules) is parsed into plain argv once at startup — operators, redirections and substitutions in `ORCA_CLI_COMMAND` are rejected, not silently mis-run — and every call spawns with `shell: false`.

## Readiness and view-only mode

`GET /api/readiness` reports `{ cli, workspace, worktree, version, executionEnabled, reason }`. Execution — Run start, gate resolution, Run creation — is enabled only on **Orca ≥ 1.4.205**; on 1.4.160–1.4.204 the UI disables those controls (Run button reads "View-only", gate buttons dim with the reason, the top-bar badge turns amber) and the server answers `503 execution_disabled` to any mutation that slips through. Reads (DAG, runs, terminals, config) always stay available.

## HTTP API

All `POST`/`PUT` routes require the `X-Orca-Dag-Token` header (see the security model above); `GET` routes are open on loopback.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/session` | Hand the same-origin client its per-process mutation token + the custom-command flag (`Cache-Control: no-store`) |
| `GET` | `/api/readiness` | Resolved CLI, Orca version, and whether execution is enabled (with the actionable reason when not) |
| `GET` | `/api/capabilities` | The runtime capability matrix: runtime facts plus per-capability `supported / alias / absent` — unknown names stay listed and gated off |
| `GET` | `/api/run-health?run=<id>` | Ownership + health of one Run: state (`viewer-owned / external / unbound / inconsistent`), coordinator handle, counts, and per-source warnings |
| `GET` | `/api/dag?run=<id>` | The Run's DAG: `{ runId, nodes, edges, hierarchy, gates, readyWave, readiness, generatedAt }` |
| `GET` | `/api/runs` | List Runs scoped to this exact workspace (derived from Task creator-worktree identity) |
| `POST` | `/api/runs` | `{ objective }`: create an empty Run in this workspace (via a throwaway coordinator terminal) |
| `GET` | `/api/terminals` | List Orca terminals |
| `POST` | `/api/run` | `{ runId, harnessByTask?, modelByTask?, effortByTask?, retainByTask?, environmentByTask?, placementByTask?, defaultHarness?, maxConcurrency? }`: start the self-driven coordinator |
| `POST` | `/api/run-stop` | Stop the coordinator and reclaim its workers |
| `GET` | `/api/run-status` | Live coordinator status: `{ running, busy, attempts, inbox, cleanupDebt, recovery, … }` |
| `GET` | `/api/inbox?run=<id>` | Compatibility view of the selected Run's pending questions/escalations + cleanup debt |
| `GET` | `/api/activity?run=<id>&after=&limit=` | Run-scoped readable Activity, per-stage fleet presence, and bounded live coordinator-check receipts |
| `GET` | `/api/activity/stream?run=<id>` | Live SSE snapshots for exactly one Run; the browser falls back to bounded polling |
| `POST` | `/api/messages/:id/reply` | `{ body, runId }`: answer a worker question/escalation |
| `GET` | `/api/audiences?run=<id>` | Preview of the group-messaging audiences for the Run (`@all` + discovered worktrees), with `coordinatorActive` and per-source discovery errors — a failed discovery degrades to an empty list, never a guessed recipient |
| `POST` | `/api/messages/group` | `{ runId, audience, body, subject?, type?, priority? }`: one confirmed coordinator broadcast to an allowlisted audience; lifecycle types are refused with `forbidden_group_type`, undiscovered worktrees with `unknown_audience`, and non-coordinators with `409 not_running` |
| `POST` | `/api/gates/:id/resolve` | `{ resolution, runId }`: resolve an approval gate |
| `GET` | `/api/workers?run=<id>` | Complete, cursor-paged, remote-inclusive worker history for the Run (liveness, terminal state, projection); also the durable launch-lock evidence |
| `GET` | `/api/workers/:dispatchId?run=<id>` | One worker's durable row plus `worker-show` evidence (Dispatch/Worker records, PTY facts, exact-worker observation with agent-wait evidence) — Run-scoped by comparing the receipt's runId; independent of the coordinator loop, so historical workers stay inspectable after a restart |
| `GET` | `/api/workers/:dispatchId/output` | Bounded output page (`?source=auto\|terminal\|transcript&cursor=&limit=`, limit clamped 1–200) |
| `GET` | `/api/requests?run=<id>` | Bounded audit list of this workspace's recorded mutation requests, Run-scoped (unscoped rows included, labeled; rows of other Runs counted, not listed) |
| `GET` | `/api/requests/:requestId?run=<id>` | One ledger row plus a fresh, read-only `request-show` probe: `{ state: completed\|pending\|absent\|unknown, interpretation, outcome }` — never replays a mutation |
| `POST` | `/api/workers/:id/release` / `/retain` | Explicit post-settlement terminal release / retain-for-debugging |
| `POST` | `/api/workers/:id/retry` | Re-place one positively failed attempt (same harness/model/effort/placement) |
| `GET` | `/api/models/:harness` | Models selectable for a harness (currently only opencode enumerates) |
| `GET` | `/api/environments` | Saved connected environments (`environment list`), each with parsed `peer` capabilities the UI gates remote controls on |
| `GET` | `/api/environments/:envId/worktrees?repo=` | Exact workspaces on one environment — full `id:<repoId>::<path>` selectors for the placement picker |
| `GET` | `/api/environments/:envId/repos` | Repositories registered on one environment (for new-top-level placement) |
| `GET` | `/api/environments/:envId/projects` | Project groupings visible on one environment |
| `GET` | `/api/config` | Viewer config (harness/model/effort/retain/environment/placement choices, lead stage per Run, max parallel, layout, last Run), stored in the workspace's `.orca-dag.config.json` |
| `PUT` | `/api/config` | Merge-write the viewer config |
| `GET` | `/api/health` | Health check (returns the workspace directory) |

Mutation routes that drive execution (`POST /api/runs`, `POST /api/run`, gate resolve) additionally answer `503 execution_disabled` when readiness says the runtime can't execute — see [Readiness](#readiness-and-view-only-mode). Starting the coordinator against a workspace another viewer is already coordinating answers `409 coordinator_conflict`.

## Code layout

```
skill/SKILL.md            thin project workflow: PRD → design → task DAG → viewer; delegates command syntax to the runtime-matched guide (skills get orchestration)
server/src/
  index.ts                process entry: subcommands (--help / uninstall), CLI+workspace resolution, skill install, loopback listener
  app.ts                  the Express app (createApp): readiness / dag / session / runs / run / run-stop / run-status / activity / inbox / messages / gates / workers / requests / environments / models / config + SPA serving
  activity.ts             Run-scoped readable event parser + bounded viewer Activity journal
  requestLedger.ts        bounded, atomic ledger of viewer-originated mutation-request ids (.orca-dag.requests.jsonl) — metadata only, state always re-read live via request-show
  security.ts             loopback policy: per-process mutation token, request validation, custom-command gate
  coordinator.ts          self-driven coordinator loop: polls the DAG, fires ready tasks via worker-start (local or --on environment), owns settlement + terminal reuse/retain/release, reconciles with worker-list --include-remote
  orca.ts                 orca CLI wrapper: one resolved executable/argv + workspace, readiness/version gate, task-list→DAG, worker-start/reuse/legacy/opencode workers, environment discovery + peer capabilities + placement gates, worker-read, gates, terminals, models
  orca.test.ts            resolution/readiness/conflict coverage (fake `orca` fixture)
  config.ts               viewer config persistence: .orca-dag.config.json in the workspace (/api/config)
  skill.ts                installs skill/SKILL.md into the agents on this machine, on startup
  uninstall.ts            `orca-dag uninstall`: the exact mirror of skill.ts, plus stale-terminal cleanup
  webAssets.ts            loader for the frontend assets (and the skill) embedded at build time
web/src/
  App.tsx                 full-width DAG shell, 2s polling, hand-drawn SVG filter defs
  components/DagView.tsx     React Flow graph + status nodes (harness label, lead-stage marker, crayon animations)
  components/ExecControls.tsx default harness + max parallel + Run/Stop + live status
  components/NodePanel.tsx    node details + collapsed spec + lead-stage control + launch-locked preferences
  components/ActivityPanel.tsx live readable timeline, filters, evidence details, and contextual actions
  components/ChatPanel.tsx     stage conversations + live coordinator-check stream
  components/GatePanel.tsx    approval gates inside Operational details
  components/RunPicker.tsx    Run selector + "New Run"
  components/DoodleSelect.tsx hand-drawn select (portal dropdown, search, keyboard nav)
  components/WorkerPanel.tsx  fleet view: liveness/attention/launch prefs/sourced output (search + download), archive facts, retain & release controls
  components/RequestAuditPanel.tsx read-only mutation-request audit: ledger rows + request-show receipts (completed/pending/absent/unknown)
  harness.ts                reactive config store: per-node launch preferences, lead stage per Run, default, max parallel, layout (persisted via /api/config)
  layout.ts                 layout algorithms: dagre layered (LR/TB) + force-directed (Fruchterman–Reingold)
  types.ts / api.ts
scripts/
  build-binary.mjs        vite build → embed assets + skill → bun --compile → dist/orca-dag
  build-npm.mjs           vite build → esbuild the server → dist-npm/ (the publishable `orca-dag` package)
  build-all-binaries.sh   every Bun target + archives + checksums (what the release workflow runs)
  check-skill.mjs         guards SKILL.md's frontmatter (which the skills CLI installs by) + rejects hard-coded CLI guidance that bypasses the runtime guide
  release.mjs             `npm run release <version>`: checks, tags, pushes — CI does the rest
```

## Design notes and boundaries

- **The brain lives outside**: planning is done by the agent you already have (the skill provides the conventions); the viewer embeds no Claude Agent SDK.
- **The viewer is its own coordinator**: Orca deliberately ships no scheduler, so `server/src/coordinator.ts` drives the loop with Orca's Run/Task/Dispatch primitives. Parallelism follows the DAG (everything ready fires together, capped by `maxConcurrency`); settled workers have their output archived, then the terminal is **released** by default, **reused** only for an immediate compatible follow-up (same harness, no model change, via `worker-start --terminal`), or **retained** on explicit request — every settled terminal gets exactly one evidence-backed ownership decision, and an ambiguous release surfaces as debt instead of being retried blind.
- **Workers must be autonomous agents**: hands-off execution requires the worker to run `orca orchestration send --type worker_done` on its own — otherwise it stalls on a permission prompt. `worker-start` launches Orca-configured TUI agents with their autonomous flags; for custom commands the legacy path uses `HARNESS_LAUNCH` in `orca.ts` (only `claude --dangerously-skip-permissions` is verified — add and verify flags for others before relying on them).
- **The `dispatch --inject` quirk** (legacy path): it types the preamble into the agent's input box but often **doesn't submit it** (a readiness race). The coordinator waits ~2s after dispatch and sends an extra Enter; a stray Enter on already-submitted input is a harmless no-op.
- **opencode goes through its own path**: `worker-start --agent opencode` opens the TUI but the injected preamble never lands, so the coordinator opens a bare shell, mints a tracking dispatch, and runs `opencode run --auto "$(cat <preamble>)"` (`--auto` is mandatory — the default permission policy silently auto-rejects tool calls).
- **Remote placement is exact or it doesn't happen**: a node pinned to a saved environment starts via `worker-start --on <environment>` — and `--on` appears on that one call only; every later read, message, stop, and release addresses the **Dispatch ID** (the execution host owns the process, filesystem, transcript, stop, and cleanup facts). Only two placement forms exist remotely — an exact existing workspace selector discovered on that environment, or a new top-level worktree with an exact repo selector and an explicit name; remote `current`/`new-child` are refused at the HTTP boundary and again in the adapter, before any Orca call. There is no synthetic local fallback: an unknown environment or an unproven capability fails the start with its reason on record. Model/effort forwarding and structured transcript reads are gated on what the peer **advertises**; a disconnected host renders its workers `unverifiable` (never `exited`) and triggers no automatic stop/retry/release — reconnection restores liveness and the original Dispatch settles.
- **Per-node launch preferences and the lead marker live in a workspace config file**: Orca tasks have no harness/metadata field (`task-create` only takes spec/title/display-name/deps/parent), so the viewer stores launch choices, one semantic lead Task per Run, max parallel, and layout in `.orca-dag.config.json` at the workspace root (`server/src/config.ts`, `GET/PUT /api/config`) — surviving browser switches and cleared localStorage. The frontend's `harness.ts` is a reactive store that hydrates from the server and migrates old localStorage values once. At Run time launch choices are snapshotted into the coordinator; durable worker history then prevents changing a Task's plan after its first Dispatch.
- **Created tasks can't be edited**: `orca orchestration task-update` only changes `--status` / `--result` — **no interface to edit spec/title/deps**, no single-task delete, and no reset either (`orca orchestration reset --tasks` wipes every Run at once, so the viewer deliberately never calls it). So "change a task" = **have the agent redraw the DAG in a fresh Run** — New Run is the only safe redraw path.
