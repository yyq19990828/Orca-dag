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
| `--no-workspace-init` or `ORCA_DAG_NO_WORKSPACE_INIT=1` | `.orca-dag/` ignore initialized | Skip adding the managed planning-artifact rule to the workspace's `.gitignore`; ensure `.orca-dag/` is ignored yourself before planning. |
| `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` | Off | Allow custom harness commands. Such commands use the legacy local path and cannot use an isolated placement. |

CLI auto-resolution is `ORCA_CLI_COMMAND` → `orca-dev` when `ORCA_DEV_REPO_ROOT` is set → `orca-ide` on Linux outside an Orca terminal → `orca`. The resolved CLI is used for both reads and mutations. `GET /api/readiness` shows that choice, workspace, version, and any execution-disabled reason. Orca 1.4.160–1.4.204 can display a Run; execution requires 1.4.205 or newer. The viewer and skill also ship as standalone release binaries and in the `npx orca-orchestration-launcher` package.

Startup also announces `.orca-dag/<timestamp>/{PRD.md,TECH_SPEC.md}` and whether its default `.gitignore` setup succeeded. The skill creates a separate UTC timestamp directory for each new plan, records the Run id, and keeps earlier plans. These ignored docs are not committed or automatically copied to isolated worktrees; Task specs must carry the worker's required context. Legacy `.orca/` documents and their managed ignore block stay in place; new planning output uses only `.orca-dag/`.

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

Orca Tasks have no fields for harness, model, placement, or canvas layout. The viewer stores those choices in `.orca-dag/config.json` in the workspace; browser localStorage is only a migration source and write-through mirror. That file stores **intent**, not runtime IDs. The actual Dispatch, worktree, host, and terminal must come from Orca receipts and fresh reads.

| Setting | Default / allowed value | Effect and limit |
| --- | --- | --- |
| OpenCode interface | `auto` | Auto retains current routes; Mini TUI / Full TUI are explicit, with per-node override or inherit. |
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

An abandoned bootstrap attempt can remain `unverifiable / missing_status` after its exact terminal exits, because the agent never created a status row. Explicit blocked-Stage recovery (`POST /api/run` with `resumeBlocked`) accepts a fresh `worker-show` observation only when it proves that exact Dispatch's recorded terminal exited and is disconnected, and both reads name a documented client gap (`missing_status` or `capability_unsupported`). The fleet verdict is not rewritten. A live, still-connected, mismatched, or merely unreachable terminal does not qualify. The separate provider-session check remains: without an exact exited provider binding, an operator must explicitly accept the unknown-provider risk through `allowUnknownProvider`. Abandon alone and closing an arbitrary pane never authorize a replacement.

### Failed worker-start retry chains

On Orca 1.4.226, failed `worker-start` calls accumulate along the exact `--retry-of` chain. The third failed start sets the Dispatch to `circuit_broken`; later starts are refused with `task_not_startable`. A worker that reaches readiness and then reports `failed` does not increment this counter. The viewer parks a failed-before-ready attempt instead of assuming Orca's current Task status makes another start legal; an explicit retry rechecks the exact Task and Dispatch with Orca.

An unresolved retry keeps its own request ID and an unsettled slot. The Task's previous Dispatch pointer or terminal status cannot identify or settle that new request. Task-based settlement is accepted only when the exact current, non-predecessor Dispatch row positively confirms the same outcome; otherwise inspect Request audit and do not start a replacement.

Stop/Run and restarting the viewer do not reset the chain. Keep a retry on the same Task and Run, use the exact prior Dispatch, and repeat the intended placement because `--retry-of` does not inherit it. Do not create another Task or Run to bypass the circuit breaker. Standard recovery asks Orca to release the old viewer-owned failed terminal when its ownership evidence permits; `user_takeover`, an explicitly selected terminal, or a structured/external session keeps its existing retain/release protections and is never force-closed. Archived output remains readable by the exact Dispatch after release.

If Codex exits during TUI bootstrap with `account/read ... workspace routing discovery timed out` and leaves an unsent draft, inspect the original Dispatch and terminal rather than resubmitting Enter. A valid `codex login status` does not prove account/workspace initialization succeeded. Fence the failed attempt, obtain permission before closing a user-owned terminal, and use explicit recovery of the same Task only after the exit and provider-risk gates above are satisfied; preserve its original launch preferences and `--retry-of` lineage.

