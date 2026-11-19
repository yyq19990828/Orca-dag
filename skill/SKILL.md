---
name: orca-dag
description: "Plan software work as an Orca orchestration task DAG and hand it off to Orchestration Panel (or coordinate it directly in Orca when requested). Use when the user wants to break a feature or project into an executable graph of tasks with dependencies and approval gates in Orca, write language-matched specs, and visualize or drive execution via Orchestration Panel / the orca-dag viewer."
---

# orca-dag

Refine a software requirement through conversation and land it as an **Orca orchestration task DAG** (directed acyclic graph). You own **the project workflow** — requirements, PRD, technical design, and the shape of the graph written into Orca.

Orca supports **two coordination models**, and you should respect whichever the user chooses:

1. **Human-driven coordination via Orchestration Panel (default handover)**: You finish the DAG and hand the Run ID to the user. In **Orchestration Panel** (either the self-contained native Orca plugin `orchestration-panel` or the standalone `orca-dag` viewer), the user picks per-node harness/model/effort/placement, reviews launch preview and account quotas, clicks **Run**, and directly handles approval gates, worker Q&A, permission prompts, retries, and L1 native session resumes while the deterministic coordinator advances ready waves in parallel.
2. **Model / Agent-as-Coordinator in Orca (when explicitly requested)**: If the user explicitly asks *you* (an Orca agent/model session) to drive execution as the Run's coordinator, follow the runtime-matched `orchestration` guide's wake-driven loop: start independent ready workers, **end your turn** so Orca wakes you on replies/completions (never poll or run watch scripts), steer via `send`, and let Orchestration Panel observe read-only.

This skill is deliberately **thin about orchestration commands**. Command flags, JSON shapes, worker lifecycle, recovery, and gate rules belong to the **runtime-matched orchestration guide your resolved CLI prints** — load it (Step 2) and follow it. Copy-pasted command syntax here would silently drift from the installed runtime; this file only adds the project workflow around that guide. If the guide and this file ever disagree, **the guide wins**.

Every planning result **must be written into Orca's orchestration state** (by running orchestration commands), not left as chat text — Orchestration Panel polls Orca live and draws whatever is there.

## Tools you may use
- **Bash** to run the resolved Orca CLI and read/write orchestration state.
- **Read / Write / Edit** to write planning docs in the working directory (`.orca-dag/<timestamp>/PRD.md`, `.orca-dag/<timestamp>/TECH_SPEC.md`).
- Do not run destructive commands unrelated to this task (`rm`, `git push`, deleting files, …).

## Step 1 — resolve the Orca CLI (once, before anything else)

The wrong binary silently breaks everything: on Linux outside Orca, plain `orca` is usually GNOME's **screen reader** (`/usr/bin/orca` — its `--version` prints a small number like `42.0`), not the Orca IDE. Resolve **one** executable, in this order (the same rules the viewer uses):

1. `ORCA_CLI_COMMAND` from the environment (exact quoted argv, parsed without a shell);
2. `orca-dev`, when `ORCA_DEV_REPO_ROOT` is set;
3. on **Linux outside a managed Orca terminal**, `orca-ide`;
4. otherwise plain `orca`.

Verify before using: `<cli> status --json` must report `result.runtime.appVersion` **≥ 1.4.205** (the execution baseline; on 1.4.160–1.4.204 the viewer stays view-only; **≥ 1.4.263** adds the native `orchestration-panel` companion plugin, verified OMP `--effort`, cascading helper stops, paired peer mail, and single-use worker permission prompts). Then use this **one literal executable for every command in this session** — never switch mid-run. The runtime guide writes `ORCA` in its examples: that always means the binary you resolved here.

## Step 2 — load the runtime-matched orchestration guide (required)

Before asking planning questions or touching orchestration state, load the guide and follow it for every orchestration command — its flags, JSON shapes, worker lifecycle, completion accounting, and gate rules are the authority:

```bash
<cli> skills get orchestration
```

Load bundled references on demand (`<cli> skills get orchestration --references` lists all names):
- Task DAGs & multiple Runs: `--reference references/coordinator-loop.md`
- Group mail & decision gates: `--reference references/messaging-and-gates.md`
- Child/top-level worktrees, SSH/WSL, paired servers: `--reference references/placement-and-remote.md`
- Failed/unknown workers, stop/abandon, circuit breaker & reopen: `--reference references/recovery-and-cleanup.md`

If the CLI rejects `skills get` entirely, stop and report the runtime version — the viewer needs ≥ 1.4.205 to execute anyway.

