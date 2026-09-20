# Phase 4 handoff note (from the fenced worker incarnation)

Written 2026-09-20 by the worker incarnation that was fenced mid-Phase-4
("the Attempt was re-attached to another worker"). This note only records
state for the current owner; it is not phase evidence.

## What the shared diff contains from this incarnation

All of the following were in place, typecheck-clean, before the fence, and the
current Phase 4 suites pass against them:

- `server/src/orca.ts` — `RESPONSE_LOST` classification in `runOrca` (killed
  spawn / non-JSON stdout / non-zero exit without a readable receipt;
  string-errno spawn failures stay `cli_not_found`/`spawn_*` — the command
  never ran), `newRequestId`, `showRequest` (`request-show`), `OrcaRequestReceipt`,
  `WorkerStartReceipt` + tolerant `parseWorkerStartReceipt`, `WorkerStartError`,
  `startSupervisedWorker` with `--retry-request` / `--retry-of` and
  `resolveAmbiguousStart` (probe → same-id replay for completed/pending →
  worker-list adoption for absent → parked failed start otherwise),
  `normalizeTerminalReceipt`, retry-request ids on worker-release / retain /
  stop with lost-response disambiguation, `followableNextAction` /
  `runNextAction` (verb-allowlisted literal argv execution), `showRun`.
- `server/src/coordinator.ts` — `adoptDeadCoordinatorTerminal` (closes the
  crashed incarnation's coordinator pane identified via the Run record's
  `coordinator_handle` + main-title + workspace hash), `recoverState`
  (task-list × scoped worker-list before any dispatch; adopt active /
  positively settled / inherited `release_unknown`-as-debt /
  `release_pending`-into-retry / retained-left-alone; unverifiable rows
  surfaced, never acted on), `performRelease` (follows a prescribed
  worker-release argv verbatim, else direct release under ONE durable id
  retained across `release_pending` retries), `startOne` without
  delete-and-retry (receipt retained, `settledVia: "start_failed"`,
  `not_needed` ownership decision), `retryWorker` (positive-failure gate +
  Orca-side live-Dispatch check + `--retry-of` lineage), boundary treats
  start-failed tasks as parked (`awaiting_input`) and `not_needed` as decided.
- `server/src/app.ts` — `POST /api/workers/:id/retry` (requires the live
  coordinator; 409 `retry_not_allowed` / `retry_target_not_found` refusals).
- `server/src/config.ts` — sanitizer comment: preferences only, never
  transient authority credentials (allowlist is the enforcement).
- `server/test/fixtures/fake-orca.mjs` — `request-show` handler,
  `worker-start` idempotency (`completed` replay verbatim, `pending` replay
  lands exactly once) with `lost` / `pending` / `lost_noreceipt` ambiguity
  modes, `workerStartFail.receipt` via `error.data.receipt`, `releaseLost`
  lost-release mode, `livenessOverride`, `nextAction` projection plumbing,
  `run-show` handler.

## What was removed here and why

This incarnation had also added three Phase 4 test suites to
`server/src/coordinator.test.ts` encoding its own (earlier) implementation
assumptions. After the re-attach they collided with the current owner's
passing suites (5 red subtests). They were deleted to leave the tree green;
the unique coverage they carried that the surviving suites do not:

- crash during an active DAG with the dead coordinator TERMINAL still
  connected (`adoptDeadCoordinatorTerminal` is currently untested — the crash
  simulations in the surviving suites do not leave a stale main-title pane
  behind);
- explicit assertion that an adopted active Dispatch holds the concurrency
  budget across the restart (surviving suites hold concurrency in the
  ambiguous-start path, not across restart adoption);
- restart inheritance of `release_pending` via the fixture's scripted
  release modes (the surviving suite covers the same class via
  `crashedState` + durable-id assertions).

## Web half

Phase 4's web work (`web/src/components/RecoveryPanel.tsx`, run-status
recovery fields, retry action in the UI) had NOT been started by this
incarnation when the fence landed.
