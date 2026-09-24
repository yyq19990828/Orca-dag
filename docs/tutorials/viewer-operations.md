# Tutorial: operate the orca-dag viewer

English | [简体中文](viewer-operations_zh.md)

This guide covers startup, launch settings, monitoring, recovery, and the viewer's API boundary. For a worked task graph, begin with [the orchestration tutorial](orchestration.md); for workspace rules, use [the isolation tutorial](worktree-isolation.md). The [README](../../README.md) remains the full feature and route inventory.

The viewer runs as a separate process because Orca intentionally has no scheduler, and its plugin panels cannot fetch this viewer's HTTP API. The app serves a loopback API and SPA, then can open a regular Orca browser tab for the UI. Its coordinator schedules Tasks while Orca remains the authority for Runs, Dispatches, workers, and worktrees.

## Startup parameters

Start from the **root of an Orca-managed workspace**. The viewer resolves its CLI and workspace once at process startup. Its default worktree selector is the real path of that workspace, so starting in a subdirectory can produce `selector_not_found` when it tries to create a terminal.

```bash
cd /path/to/orca-managed/project
npx orca-orchestration-launcher
```

If launching from inside an Orca-managed terminal, clear inherited Orca identity so the viewer's newly created coordinator terminal can bind the Run:

```bash
env -u ORCA_TERMINAL_HANDLE -u ORCA_TAB_ID -u ORCA_WORKSPACE_ID -u ORCA_WORKTREE_ID \
  WORKSPACE_DIR="$PWD" npx orca-orchestration-launcher
```

| Setting | Default | Effect |
| --- | --- | --- |
| `PORT` | `8787` | Loopback HTTP listener; Vite development UI uses `:5173` and proxies `/api`. |
| `NO_OPEN=1` | Off | Skip opening the browser automatically. |
| `WORKSPACE_DIR` | Process cwd | Must exist; resolved to its real path and used for all Orca calls and the default `path:` workspace selector. |
| `ORCA_WORKTREE` | `path:<WORKSPACE_DIR>` | Explicit Orca selector for coordinator and Current workers; overrides the path default. |
| `ORCA_CLI_COMMAND` | Auto-resolved CLI | Exact executable plus quoted argv; parsed **without a shell**. Pipes, redirection, substitutions, and unquoted `$` are rejected. |
| `--no-skill` or `ORCA_DAG_NO_SKILL=1` | Skill installed | Skip best-effort installation of the bundled `orca-dag` skill into existing agent directories. |
| `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` | Off | Allow custom harness commands. Such commands use the legacy local path and cannot use an isolated placement. |

CLI auto-resolution is `ORCA_CLI_COMMAND` → `orca-dev` when `ORCA_DEV_REPO_ROOT` is set → `orca-ide` on Linux outside an Orca terminal → `orca`. The resolved CLI is used for both reads and mutations. `GET /api/readiness` shows that choice, workspace, version, and any execution-disabled reason. Orca 1.4.160–1.4.204 can display a Run; execution requires 1.4.205 or newer. The viewer and skill also ship as standalone release binaries and in the `npx orca-orchestration-launcher` package.

## Read the interface before pressing Run

| Surface | What it tells you | What you can do |
| --- | --- | --- |
| Run picker and health badge | Workspace-scoped Run history; `viewer-owned`, `external`, `unbound`, or `inconsistent` coordinator state. | Pick or create a Run, page older Runs, or look up an exact Run ID. |
| DAG and Stage card | Task spec, dependency arrows, separate parent links, status, result, and actual worker workspace. | Select a Stage; choose its launch preferences before they lock. |
| Scheduler | Ready wave, capacity, and a reason for each waiting Stage. | Distinguish an unmet dependency, gate, full capacity, or unknown state. |
| Chat / Activity | Assignments, replies, durable sends, coordinator checks, and an event timeline. | Answer a question or send guidance to an Orca-verified active Dispatch. |
| Operational details | Workers, gates, workspace lanes, Recovery, capabilities, and Request audit. | Inspect evidence before retry, stop, abandon, integration, or removal. |

The DAG refreshes every two seconds. Moving a node changes only canvas position; layout can be layered horizontal/vertical or force-directed. One optional **Lead Stage** marks semantic main-agent ownership in the drawing; it does not grant Orca coordinator authority. UI language is English or Simplified Chinese and persists per browser.

## Launch settings and their design

Orca Tasks have no fields for harness, model, placement, or canvas layout. The viewer stores those choices in `.orca-dag.config.json` in the workspace; browser localStorage is only a migration source and write-through mirror. That file stores **intent**, not runtime IDs. The actual Dispatch, worktree, host, and terminal must come from Orca receipts and fresh reads.