## Preflight
```bash
<cli> status --json      # result.runtime.state should be "ready"; if not, ask the user to run `orca open` first
                         # result.runtime.appVersion >= 1.4.205 for execution; >= 1.4.263 for plugin/OMP effort/permissions
```

## Workflow (three phases, all in conversation)
1. **Requirement clarification (PRD)**: align on the goal, MVP scope, and explicit non-goals with short questions — one key question at a time. If MVP is enough, plan only P0; don't over-design. Once agreed, write `.orca-dag/<timestamp>/PRD.md` in the user's conversation language.
2. **Technical design (TECH_SPEC)**: stack, data model (down to fields), module interfaces (pseudocode). Write `.orca-dag/<timestamp>/TECH_SPEC.md` in the **same** planning directory and in the user's conversation language.
3. **Decompose into a task DAG**: split the design into parallel/serial subtasks and write them into Orca (next section). **This step is the required output.**

### Make prerequisites actionable before dispatch

- **Separate worker placement from test resources.** A Task's assigned worktree is where its worker executes. An isolated test runtime, fixture workspace, account, or service is a separate resource; placement controls do not provision arbitrary external runtimes.
- **Provision first, or add a preparation dependency.** Name the resource owner, exact paths/selectors, runtime identity, access method, allowed changes, and cleanup owner in the dependent Task's spec. Do not request execution approval while required resources remain unspecified and unowned.
- **Account for verified worker harnesses and adapter routes.** Verified supervised worker harnesses in Orchestration Panel are `claude`, `codex`, `opencode`, `omp`, and `antigravity` (five unverified IDs — `gemini`, `grok`, `cursor`, `droid`, `kimi` — are refused for worker launch, even if the skill is installed for them). On Orca ≥ **1.4.263**, OMP supports named `--effort` levels alongside Claude and Codex (never treat raw numeric `reasoning_effort` values as a 0–100 scale). OpenCode Auto uses native `opencode2` (default model) or native `opencode` (plain model on ≥ 1.4.241), while `#variant`, effort, or older runtimes keep CLI compatibility or explicit Mini/Full TUI adapters. Preserve the requested model/variant, never silently change it to make another route fit. Provider activity/output is separate from Orca settlement.
- **Review launch preview and account quotas before handover.** `POST /api/launch-preview` and `GET /api/accounts` explain route selection, launch constraints, and account/quota status, not guaranteed startup or prerequisites hidden in prose. Agent-specific validation remains on the execution host.
- **Account for launch locks.** Preferences freeze while the coordinator runs and remain pinned after a Task's first Dispatch. Do not ask the user to move an already-started worker through disabled controls or configure an external runtime in a field the viewer does not have. Supply additional test resources when safe; otherwise preserve the outcome and use the runtime's explicit recovery contract.

### Planning artifacts (one directory per plan)

- For each **new requirement or fresh replanning Run**, create a new `.orca-dag/<timestamp>/` directory. Use a filesystem-safe UTC timestamp with milliseconds: `YYYYMMDD-HHmmss-SSS` (e.g. `.orca-dag/20261008-143012-123/`). Create the final directory exclusively; if it already exists, choose a new timestamp or append a numeric suffix. Never reuse another plan's directory or overwrite its documents.
- Put **all file-based planning intermediates** in that same directory, including any supplemental notes, task-spec drafts, or local DAG drafts you choose to create. Do not scatter them in the project root or shared `docs/` files. Local drafts never replace the required writes into Orca's orchestration state.
- Viewer runtime state shares the `.orca-dag/` root: `config.json`, `activity.jsonl`, `launches.jsonl`, `requests.jsonl`, `sessions.json`, and ephemeral `0o600` `endpoint.json` (while a viewer or embedded plugin backend is running). In addition to provider session bindings, `sessions.json` stores critical recovery journals (`mailboxChecks`, `guidanceSends`, `operatorMessages`, and `resumeAttempts`) that serve as recovery authority, not rotating audit logs. Unsupported older readers will fail if encountering these fields, so critical recovery journals cannot safely be hot-downgraded across unsupported readers. The viewer migrates legacy root `.orca-dag.*` files without overwriting existing destinations; stop old viewers before upgrading. Do not hand-edit these state files as part of planning. Uninstall keeps them by default; `--purge` removes only known state files, never timestamp planning directories or other user files.
- Keep the same directory while refining that plan or adding Tasks to its existing Run. When resuming, use its explicitly recorded path, not whichever directory happens to be newest. After creating the Run, record its id in both documents and report the **Run id + planning directory** to the user.
- `npx orca-orchestration-launcher` adds a marked `.orca-dag/` rule to the workspace's `.gitignore` on startup and announces it. If you installed only the skill, used only the embedded plugin backend (`ORCA_DAG_NO_WORKSPACE_INIT=1`), opted out of workspace initialization, or saw an initialization warning, ensure `.orca-dag/` is ignored before writing documents; preserve existing rules and never write through a symlinked `.gitignore` or `.orca-dag` directory. Explain any inability to set up the ignore rule instead of silently assuming protection.
- Planning docs are **local, ignored artifacts**, not committed source. Do not force-add them. Isolated worktrees won't automatically contain them: every Task spec must embed the requirements, interfaces, and acceptance criteria its worker needs, rather than relying on a planning-document path. Include the originating planning path for traceability, not as a required worker input.
- Existing legacy `.orca/` documents are not automatically moved or deleted. All new planning output uses `.orca-dag/`. Startup preserves any legacy managed ignore block; `npx orca-orchestration-launcher uninstall` removes the installed skill, stale `endpoint.json`, orphaned coordinator terminals, and exact managed ignore blocks for either location, but keeps planning documents even with `--purge`. User-authored ignore rules remain untouched.