### Supervision, terminal ownership, and effective launch

Workers shows separate evidence layers; none grants the authority of another:

| Field | Meaning |
| --- | --- |
| `workerState` / worker record | The original lifecycle (`starting`, `ready`, `start_unknown`, `succeeded`, etc.), not `projection.role: worker`. Known worker lifecycles are supervised records; `unsupervised` is tracking-only and unknown values remain unknown. |
| Liveness / exact observation | Whether Orca can observe the worker or its exact terminal now. A live terminal alone does not establish an active agent, settlement, or process ownership. |
| `ownershipState` / `releaseState` / `retainedReason` | Terminal custody and cleanup accounting, independent of lifecycle. A live supervised Codex can still be `user_owned / retained / user_takeover`. |
| Requested / effective launch | Intent and Orca's applied-preference echo are displayed separately, including model and effort. Structured `launch.effective` takes precedence; missing, partial, or explicit-null values never borrow requested preferences. Durable `worker.startOptions` restores the distinction after restart. |

The ownership section compares the original and current owner Dispatch IDs with the worker/resource terminal handles. Diagnostic receipts retain endpoint identity, release errors and release/recovery times. An owner or handle mismatch is not permission to reclaim a terminal. Orca's public custody receipt does **not** identify which input or actor triggered `user_takeover`, or expose a dedicated takeover timestamp; do not attribute it to a keyboard user or the viewer without additional evidence. See the [1.4.226 ownership implementation](https://github.com/stablyai/orca/blob/v1.4.226/src/main/runtime/orchestration/db/worker-terminal/worker-terminal-user-takeover.ts) and [resource presentation](https://github.com/stablyai/orca/blob/v1.4.226/src/main/runtime/rpc/methods/orchestration/worker/worker-terminal-resource-presentation.ts).

Fleet polling updates ownership while a worker stays expanded. If fleet and detail custody disagree, native Stop remains disabled until the exact detail is refreshed by reopening that worker; an old `owned` snapshot cannot conceal a newly observed handoff.

Recovery holds both `pending` and `dispatched` attempts against concurrency and lane budgets, including a blocked Task with `start_unknown`. It follows the exact Task pointer or a unique Task/Run history association; ambiguous history is held, not reduced to a guessed latest worker. Each uncertain active Dispatch consumes its own slot. Settled worker lifecycle records can recover cleanup even when Orca has cleared `task.dispatch_id`.

Native **Stop worker** requires an eligible lifecycle plus positive live and matching `owned` terminal evidence. `user_owned`, transferred ownership, missing custody, or a mismatched handle does not authorize forced closure. The API-preselected OpenCode adapter keeps its separate, server-selected provider Stop with its own execution/identity checks. A native `stop_unknown`/unknown receipt remains unknown in the Stop report, request audit, and cleanup debt; a known terminal handle is never a substitute for confirmed Stop.

A read-only Orca 1.4.226 acceptance check observed `ready`, a supervised worker record, `user_owned / retained / user_takeover`, and effective `codex / gpt-6-luna / max` together in the API and bilingual Workers UI. This verifies parsing and diagnostics, not a return of terminal ownership or a successful process stop.

## Review, persistence, and cleanup

Use Workspace lanes' **Changed files / Diff** or the file review actions to open an exact local workspace in Orca. Resolve integration gates only after the target workspace contains the intended code. Remove a worktree only after its lane is settled and its changes and worker ownership are accounted for; removal calls `orca worktree rm` with explicit confirmation.

All five state files live inside `.orca-dag/`: `config.json` stores preferences, `activity.jsonl` stores bounded explanatory activity, `requests.jsonl` stores mutation request IDs for audit, `sessions.json` stores exact provider session bindings, and `launches.jsonl` stores historical launch identities. None replaces Orca's authoritative Run/Task/Dispatch records. Stop older viewers before upgrading: startup moves legacy root `.orca-dag.*` files without overwriting destinations and prints the result. A conflict retains both files, uses the new one, and requires manual reconciliation. Unwritable migration leaves legacy regular files readable; writes never fall back to the root. Symlinked data directories/files are never followed.

