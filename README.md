# Orca DAG — skill + viewer

English | [简体中文](README_zh.md)

> Forked from [ZinkLu/Orca-Orchestration](https://github.com/ZinkLu/Orca-Orchestration) and extended into its own feature line — per-node model/effort overrides, workspace lanes, integration gates, session recovery, mutation audit, bilingual UI — published independently as the [`orca-orchestration-launcher`](https://www.npmjs.com/package/orca-orchestration-launcher) npm package.

Split "planning by chatting with an agent" from "visualizing + executing" into two independent modules:

1. **skill** (`skill/SKILL.md`): teaches **your own agent** (Claude Code / kimi / …) the project workflow — PRD → technical design → decompose into an **Orca orchestration task DAG**. It is deliberately thin about commands: it resolves the right Orca CLI, loads the **runtime-matched orchestration guide** (`orca skills get orchestration`), and delegates command syntax and lifecycle rules to that guide — installed instructions can't drift from your installed runtime. The planning "brain" stays in your agent — **no embedded Claude Agent SDK**.
2. **viewer** (`server/` + `web/`, shipped as the `orca-orchestration-launcher` npm package and a standalone binary): connects to Orca's orchestration state and **visualizes the DAG live**; each node **picks its own harness** (claude / kimi / opencode / grok …) and optionally a **model**; click **"▶ Run with Orca"** and the viewer's built-in **self-driven coordinator** dispatches ready tasks **in parallel** along the dependencies to autonomous workers spun up on demand, until the whole graph is done.

> Core flow: **agent builds the graph → pick a Run and per-node harnesses in the viewer → Run → the DAG executes in dependency-parallel**. To change a task or a dependency, have the agent redraw the DAG — Orca has no interface for editing a single task.
>
> ⚠️ **Requires Orca ≥ 1.4.205 to execute.** That's the supervised-worker execution floor; **1.4.160–1.4.204 stays view-only** (the DAG renders, execution controls disable themselves). Older than 1.4.160 — where the Run/Task/Dispatch contract (2026-07-29, PR #9925) landed — is unsupported.
>
> ⚠️ Why the viewer still acts as its own coordinator: not because `orca orchestration run` is buggy — that command (along with `coordinator-start`) has been **officially retired** (calling it has no side effects; it just says "go read the skill"). Orca **deliberately ships no scheduler** — the official skill's words: *"Agents still choose placement and concurrency; Orca does not schedule workers."* So the DAG loop belongs to the viewer, but **every step** inside that loop now uses Orca's own Run / Task / Dispatch primitives.

![Crayon-style viewer: full-width DAG, default-harness/max-parallel/Run toolbar, and a read-only node panel with per-node harness and model pickers](docs/screenshot.png)

## How it works

```
   your agent (loads the orca-dag skill)          orca-dag viewer (npx orca-orchestration-launcher)
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
2. Open the viewer (`npx orca-orchestration-launcher`). Pick the Run in the top bar; it polls `orca orchestration task-list --run <id> --json` every 2 seconds, lays out with **dagre**, renders with **React Flow**, and recolors statuses live.
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
- **Mutations** (`dispatch` / `gate-resolve` / `task-create` / `worker-start`) require the caller to own that Run's coordinator binding. Orca-native chats can act through their session identity; this external viewer acts through a bound terminal supplied as `--from <handle>`.

The viewer is an ordinary process with no Orca session or terminal identity, so every mutation would fail with `run_required`. It opens its own Orca terminal titled `orca-dag coordinator · <workspace-hash> · <instance-id>`, binds it with `run-use`, and passes `--from` on every mutation. **Binding fences the previous coordinator**, whether an agent terminal or an Orca-native chat, so the viewer asks for explicit confirmation before starting; that agent can reclaim the Run with `orca orchestration run-use --id <run>`. On stop, the viewer closes its terminal and releases the Run.

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
- **Node.js ≥ 20** to run `npx orca-orchestration-launcher` — or none at all if you use a release binary. **Bun** only if you want to build a binary yourself.

## Install

One command, both halves:

```bash
cd ~/any/orca-managed/project
npx orca-orchestration-launcher
```

That installs the `orca-dag` **skill** into every coding agent on your machine (Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Droid, and the shared `~/.agents/skills` directory — whichever of them exist), then starts the **viewer** on <http://localhost:8787> with the current directory as the workspace. It re-runs safely: the skill is only rewritten when it actually changed, and a skill directory you symlinked yourself is left untouched.

**Workspace initialization is part of this command:** startup adds a marked `.orca/` rule to the workspace's `.gitignore` by default and prints the planning location and ignore result. Existing matching rules are reused, other rules are preserved, and a symlinked/non-regular `.gitignore` is never modified. A failure is reported as a warning, not a viewer startup error.

The agent writes each new requirement or fresh replanning Run into its own UTC timestamp directory (milliseconds; collisions get a fresh timestamp or numeric suffix), rather than overwriting shared documents:

```text
.orca/20261008-143012-123/
  PRD.md
  TECH_SPEC.md
```

Continuing the same plan or adding Tasks to its Run keeps that directory; the agent records the Run id in both documents and reports the directory alongside the id. Documents are local and ignored, **not force-added to Git**. Task specs carry all required context so isolated workers do not depend on these files. Starting the viewer alone does not create a timestamp directory.

Then just chat your requirement to the agent. It builds the DAG into Orca per `SKILL.md` and tells you to open the viewer.

Needs only **Node.js ≥ 20** — the package is a ~500 KB dependency-free bundle, and `bunx orca-orchestration-launcher` works too. Keep it around with `npm i -g orca-orchestration-launcher`.

No Node on the machine? Grab a standalone binary from the [releases page](https://github.com/yyq19990828/Orca-dag/releases) — same behaviour, bundles its own runtime, needs only the `orca` CLI on PATH:

```bash
tar xzf orca-dag-darwin-arm64.tar.gz && sudo mv orca-dag /usr/local/bin/ && orca-dag
```

Switches: `PORT` (default 8787), `NO_OPEN=1` (don't open the browser), `--no-skill` / `ORCA_DAG_NO_SKILL=1` (don't touch the agent skill directories), `WORKSPACE_DIR` (use another workspace instead of the current directory — must exist, becomes the exact `path:` worktree), `ORCA_WORKTREE` (explicit Orca worktree selector, overriding the `path:` default), `ORCA_CLI_COMMAND` (exact Orca CLI to run, as quoted argv with no shell — see [CLI/workspace resolution](#which-orca-binary-which-workspace-whether-it-can-execute)), `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` (allow arbitrary custom harness commands — see [Security](#security-model)).

`--no-workspace-init` / `ORCA_DAG_NO_WORKSPACE_INIT=1` skips automatic `.gitignore` changes; add `.orca/` yourself before planning. This is independent of `--no-skill`, which only skips agent skill installation.

Want the skill *without* the viewer, or managed by the standard tooling? `npx skills add yyq19990828/Orca-dag --skill orca-dag --global` — the [open agent skills CLI](https://github.com/vercel-labs/skills), the same one `orca skills install` shells out to.
The skill-only installer does not initialize a project; the skill instructs your agent to ensure `.orca/` is ignored before writing planning documents.

## Uninstall

```bash
npx orca-orchestration-launcher uninstall   # add --dry-run first if you want to see the list
```

Removes the skill from every agent directory it was installed into and closes any `orca-dag coordinator` terminal a crashed viewer left bound to a Run, reporting the workspace (directory + hash) each terminal was coordinating before closing it (that cleanup matters — a stale coordinator keeps your own agent fenced out). A skill directory you symlinked yourself is unlinked, never followed, so your checkout is safe.

Run uninstall from the project root (or set `WORKSPACE_DIR`): it also removes **only its exact managed `.orca/` block** from that workspace's `.gitignore`. User-authored rules, edited blocks, and the `.gitignore` file itself are retained. `.orca/` planning documents are **always kept, even with `--purge`**; add your own `.orca/` rule if you want them to remain ignored after uninstall. No Orca Run/Task history is deleted.

Workspace viewer history is kept by default: config, Activity/check receipts, request audit, session bindings, launch history, and committed-Stage Git evidence. Pass `--purge` to remove that viewer-owned state, not planning documents. The program itself is also retained because a running process cannot remove its own binary; uninstall prints the appropriate follow-up command.

### Building and releasing it yourself

```bash
npm install
npm run check          # skill validation + typecheck + tests + web build (what CI runs)
npm run dev            # frontend :5173 + backend :8787 (vite proxies /api) → http://localhost:5173
npm run build:npm      # stage the publishable package → dist-npm/ (Node only)
npm run build:binary   # portable single binary → dist/orca-dag (~100 MB, frontend embedded; needs Bun)
npm run release 1.0.0  # tag + push; CI publishes to npm and attaches every binary to a GitHub release
```

Cross-compile a binary for another platform with `TARGET=bun-linux-x64 npm run build:binary`; `bash scripts/build-all-binaries.sh` does every target at once, which is what the release workflow runs.

The npm release job uses **Trusted Publishing (OIDC)**, so it needs no `NPM_TOKEN` GitHub secret. npm requires the package to exist before you can configure a trusted publisher. For the first release only, sign in to npm with 2FA and publish a prerelease from the staged package under the `bootstrap` tag:

```bash
npm login
PKG_VERSION=1.0.0-oidc-bootstrap.0 npm run build:npm
npm publish ./dist-npm --access public --tag bootstrap
```

On the first publish, npm also initialized `latest` to the prerelease despite `--tag bootstrap`; the first stable release will move `latest` to `1.0.0`. Then, on npmjs.com, open **orca-orchestration-launcher → Settings → Trusted publishing → GitHub Actions**. Set user `yyq19990828`, repository `Orca-dag`, workflow filename `release.yml`, no environment, and allow **npm publish**. Or, with npm >=11.15.0, run `npm trust github orca-orchestration-launcher --repo yyq19990828/Orca-dag --file release.yml --allow-publish` and verify with `npm trust list orca-orchestration-launcher`. Commit and push the OIDC workflow to `main` before running `npm run release 1.0.0`. That command pushes the first stable tag; future releases use the same tag workflow. The staged package's `repository.url` already matches this GitHub repository. See [npm's Trusted Publishing setup](https://docs.npmjs.com/trusted-publishers/).

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
   npx orca-orchestration-launcher
                          # installs the skill into your agents, serves :8787, opens the browser
   ```

3. **Plan in your agent.** In Claude Code (or any agent that just got the skill), describe what you want and ask for a DAG:

   > Use the orca-dag skill: break "add CSV export to the reports page" into a task DAG.

   The agent will ask a few clarifying questions, write `.orca/<timestamp>/PRD.md` / `.orca/<timestamp>/TECH_SPEC.md`, then run `orca orchestration run-create` + `task-create --deps …`. When it's done it tells you the **Run id** (like `run_ab12cd34ef56`) and the planning directory.

4. **Pick the Run** the agent just named in the top-bar dropdown. The DAG appears and refreshes every 2 seconds — you can keep chatting with the agent to reshape it and watch nodes pop in live.

5. **Choose harnesses.** Set the toolbar's **Default harness** (fallback for every node), and optionally click individual nodes to override harness/model per node. Set **Max parallel**.

6. **Click "▶ Run with Orca"** and accept the confirmation (it explains that the viewer takes over the Run's coordinator slot, fencing the agent terminal or Orca-native chat coordinating it). Ready tasks fire in parallel; running nodes get the crayon scribble; the graph advances as workers report `worker_done`.

7. **Resolve gates when they pop.** If the plan includes approval gates, approve/reject buttons float over the DAG at the right moment.

8. **Change the plan?** Go back to the agent conversation. It reclaims the Run with `orca orchestration run-use --id <run>` (or just opens a fresh Run and redraws), and the viewer follows along. Then hit Run again.

## Tutorials

- [Plan and run a DAG](docs/tutorials/orchestration.md) — Run/Task/Dispatch design, a worked graph, CLI parameters, and the coordinator loop.
- [Stage behavior in isolated worktrees](docs/tutorials/worktree-isolation.md) — placement and creation parameters, Git staging boundaries, lanes, integration gates, and cleanup.
- [Operate the viewer](docs/tutorials/viewer-operations.md) — startup and launch settings, API shape, monitoring, recovery, and persistent state.

## What the viewer can do

- **OpenCode 2 TUI**: the existing `opencode` choice uses Orca's native `opencode2` agent id on a running Orca 1.4.220+ when no per-node model is selected. Orca then owns status, placement, and terminal cleanup; OpenCode uses its configured model. Selecting a model keeps the `opencode run --auto -m` one-shot path, as do older/unknown runtimes. A failed native start never launches a second worker. Verified with OpenCode 2.0.22 on read-only and file-writing Tasks.

- **Workspace-scoped Run picker**: Orca's Run registry is global, but the viewer shows only Runs whose Task creator identity matches this workspace (plus the workspace's persisted/current empty Run). The compact selector leads with the stable `run_*` id and keeps the objective as secondary context. **＋ Create Run** creates an empty Run from this workspace and selects it immediately. **Load older** walks further back through Orca's cursor-paginated registry (the opaque cursor passes through byte-for-byte), and an exact `run_*` id can be opened directly — the exact lookup re-checks workspace ownership, so a foreign id reads as not-found instead of leaking another workspace's Run.
- **Run health badge**: the selected Run always reports its ownership state — **viewer-owned** (this viewer's live coordinator), **external** (another terminal coordinates it), **unbound** (no coordinator at all), or **inconsistent** (Orca's own records disagree), plus per-source counts with a warning when a read fails (a failed read is never a silent zero). An empty Run that still has messages is explained as such instead of looking like a rendering failure.
- **Runtime capability matrix**: a read-only panel reads the local Orca runtime's `status --json` capability advertisement and compares it with the canonical 1.4.206 orchestration ids — documented older aliases say so, unknown orchestration names and absent fields stay gated off. The full local advertisement remains available in the API response; unrelated browser/terminal capabilities do not flood the panel. Remote environments are checked against their own advertisements, not the local one. The `orchestration.contract.v1` and `orchestration.federation.v1` umbrella ids are informational and never enable narrower capabilities. Support is never inferred from the version string.
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
- **Per-node model override**: for harnesses that support it — opencode gets a dropdown enumerated from `opencode models` (selecting one uses the one-shot path); claude / codex / cursor get free-text. Claude/Cursor pass it via `worker-start --model`. Local POSIX Codex in a current or existing worktree uses native `worker-start --agent codex --model` when the running Orca is 1.4.217 or newer. Older/unknown runtimes and newly created local worktrees retain the prestart-and-bind compatibility path; creation and any committed-Stage base-SHA verification finish before Codex starts. Remote and Windows Codex use native starts. Others run on their default model.
- **Per-node reasoning effort**: claude / codex / cursor additionally take an effort level. Native starts pass it via `worker-start --effort`; compatibility-prestarted Codex receives it when its terminal launches. It only applies when a model is set for that node (Orca's contract), so clearing the model clears the effort.
- **Per-node placement — the complete local matrix**: every node executes in one of four Orca placement modes, picked in its panel: the coordinator workspace (**Current**, the default), an Orca-discovered **exact existing workspace** (the full selector `worktree list` returned — a Git worktree *or* a folder workspace), a stacked **new child worktree** that Orca creates during `worker-start`, or an independent **new top-level worktree** created from an exact Orca-discovered repository selector. The two new-worktree modes carry bounded creation metadata — an explicit name (or a deterministic one derived from the Run + Task/lane ids), a setup policy (`run` / `skip` / `inherit`, default `run`), an optional base branch, a display name, and a comment. Current and existing placements reject every creation-only field and never rerun setup, and each worker's receipt reports the **requested vs. effective** placement.
- **Per-node environment (remote placement)**: a node can instead execute on a **saved connected environment** (`orca environment list`) while the Run stays on this server. Remote placement supports exactly the two unambiguous forms — an **exact existing workspace** (the full `id:<repo>::<path>` selector discovered on that environment) or a **new top-level worktree** (exact repo selector + explicit name). Remote `current`/`new-child` are never offered — they are ambiguous across servers — and the server refuses them at the HTTP boundary and again in the adapter, before any Orca call. Model/effort controls hide for peers that don't advertise the capability.
- **Workspace lanes (serial shared workspaces)**: a dependency-ordered chain of tasks can share one non-current local workspace. A lane is seeded by an exact-existing, new-child, or new-top-level placement; the first task opens or creates that workspace, and every later task — and every retry, and a viewer restart — reuses the **exact Orca-returned selector**, never a name, path, or branch reconstructed by the viewer. Tasks in one lane never run concurrently (one unsettled Dispatch per lane); different lanes may run in parallel up to Max parallel. Unordered tasks cannot share a lane — Run start refuses the plan instead of inventing an order. If Orca evidence cannot positively recover a lane's workspace, the lane freezes as **unverifiable**: nothing is guessed, recreated, or silently moved to current. The Workspace-lanes panel shows each lane's state (`planned / creating / active / integration_required / settled / unverifiable / removal_blocked / removed`) with its Orca-derived identity (selector, worktree id, path, branch, HEAD) and where each fact came from.
- **Integration gates on cross-lane joins**: when a task's dependencies ran in different workspace lanes, completing them is *not* treated as proof that their changes were merged. Before such a task starts, the coordinator creates one idempotent Orca decision gate (stable `[orca-dag:integration]` marker, source and target lanes named) that offers only an `integrated` resolution, and the task stays blocked until a human resolves it. Resolution records a **human assertion** — the viewer never claims to have verified a Git merge, and it never merges, rebases, cherry-picks, commits, pushes, or deletes branches.
- **Per-Dispatch intervention**: stop one positively identified active Dispatch (`worker-stop`), explicitly abandon one positively exited or Orca-prescribed outcome-unknown attempt (`worker-abandon` — refused while Orca proves the worker live), or focus a local worker terminal that Orca reports as waiting for human input (`terminal switch`, fresh local `agentWait` evidence only). Missing, stale, remote, or unverifiable evidence authorizes no action; every intervention runs under a durable request id and never touches unrelated Dispatches.
- **Review and removal, Orca-native**: after execution, changed files and diffs open in the Orca editor for the exact proven workspace (`file open` / `file diff` / `file open-changed`; report/file paths are validated against that workspace first), and a settled lane's worktree is removed only through `orca worktree rm` — explicit confirmation, token-protected, and refused while any live, reclaimable, retained, release-pending, or unverifiable worker may still own the workspace. An archive-hook failure surfaces verbatim; Orca's documented waiver is a separate second confirmation, never automatic and never a `--force`.
- **Per-node harness**: click a node and pick `claude / kimi / opencode / grok / codex` or a custom command in its panel (persisted to the workspace's `.orca-dag.config.json`; custom commands additionally need `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` — see the [security model](#security-model)); nodes without an explicit choice fall back to the toolbar's **default harness**. One harness boundary: one-shot opencode and custom commands run on the viewer's legacy local-terminal path, which cannot own a non-current workspace — combining either with a non-current local placement (or a lane) is refused before anything starts, with **no fallback to current**.
- **Immutable launch preferences after execution**: harness, model, effort, environment, and placement freeze as soon as a Task has its first Dispatch. The lock survives viewer restarts through complete, remote-inclusive worker history; safe retry therefore preserves the original launch plan. While the selected Run's coordinator is active, launch preferences are also frozen for Tasks that have not started because the running coordinator already holds a snapshot; stopping it unlocks only those never-started Tasks.
- **▶ Run with Orca / ⏹ Stop** + **Max parallel**: start/stop the viewer's built-in self-driven coordinator; worker count follows the DAG's parallelism (whatever is ready runs together, capped by "Max parallel") — **no manual worker management**. Settled workers have their output archived, then their terminal is released by default; it is handed to an immediate compatible follow-up (same harness, no model change) via `worker-start --terminal` when one is ready, and kept alive instead with the explicit **Retain for debugging** control. While running it shows "N workers".
- **Approval gates & integration gates**: gate decisions live under Activity's expandable Operational details instead of overlapping the canvas. A cross-lane integration gate names its source and target lanes, explains that upstream completion is not integration, and offers only the `integrated` resolution; the Workspace-lanes panel shows the same boundary from the lane's side (`integration_required`).
- **Node details (read-only spec)**: click a node to see its spec / status / result. The spec starts as a smaller one-line preview with an accessible Expand control. Structured worker results are parsed into an outcome, concise report, modified-file list, and optional report path; the complete payload stays available under collapsed technical details. To change the Task or its deps, have the agent redraw the DAG.
- **Workers panel**: Activity's Operational details contains the live fleet view per attempt — liveness (`live / unverifiable / exited`, with Orca's own reason), attention flags, agent-wait stage, execution host, terminal accounting, requested vs effective model/effort/**placement/workspace**, Orca's literal next action, and bounded output reading with explicit **source badges** (`auto / terminal / transcript`, clipped/complete flags), a **search that filters only the rows already loaded** (it never fetches more transcript), a local **Download loaded rows** export, and release-**archive facts** kept visibly separate from the authoritative fleet state (archive presence is evidence, not settlement). Each row also carries its evidence-gated **Stop / Abandon / Focus** actions: stop for a positively active Dispatch, abandon only for positively exited or Orca-prescribed outcome-unknown attempts, focus only for a local exact `agentWait` — anything unproven renders no action at all.
- **Background session recovery**: Recovery binds a provider-issued session ID automatically when Claude's exact worker process, Codex's exact preamble IDs, or OpenCode's Dispatch-specific launch title establishes a unique match. Bind a known ID manually if that evidence is unavailable. Bindings are kept in `.orca-dag.sessions.json` and checked against Orca's execution location. A provider probe shows its observation separately from Orca's Dispatch state; an unavailable host, terminal closure, or Codex `notLoaded` status never proves that background work exited. Unknown attempts keep their concurrency slot and are not automatically re-placed. Binding and probing do not themselves resume a stopped Dispatch.
- **Blocked Stage resolution**: Operational details offers a reviewed manual completion or an explicit retry for a blocked Task with a failed, fleet-confirmed exited Dispatch. Manual completion keeps the historical Dispatch failed; retry checks the exact provider session and restores the old harness, model, and workspace. Unknown provider state requires the operator to enter the Dispatch ID before retrying, since detached work may still be active.
- **Mutation-request audit**: every viewer-originated mutation (worker-start / release / retain / stop) runs under a durable `--retry-request` id that is persisted — bounded, metadata-only — in the workspace's `.orca-dag.requests.jsonl` ledger *before* the CLI call, so the id stays inspectable even after a lost response or a viewer restart. Operational details gains a read-only **audit panel**: one row per recorded request (operation, Task/Dispatch linkage, scope), and per-row **Inspect** runs a fresh `request-show` probe rendering Orca's own state and interpretation verbatim — `completed` (green), `pending` (amber), `absent` (gray, explicitly labeled "absence is NOT proof the mutation did not happen"), and `unknown` when the probe itself fails. The audit surface never replays a mutation.
- **Hand-drawn crayon style**: 🖍️ SVG feTurbulence wobbled strokes on a cream sketchbook canvas.

## Interface language

The viewer UI ships in **English and Simplified Chinese**. The **中 / EN** toggle sits in the top bar, next to the Run health badge, and always shows the language you'd switch *to* — one click flips the whole UI.

- **First visit** picks the language from the browser's locale: a `zh`-prefixed `navigator.language` opens in Simplified Chinese, anything else in English. From then on an explicit toggle is what decides.
- **The choice persists per browser**, in one `localStorage` key (`orca-dag:lang`) — it survives reloads and viewer restarts, and nothing about it is written to the workspace.
- **Status names, timestamps, relative ages and every panel follow the selection**: DAG nodes and their harness labels, the Run picker, Activity / Chat, Operational details, the node / lane / worker panels, gates and dialogs.
- **Server error messages keep the wording the server sent (English) — deliberately.** Diagnostics (readiness reasons, API errors, Orca's own output) are reproduced verbatim, so anything you quote from the UI still matches the server logs; only the viewer's own copy is translated.

The dictionaries live in `web/src/i18n/en.ts` / `zh.ts`, and `npm run typecheck` fails on any key present in one language only — the two can't drift.

## Security model

The viewer is a control plane into Orca — starting a Run fences whoever was coordinating it, and dispatch spawns real worker terminals — so it is locked down by default:

- **Loopback only.** The server binds `127.0.0.1`, never all interfaces. Nothing on your LAN can reach it; there is no remote-listen mode.
- **No CORS.** The API emits no `Access-Control-*` headers, so a page served from another origin cannot read a single byte of any response — including the token below.
- **Per-process mutation token.** Every mutating request (`POST`/`PUT` under `/api`) must carry `X-Orca-Dag-Token`, a fresh 256-bit random value minted at process start. The web client fetches it from `GET /api/session` and retries once automatically if the server restarts (new token). Read-only endpoints (`GET`) stay token-free. A rejected mutation answers `403` before any route logic runs — no Orca command, no validation-oracle probing.
- **Custom harness commands are opt-in.** Only known viewer harnesses (`claude`, `codex`, `opencode`, `gemini`, `grok`, `cursor`, `droid`, `kimi`) can be launched by default; the `opencode` harness maps to Orca's `opencode2` agent id when the native path applies. Arbitrary commands (e.g. `aider`) are rejected with `custom_commands_disabled` unless the viewer was started with `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`; the UI hides/disables "Custom…" accordingly. A stored custom value stays visible in `.orca-dag.config.json` — it just won't run until the flag is present.
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
| `GET` | `/api/runs/page?cursor=` | One raw cursor-paged `run-list` page — the opaque `nextCursor` passes through byte-for-byte (null = last page); rows carry cheap local ownership evidence only |
| `GET` | `/api/runs/:runId` | Exact Run lookup (`run-show`) with workspace-ownership evidence; `run_not_found` only on Orca's own definite absence — a foreign id reads as not-found, a transport failure never masquerades as one |
| `POST` | `/api/runs` | `{ objective }`: create an empty Run in this workspace (via a throwaway coordinator terminal) |
| `GET` | `/api/terminals` | List Orca terminals |
| `POST` | `/api/run` | `{ runId, harnessByTask?, modelByTask?, effortByTask?, retainByTask?, environmentByTask?, placementByTask?, worktreeLanes?, laneByTask?, defaultHarness?, maxConcurrency? }`: start the self-driven coordinator |
| `POST` | `/api/run-stop` | Stop the coordinator and reclaim its workers |
| `GET` | `/api/run-status` | Live coordinator status: `{ running, busy, attempts, inbox, cleanupDebt, recovery, … }` |
| `GET` | `/api/worktree-lanes?run=<id>` | Run-scoped workspace-lane plan plus each lane's Orca-derived runtime identity (`planned/creating/active/integration_required/settled/unverifiable/removal_blocked/removed`, exact selector, worktree id, path, branch, HEAD, provenance, warnings) |
| `POST` | `/api/worktree-lanes/:laneId/open-changed` | Open the lane workspace's changed files/diffs in the Orca editor (local-only; disabled when the workspace identity is unverifiable) |
| `POST` | `/api/worktree-lanes/:laneId/remove` | Explicit removal of the lane's proven worktree via `orca worktree rm` — requires settled ownership and explicit confirmation; an archive-hook failure surfaces verbatim and is never auto-waived |
| `GET` | `/api/worktrees` | Orca-discovered local workspaces (`worktree list`) — the exact-existing placement picker; never synthesized from the filesystem |
| `GET` | `/api/worktrees/:worktreeId` | One worktree's durable identity via `worktree show`; 404 only on Orca's definite absence — a transport failure propagates so unverifiable is never rendered as "missing" |
| `GET` | `/api/repos` | Orca-discovered local repositories (`repo list`) — the new-top-level placement picker |
| `GET` | `/api/inbox?run=<id>` | Compatibility view of the selected Run's pending questions/escalations + cleanup debt |
| `GET` | `/api/activity?run=<id>&after=&limit=` | Run-scoped readable Activity, per-stage fleet presence, and bounded live coordinator-check receipts |
| `GET` | `/api/activity/stream?run=<id>` | Live SSE snapshots for exactly one Run; the browser falls back to bounded polling |
| `POST` | `/api/messages/:id/reply` | `{ body, runId }`: answer a worker question/escalation |
| `GET` | `/api/audiences?run=<id>` | Preview of the group-messaging audiences for the Run (`@all` + discovered worktrees), with `coordinatorActive` and per-source discovery errors — a failed discovery degrades to an empty list, never a guessed recipient |
| `POST` | `/api/messages/group` | `{ runId, audience, body, subject?, type?, priority? }`: one confirmed coordinator broadcast to an allowlisted audience; lifecycle types are refused with `forbidden_group_type`, undiscovered worktrees with `unknown_audience`, and non-coordinators with `409 not_running` |
| `POST` | `/api/gates/:id/resolve` | `{ resolution, runId }`: resolve an approval gate |
| `GET` | `/api/workers?run=<id>` | Complete, cursor-paged, remote-inclusive worker history for the Run (liveness, terminal state, projection); also the durable launch-lock evidence |
| `GET` | `/api/workers/:dispatchId?run=<id>` | One worker's durable row plus `worker-show` evidence (Dispatch/Worker records, PTY facts, exact-worker observation with agent-wait evidence) — Run-scoped by comparing the receipt's runId; independent of the coordinator loop, so historical workers stay inspectable after a restart |
| `GET` | `/api/session-bindings?run=<id>` | List this workspace's exact provider session bindings for the Run, without probing providers |
| `PUT` | `/api/session-bindings/:dispatchId` | Attach a known `{ runId, taskId, harness, sessionId }` after rechecking the exact Orca worker and execution location |
| `POST` | `/api/session-bindings/:dispatchId/probe` | `{ runId }`: probe only that bound provider session on demand; the result is observation, never Task settlement |
| `POST` | `/api/workers/:dispatchId/resolve-blocked` | `{ runId, result, acknowledgeUnknownProvider: true }`: record an operator-reviewed result on an exited worker's blocked Task; the historical Dispatch stays failed |
| `GET` | `/api/workers/:dispatchId/output` | Bounded output page (`?source=auto\|terminal\|transcript&cursor=&limit=`, limit clamped 1–200) |
| `POST` | `/api/workers/:dispatchId/stop` | Stop one positively identified Dispatch — fresh `worker-show` re-read immediately before acting, durable request id, unrelated Dispatches untouched; a lost response answers `502 response_lost` with the request id to probe, never a blind retry |
| `POST` | `/api/workers/:dispatchId/abandon` | Evidence-gated explicit abandon (`worker-abandon`) — only for positively exited / Orca-prescribed outcome-unknown attempts; refused with `abandon_refused` while Orca proves the worker live, and it claims no process or filesystem action |
| `POST` | `/api/workers/:dispatchId/focus` | Switch to a local exact worker terminal (`terminal switch`) — fresh positive `agentWait` evidence required; remote, inexact, stale, or missing waits expose no action |
| `GET` | `/api/requests?run=<id>` | Bounded audit list of this workspace's recorded mutation requests, Run-scoped (unscoped rows included, labeled; rows of other Runs counted, not listed) |
| `GET` | `/api/requests/:requestId?run=<id>` | One ledger row plus a fresh, read-only `request-show` probe: `{ state: completed\|pending\|absent\|unknown, interpretation, outcome }` — never replays a mutation |
| `POST` | `/api/workers/:id/release` / `/retain` | Explicit post-settlement terminal release / retain-for-debugging |
| `POST` | `/api/workers/:id/retry` | Re-place one positively failed attempt (same harness/model/effort/placement) |
| `POST` | `/api/files/open` / `/api/files/diff` / `/api/files/open-changed` | Open a file, its diff, or a workspace's changed files in the Orca editor for review — paths validated against the proven workspace, local-only, no Git state change |
| `POST` | `/api/worktrees/remove` | Explicit worktree removal via `orca worktree rm` with the exact selector — refused with `removal_evidence_required` unless Orca positively shows settled ownership; distinguishes removed / branch-retained / archive-hook-refused / unverifiable receipts |
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
  index.ts                process entry: subcommands (--help / uninstall), CLI+workspace resolution, skill/workspace initialization, loopback listener
  app.ts                  the Express app (createApp): readiness / dag / session / runs / run / run-stop / run-status / activity / inbox / messages / gates / workers / requests / environments / models / config + SPA serving
  activity.ts             Run-scoped readable event parser + bounded viewer Activity journal
  requestLedger.ts        bounded, atomic ledger of viewer-originated mutation-request ids (.orca-dag.requests.jsonl) — metadata only, state always re-read live via request-show
  security.ts             loopback policy: per-process mutation token, request validation, custom-command gate
  coordinator.ts          self-driven coordinator loop: polls the DAG, fires ready tasks via worker-start (local or --on environment), owns placement/lane mapping, integration gates, settlement + terminal reuse/retain/release, reconciles with worker-list --include-remote
  orca.ts                 orca CLI wrapper: one resolved executable/argv + workspace, readiness/version gate, task-list→DAG, worker-start/reuse/legacy/opencode workers, worktree/repo discovery + placement gates, environment discovery + peer capabilities, worker-read/stop/abandon, gates, terminals, models
  orca.test.ts            resolution/readiness/conflict coverage (fake `orca` fixture)
  runHealth.ts            Run ownership/health evaluation (viewer-owned / external / unbound / inconsistent) behind /api/run-health and /api/capabilities
  config.ts               viewer config persistence: .orca-dag.config.json in the workspace (/api/config)
  skill.ts                installs skill/SKILL.md into the agents on this machine, on startup
  planning.ts             managed .orca/ ignore setup/removal and explicit startup reporting
  uninstall.ts            `orca-dag uninstall`: mirrors skill/workspace setup, preserves plans, cleans stale terminals
  webAssets.ts            loader for the frontend assets (and the skill) embedded at build time
web/src/
  App.tsx                 full-width DAG shell, 2s polling, hand-drawn SVG filter defs
  components/DagView.tsx     React Flow graph + status nodes (harness label, lead-stage marker, crayon animations)
  components/ExecControls.tsx default harness + max parallel + Run/Stop + live status
  components/NodePanel.tsx    node details + collapsed spec + lead-stage control + launch-locked preferences + local/remote placement editor + lane membership
  components/PlacementEditor.tsx  the placement matrix editor: 4 local modes / 2 remote modes, creation metadata fields with bounded validation
  components/LanesPanel.tsx       workspace lanes: Orca-derived runtime identity, review actions, and explicit `orca worktree rm` removal
  components/ActivityPanel.tsx live readable timeline, filters, evidence details, and contextual actions
  components/ChatPanel.tsx     stage conversations + live coordinator-check stream
  components/GatePanel.tsx    approval gates + cross-lane integration gates inside Operational details
  components/RunPicker.tsx    Run selector + "New Run" + Load older (cursor pagination) + exact-id lookup
  components/DoodleSelect.tsx hand-drawn select (portal dropdown, search, keyboard nav)
  components/WorkerPanel.tsx  fleet view: liveness/attention/launch prefs/sourced output (search + download), archive facts, retain/release/stop/abandon/focus controls
  components/RequestAuditPanel.tsx read-only mutation-request audit: ledger rows + request-show receipts (completed/pending/absent/unknown)
  harness.ts                reactive config store: per-node launch preferences, placement/lane intent, lead stage per Run, default, max parallel, layout (persisted via /api/config)
  placement.ts              shared client-side placement/lane grammar + lane-plan preflight (mirrors the server grammar; the server re-validates everything)
  layout.ts                 layout algorithms: dagre layered (LR/TB) + force-directed (Fruchterman–Reingold)
  types.ts / api.ts
scripts/
  build-binary.mjs        vite build → embed assets + skill → bun --compile → dist/orca-dag
  build-npm.mjs           vite build → esbuild the server → dist-npm/ (the publishable `orca-orchestration-launcher` package)
  build-all-binaries.sh   every Bun target + archives + checksums (what the release workflow runs)
  check-skill.mjs         guards SKILL.md's frontmatter (which the skills CLI installs by) + rejects hard-coded CLI guidance that bypasses the runtime guide
  release.mjs             `npm run release <version>`: checks, tags, pushes — CI does the rest
```

## Design notes and boundaries

- **The brain lives outside**: planning is done by the agent you already have (the skill provides the conventions); the viewer embeds no Claude Agent SDK.
- **The viewer is its own coordinator**: Orca deliberately ships no scheduler, so `server/src/coordinator.ts` drives the loop with Orca's Run/Task/Dispatch primitives. Parallelism follows the DAG (everything ready fires together, capped by `maxConcurrency`); settled workers have their output archived, then the terminal is **released** by default, **reused** only for an immediate compatible follow-up (same harness, no model change, via `worker-start --terminal`), or **retained** on explicit request — every settled terminal gets exactly one evidence-backed ownership decision, and an ambiguous release surfaces as debt instead of being retried blind.
- **Workers must be autonomous agents**: hands-off execution requires the worker to run `orca orchestration send --type worker_done` on its own — otherwise it stalls on a permission prompt. `worker-start` launches Orca-configured TUI agents with their autonomous flags; for custom commands the legacy path uses `HARNESS_LAUNCH` in `orca.ts` (only `claude --dangerously-skip-permissions` is verified — add and verify flags for others before relying on them).
- **The `dispatch --inject` quirk** (legacy path): it types the preamble into the agent's input box but often **doesn't submit it** (a readiness race). The coordinator waits ~2s after dispatch and sends an extra Enter; a stray Enter on already-submitted input is a harmless no-op.
- **OpenCode launch mapping**: the viewer choice `opencode` means OpenCode 2. With no per-node model on a running Orca 1.4.220+, it starts native `worker-start --agent opencode2`; Orca supervises the TUI and owns terminal cleanup. A selected model or older/unknown runtime keeps `opencode run --auto` in a bare shell with a tracking Dispatch. Native-start failure never triggers a second legacy worker.
- **Placement is exact or it doesn't happen — local and remote**: the four local modes map one-to-one onto `worker-start --worktree` values (`current`, the exact existing selector, `new-child`, `new-top-level --repo <exact-repo>`), and creation flags (`--name`, `--base-branch`, `--display-name`, `--comment`, `--setup`) are emitted **only** for the two new-worktree modes — never for current or existing starts, which never rerun setup either. When the user supplies no name, the server derives a deterministic bounded one from the Run + Task/lane ids before calling Orca. A node pinned to a saved environment starts via `worker-start --on <environment>` — and `--on` appears on that one call only; every later read, message, stop, and release addresses the **Dispatch ID** (the execution host owns the process, filesystem, transcript, stop, and cleanup facts). Only two placement forms exist remotely — an exact existing workspace selector discovered on that environment, or a new top-level worktree with an exact repo selector and an explicit name; remote `current`/`new-child` are refused at the HTTP boundary and again in the adapter, before any Orca call. There is no synthetic local fallback anywhere: a failed new-worktree start never runs the Task in the current workspace and never creates a replacement from missing evidence, an unknown environment or an unproven capability fails the start with its reason on record, and a safe retry repeats the positively proven selector (`placement` cannot be re-proven → the retry is refused). Model/effort forwarding and structured transcript reads are gated on what the peer **advertises**; a disconnected host renders its workers `unverifiable` (never `exited`) and triggers no automatic stop/retry/release — reconnection restores liveness and the original Dispatch settles.
- **The legacy harness boundary is fail-closed**: one-shot opencode and custom commands run on the viewer's legacy local-terminal path, which cannot honor an exact non-current workspace or atomically create and own a new worktree. Selecting any non-current local placement or a lane with such a harness is refused before any terminal or Dispatch exists — there is no silent fallback to the current workspace, and `agent_unconfigured` never broadens placement after the fact.
- **Worktrees are Orca's, end to end**: every new worktree is created by `worker-start` itself — one receipt owns the Task, Dispatch, setup, terminal, worktree effects, residual resources, and recovery commands; there is no separate `worktree create` call. Every removal is `orca worktree rm` with the exact selector Orca returned or rediscovered, gated on settled worker ownership and an explicit confirmation. Native `git worktree` commands and direct directory deletion exist nowhere in the product, a failed archive hook blocks removal instead of being waived, and a `worker-release` alone never enables removal.
- **Per-node launch preferences and the lead marker live in a workspace config file**: Orca tasks have no harness/metadata field (`task-create` only takes spec/title/display-name/deps/parent), so the viewer stores launch choices, per-task placement intent, lane definitions and memberships, one semantic lead Task per Run, max parallel, and layout in `.orca-dag.config.json` at the workspace root (`server/src/config.ts`, `GET/PUT /api/config`) — surviving browser switches and cleared localStorage. The config stores **intent only**: created worktree ids, paths, branches, terminal handles, Dispatch ids, and capability grants never enter it; runtime identity is always rebuilt from Orca receipts and reads. The frontend's `harness.ts` is a reactive store that hydrates from the server and migrates old localStorage values once. At Run time launch choices are snapshotted into the coordinator; durable worker history then prevents changing a Task's plan after its first Dispatch.
- **Created tasks can't be edited**: `orca orchestration task-update` only changes `--status` / `--result` — **no interface to edit spec/title/deps**, no single-task delete, and no reset either (`orca orchestration reset --tasks` wipes every Run at once, so the viewer deliberately never calls it). So "change a task" = **have the agent redraw the DAG in a fresh Run** — New Run is the only safe redraw path.