| Setting | Default / allowed value | Effect and limit |
| --- | --- | --- |
| Default harness | `claude` | Used when a Stage has no override. Known choices include Claude, Codex, OpenCode, Gemini, Grok, Cursor, Droid, and Kimi. |
| Stage harness | Inherits default | Selects the launch adapter; custom commands require `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`. |
| Stage model | Agent default | OpenCode enumerates `provider/model` IDs (optional `#variant`); Claude, Codex, and Cursor accept a model name. Other harnesses have no model picker. |
| Stage effort | Unset | `low`, `medium`, or `high` in the UI for Claude, Codex, or Cursor; requires a model on the same Stage and remote peer support when applicable. |
| Max parallel | `4`, integer `1`–`16` | Caps simultaneous worker starts; DAG dependencies and lanes may reduce actual parallelism. |
| Stage environment / placement | Local / Current | A saved remote environment needs an exact existing workspace or named new top-level worktree. See [placement parameters](worktree-isolation.md#creation-fields-and-limits). |
| Workspace lane | None | Reuses one non-Current local workspace for a dependency-ordered Task chain. |
| Retain for debugging | Off | Keeps a settled worker terminal instead of the default release. |
| Layout / Lead Stage | Saved layout / none | Viewer presentation only; neither changes Task readiness nor coordinator binding. |

The Run button snapshots these settings. While the coordinator is active, even an unstarted Stage is locked to that snapshot. Once a Stage has its first Dispatch, launch settings stay locked across viewer restarts; a safe retry uses the original harness, model, effort, and placement. A failed worker-history read also keeps editing locked rather than assuming no attempt exists.

A normal UI pass is: select the intended Run and check its health badge; open each Stage to choose its harness and placement; assign a lane only to a dependency-ordered chain; set Max parallel; review the Scheduler's ready wave and any preflight warnings; then press **Run with Orca** and confirm the coordinator handover. During execution, use Chat and Activity to understand progress, and Operational details for decisions that need exact worker or workspace evidence.

## What happens after Run

The viewer creates a workspace-scoped Orca terminal and binds it as the Run's coordinator. The previous coordinator is fenced; ordinary Run-scoped reads still work. On each pass it finds ready Tasks, honors dependencies, gates, lanes, and Max parallel, then asks Orca to start supervised workers. `worker_done` settles a Task; the viewer processes and acknowledges inbox deliveries and accounts for each settled terminal by reuse, explicit retention, or release. Cross-lane joins wait for a human `integrated` decision; the viewer does not merge Git branches.

One-off UI mutations such as Run creation and gate resolution use a separate temporary coordinator terminal. They do not borrow the running loop's terminal, which would fence it. A second viewer pointed at the **same** workspace reports `coordinator_conflict` rather than adopting or closing the first viewer's terminal; different workspaces get distinct coordinator identities.

### Messages, sessions, and audit evidence

Chat can send guidance to one Orca-verified live `dispatch:<id>`. The group composer offers `@all` or a freshly discovered worktree audience; it previews recipients and requires confirmation from this Run's live viewer coordinator. Lifecycle messages such as `worker_done` cannot be broadcast. A successful send means Orca durably queued the message, not that an agent read or accepted it.

Recovery can bind an exact Claude, Codex, or OpenCode provider session when identity is unambiguous, or accept a manually supplied exact ID. A provider probe may report `active`, `idle`, `exited`, `unknown`, or `unavailable`; it is observation beside Orca's Dispatch state, never a substitute for settlement. Unknown or disconnected attempts keep their concurrency slot. Request audit records viewer mutation IDs before the CLI call, then `request-show` distinguishes `completed`, `pending`, `absent`, and `unknown` without replaying the action.

The viewer offers a local HTTP API for the same controls. `GET` routes are loopback reads. Mutating `POST`/`PUT` routes require the per-process `X-Orca-Dag-Token` obtained by the same-origin client from `GET /api/session`; they also recheck readiness and input. The core start body is:

```json
{
  "runId": "run_example",
  "defaultHarness": "claude",
  "maxConcurrency": 2,
  "harnessByTask": { "task_api": "codex" },
  "modelByTask": { "task_api": "example-model" },
  "placementByTask": { "task_api": { "kind": "new-child", "setup": "run" } }
}
```

`POST /api/run` also accepts `effortByTask`, `environmentByTask`, `worktreeLanes`, `laneByTask`, and `retainByTask`. The maps are keyed by exact Task IDs. The UI builds them from saved settings, validates the whole plan before starting, and shows errors without creating a worker. `PUT /api/config` patches saved preferences; it does not grant Orca lifecycle authority. See the [HTTP API table](../../README.md#http-api) for the other routes and request details.

## Handle a blocked or uncertain Stage

| Observation | Inspect | Next step |
| --- | --- | --- |
| Waiting Stage | Scheduler reason and Task deps/gates. | Wait for prerequisites, resolve a genuine approval gate, or integrate lanes before choosing `integrated`. |
| Worker waiting for input | Workers `agentWait` and exact local terminal. | Use **Focus** only when Orca positively reports that wait. |
| Start failed before readiness | Failure stage, prompt, and residual resources. | Fix the trust/update/permission prompt; Stop and Run again explicitly. The Stage is parked, not auto-retried. |
| Failed or stopped Dispatch | Exact worker row, Task status, original launch. | Use the evidence-gated retry control; it preserves the launch choice. |
| Remote disconnected or liveness `unverifiable` | Remote-inclusive worker history and Recovery observations. | Keep the original attempt accounted for; absence does not authorize stop, retry, or replacement. |
| Mutation response lost | Request audit ID, `request-show` receipt, Task/worker state. | `completed` means applied; `pending` needs the same request identity; `absent` alone proves nothing. Do not replay blindly. |

**Stop Run** stops the viewer coordinator and reports per-Dispatch cleanup, including unknown results. **Stop worker** targets one positively identified Dispatch. **Abandon** fences orchestration without claiming the process or files were stopped. A terminal can outlive a completed Task, so inspect ownership before release or worktree removal. The viewer's Recovery panel keeps provider session observations separate from Orca's Task/Dispatch authority.

## Review, persistence, and cleanup

Use Workspace lanes' **Changed files / Diff** or the file review actions to open an exact local workspace in Orca. Resolve integration gates only after the target workspace contains the intended code. Remove a worktree only after its lane is settled and its changes and worker ownership are accounted for; removal calls `orca worktree rm` with explicit confirmation.

Workspace files have distinct purposes: `.orca-dag.config.json` stores preferences, `.orca-dag.activity.jsonl` stores bounded explanatory activity, `.orca-dag.requests.jsonl` stores mutation request IDs for audit, and `.orca-dag.sessions.json` stores exact provider session bindings. None replaces Orca's authoritative Run/Task/Dispatch records. `orca-dag uninstall` removes installed skills and stale viewer coordinator terminals; `--purge` also removes the workspace config and activity file. It does not merge or publish your branches.

## Known limitations

Add new runtime findings here with the affected launch path, observable symptom, and tested recovery. Keep Orca fleet liveness separate from whether the Codex TUI is visible or a Task has completed.

### Codex status hooks in existing or native sessions

On Orca 1.4.209 and Codex 0.156.1, a Codex TUI started without an explicit `--enable hooks` could execute the injected Task and send `worker_done` while `worker-list` still reported `unverifiable / missing_status`. In a same-Run GPT-6 Luna comparison, a fresh TUI started with `codex --enable hooks ...` reported `live` from `agent_status`, although `codex features list` already reported `hooks` enabled on this machine. A reused Codex app-server without Orca pane variables is a likely contributor, but the hook subprocess environment was not captured directly.

The viewer now adds `--enable hooks` to the **local Codex terminals it starts** before binding them with `worker-start --terminal`. This Codex CLI flag does not belong on other harness commands; their status integrations must be diagnosed separately. The change does not affect an already-running Codex TUI, a manually launched `codex resume`, or Orca's native/remote Codex launch path. For a manual session, start a new Codex process from an Orca-managed terminal with `codex --enable hooks` (or `codex --enable hooks resume` when resuming). Check `worker-list` for `liveness.source: agent_status` during an active Dispatch. Do not infer process exit or retry permission from `missing_status` alone.

### OpenCode's tracking Dispatch has no fleet liveness

The viewer launches OpenCode with a one-shot `opencode run --auto` command and creates an Orca Dispatch for tracking. This path is `unsupervised`: it has no supervised worker resource or `agent_status` fleet evidence. In a parallel read-only comparison on Orca 1.4.209, OpenCode completed its Task with `worker_done`, while `worker-list` showed `unverifiable / missing_status` during execution and `unverifiable / unsupervised_settled` after completion. `worker-show` independently observed the exact OpenCode terminal as live while it ran. These fleet values are expected for the viewer's current OpenCode launch path; they do not by themselves establish a broken OpenCode hook. Use the Task/Dispatch outcome and exact terminal observation for this path, and do not treat `unverifiable` as proof of exit.

A direct read-only `worker-start --agent opencode` test on Orca 1.4.209 with OpenCode 2.0.15 still failed to deliver the Task: the receipt said `input_accepted`, but the OpenCode TUI stayed at its empty initial composer, with no agent turn or `worker_done`. The test Dispatch was abandoned, its exact terminal closed, and its Task marked failed. This is why the viewer keeps the one-shot compatibility path; `input_accepted` alone does not validate prompt delivery.

Prestarting `opencode mini` in a ready Orca terminal and binding it with `worker-start --terminal <handle>` **did** deliver a read-only Task and complete it through `worker_done` on those versions. The resulting Dispatch was supervised, but `worker-list` still reported `unverifiable / missing_status`. `mini` is an interactive interface, whereas `opencode run` is the one-shot CLI mode; OpenCode 2.0.15's `mini --help` has no `--auto` option. Permission behavior for autonomous editing has not been verified, so this experiment does not yet replace the viewer's `opencode run --auto` path.
