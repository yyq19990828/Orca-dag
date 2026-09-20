# Phase 3 evidence — closed supervised-worker lifecycle

Plan: `docs/plans/1789886261_orca-orchestration-hardening-and-modernization.md`, Phase 3.
Baseline: Phases 1–2 present in the same worktree, preserved and green. Nothing committed or pushed.

## What changed

- `server/src/orca.ts` — typed Phase 3 adapters, the only place that knows the 1.4.205 wire shapes:
  `checkInbox` (`check --terminal`, `--wait`+`--timeout-ms`, `--types` wake filter, `--ack`),
  `replyToMessage`, `listWorkers` (`worker-list --run [--terminal-state]`), `releaseWorker` /
  `retainWorker` (`worker-release` / `worker-retain --dispatch`; `release_unknown` exits non-zero per
  the runtime contract and is folded into a typed receipt, not an exception), `readWorkerOutput`
  (`worker-read --dispatch`), `stopWorkerReceipt` (`worker-stop --dispatch`).
  Mid-session cleanup: the late-landing writes from an operator-closed retry had left a SECOND,
  divergent adapter block (camelCase shapes that do not match the live wire) plus a duplicated
  `closeTerminalStrict` in this file; the stale block was excised and the snake_case block kept
  (verified against the coordinator terminal's own `check` output on this runtime).
- `server/src/coordinator.ts` — the lifecycle state machine:
  - fixed 3.5 s poll sleep replaced by a rolling `check --wait` on the Run inbox (wake types
    `worker_done,escalation,question`) with a hot-spin floor, plus task/worker reconciliation after
    every wake or wait timeout;
  - FIFO Deliveries are processed row by row; per-message-id dedupe (bounded set) makes replay of an
    unacknowledged batch a no-op;
  - ack is deferred until (a) no question/escalation in the batch is open AND (b) every
    `worker_done`-triggered terminal-ownership decision has actually executed (`pendingOwnership`) —
    plan item 6, so a crash between settlement and release replays the batch;
  - `worker_done` validation before settlement: unknown Dispatch, already-settled duplicate,
    dispatch-id mismatch, or outcome other than succeeded/failed is recorded and settles nothing;
    Orca's terminal task status is the second, independent settlement evidence;
  - heartbeats update liveness only — never completion;
  - post-settlement ownership: archive output via `worker-read`, then retain (explicit
    `retainByTask`) or release (default); `release_pending` retried on reconciliation up to
    RELEASE_RETRY_MAX, then debt; `release_unknown` / legacy `close_failed` become cleanup debt that
    blocks completion and is never auto-retried; the legacy lane (opencode/custom) closes only the
    viewer-created terminal and settles its unsupervised tracking dispatch by receipt — never
    `worker-stop` on the happy path;
  - unowned `dispatched` tasks (pre-existing Dispatches) are surfaced and counted against the
    concurrency budget instead of being double-placed over;
  - explicit Stop returns a per-target report (stopped / already_settled / fenced / closed /
    unknown), never releases on Stop, and persists unknowns as `stop_unknown` debt;
  - §6.2 completion boundary: nothing ready/dispatched, every Dispatch settled with a decided
    ownership outcome, no open inbox/Delivery, zero `reclaimable` workers (fleet query, with stale
    debt pruning), and the coordinator terminal's close verified or surfaced as
    `coordinator_close_failed`; phases idle/binding/running/awaiting_input/stopping/completed/error
    exposed via `/api/run-status` (`recovering` reserved for Phase 4);
  - `noteManualRelease` folds an explicit HTTP release/retain back in — only a KNOWN receipt state
    resolves the projection and clears debt; `release_pending` hands control back to the retry loop.
- `server/src/app.ts` — `POST /api/run-stop` returns `{ ok, clean, results }`; new routes:
  `GET /api/workers?run=`, `GET /api/inbox`, `POST /api/messages/:id/reply` (routed through the live
  coordinator when running so the Delivery acks exactly once, else via a throwaway bound terminal),
  `POST /api/workers/:dispatchId/release|retain`; `POST /api/run` accepts `retainByTask` (request
  wins, persisted config fills in). Phase 1 token/validation ordering and the Phase 2 readiness gate
  are preserved on every new mutation.
- `server/src/config.ts` — `retainByTask` sanitizer (plan §7.3); unknown fields still ignored, no
  migration rewrite.
- Web — `types.ts`: RunStatus gains phase/inbox/cleanupDebt/lastStopReport/unownedDispatches and
  per-attempt settlement/ownership/output fields; `api.ts`: `replyToMessage`, `releaseWorker`,
  `retainWorker`, `stopRun` returning the report; new `components/InboxPanel.tsx` (questions and
  escalations with reply input, cleanup-debt Release/Retain actions, 2 s inbox poll); `App.tsx`
  mounts the panel; `ExecControls.tsx` shows the §6.3 phase, settled/released counters, a completed
  state, and the explicit-stop report with every uncertain entry listed; `styles.css` covers the new
  surfaces.
- Tests — new `server/src/coordinator.test.ts` (13 tests) plus
  `server/test/fixtures/fake-orca.mjs`, a stateful Orca CLI double (lockfile-serialized JSON state,
  FIFO Deliveries that replay until `--ack`, worker accounting with terminal states, release/retain/
  stop/read receipts including the non-zero `release_unknown`, worker-start and tracking-dispatch
  launch paths, terminal registry, full argv log). Phases 1–2 suites are untouched and green.

## Acceptance evidence

- **Success, failure, two-wave dependency order, maxConcurrency**: the two-wave test starts both
  roots under cap 2 while the dependent does not start; A settles via an accepted `worker_done`, B
  via Orca's terminal task status, and C (a failure) via `worker_done` — all three reach `released`
  after a `worker-read` archive (argv-log-proven, output tail asserted), C starts only after both
  roots are released (log order), and the run reaches `completed` with `cleanupDebt: []`. A cap-1
  test holds starts at exactly 1 across multiple ticks.
- **No reclaimable worker at completion**: the boundary queries
  `worker-list --terminal-state reclaimable` (asserted in the log), refuses to complete while any
  row remains, and the test asserts zero reclaimable dispatches plus a disconnected coordinator
  terminal (§6.2 clauses 4 and 6) at `completed`.
- **Question / escalation with reply UI**: one FIFO batch carrying a `worker_done` and a question —
  the worker still releases, the question surfaces via `/api/inbox` (InboxPanel data), no
  `check --ack` is sent while it is open, `POST /api/messages/msg_question/reply` produces exactly
  one `orchestration reply`, the batch is `--ack`ed **exactly once** after the reply, and the run
  completes. An escalation likewise parks the run in `awaiting_input` until answered.
- **Replay**: a redelivered `worker_done` for an already-settled Dispatch is a recorded no-op —
  exactly one `worker-release` for that dispatch, no state change, run still completes.
- **release_pending**: scripted receipt defers the decision, reconciliation retries it, and the run
  completes once Orca answers `released` (retry proven by call count).
- **release_unknown**: the non-zero receipt becomes debt with no automatic retry (exactly one
  release call), completion stays blocked, and the explicit HTTP release (receipt folded back into
  the projection) lets the boundary pass with empty debt.
- **Explicit stop**: two supervised workers + one opencode tracking dispatch — report shows
  `stopped`, `unknown` (scripted failure; `clean: false`), tracking `fenced`, legacy terminal
  `closed` (kind `legacy_terminal`), coordinator terminal closed, and `stop_unknown` debt persisted
  after the phase resets. A supervised terminal is never "closed" to fake a stop.
- **Validation negatives**: foreign dispatch id and outcome `probably_fine` settle nothing
  (asserted after both rows are provably processed); a heartbeat updates `lastHeartbeatAt` only.
- **Test stability**: coordinator suite 13/13 across 8+ consecutive runs (projection-capture races
  root-caused and fixed in the tests: dispatch id/mode are awaited from the projection, and log
  order assertions match on argv, never object identity). Full server suite **104/104**.
- **Builds and smoke**: `npx tsc -p server/tsconfig.json --noEmit` clean; `npm run build -w web`
  (tsc -b + vite) clean; `npm run build:npm` → packed → booted on :8795 with a deliberately bogus
  `ORCA_CLI_COMMAND`: `/api/health` (workspace + exact `path:` selector), `/api/readiness` honestly
  view-only with the actionable reason, `/` 200, no-token POST → 403, token POST → 503
  `execution_disabled`, `/api/inbox` JSON. `TARGET=bun-linux-x64 npm run build:binary` →
  `dist/orca-dag` (101 MB) booted on :8796: health/root/inbox OK. All smoke processes stopped.
- `git diff --check` clean; no stray processes; nothing committed or pushed.

## Notes for review

- Late-landing edits from the operator-closed prior retries briefly broke `orca.ts` (two divergent
  adapter blocks). Resolution: kept the block matching the live snake_case wire format observed on
  this machine's Orca 1.4.205, removed the rest; the whole suite is green after.
- Boundary-surfaced fleet rows now carry debt kind `reclaimable` (the UI already labeled it) and
  are pruned once Orca stops reporting them, so a manual CLI release cannot wedge completion.
- Deferred per plan (not implemented early): restart recovery/adoption and idempotent request IDs
  (Phase 4); `/api/workers/:dispatchId/output`, worker panels, reuse, effort (Phase 5).
