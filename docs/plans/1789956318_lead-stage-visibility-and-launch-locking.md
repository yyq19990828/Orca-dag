# Lead-stage visibility and immutable launch preferences plan

## 1. Decision

Ship one cohesive viewer slice that makes the human-selected lead stage visually prominent and makes launch preferences honest after execution begins.

The viewer will store one explicit lead Task per Run in its existing workspace config. It will never infer that role from graph position, Task creation order, harness, or the current Orca coordinator handle: those facts describe different concepts and would eventually label the wrong Task. The lead marker is presentation metadata only and does not change Orca authority or DAG dependencies.

Launch preferences will be editable only while they can still affect execution. A Task becomes permanently launch-locked after its first durable Dispatch. While this viewer's coordinator is running, all Tasks are temporarily launch-locked because the coordinator already holds an immutable launch-plan snapshot. Stopping the coordinator unlocks Tasks that have never dispatched; Tasks with Dispatch history remain locked. Safe retry continues to reuse the original launch parameters.

This is one mergeable slice rather than artificial phases: the durable started-state, config schema, and UI behavior jointly define one user-visible truth. Parallel workstreams may implement separate file groups, but the slice ships only after integrated verification.

## 2. Goals

1. Let the user explicitly select one Task in each Run as the main-agent or lead stage.
2. Render that Task with a strong visual treatment that remains distinct from status colors.
3. Explain that the lead marker is semantic ownership, not the live Orca coordinator authority.
4. Prevent edits to harness, model, effort, environment, and placement after the Task has ever dispatched.
5. Prevent edits to all launch preferences while the viewer coordinator is running, because the active coordinator uses a start-time snapshot.
6. Preserve the lock after a page or viewer restart by deriving it from Orca's durable worker accounting, including legacy tracking Dispatches and connected-server workers.
7. Keep existing configuration files backward compatible and retain the current npm and standalone-binary distribution paths.

## 3. Non-goals

- Do not add a synthetic Task or dependency edge for the lead marker.
- Do not infer the lead Task from the first/root Task, creator terminal, harness, or Run coordinator handle.
- Do not change Orca's Run, Task, Dispatch, or Gate schemas.
- Do not add live mutation of the coordinator's launch-plan snapshot in this slice.
- Do not permit a safe retry to change harness, model, effort, environment, or placement.
- Do not lock read-only Task details, output viewing, gate actions, inbox replies, or terminal release/retain actions.
- Do not change the status palette: lead styling must layer around it.
- Do not add a new service, database, environment variable, CLI command, account, or credential.

## 4. Current-state evidence

- `web/src/components/NodePanel.tsx` currently leaves per-node launch controls editable regardless of Task history or coordinator state.
- `POST /api/run` snapshots the launch maps into `StartOpts`; later config-file edits do not update the running coordinator.
- A completed or failed Task no longer carries `dispatchId` in `task-list`, so `DagNode.dispatchId` alone cannot prove whether it has run.
- `GET /api/workers?run=<id>` already exposes Orca worker accounting, but the web client does not consume it.
- `worker-list` includes supervised workers and legacy/context-only tracking Dispatches, which makes its Task IDs the correct durable evidence that a Task has started.
- Remote workers require `--include-remote`; loss of contact remains `unverifiable` but still proves that a Dispatch exists.
- `.orca-dag.config.json` is already the documented home for viewer-only Task metadata and is sanitized without migration rewrites.

## 5. Chosen data model and API

### 5.1 Viewer config

Add one optional, sanitized map to both server and web config types:

```text
leadTaskByRun: Record<runId, taskId>
```

Rules:

- Missing map means no Run has a lead stage.
- Setting a Task replaces the previous lead for that Run.
- Clearing removes only that Run's entry.
- Stale Run or Task IDs are harmless viewer metadata and may be ignored by the UI.
- Existing config files load unchanged; unknown fields retain the current compatibility behavior.

### 5.2 Durable launch-lock evidence

Add a typed web client for `GET /api/workers?run=<id>`. The endpoint must include connected-server rows and must not silently truncate the evidence needed for locking. Extend the Orca adapter with cursor-aware pagination while preserving existing callers' array-oriented contract.

The client derives:

```text
startedTaskIds = unique worker.taskId values for the selected Run
```

This is evidence of existence only. Liveness, outcome, terminal state, and attention do not affect the permanent lock.

### 5.3 Lock policy

For the selected Task:

```text
permanentlyLocked = startedTaskIds contains task.id
temporarilyLocked = runStatus.running and runStatus.runId equals selectedRunId
coordinatorStarting = the selected Run's POST /api/run is binding or recovering
historyUnverified = worker history is loading or failed
launchLocked = permanentlyLocked or temporarilyLocked or coordinatorStarting or historyUnverified
```

Defensive rules:

- `dispatchId != null`, `status == completed`, or `status == failed` also locks immediately.
- Worker-history loading or failure locks all launch settings until the complete history is verified; incomplete evidence must never look like permission to edit.
- A fetch failure must not unlock a Task already known to be locked during the current page session.
- Run-status from a different Run must never lock the selected Run.
- The client raises the selected Run's starting lock before sending `POST /api/run`, closing the interval before the server can report a bound `runId`.

The web state must retain a monotonic per-Run set during the page session: once a Task ID is observed in worker accounting, a transient empty/error response cannot remove it.

## 6. User interface

### 6.1 Lead-stage marker

NodePanel adds an explicit action:

- `Mark as lead stage` when the Task is not the Run lead.
- `Lead stage` with a clear action when it is selected.

The control remains editable after execution because it is viewer presentation metadata, not a launch parameter.

DagView renders a lead Task with:

- a saturated indigo outer/double outline that does not replace the status border/fill;
- a small gold `★ Lead` badge;
- an accessible label/title explaining `Lead stage — semantic main-agent ownership; Orca coordinator authority is shown separately`;
- no additional graph edge and no layout-size change large enough to destabilize handle measurements.

### 6.2 Locked launch controls

Disable these NodePanel controls when `launchLocked`:

- harness and custom harness command;
- model;
- effort;
- environment;
- exact workspace/new-worktree placement inputs.

Show one concise reason above the launch section:

- Permanent: `Launch settings locked after the first Dispatch. Safe retry preserves the original launch plan.`
- Temporary: `Launch settings are frozen while this Run is executing. Stop the coordinator to edit Tasks that have not started.`

Do not use disabled controls as the only signal; the reason remains visible and readable.

### 6.3 Loading and error behavior

- While worker history is loading, keep every launch-shaping control locked; obvious terminal Task states also remain locked through the defensive fallback.
- If worker history fails, show a warning in NodePanel and keep launch settings locked until verification recovers.
- Do not claim a pending/ready Task is editable while the selected Run's active coordinator is running.

## 7. Component flow

```text
Orca worker-list --run --include-remote --cursor
                  |
                  v
server adapter -> GET /api/workers?run=... -> App run-scoped execution state
                                                   |              |
                                                   v              v
                                           NodePanel lock     DagView lead style
                                                   ^              ^
                                                   |              |
                                      config leadTaskByRun --------+

GET /api/run-status -- process-local coordinator state
                  |
                  +-- accepted only when status.runId == selected Run
```

There is no cycle: config writes never mutate Orca state, and worker accounting remains read-only.

## 8. Implementation ownership

This slice touches more than eight files; the breadth is explicit because the feature crosses the persisted config, Orca adapter, HTTP API, shared web types, state polling, node controls, canvas rendering, tests, and mirrored documentation.

### Backend/config workstream

Owned files:

- `server/src/config.ts`
- `server/src/config.test.ts`
- `server/src/orca.ts`
- `server/src/orca.test.ts`
- `server/src/app.ts`
- `server/src/app.test.ts`
- `server/test/fixtures/fake-orca.mjs` when pagination fixtures require it

Responsibilities:

1. Add and sanitize `leadTaskByRun` without rewriting old configs.
2. Add cursor-aware worker-list pagination and include-remote support.
3. Make `/api/workers` return complete run-scoped accounting for UI locking.
4. Cover legacy/context-only rows, remote rows, empty pages, multiple pages, invalid Run IDs, and backward-compatible config loading.

### Frontend workstream

Owned files:

- `web/src/types.ts`
- `web/src/api.ts`
- `web/src/harness.ts`
- `web/src/App.tsx`
- `web/src/components/DagView.tsx`
- `web/src/components/NodePanel.tsx`
- `web/src/styles.css`

Responsibilities:

1. Hydrate and persist `leadTaskByRun`.
2. Poll run-scoped worker accounting and coordinator status without cross-Run leakage.
3. Maintain the monotonic started-Task set.
4. Apply the permanent/temporary lock policy to every launch-shaping control.
5. Add the explicit lead-stage action and accessible canvas styling.
6. Preserve current drag/layout behavior, SVG filters, and strict TypeScript rules.

### Integration/documentation workstream