## Writing the DAG into Orca (the core)

One Run holds one DAG — Orca treats a Run as a namespace and home inbox, so "one Run = one DAG" is a planning convention rendered by Orchestration Panel. The runtime guide owns exact command syntax; conceptually you will:

- **Match the user's conversation language for every Run, Task, and Gate.** Write the Run objective, every Task's title (`--task-title`), display name (`--display-name`), and spec body (`--spec` / `--spec-file`), and every decision gate's question in the **language the user is conversing in** (e.g., Simplified Chinese when the user interacts in Chinese; English when in English). Keep exact technical identifiers, file paths, symbol names, CLI flags, code snippets, and local protocol markers (such as `[orca-dag:merge-prep]` / `[orca-dag:merge-inputs-v3]`) verbatim.
- **Open a fresh Run** for this plan (`run-create`) and note the returned `run_*` id. Note that on Orca 1.4.263+, a later `run-create` keeps earlier Runs alive while commands without `--run` default to the newest Run — always pass `--run <run_id>` explicitly when adding tasks or inspecting a specific Run. To replan, open a **new** Run — **never** `reset`.
- **Create tasks one by one**, passing each task's dependencies as a **JSON array** of earlier task ids. Deps may only point at tasks **within the same Run**, and they are what make execution advance in the right order — **remember every returned task id**. On Orca 1.4.263+, prefer passing multi-line Markdown specs from a file or stdin via the runtime guide's `--spec-file` flag alongside concise `--task-title` and `--display-name` (in the user's language) so shell quoting never corrupts code fences or backticks and cards stay readable in both the full Tab and compact Sidebar.
- **Self-check the graph after each batch** with a Run-scoped read (`task-list --run <run_id> --json`): verify the dependency arrows, because a wrong edge **cannot be fixed after creation** (see Boundaries).
- **Write self-contained specs** — the guide's *Task-spec contract* is the floor: target, change, constraints, ownership (what the worker may edit), observable acceptance evidence, and whether a non-zero exit means failure or is the deliverable. Every planned input and resource must be available when the worker starts; do not leave them to post-dispatch clarification or local plan mode. Unexpected runtime blockers follow the live preamble's `ask` contract (call `ask`, then end turn so Orca wakes the worker with the reply). Use imperative sentences and avoid vague phrasing like "investigate" or "as appropriate".
- **Plan workspace placement through the viewer (or `worker-start`), not by telling workers to branch:** by default every task executes in the coordinator's current workspace. Tasks editing overlapping files in parallel must run in isolated local workspaces — an exact existing workspace, a stacked child worktree, or an independent top-level one — and a dependency-ordered chain may share one such workspace as a serial lane. Which task goes where is **launch configuration**, not Orca task state. Tell each worker to edit and commit in the worktree **already assigned to its Dispatch**; never tell it to create a worktree or switch branches when placement creates one. Otherwise the worker can create a nested worktree with a different Git base, leaving the assigned Stage unchanged.
- **For committed Stage integration, split every cross-workspace join into two Tasks**: a merge-preparation Task containing both `[orca-dag:merge-prep]` and `[orca-dag:merge-inputs-v3]`, then a development Task depending on it. The merge-preparation Task depends on every source Stage and runs in the target worktree. Its spec must require the worker to use the runtime-matched guide to ask the bound coordinator for immutable dependency inputs before any Git edit. The ENTIRE question text must be EXACTLY `[orca-dag:merge-inputs-v3]`, with no surrounding prose; wait for the exact immutable SHA reply before proceeding. Then merge those commits with history-preserving Git merges, resolve conflicts, commit, and report completion. Both markers are required; legacy runnable merge specs lacking the marker must replan in a fresh Run. Note that the official public orchestration contract is contract 1 (`orchestration.contract.v1`), runtime protocol is 3, federation lifecycle settlement protocol is 3, and control mail protocol is 2; `[orca-dag:merge-inputs-v3]` is a local viewer contract marker (not a global upstream version name) and must not be renamed. Never rely on a blind post-start message for essential inputs. The development Task uses the **same workspace** and depends on merge preparation; give it only development work. Commit current-worktree source changes (including a newly added `.gitignore` rule) **before starting the Run** so its base HEAD is clean; keep `.orca-dag/` planning docs ignored, never force-add them. Every Stage worker must leave its worktree clean with its result committed before `worker_done`. Assign parallel source Stages to separate worktrees; unordered Tasks must not share a worktree, even if they edit different files. New worktrees in this mode start from the Run's captured HEAD, so leave any viewer `baseBranch` override empty. Git must verify that all dependency SHAs are ancestors of the merge worktree's clean HEAD before development proceeds; missing evidence parks the dependent Task. This mode is local Git only; remote and folder workspaces are unsupported.
- **For ordinary lane Runs without that marker**, a cross-lane join retains the human `integrated` checkpoint. That resolution is a human assertion and does not prove Git ancestry.
- **Merge handshake implementation:** The viewer verifies immutable dependency snapshots and the current merge worker's identity before replying. Legacy runnable merge specs without the local merge-inputs-v3 marker are rejected at preview and execution admission; replan them in a fresh Run rather than sending essential inputs after launch.
- **Add a decision gate** where human approval is needed (e.g. approving the design or a wave milestone, written in the user's language) — the guide's gates reference has the rules; Orchestration Panel surfaces approve/reject buttons in both the full Tab and compact Sidebar **Pending** view. Canonical approval/rejection gates can also be created for not-yet-dispatched Tasks in the same Run via `POST /api/gates` before dispatch.

## After the DAG is built: hand off to Orchestration Panel (or coordinate directly if asked)

Once the graph is right, report the **Run id + `.orca-dag/<timestamp>/` planning directory** to the user:

- **With the native Orca plugin (`orchestration-panel`, Orca ≥ 1.4.263)**: No extra terminal is needed — the plugin automatically manages an isolated loopback backend per workspace and immediately displays the Run in Orca's right sidebar (**Tasks** / **Pending** / **Live**) and full 4-zone workbench Tab (`↗ Tab` or status bar click), with live **Session** tool-call cards (`OutputTail` SSE + plugin hooks) and one-click **L1 Native Session Resume** for exited local workers.
- **Standalone CLI / web viewer**: If the plugin is not installed, ask the user to run:
  ```bash
  npx orca-orchestration-launcher    # run in the project root; serves http://localhost:8787 and opens the browser
  ```

The user picks the Run, chooses per-node harness/model/effort/placement, and clicks **"▶ Run with Orca"**.

**Triggering execution via the backend API (when the user asks you to start the viewer run yourself):**
Check `.orca-dag/endpoint.json` first (the embedded plugin backend runs on an ephemeral loopback port published there; fall back to `8787` for a standalone viewer). Inspect `POST /api/launch-preview` and `GET /api/accounts` before starting; the API cannot infer external resource readiness from Task prose.

```bash
PORT=$(python3 -c "import json; print(json.load(open('.orca-dag/endpoint.json'))['port'])" 2>/dev/null || echo 8787)
TOKEN=$(curl -s "http://127.0.0.1:${PORT}/api/session" | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
curl -s -X POST "http://127.0.0.1:${PORT}/api/run" -H "X-Orca-Dag-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"runId":"<run_id>","defaultHarness":"codex","maxConcurrency":2}'
```

The viewer then binds **its own** terminal as the Run's coordinator and advances the graph autonomously — parallel waves, durable mailbox recovery, gate and single-use permission surfacing, terminal release/retain — while streaming live tool calls and check receipts into the **Session** and **Messages** tabs. Failed worker starts are never auto-retried; they park their Task for inspection, retry, or L1 native session resume (`POST /api/workers/:dispatchId/resume`).

**When the user explicitly asks you (the model) to act as coordinator in Orca instead of the viewer:**
Follow the loaded `orchestration` guide's wake-driven loop (`references/coordinator-loop.md` and `references/recovery-and-cleanup.md`): start ready workers, end your turn so Orca wakes you on mail/completions, never run polling/watch scripts (plain `check` steals mail and prevents wakes), steer via `send` (never terminal keystrokes), and use `--keep-open` or `worker-keep-open` when the user wants to keep using a worker's chat. Orchestration Panel will automatically display your Run live in read-only observability mode without interfering.

⚠️ **Fencing is normal when switching coordinators.** Starting execution in Orchestration Panel binds the viewer's terminal as the Run's coordinator, so subsequent mutations from your terminal fail with `consumer_fenced` (reads such as `task-list --run <id>` and `gate-list --run <id>` stay open). To hand authority back cleanly, re-bind via `run-use` following the runtime guide's rules. Conversely, Orchestration Panel refuses implicit takeover of an externally coordinated Run unless the operator explicitly confirms matching binding evidence (`coordinatorControl`).

## Boundaries and known constraints
- **Default to planning + DAG authoring**; only drive execution directly in your terminal if the user explicitly asks for Model-as-Coordinator mode, or trigger the viewer via `/api/run` when asked to launch through Orchestration Panel.
- **Created tasks cannot be edited or deleted**: `task-update` only changes `--status` / `--result` — there is no interface to change spec/title/deps, and no command to delete a single task. You can still **add** new tasks or gates to a Run that hasn't finished (additions are creates), but to **change** an existing task or dependency, open a **new Run and redraw** the whole DAG; the old Run stays as history.
- **Never `reset` during planning.** `orchestration reset --tasks` / `--all` has **no `--run` scope**: it wipes the entire local orchestration DB across all Runs. Only run `reset` when the user explicitly chooses to discard local coordination state; the right way to replan is always a fresh Run.
- **Circuit breaker & user-directed reopen (Orca ≥ 1.4.226 / 1.4.263)**: Three consecutive failed starts in one `--retry-of` chain trip `circuit_broken` (a worker's own `failed` report does not increment it). Never route around a breaker by creating a replacement Task or Run. Only when the user explicitly directs a retry/reassignment may the Run's coordinator inspect retained attempts (`worker-show`/`worker-read`), settle/release reclaimable failed terminals, and reopen the **same Task** in its owning Run.
- **Mailbox, permission, helper, and recovery semantics depend on the runtime.** Upstream official public orchestration contract is contract 1 (`orchestration.contract.v1`), runtime protocol is 3, federation lifecycle settlement protocol is 3, and control mail protocol is 2; local V3 migration is a local viewer contract.
  - Legacy FIFO checks replay the oldest unacknowledged Delivery; consuming checks acknowledge on read and a standalone ACK does not fetch the next batch. Transport acknowledgment is not local processing completion: durable checkpoints live in `sessions.json` (`mailboxChecks`, `guidanceSends`, `operatorMessages`, `resumeAttempts`) and cannot safely be hot-downgraded across unsupported readers. Recover lost responses with the same request identity, never a fresh mutation.
  - Native `stopReason` escalations (`finished`, `errored`, `needs-input`, `exited`, `lost`) are events, not replyable question threads; resolution follows exact Dispatch steering (`send`), operator decisions, or authoritative later settlement.
  - On Orca **1.4.263+**: `worker-stop` cascades to child helpers (`orchestration.worker-stop-helpers.v1`), direct paired-server mail uses `send --on <server>` (`orchestration.peer-mail.v1`), remote receipts use `request-show --on <server>` (`orchestration.remote-owned-workers.v1`), and pending worker permission prompts can be answered single-use from the viewer (`POST /api/workers/:dispatchId/permission`, backed by `approve`/`deny` when enabled in Orca settings).
  - Guidance sends support positively evidenced `recipient_run_bound_redirect` to actual destination mailboxes without adopting child authority. `--peek` is observation only; never consume another agent's mailbox to monitor it.
- The retired scheduler commands (`orchestration run` / `run-stop` / `coordinator-start` / `coordinator-stop`) are no-ops — don't use them.
- Don't run destructive or off-task system commands.

## Communication style
- Follow the user's language across conversation, planning docs, Run objectives, Task titles/display names/specs, and Gate questions. Concise and direct.
- After each batch of task creation, summarize the DAG's current shape in one sentence (what runs in parallel, what is serial) — the user is watching it appear live in Orchestration Panel.
