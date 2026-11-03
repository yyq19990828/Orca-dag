# Tutorial: operate the orca-dag viewer

English | [简体中文](viewer-operations_zh.md) · [Documentation](../README.md)

This guide covers startup, launch settings, monitoring, recovery, and the viewer's API boundary. For a worked task graph, begin with [the orchestration tutorial](orchestration.md); for workspace rules, use [the isolation tutorial](worktree-isolation.md). Technical reference topics are organized into dedicated guides: [HTTP API reference](../reference/http-api.md), [viewer features](../reference/viewer-features.md), [compatibility matrix](../reference/compatibility.md), and [architecture reference](../reference/architecture.md).

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
| `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` | Off | Allow experimental custom harness commands (opt-in escape hatch; NOT a verified support claim). Such commands use the legacy local path and cannot use an isolated placement. Unverified bare IDs (`gemini`, `grok`, `cursor`, `droid`, `kimi`) are rejected with `unverified_harness` even with this flag enabled. |

CLI auto-resolution is `ORCA_CLI_COMMAND` → `orca-dev` when `ORCA_DEV_REPO_ROOT` is set → `orca-ide` on Linux outside an Orca terminal → `orca`. The resolved CLI is used for both reads and mutations. Starting with CLI 1.4.246, `orca orchestration` machine calls require `--full` alongside `--json` to return complete Run, Task, and launch receipt schemas rather than concise summaries; the viewer gates this by resolved CLI version before mutation, while CLI 1.4.245 and earlier reject `--full` on orchestration verbs. Live 1.4.246 acceptance verified that a single `POST /api/runs` creates and parses the complete Run without retries (`run_2a67b90e6a94`), resolving the 500 error that concise output previously caused when Run ownership was omitted. `GET /api/readiness` reports `cliVersion` separately from the selected runtime's `version` and `runtimeState`; a newer executable does not prove its target is running or updated. Execution requires CLI 1.4.205+ and a positively ready runtime with a stable appVersion of 1.4.205+; unknown, disconnected, or starting runtimes stay view-only. Orca 1.4.160–1.4.204 can still display a Run. The viewer and skill also ship as standalone release binaries and in the `npx orca-orchestration-launcher` package.

Startup also announces `.orca-dag/<timestamp>/{PRD.md,TECH_SPEC.md}` and whether its default `.gitignore` setup succeeded. The agent writes each new requirement or fresh replanning Run into its own UTC timestamp directory (milliseconds; collisions get a fresh timestamp or numeric suffix), rather than overwriting shared documents:

```text
.orca-dag/
  config.json
  activity.jsonl
  launches.jsonl
  requests.jsonl
  sessions.json
  20261008-143012-123/
    PRD.md
    TECH_SPEC.md
```

Continuing the same plan or adding Tasks to its Run keeps that directory; the agent records the Run id in both documents and reports the directory alongside the id. Documents are local and ignored, **not force-added to Git**. Task specs carry all required context so isolated workers do not depend on these files. Starting the viewer alone does not create a timestamp directory. Any additional file-based planning notes, task-spec drafts, or local DAG drafts also stay in that directory; they do not replace Orca's authoritative state. Legacy `.orca/` documents and their managed ignore block stay in place; all new planning output uses `.orca-dag/`.

### Skill installation and agent homes

The bundled skill is installed only for detected agent configuration roots. Claude Code, Cursor, Gemini CLI, Droid, Grok, Kiro, Qoder and CodeBuddy use native skill directories. Codex, OpenCode, Pi, OMP and Kimi share a canonical `~/.agents/skills` copy; their existing config directories can trigger installation even when `.agents` does not exist yet. An otherwise agent-free HOME is not populated. Agent skill installation and planning capability are independent of supervised worker execution verification.

`CLAUDE_CONFIG_DIR`, `GROK_HOME` and `KIRO_HOME` select existing absolute native-agent homes; relative paths, HOME itself and its ancestors are ignored. `CODEX_HOME` also participates in detection, while its skill destination stays canonical. Use the same overrides when uninstalling.

Unchanged content preserves its mtime. The installer never follows symlinked config ancestors, skill directories or skill files. Legacy single-file Codex/OpenCode or relocated-home installs migrate only when the destination is absent; non-simple folders, extra files and links stay untouched. Discovery and uninstall share the same resolver.

## Read the interface before pressing Run

| Surface | What it tells you | What you can do |
| --- | --- | --- |
| Run picker and health badge | Workspace-scoped Run history; `viewer-owned`, `external`, `unbound`, or `inconsistent` coordinator state, plus nullable `removedWork` summary and on-demand pagination without reset controls. | Pick or create a Run, page older Runs, inspect removed-work history, or look up an exact Run ID. |
| DAG, Stage card, and Task list | Task spec, dependency arrows, separate parent links, status, result, and actual worker workspace; accessible vertical task list default on mobile (≤760px). | Select a Stage (click or keyboard Enter/Space); choose its launch preferences before they lock; toggle between task list and graph on mobile. |
| Scheduler | Ready wave, capacity, and a reason for each waiting Stage. | Distinguish an unmet dependency, gate, full capacity, or unknown state. |
| Chat / Activity | Assignments, replies, durable sends, coordinator checks, and an event timeline. | Answer a question or send guidance to an Orca-verified active Dispatch. |
| Operational details | Workers, gates, workspace lanes, Recovery, capabilities, and Request audit. | Inspect evidence before retry, stop, abandon, integration, or removal. |