`orca-dag uninstall` removes installed skills, stale viewer coordinator terminals, and only its exact managed `.orca-dag/` and legacy `.orca/` ignore blocks in the selected workspace; user ignore rules are retained. `--purge` removes known viewer-owned state files in both layouts and committed-Stage Git evidence, but **never the shared directory, timestamp planning folders, or other user files**. Neither ordinary uninstall nor `--dry-run` relocates state. After uninstall, add your own ignore rules if retained files should stay ignored. It does not delete Orca Run/Task history, merge, or publish your branches.

### OpenCode interface selection

The Run settings and OpenCode node panel offer Auto, Mini TUI and Full TUI. Node overrides win over the workspace default; inherit removes the override. Auto preserves the existing routing described below, including `ORCA_DAG_OPENCODE_TUI=1`. Explicit selections do not need that flag. Choices are frozen for the Run, including Retry; Recovery refreshes saved choices before starting a new Run loop.

Explicit interfaces currently require local Linux current/existing workspaces, no lane or generic terminal reuse, running Orca ≥ 1.4.222 and OpenCode ≥ 2.1.2 in the worker workspace. Unsupported placements or unknown versions are refused before worker preparation, with no alternate launch. The official workspace default-model resolver selects the configured default, which is then verified on the exact new session; explicit variants remain strict. Mini uses `opencode mini --session` without `--auto`, respects current permissions and can wait for confirmation.

Both interfaces retain exact API/session/terminal identity in `sessions.json`. Viewer frontend records are not Orca effective-launch evidence. Accepted Task settlement and confirmed provider exit are required before caller-owned terminal cleanup. Later user input or unproven message provenance retains the pane; a follow-up nudge is not exempt merely because its text looks familiar. Stop first interrupts the exact provider execution, then performs the existing external `worker-abandon` accounting. New journal fields are backward-readable by this version, but older binaries can reject them: settle new preparations and back up history before downgrading; changing future starts to Auto is the normal feature rollback.

## Known limitations

In Auto mode, the viewer's `opencode` choice runs OpenCode 2. On a running Orca 1.4.220+, a Task without a per-node model override uses native `worker-start --agent opencode2`. With OpenCode 2.0.22, that path delivered a read-only Task and autonomously wrote and verified one file in an isolated worktree; Orca accepted `worker_done`, reported `agent_status`, and released the terminal. Explicit models follow the newer gated route below or retain one-shot compatibility. A failed native start never launches a second worker. `worker-read --source auto` currently falls back to terminal output for OpenCode 2, so this path does not provide an exact provider transcript.

Add new runtime findings here with the affected launch path, observable symptom, and tested recovery. Keep Orca fleet liveness separate from whether the Codex TUI is visible or a Task has completed.

### Orca 1.4.241 native model and coordinator boundaries

Auto can use native `opencode` with a selected model when the running app is stable **1.4.241+**, advertises `orchestration.worker-launch-preferences.v1`, and the placement is local POSIX current/existing, non-lane, without model variant or effort. This does not establish model support for `opencode2`. Explicit Mini/Full TUI and `ORCA_DAG_OPENCODE_TUI=1` keep their own adapters. Unsupported requests retain their prior compatibility boundary; a refused native launch never causes a second start.