Owned by the primary agent after both workstreams land:

- reconcile shared interfaces and review every diff;
- update `README.md` and `README_zh.md` together;
- add or adjust integration tests where a worker could not safely own both sides;
- run the full verification matrix and perform the final acceptance review.

Workers are not alone in the codebase. Each worker must preserve edits outside its ownership, must not revert another worker's changes, and must adapt to concurrently landed interfaces.

## 9. Verification

### Automated

Run, in order:

```text
npm run typecheck
npm test
npm run build
npm run check
npm audit --audit-level=high
git diff --check
```

Targeted automated coverage plus the manual UI acceptance below must prove:

1. Old config without `leadTaskByRun` remains absent in the server's lenient on-disk shape (so loading does not invent a migration rewrite), while frontend hydration normalizes it to an empty map.
2. A lead Task round-trips through config save/load; clearing one Run does not affect another.
3. Worker pagination follows opaque cursors unchanged and returns all Task IDs.
4. `/api/workers` requests remote-inclusive accounting and remains Run-scoped; missing pagination fields, malformed worker identities, and cross-Run rows fail closed.
5. An active Dispatch, completed Task, failed Task, legacy tracking Dispatch, and remote unverifiable Dispatch all lock their Task.
6. A pending/ready Task with no Dispatch is editable only when its selected Run is not executing.
7. Run-status for Run A does not lock nodes while Run B is selected.
8. A transient worker-history failure locks launch settings and does not remove a lock already observed in the page session.
9. Starting a Run locks controls before the request completes binding/recovery, and a delayed DAG response from Run A never renders under selected Run B.
10. Marking a new lead replaces only that Run's previous lead.

### Manual UI acceptance

1. Mark a pending Task as lead; confirm indigo outer emphasis and gold badge while its normal pending/ready status color remains visible.
2. Change the lead to another Task; confirm exactly one node in that Run is highlighted.
3. Reload the page and switch Runs; confirm each Run restores its own lead marker.
4. Before execution, edit harness/model/effort/environment/placement successfully.
5. Start the Run; confirm all launch controls freeze with the active-Run explanation.
6. Stop before a pending Task starts; confirm only never-started Tasks become editable again.
7. Complete or fail a Task, restart the viewer, and confirm its controls remain locked from durable worker history.
8. Confirm lead marking can still change on a completed Task.
9. Confirm output, inbox, gate, retry, retain, and release actions remain available where previously supported.

## 10. Risks and premise collapse

The most fragile assumption is that every execution path that matters creates an Orca worker-list row with the Task ID. This holds for supervised `worker-start` and the existing OpenCode legacy path because that path explicitly mints a tracking Dispatch. If a future custom path can execute a Task without any Dispatch, terminal Task states still lock completed/failed work, but a returned-to-ready Task could appear editable. The safe response is to add durable viewer-side `startedTaskIds` only after such a path exists; do not guess from timestamps or terminal titles now.

Other risks:

- Worker-list pagination increases CLI reads on Runs with more than 100 attempts. Pages are bounded at 100, read sequentially, and only the selected Run is polled.
- Lead styling could be mistaken for status. The design preserves the status fill/border and puts role emphasis outside the card with an explicit badge.
- Config writes are debounced. The lead marker may update optimistically in the existing store, while persistence follows the same 250 ms contract as other viewer preferences.
- Concurrent dispatch and polling can race. The synchronous client-side starting flag, active `dispatchId`, active-Run freezing, and fail-closed history verification cover the window before durable history arrives.

## 11. Surface delta and rollback

Surface delta:

- one backward-compatible config field: `leadTaskByRun`;
- richer behavior from the existing `/api/workers` route;
- no new route, command, flag, environment variable, service, or dependency.

Rollback is data-safe: remove the UI marker/locking and ignore `leadTaskByRun`. Existing config files remain readable because unknown fields are already tolerated. Worker-list pagination is a read-only adapter improvement and may remain independently.

## 12. Definition of done

- Exactly zero or one lead stage is visibly and accessibly marked per Run.
- Lead styling never replaces Task status styling or changes DAG semantics.
- Every Task with durable Dispatch history remains launch-locked after page and viewer restart.
- The selected Run alone controls temporary active-run locking.
- No launch-shaping control suggests a change can affect an already-running coordinator snapshot.
- Safe retry continues to preserve original launch preferences.
- Existing configs require no migration and both English and Chinese documentation agree.
- Full repository checks, audit, package-facing build paths used by `npm run check`, and `git diff --check` pass.