The DAG refreshes every two seconds. Moving a node changes only canvas position; layout can be layered horizontal/vertical or force-directed. One optional **Lead Stage** marks semantic main-agent ownership in the drawing; it does not grant Orca coordinator authority. UI language is English or Simplified Chinese and persists per browser.

The UI distinguishes loading, first-read failure, confirmed empty and stale data.
When task data has not been read, a failed initial request shows technical details
and a **Reload page** action instead of claiming an empty project; launch preview
and execution require task data. A failed refresh retains the same Run's last
successful tasks and counts. **Retry read** updates projections without replaying
mutations or reloading the page. Run list reads are single-flight, so the
10-second poll cannot continually discard a slower successful response.

Use Tab to focus a DAG node, then `Enter` or `Space` to open its inspector.
Focus moves to the title; `Escape` closes the inspector and returns to its trigger.
Nested selectors consume the first `Escape`, closing only their own dropdown.
Task definitions and relationships remain read-only in the viewer.

At narrow screen widths (≤760px), the viewer defaults to an accessible vertical **Task list** showing task labels, status dots, and blocked/readiness reasons, bypassing mobile canvas navigation. A toolbar switch allows toggling between the Task list and the DAG canvas. At ≤1024px, floating menus (Run options, View, and Execution settings) adapt into fixed, viewport-bound sheets with explicit **Close** buttons, and the View toolbar elevates its stacking context so its close button remains clickable. Note that execution planning and controls remain **desktop-first**; the mobile interface is intended for readable inspection and triage, not promised full execution parity.

## Launch settings and their design

Orca Tasks have no fields for harness, model, placement, or canvas layout. The viewer stores those choices in `.orca-dag/config.json` in the workspace; browser localStorage is only a migration source and write-through mirror. That file stores **intent**, not runtime IDs. The actual Dispatch, worktree, host, and terminal must come from Orca receipts and fresh reads.