The execution host validates CLI/model availability. The tagged [model version policy](https://github.com/stablyai/orca/blob/v1.4.241/src/main/opencode/opencode-model-version-policy.ts) expands supported versions, while [1.4.241](https://github.com/stablyai/orca/releases/tag/v1.4.241) excludes releases that drop the first prompt. Do not replace that host proof with a local `opencode --version` check. No OpenCode worker enters generic terminal reuse: a recovered pane's current default model or frontend cannot safely be inferred from the viewer request.

On 2026-10-26, an isolated Linux Orca **1.4.241** runtime with OpenCode **2.1.2**, native `opencode` and `deepseek/deepseek-flash` completed file write/readback, accepted `worker_done`, echoed the effective model and released the terminal. A viewer restart recovered the original Dispatch, completed a dependent Task and reached completion with two Dispatches and no cleanup debt. This does not verify remote/Windows execution, new-worktree model selection, active Stop or an exact provider transcript.

The same runtime verified that ACK can return the next FIFO Delivery; the coordinator preserves and processes it before completion. Ordinary/stale reports are acknowledged, unanswered questions and owed terminal decisions hold ACK, and externally released reclaimable debt is rechecked against fresh fleet state. Overlapping presentation GETs share only in-flight identical reads; mutation evidence is not cached.

Helpers keep their active creator's custody, proven with exact `worker-show` Dispatch lineage. A Task parent is a discovery hint, not permission to stop or release. Missing lineage holds; positive creator settlement hands the helper back. Regression coverage includes retained active helpers, blocked handback and Stop/restart read races. Live helper startup was refused by this profile's nested-worker depth limit of **1**; the limit was not changed or bypassed. Max parallel limits viewer admission against visible active fleet, not every helper a runtime may admit independently.


### Orca 1.4.222 compatibility

[Orca 1.4.222](https://github.com/stablyai/orca/releases/tag/v1.4.222) waits until OpenCode can submit a worker's task, rather than only until its input box appears. This applies to both native `opencode` and `opencode2` starts; the viewer already uses the latter for nodes without a model override. Leave readiness and submission to Orca instead of adding Enter retries. A remote worker needs the updated execution host for that wait; updating the Run's home alone does not establish it.

The release's native model override is a separate contract. In the tagged source, [`opencode` model preflight](https://github.com/stablyai/orca/blob/v1.4.222/src/main/opencode/opencode-model-startup-plan.ts) accepts only verified OpenCode 2.0.16 or the exact [legacy versions 1.18.30 and 1.18.32](https://github.com/stablyai/orca/blob/v1.4.222/src/main/opencode/opencode-model-version-policy.ts), with model availability checked on the execution host. It does not add a model-launch catalog for `opencode2`. A generic `orchestration.worker-launch-preferences.v1` capability is therefore insufficient to enable models on the viewer's native branch. OpenCode model overrides also require a current/existing workspace, cannot create a new worktree, and support neither effort nor same-terminal reuse. On 1.4.222, the viewer keeps selected models on its existing one-shot path with its existing placement limits.

The coordinator regression suite covers both 1.4.220 and 1.4.222: native completion and release, no second worker after a native rejection, and model-pinned compatibility even with launch preferences advertised. A newer CLI with an old, prerelease, or unknown running app keeps compatibility. These fake-CLI tests establish routing and lifecycle accounting, not real prompt submission; a runtime acceptance check must observe Task execution, accepted `worker_done`, and terminal release.

If Orca refuses a start with `Agent launcher opencode2 is disabled or unavailable`, check **Settings → Agents → OpenCode 2** on the execution host. Installing a PATH executable does not enable the Orca launcher. After enabling it, Stop and Run again or explicitly retry the failed Task. The viewer preserves the original refusal and request ID, adds this recovery hint, and parks the Task without launching a replacement worker. A subsequent “nothing was created” cleanup verdict no longer erases the launch diagnosis.

On 2026-10-08, the first real read-only check on Orca 1.4.222 was refused before Dispatch creation because the active profile disabled `opencode2`; both PATH commands already reported OpenCode 2.0.15. After the user enabled OpenCode 2, the same viewer coordinator path passed: Run `run_293bfeda1764`, Task `task_eeae01b16f77`, Dispatch `ctx_ff7d6ff78bf4`. The worker read README.md and sent `ORCA-14222-E2E-OK`; Orca recorded accepted message `msg_eeb2e81dec48`, Task `completed`, and worker `succeeded`. The coordinator settled via `worker_done`, reached `completed`, and released the worker terminal. Scoped `worker-show` confirmed terminal resource `released`, with no next action. All test coordinator terminals closed, no extra terminals remained, and existing terminals were preserved. This verifies the local current-worktree, no-model-override read-only path; worker output remains a clipped terminal archive rather than an exact provider transcript.

### Codex native startup and compatibility

On Orca 1.4.209 and Codex 0.156.1, a Codex TUI started without an explicit `--enable hooks` could execute the injected Task and send `worker_done` while `worker-list` still reported `unverifiable / missing_status`. In a same-Run GPT-6 Luna comparison, a fresh TUI started with `codex --enable hooks ...` reported `live` from `agent_status`, although `codex features list` already reported `hooks` enabled on this machine. A reused Codex app-server without Orca pane variables is a likely contributor, but the hook subprocess environment was not captured directly.

Orca 1.4.217 fixes Codex readiness and isolates each new terminal's background server by default. A local read-only test with Codex 0.159.2 confirmed native `worker-start --agent codex`, observed turn start, `live / agent_status`, an exact transcript, and accepted `worker_done`. The viewer therefore uses native startup for current/existing POSIX workspaces when `status.runtime.appVersion` is at least 1.4.217, forwarding model and effort directly. The running app version selects the path; a newer CLI alone does not establish support. Existing terminals need reopening to receive Orca's isolation change. See the [1.4.217 release notes](https://github.com/stablyai/orca/releases/tag/v1.4.217).

Older or unknown runtimes keep prestart-and-bind compatibility with explicit `--enable hooks`. Newly created local POSIX worktrees also keep this path so creation and any committed-Stage base-SHA verification finish before the worker starts; native combined creation has not been accepted here. Compatibility readiness checks two stable empty-composer screen frames and refuses `model: loading`, but does not require a `model:` footer: Codex 0.159.2 displays `GPT-…` instead. Remote and Windows Codex retain native startup. A native failure is recorded without automatically launching a second compatibility worker.

For a manual session on an older runtime, start a fresh Codex process in an Orca-managed terminal with `codex --enable hooks` (or `codex --enable hooks resume`). Check `worker-list` for `liveness.source: agent_status` during an active Dispatch. Do not infer process exit or retry permission from `missing_status` alone. `worker-release` may retain a terminal attributed to `user_takeover`; that ownership verdict is separate from whether progress and completion were supervised successfully.

### OpenCode's tracking Dispatch has no fleet liveness

For the opt-in full-TUI adapter below, Stop confirms API execution exit and uses `worker-abandon` for Orca-only cancellation accounting, instead of native `worker-stop` (external processes are outside its ownership). It re-reads settlement. If fencing causes `retained / identity_unproven`, the pane stays retained for inspection; the viewer does not force-close it or label it as native process termination.

**Experimental alternative:** `ORCA_DAG_OPENCODE_TUI=1` sends explicit OpenCode models through an API-preselected full TUI on running Orca ≥ 1.4.222. Only local POSIX current/existing non-lane placements are supported, with no fallback on refusal or ambiguity. Its Dispatch is supervised, but the precreated process remains external to Orca ownership. Preparation/session/terminal identity is durable in `.orca-dag/sessions.json`; API assistant turns prove execution, not Task settlement. Orca model/effort echoes may remain null.

The Output view labels bounded assistant text as `opencode-api`, still readable after terminal close; it excludes tool inputs and reasoning. Default cleanup requires accepted settlement, confirmed external release, exact pane identity and provider execution exit. Retain or subsequent user prompts preserve the pane. Stop interrupts the exact shared-service session before Orca accounting; service failure, changed identity or unknown exit never counts as success. Unresolved preparations block replacement even after disabling the flag: inspect the saved request/session/terminal and request audit, not another launch. Automatic reuse, newly created workspaces, lanes, remote and Windows remain disabled in this increment. With the flag unset, Auto selects its version-gated native or compatibility route.

On the one-shot compatibility path, the viewer launches OpenCode with `opencode run --auto` and creates an Orca Dispatch for tracking. This path is `unsupervised`: it has no supervised worker resource or `agent_status` fleet evidence. In a parallel read-only comparison on Orca 1.4.209, OpenCode completed its Task with `worker_done`, while `worker-list` showed `unverifiable / missing_status` during execution and `unverifiable / unsupervised_settled` after completion. `worker-show` independently observed the exact OpenCode terminal as live while it ran. These fleet values are expected for the compatibility path; they do not by themselves establish a broken OpenCode hook. Use the Task/Dispatch outcome and exact terminal observation for this path, and do not treat `unverifiable` as proof of exit.

A direct read-only `worker-start --agent opencode` test on Orca 1.4.209 with OpenCode 2.0.15 still failed to deliver the Task: the receipt said `input_accepted`, but the OpenCode TUI stayed at its empty initial composer, with no agent turn or `worker_done`. The test Dispatch was abandoned, its exact terminal closed, and its Task marked failed. This is why the viewer keeps the one-shot compatibility path; `input_accepted` alone does not validate prompt delivery.

Prestarting `opencode mini` in a ready Orca terminal and binding it with `worker-start --terminal <handle>` **did** deliver a read-only Task and complete it through `worker_done` on those versions. The resulting Dispatch was supervised, but `worker-list` still reported `unverifiable / missing_status`. `mini` is an interactive interface, whereas `opencode run` is the one-shot CLI mode; OpenCode 2.0.15's `mini --help` has no `--auto` option. Permission behavior for autonomous editing has not been verified, so this experiment does not yet replace the viewer's `opencode run --auto` path.