| Setting | Default / allowed value | Effect and limit |
| --- | --- | --- |
| OpenCode interface | `auto` | Auto retains current routes; Mini TUI / Full TUI are explicit, with per-node override or inherit. |
| Default harness | `claude` | Used when a Stage has no override. Built-in choices are `claude`, `codex`, `opencode`, `omp`, and `antigravity`, within their version/placement limits. Unverified harnesses (`gemini`, `grok`, `cursor`, `droid`, `kimi`) are not exposed as built-in presets; saved selections attempting to launch fail upfront with an explicit `unverified_harness` refusal (no silent fallback or auto-migration). Historical records remain readable. |
| Stage harness | Inherits default | Selects the launch adapter (`claude`, `codex`, `opencode`, `omp`, `antigravity`). User-defined custom commands require `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` (experimental opt-in, legacy local path only, no isolated placement, and NOT a verified support claim; unverified bare IDs are rejected even with custom flag on). |
| Stage model | Agent default | OpenCode offers advisory dropdown suggestions from local workspace discovery alongside manual valid `provider/model[#variant]` input; Claude and Codex accept a model name. OMP/Antigravity accept the full opaque native selector as free text, with no provider/suffix remapping; empty omits `--model` for the configured default. Saved unlisted models are preserved; locked once execution begins. |
| Stage effort | Unset | `low`, `medium`, or `high` in the UI for Claude or Codex; requires a model on the same Stage and remote peer support when applicable. OMP/Antigravity reject every nonempty effort, with or without a model; saved values remain visible and must be explicitly cleared. |
| Max parallel | `4`, integer `1`–`16` | Caps simultaneous worker starts; DAG dependencies and lanes may reduce actual parallelism. |
| Stage environment / placement | Local / Current | A saved remote environment needs an exact existing workspace or named new top-level worktree. See [placement parameters](worktree-isolation.md#creation-fields-and-limits). |
| Workspace lane | None | Reuses one non-Current local workspace for a dependency-ordered Task chain. |
| Retain for debugging | Off | Keeps a settled worker terminal instead of the default release. |
| Layout / Lead Stage | Saved layout / none | Viewer presentation only; neither changes Task readiness nor coordinator binding. |

The Run button snapshots these settings. While the coordinator is active, even an unstarted Stage is locked to that snapshot. Once a Stage has its first Dispatch, launch settings stay locked across viewer restarts; a safe retry uses the original harness, model, effort, and placement. A failed worker-history read also keeps editing locked rather than assuming no attempt exists.

**OMP / Antigravity follow Orca settings.** Local Linux only (remote environments, macOS, and Windows are unsupported). Current or exact Existing placement requires running Orca and resolved CLI ≥ **1.4.245**; creating new Git worktrees (`new-child`, `new-top-level`) or running workspace lanes requires both ≥ **1.4.246**. New child worktrees require a positively identified local managed Git parent; new top-level worktrees require an exact `id:` or absolute `path:` Git repository (ambiguous names, bare folders, and foreign-host repositories are refused, and no automatic git-init is performed).

A workspace lane shares the isolated working directory across a dependency-ordered chain of Tasks, not agent sessions or terminals. The first Task creates or adopts the worktree using its seed placement; subsequent dependency-ordered Tasks reuse that exact existing workspace selector. Each Task receives a fresh native agent process and its own Dispatch. The viewer never reuses generic terminals, never passes `--terminal` (which moves custody outside Orca), never overrides surface with `--surface`, and never attempts an unverified fallback on refusal. The viewer calls native `worker-start --agent omp` / `--agent antigravity` and strictly follows the user's Chat/Terminal setting in Orca. Model overrides are passed as opaque native selectors (empty omits `--model` for the configured default); all nonempty effort values are rejected with or without a model. OMP Native Chat has separate verification and [fleet status limitations](#known-limitations); Antigravity Native Chat remains unverified, not blocked by preference. OpenCode's interface selector applies only to OpenCode. Native refusal or an unknown result never starts a fallback worker; native requested/effective, liveness, custody and unknown receipts remain authoritative.

**Preview launch** is read-only and remains available when launch editing is locked. It presents a structured preflight summary of current configuration intent, not an existing Dispatch receipt:
- Requested defaults (harness and max parallel) appear once; the default OpenCode interface appears only when applicable.
- Common limitations shared across all tasks are deduplicated and summarized once at the top, avoiding repetitive noise.
- The task list displays full task names alongside exact task IDs (`task.taskId`), with an accessible **Copy ID** button that provides visual feedback or fallback instructions if clipboard permissions are denied.
- Each task details its resolved harness, model, placement, and route reason, clearly separating resolved values from requested overrides (such as model, effort, or retention). Tasks with unsupported routes, unknown route/limitation codes, or task-specific constraints are flagged for review and automatically expanded (`open={needsReview || undefined}`).
- For workspace lanes, preview validates the lane's seed placement upfront, failing before mutation if runtime or CLI versions are insufficient or if the parent/repo is invalid.
- OpenCode Auto with a model variant such as `#xhigh` can select **CLI run compatibility**, not a native TUI. Selecting Mini / Full TUI requests the existing strict API adapter; preview never bypasses its execution-host version, permissions or startup-identity checks.

**Safe confirmation and execution boundaries.** **Run with Orca** flushes pending
configuration, refreshes it and previews the same plan before authority transfer.
Tab / Shift+Tab stays within visible dialog controls, including disclosure summaries.
**Not now**, `Escape` or backdrop dismissal never issues `POST /api/run` or binds the viewer;
preferences already saved while preparing the plan remain saved.
**Preview does not verify execution**: it cannot establish execution-host model
availability, agent readiness or actual worker startup. Placement does not provision
external test runtimes.

**Prepare external resources before dispatch.** Worker placement does not create an arbitrary isolated test runtime, account or service. Prepare those resources first, or add a preparation Task dependency that supplies the owner, exact paths/selectors, runtime identity, access method, allowed changes and cleanup responsibility. A gate approval is not resource provisioning. Once a Dispatch exists, disabled placement controls cannot relocate that worker; safely hand it additional test resources or use explicit evidence-gated recovery.

A normal UI pass is: select the intended Run and check its health badge; open each Stage to choose its harness and placement; assign a lane only to a dependency-ordered chain; set Max parallel; review **Preview launch**, the Scheduler's ready wave and preflight warnings; then press **Run with Orca** and confirm the refreshed plan and coordinator handover. During execution, use Chat and Activity to understand progress, and Operational details for decisions that need exact worker or workspace evidence.

## What happens after Run

The viewer creates a workspace-scoped Orca terminal and binds it as the Run's coordinator. The previous coordinator is fenced; ordinary Run-scoped reads still work. On each pass it finds ready Tasks, honors dependencies, gates, lanes, and Max parallel, then asks Orca to start supervised workers. `worker_done` settles a Task; the viewer processes and acknowledges inbox deliveries and accounts for each settled terminal by reuse, explicit retention, or release. Cross-lane joins wait for a human `integrated` decision; the viewer does not merge Git branches.

One-off UI mutations such as Run creation and gate resolution use a separate temporary coordinator terminal. They do not borrow the running loop's terminal, which would fence it. A second viewer pointed at the **same** workspace reports `coordinator_conflict` rather than adopting or closing the first viewer's terminal; different workspaces get distinct coordinator identities.

### Messages, sessions, and audit evidence

Chat can send guidance to one Orca-verified live `dispatch:<id>`. The group composer offers `@all` or a freshly discovered worktree audience; it previews recipients and requires confirmation from this Run's live viewer coordinator. Lifecycle messages such as `worker_done` and `heartbeat` cannot be broadcast; Orca refuses them for group audiences and the viewer rejects them as `forbidden_group_type`. A successful send means Orca durably queued the message, not that an agent read or accepted it.

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

`POST /api/run` also accepts `effortByTask`, `environmentByTask`, `worktreeLanes`, `laneByTask`, and `retainByTask`. The maps are keyed by exact Task IDs. The UI builds them from saved settings, validates the whole plan before starting, and shows errors without creating a worker. `PUT /api/config` patches saved preferences; it does not grant Orca lifecycle authority. See the [HTTP API reference](../reference/http-api.md) for the other routes and request details.

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

All five state files live inside `.orca-dag/`: `config.json` stores preferences, `activity.jsonl` stores bounded explanatory activity, `requests.jsonl` stores mutation request IDs for audit, `sessions.json` stores exact provider session bindings, and `launches.jsonl` stores historical launch identities. None replaces Orca's authoritative Run/Task/Dispatch records. Files are created only as their stores are used; `--no-workspace-init` skips ignore-rule setup, not state persistence or migration. Stop older viewers before upgrading: after acquiring its HTTP port, the new viewer moves legacy root `.orca-dag.*` state files here byte-for-byte and reports each move. A conflict retains both files, uses the new one, and warns you to reconcile manually. Unwritable migration leaves legacy regular files readable; writes never fall back to the root. Symlinked data directories/files are never followed.

Run health also includes an optional `removedWork` summary ledger (`coverage: complete | partial`, recorded counts, and nullable `lastRemovedAt`). Older runtimes or unprovided data return `null` (unavailable) rather than zero counts. Historical `activeWorkersAtRemoval` records workers that were possibly active when removed, not a live process probe. Detailed entries page on demand via `GET /api/runs/:runId/removed-work?cursor=` with opaque cursors (up to 200 entries per page). Unknown kinds are marked `unreadable` rather than dropped. Viewing removed history never resets orchestration state; the viewer deliberately provides no reset button.

`orca-dag uninstall` removes the skill from every agent directory it was installed into (symlinks you created yourself are unlinked, never followed). It closes any `orca-dag coordinator` terminal a crashed viewer left bound to a Run, reporting the workspace (directory + hash) each terminal was coordinating before closing it (clearing stale coordinator fencing). It removes only its exact managed `.orca-dag/` and legacy `.orca/` ignore blocks in the selected workspace; user-authored ignore rules are retained. `--purge` removes known viewer-owned state files in both layouts and committed-Stage Git evidence, but **never the shared directory, timestamp planning folders, or other user files**. Neither ordinary uninstall nor `--dry-run` relocates state. Planning documents are always kept, even with `--purge`; add your own ignore rules if retained files should stay ignored. The executable itself is retained because a running process cannot delete its own binary; uninstall prints the appropriate follow-up command.

### OpenCode interface selection

The Run settings and OpenCode node panel offer Auto, Mini TUI and Full TUI. Node overrides win over the workspace default; inherit removes the override. Auto preserves the existing routing described below, including `ORCA_DAG_OPENCODE_TUI=1`. Explicit selections do not need that flag. Choices are frozen for the Run, including Retry; Recovery refreshes saved choices before starting a new Run loop.

Explicit interfaces currently require local Linux current/existing workspaces, no lane or generic terminal reuse, running Orca ≥ 1.4.222 and OpenCode ≥ 2.1.2 in the worker workspace. Unsupported placements or unknown versions are refused before worker preparation, with no alternate launch. The official workspace default-model resolver selects the configured default, which is then verified on the exact new session; explicit variants remain strict. Mini uses `opencode mini --session` without `--auto`, respects current permissions and can wait for confirmation.

Both interfaces retain exact API/session/terminal identity in `sessions.json`. Viewer frontend records are not Orca effective-launch evidence. Accepted Task settlement and confirmed provider exit are required before caller-owned terminal cleanup. Later user input or unproven message provenance retains the pane; a follow-up nudge is not exempt merely because its text looks familiar. Stop first interrupts the exact provider execution, then performs the existing external `worker-abandon` accounting. New journal fields are backward-readable by this version, but older binaries can reject them: settle new preparations and back up history before downgrading; changing future starts to Auto is the normal feature rollback.

On **2026-11-02**, **Orca 1.4.245 + OpenCode 2.2.0** passed the exact startup gate with the workspace interface set to **Mini** and model **`openai/gpt-6.1-sol#xhigh`**. The current-workspace check created one file exclusively, independently recomputed `2+3+5+7=17`, received accepted `worker_done`, and closed the caller-owned pane with no cleanup debt (`run_0e5b949ffb1b`). A cold viewer also inherited saved Mini when the Run request omitted both frontend fields, completed a second exclusive file with sum `24`, and closed its pane (`run_dee4d21b8c0c`). An existing-workspace check recovered the same Dispatch/session after a deliberately crashed viewer, then stopped the exact active execution and its foreground tool child before it could write its completion file (`run_e86a2745afe1`). Orca cancellation was `worker-abandon`; the post-fence pane remained retained for inspection because release returned `identity_unproven`. These are Mini results, not Full-TUI or multiaccount certification, and they do not explain or erase the historical 1.4.243 startup refusal below. No Orca desktop or native Chat was opened for these checks.

### OMP / Antigravity native evidence and output limits

The **2026-11-02** independent native baselines used **Orca runtime/CLI 1.4.245, OMP 18.15.0, and Antigravity 1.4.12** with existing Terminal TUI preferences. Current/exact Existing placements, configured default/explicit models, file write/readback, independent recomputation, accepted `worker_done`, normal native release and owned active Stop were observed. OMP provides bounded transcript/tool output and normal-release transcript archives. Antigravity explicitly provides terminal fallback (`provider_unsupported`) and normal-release terminal archives, not structured provider transcript or verified provider-session identity. Both post-active-Stop archives were unavailable. Antigravity's earlier 1.4.10 version evidence drifted to actual 1.4.12 execution; the cause and 1.4.10 execution remain unverified.

The earlier forced-Terminal prelaunch-bind certification in Run `run_8713a6b6ebfe` failed custody, Stop and archive gates; those outcomes remain rejected **design** evidence, not native agent unavailability. See the [compatibility matrix](../reference/compatibility.md#path-boundaries-and-historical-findings) for the historical boundary and current policy.

Separate viewer checks on **2026-11-02** are recorded under `.orca-dag/20261102T084604Z/`:

- `run_f94b248416ff`: Current default-model OMP and exact Existing explicit-model Antigravity each wrote/read an artifact, passed independent recomputation (sums **38** and **60**) and reached accepted `worker_done`. Antigravity released with a terminal archive; OMP's native `user_takeover` verdict retained its pane rather than forcing closure.
- `run_19ca9da2a106`: Existing explicit-model OMP and Current default-model Antigravity ran real foreground Node children. After crashing only the viewer, restart adopted both original Dispatches and terminals without replacement. Native Stop reported owned `closed_agent_terminal`; both child PIDs exited before their completion files were written. Authorized release succeeded, with post-Stop archives explicitly `unavailable`.
- `run_1c6712c54ee8`: Real English/Chinese web controls exposed both presets and full model selectors. A saved orphan effort was rejected before launch, survived model reset, and disappeared only through **Clear unsupported effort**. Clicking Run and confirming its preview launched both native agents; independent sums were **10** and **31**, both reports were accepted, and both terminals released. The web history read OMP transcript and Antigravity terminal archives after closure, keeping clipping/source warnings visible.

Native launch receipts positively recorded `mode: terminal`, `preferred: terminal`, `reason: user_default`; the viewer did not force the surface or change Orca preferences. These checks establish viewer TUI execution and viewer restart recovery, not Native Chat, Orca-runtime restart, or untested placements.

On **2026-11-03**, end-to-end verification of native Git worktrees and workspace lanes was completed on **Orca runtime/CLI 1.4.246** (evidence recorded under `.orca-dag/20261103T024111Z/`):

- `run_67072641a11a`: Ran 4 workspace lanes across 4 separate exact paths, with 2 dependency-ordered Tasks per lane (8 Tasks total). All 8 Tasks succeeded, reaching phase `completed` with zero cleanup debt.
  - OMP child lane (`native_omp_new_child`, `new-child`): computed sum **20** (values `[2, 7, 11]`, count 3).
  - OMP top-level lane (`native_omp_new_top_level`, `new-top-level`): computed sum **21** (values `[3, 5, 13]`, count 3).
  - Antigravity child lane (`native_antigravity_new_child`, `new-child`): computed sum **59** (values `[17, 19, 23]`, count 3).
  - Antigravity top-level lane (`native_antigravity_new_top_level`, `new-top-level`): computed sum **97** (values `[29, 31, 37]`, count 3).
  - **Serial workspace handoff and fresh sessions:** In each lane, Task 1 created or adopted the isolated Git worktree; Task 2 reused that exact selector. Every Task was granted its own distinct native handle (8 fresh handles: `structworker_*` for OMP, agent terminal handles for Antigravity) and unique Dispatch ID (`ctx_*`). No generic terminal reuse occurred.
  - **Artifacts and lineage:** Independent file readback verified nonces, values arrays, sums, counts, and cwds against exact parent lineage and base Git SHAs.
  - **Launch modes:** OMP native receipts recorded `mode: structured`, `preferred: structured`, `reason: user_default` (Chat); Antigravity receipts recorded `mode: terminal`, `preferred: terminal`, `reason: user_default` (Terminal). All 8 workers completed with accepted `worker_done` and clean native release.
  - **Scope and negative boundaries:** This run exercised `setup: skip` and configured-default models only. It certifies OMP Chat and Antigravity Terminal creation, serial workspace handoff, and normal release on local Linux. It does **not** certify new-placement active Stop or restart, Antigravity Chat (which remains unverified), Orca-runtime restart, setup `run`/`inherit`, or explicit models on new placements. Agent executable versions were not recaptured for this run; the versions in the 1.4.245 baselines above remain historical evidence.

## Known limitations

In Auto mode, the viewer's `opencode` choice runs OpenCode 2. On a running Orca 1.4.220+, a Task without a per-node model override uses native `worker-start --agent opencode2`. With OpenCode 2.0.22, that path delivered a read-only Task and autonomously wrote and verified one file in an isolated worktree; Orca accepted `worker_done`, reported `agent_status`, and released the terminal. Explicit models follow the newer gated route below or retain one-shot compatibility. A failed native start never launches a second worker. `worker-read --source auto` currently falls back to terminal output for OpenCode 2, so this path does not provide an exact provider transcript.

Add new runtime findings here with the affected launch path, observable symptom, and tested recovery. Keep Orca fleet liveness separate from whether the Codex TUI is visible or a Task has completed.

### Native Chat fleet status

**Observed on Orca runtime/CLI 1.4.245 with OMP 18.15.0:** a native Chat worker was actively executing a tool, `worktree ps` reported `working`, and `worker-show` confirmed the exact worker was `live` and addressable. Yet fleet reported `unverifiable / missing_status`, provider `null`, activity `unknown`, and no observation timestamp. This upstream identity-binding gap can make a running worker look unobservable in the viewer; it is not proof of a failed launch, a dead worker, or an uninstalled OMP hook.

The fleet evidence path resolves status through terminal/PTY identity, which a `structworker_*` Chat worker lacks. Its separate Chat liveness fallback accepts `orca_session_id:` addresses, not those structured-worker handles. Upstream [PR #34068 — Let fleet status and transcript reads follow structured workers](https://github.com/stablyai/orca/pull/34068) tracks this exact problem and remained **open/unmerged as checked on 2026-11-03**. Inspection and in-memory function replay of the [v1.4.246 release](https://github.com/stablyai/orca/releases/tag/v1.4.246) still reproduced the gap; that investigation was limited to inspecting the fleet status logic, distinct from the real 1.4.246 runtime E2E tests for worktree placement and lanes. Upgrading to that release alone does not fix the fleet status gap.

**Verified behavior is narrower than complete fleet observability.** OMP Native Chat completed independently checked work with accepted `worker_done` and bounded transcript reads (`run_1add447bb085`). A separate active execution recovered the same Dispatch/session after a viewer crash, then native Stop ended its foreground tool child before its completion file was written; release succeeded, with the post-Stop archive unavailable (`run_553bb0bda95c`). The intentionally cancelled Task was explicitly settled as failed/cancelled, not a startup failure. Evidence is recorded under `.orca-dag/20261102T095434Z/` and `.orca-dag/20261102T100646Z/`. These checks do not certify Antigravity Native Chat, Orca-runtime restart, other agents or untested placements.

**Safe handling:** preserve the raw fleet verdict and distinguish exact worker/session observations from activity and accepted Task settlement. Missing fleet status alone never authorizes automatic retry, replacement, cancellation or cleanup, and `live` alone never proves Task success. The viewer continues to respect Orca's Chat/Terminal preference; it neither forces Terminal nor rewrites unknown status as live. Reverify against a release containing the upstream fix before claiming complete Native Chat fleet visibility.

### Orca 1.4.243 discovery, heartbeat, and removed-work boundaries

Model discovery via `GET /api/models/:harness` executes in the resolved local viewer workspace (`scope: "local-workspace"`), not the selected execution host or remote environment. It distinguishes between an empty catalog (`status: "available", models: []`) and an unavailable or failed query (`status: "unavailable"`, returning a sanitized English diagnostic without leaking stderr). In the Node panel, the model selector offers advisory dropdown suggestions alongside free-text input for valid `provider/model[#variant]`. Unfinished drafts are not persisted to the config store. Unlisted saved models are preserved in the picker without being erased. Once execution starts, model editing locks along with other launch settings.

Local discovery failure does not alter native routing gates. On 2026-10-29, in an isolated Linux runtime with Orca 1.4.243 and OpenCode 2.2.0, a PATH wrapper forced `opencode models` to exit 23, yet a single native worker with explicit `deepseek/deepseek-flash` started, executed file write/readback of `{"verified":243,"frontend":"native"}`, received accepted `worker_done`, exact 1 Dispatch, terminal release, and no cleanup debt. This proves native execution succeeds even when viewer discovery fails; it does not prove execution-host discovery failed. Upstream PR 32006 (nativeChat models) and new-top-level worktree fixes must not be treated as worker model support expansion for `opencode2`, new worktrees, variant/effort, or remote/Windows placements.

Heartbeat messages (`type: "heartbeat"`) are strictly **liveness evidence only**, never completion or settlement. The coordinator records `lastHeartbeatAt` on the attempt but never settles a Task or Dispatch. The Activity timeline coalesces adjacent heartbeats in the same phase (`label is working · <phase>`) without hiding outcomes or subsequent events. Orca rejects lifecycle signals (`worker_done`, `heartbeat`) in group sends (`@all`, `@worktree:<id>`), and the viewer enforces this with HTTP 400 `forbidden_group_type`. In isolated test profiles, pre-dispatch preamble preview verified intervals of 5 minutes, off, and 15 minutes. When set to off, no heartbeat command is emitted into the preamble. This was verified in preamble preview only; live heartbeat worker execution or hot-reloading worker settings was not tested, and user global settings are not modified.

Orca optionally provides a `removedWork` summary in `run-show`, surfaced via `GET /api/run-health`. Older runtimes or unprovided data return `null` (unavailable) rather than zero counts. Historical `activeWorkersAtRemoval` is historical evidence at the moment of removal, not a live process check. Detailed removal history is paged on demand via `GET /api/runs/:runId/removed-work?cursor=` with opaque cursors (up to 200 entries per page). Unknown kinds are marked `unreadable: true` rather than dropped. The viewer deliberately provides NO reset button (`orchestration reset --tasks` has no `--run` scope and would wipe the entire local orchestration database). Removed work inspection never resets any state.

On Orca 1.4.243 with OpenCode 2.2.0, explicit Mini and Full TUI both failed the startup identity ready gate: the API-prepared sessions had the requested model, but the exact `OC | odag:<request>` title was not observed within 60 seconds. A separate, input-free Mini diagnostic pane displayed `▪ oc mini v2.2.0 ...` / `Build · Default model` while retaining its creation title. No Task input or Dispatch was created. The viewer recorded `settledVia=start_failed` and parked the attempt; the Run loop entered `awaiting_input`, not a new Orca Task status. Both preparations ultimately closed safely, and `POST /api/run-stop` returned `clean: true` with no cleanup debt. This is a verified refusal, not successful Mini/Full execution certification. The root cause is unproven; the identity gate was not weakened.

There were no Orca-managed OpenCode accounts available, so real multiaccount execution is not certified. Separate regression fixtures simulate API session invisibility after pane creation: both frontends preserve the exact `prepared` record, original provider session and pane, without Task input, pane closure or replacement. These fixtures do not establish real-account compatibility.

### Orca 1.4.242 output, startup and authority boundaries

Native transcript pages contain `transcript.messages`, with roles and typed blocks. The viewer renders text, tool calls/results and image references with labels; unknown blocks remain explicit markers rather than disappearing or becoming `[object Object]`. Each displayed message is bounded to 16,000 characters and each page to 10,000 lines; runtime `limited` and viewer clipping keep the page marked partial. The terminal and OpenCode API adapters remain separate.

A cursor continues **forward** after the current bounded tail, including at current EOF; it does not recover omitted older history. `contentComplete` describes this page/read window, not Task settlement or the entire historical conversation. Source replacement still restarts one read and labels the discontinuity. [Orca 1.4.242](https://github.com/stablyai/orca/releases/tag/v1.4.242) fixes full-page forward scanning upstream; the viewer does not add output retries or automatic history draining.

Worker-start receipts normalize official `state` ahead of legacy status fields and preserve nullable `workerOutcome` separately. `ready / settled / workerOutcome: failed` is a successful start with failed work, not a failed launch. An explicit `outcome_unknown` or `start_unknown` holds the exact Dispatch, request and concurrency slot until positive settlement; it never authorizes release, replay or replacement. A recorded replay passes the same readiness gate. Accepted Task/Dispatch evidence retires the pending request marker while the original receipt remains inspectable.

Regression coverage models both accepted outcomes before a late startup error, then checks terminal ownership, no duplicate worker and dependent progress after success. It also covers explicit unknown followed by positive exact settlement. This uses the tagged [early-report contract](https://github.com/stablyai/orca/pull/26762), not a forced live-provider race.

An isolated Linux runtime with Orca 1.4.242 and Codex 0.164.0 verified file write/readback, a rendered native transcript, multiple forward cursor pages, accepted completion, terminal release and readable transcript after release. Remote/Windows and active Stop were not exercised by this check.

ACK-returned distinct batches run immediately through normal processing and reconciliation; empty/error/replayed-held batches retain the polling floor. Workers must not take the coordinator seat for their own or ancestor Run or use `--takeover-legacy`. They read/report using the live preamble; only an eligible coordinator resumes Run authority. The runtime-matched guide remains authoritative.

### Orca 1.4.241 native model and coordinator boundaries

Auto can use native `opencode` with a selected model when the running app is stable **1.4.241+**, advertises `orchestration.worker-launch-preferences.v1`, and the placement is local POSIX current/existing, non-lane, without model variant or effort. This does not establish model support for `opencode2`. Explicit Mini/Full TUI and `ORCA_DAG_OPENCODE_TUI=1` keep their own adapters. Unsupported requests retain their prior compatibility boundary; a refused native launch never causes a second start.

The execution host validates CLI/model availability. The tagged [model version policy](https://github.com/stablyai/orca/blob/v1.4.241/src/main/opencode/opencode-model-version-policy.ts) expands supported versions, while [1.4.241](https://github.com/stablyai/orca/releases/tag/v1.4.241) excludes releases that drop the first prompt. Do not replace that host proof with a local `opencode --version` check. No OpenCode worker enters generic terminal reuse: a recovered pane's current default model or frontend cannot safely be inferred from the viewer request.

On 2026-10-26, an isolated Linux Orca **1.4.241** runtime with OpenCode **2.1.2**, native `opencode` and `deepseek/deepseek-flash` completed file write/readback, accepted `worker_done`, echoed the effective model and released the terminal. A viewer restart recovered the original Dispatch, completed a dependent Task and reached completion with two Dispatches and no cleanup debt. This does not verify remote/Windows execution, new-worktree model selection, active Stop or an exact provider transcript.

The same runtime verified that ACK can return the next FIFO Delivery; the coordinator preserves and processes it before completion. Ordinary/stale reports are acknowledged, unanswered questions and owed terminal decisions hold ACK, and externally released reclaimable debt is rechecked against fresh fleet state. Overlapping presentation GETs share only in-flight identical reads; mutation evidence is not cached.

Helpers keep their active creator's custody, proven with exact `worker-show` Dispatch lineage. A Task parent is a discovery hint, not permission to stop or release. Missing lineage holds; positive creator settlement hands the helper back. Regression coverage includes retained active helpers, blocked handback and Stop/restart read races. Live helper startup was refused by this profile's nested-worker depth limit of **1**; the limit was not changed or bypassed. Max parallel limits viewer admission against visible active fleet, not every helper a runtime may admit independently.
### Orca 1.4.229 compatibility

[Orca 1.4.229](https://github.com/stablyai/orca/releases/tag/v1.4.229) broadens native-chat workers, but does not establish native model selection for the viewer's separate `opencode2` path. Existing OpenCode model adapters and Codex creation/base-verification ordering remain unchanged.

- **Native refusal is not a fallback signal.** Unsupported model/effort, invalid arguments, and disabled known-agent launchers park the original attempt with its receipt. They never start a second legacy worker. Opted-in custom commands choose the local legacy path before any native start.
- **Every consumed FIFO batch gets an ownership-aware acknowledgment**, including rejected or duplicate-only reports. A batch returned by the acknowledgment is processed before the Run can finish. Unanswered questions and unresolved terminal custody still hold the batch open.
- **Pending gates prevent completion**, including Run-scoped gates without a blocked Task. Ordinary approval gates accept the exact resolved decisions `approve` and `approved`; all gates and same-Run dependencies must be satisfied before a Task is runnable. `integrated` remains an exact, separate integration decision. Orca can report `ready` after only one approval; remaining gates or unfinished, failed, blocked, or missing dependencies still exclude that Task from the ready wave and appear in its waiting reasons.
- **Orca can correct a provisional failed start.** If Orca accepts a later success for the exact Run/Task/Dispatch, the viewer updates the attempt outcome while preserving the start receipt and any release/retain decision already made. A stale/rejected report or a different Dispatch cannot clear the failure.

The local read-only smoke on Orca 1.4.229 confirmed runtime readiness and capability discovery; an unreachable selected environment remained view-only and rejected Run creation with `503 execution_disabled`. A built-UI browser smoke also confirmed that execution and **New Run** are disabled for that unavailable runtime while exact-ID input remains editable. Native rejection, FIFO delivery, gate progression, and late correction were exercised against an isolated CLI fixture running the real coordinator, not real paid agents. This is not an all-agent 1.4.229 end-to-end certification.

**Real-agent certification (2026-10-17).** Run `run_e78451d88bc7` completed two dependent Tasks with OpenCode 2.0.28 and `deepseek/deepseek-flash` through the default explicit-model one-shot adapter on Orca 1.4.229. Both OpenCode session exports recorded provider `deepseek`, model `deepseek-flash`, and a final `idle / succeeded` event; model use was not inferred from requested argv alone.

The built viewer handled the worker's blocking ask/reply and the second approval. One approved gate did not release the dependent Task while its other gate was pending. Pausing and recovering the same Run at that checkpoint did not relaunch the completed producer. Both Dispatches completed through accepted `worker_done`; independently recomputed JSON artifacts matched the input nonce, integer results, reply token, and SHA-256. The final Run had no pending Delivery, cleanup debt, reclaimable worker, or remaining experiment-owned terminal. Orca's tracking rows report `terminalState: retained`, while the viewer's physical-pane decision is `closed`; this is not a native `worker-release` receipt.

Workspace-local evidence is retained in `.orca-dag/e2e-20261017T162611Z-b1d3a6/certificate.json`. This certifies only the local POSIX current-workspace explicit-model one-shot path, not native `opencode2` model selection, the experimental API-preselected TUI, remote/Windows placements, or other agents. Unbound Run-level gates and the native-rejection, invalid/duplicate-only FIFO, and provisional-start-failure late-correction fault cases remain fixture-tested.


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

Full-TUI preparation uses a request-local `OPENCODE_TUI_CHANNEL` so shared tab restoration cannot select an older session. This isolates TUI persistence, not backend discovery, and does not rewrite global OpenCode configuration. Before binding, the viewer waits for the exact session-derived `OC | odag:<request>` title and then TUI idle; an idle startup shell is not readiness evidence. OpenCode V2 may return an omitted model variant as `default`: those two forms are equivalent, while provider, model ID and explicitly selected variants must still match exactly.

The Output view labels bounded assistant text, tool progress and tool results as `opencode-api`, still readable after terminal close; it filters sensitive tool-input keys, suppresses auth/settings/config tool results, and excludes reasoning. Mini/Full-TUI and CLI-run use the same renderer, including OpenCode 2.2 `state.content` results and errors. Forward cursors pin already-rendered content: a tool changing from running to completed before the cursor explicitly restarts the output rather than silently skipping its result. An older cursor format also restarts with `sourceChanged`. This API history is not an Orca transcript archive. Default cleanup requires accepted settlement, confirmed external release, exact pane identity and provider execution exit. Retain or subsequent user prompts preserve the pane. Stop interrupts the exact shared-service session before Orca accounting; service failure, changed identity or unknown exit never counts as success. Unresolved preparations block replacement even after disabling the flag: inspect the saved request/session/terminal and request audit, not another launch. Automatic reuse, newly created workspaces, lanes, remote and Windows remain disabled in this increment. With the flag unset, Auto selects its version-gated native or compatibility route.

At a complete output read, the panel replaces **Load more** with **Read output**, which starts a fresh bounded read of the selected source. Reaching the end of an output window is not Task settlement.

On the one-shot compatibility path, the viewer launches OpenCode with `opencode run --auto` and creates an Orca Dispatch for tracking. This path is `unsupervised`: it has no supervised worker resource or `agent_status` fleet evidence. In a parallel read-only comparison on Orca 1.4.209, OpenCode completed its Task with `worker_done`, while `worker-list` showed `unverifiable / missing_status` during execution and `unverifiable / unsupervised_settled` after completion. `worker-show` independently observed the exact OpenCode terminal as live while it ran. These fleet values are expected for the compatibility path; they do not by themselves establish a broken OpenCode hook. Use the Task/Dispatch outcome and exact terminal observation for this path, and do not treat `unverifiable` as proof of exit.

The Worker detail now separately shows the exact persisted local OpenCode session's provider status, observed model/variant, provenance and observation time. It validates the Run/Task/Dispatch binding, canonical workspace, session title and Task preamble; it never picks the newest session. Provider `active` can coexist with fleet `unverifiable`, and provider execution `exited` is not a successful Task outcome or permission to retry, Stop or release.

For that exact CLI-run binding, Output's Auto / Transcript modes read bounded `opencode-api` text and tool results, with sensitive tool-input keys filtered. Startup instructions, reasoning and later user-owned turns are excluded. Paging continues across appended output; changed already-read content resets the source explicitly. Partial history, clipping and unavailable reads remain visible rather than becoming a fabricated empty/completed transcript. Explicit Terminal mode remains a terminal read. Small history pages avoid an observed OpenCode 2.2.0 large-response failure where the CLI exits successfully with incomplete JSON; oversized or unreadable evidence still does not authorize a replacement worker.

A direct read-only `worker-start --agent opencode` test on Orca 1.4.209 with OpenCode 2.0.15 still failed to deliver the Task: the receipt said `input_accepted`, but the OpenCode TUI stayed at its empty initial composer, with no agent turn or `worker_done`. The test Dispatch was abandoned, its exact terminal closed, and its Task marked failed. This is why the viewer keeps the one-shot compatibility path; `input_accepted` alone does not validate prompt delivery.

Prestarting `opencode mini` in a ready Orca terminal and binding it with `worker-start --terminal <handle>` **did** deliver a read-only Task and complete it through `worker_done` on those versions. The resulting Dispatch was supervised, but `worker-list` still reported `unverifiable / missing_status`. `mini` is an interactive interface, whereas `opencode run` is the one-shot CLI mode; OpenCode 2.0.15's `mini --help` has no `--auto` option. Permission behavior for autonomous editing has not been verified, so this experiment does not yet replace the viewer's `opencode run --auto` path.
