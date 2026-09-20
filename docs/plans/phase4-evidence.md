# Phase 4 evidence — restart recovery and idempotent mutations

Plan: `docs/plans/1789886261_orca-orchestration-hardening-and-modernization.md`, Phase 4.
Baseline: Phases 1–3 present in the same worktree, preserved and green (115/115 server tests include
the full Phase 1–3 suites). Nothing committed or pushed.

## What changed

- `server/src/orca.ts` — the idempotent mutation layer, the only place that knows the wire shapes:
  - every mutating call (`worker-start`, `worker-release`, `worker-retain`) runs under a durable
    `--retry-request <uuid>` id minted by `newRequestId()` **before** the call;
  - `showRequest` wraps `orchestration request-show --request <id>` — read-only by contract, returns
    `null` when the probe itself fails (probing trouble is its own ambiguity);
  - `WorkerStartReceipt` + `parseWorkerStartReceipt`: full start receipts (stage, failedStage, setup,
    effects, residualResources, dispatchId, requestId, recoveryCommands, raw) parsed tolerantly from
    success results **and** `ok:false` envelopes (receipts hide under `error.data[.receipt]`);
  - `WorkerStartError`: a start that positively did not reach ready, carrying the receipt (and the
    original `OrcaCliError.code`, so the `agent_unconfigured` legacy fallback still fires);
  - `RESPONSE_LOST` covers the two ambiguity classes (spawn killed by timeout; non-JSON output after
    a possibly-effective run); `ENOENT`/spawn failures are definite non-events and never enter the
    recovery path;
  - `resolveAmbiguousStart` (plan item 3): probe first; replay the EXACT argv (same id) only when the
    probe says `completed` or `pending`; on `absent` check worker-list for an already-landed dispatch
    for the task and **adopt** it instead of minting a second one; if still unresolved, throw a
    receipt-bearing failure with `failedStage: "response_lost"` — a decision is never invented;
  - receipts echo the minted id even when a runtime reply forgets it (`requestId: receipt.requestId ?? requestId`)
    — the caller minted it, so it is authoritative;
  - `followableNextAction` / `runNextAction` (plan item 6): `projection.nextAction` is followed only
    when it literally contains argv for an allowlisted orchestration verb (`worker-release`,
    `worker-retain`, `worker-abandon`, `worker-read`, `request-show`, `worker-list`); empty/`none`
    means "no prescribed action" and nothing is invented; a followed argv runs verbatim (no extra
    flags added — verified by log assertions).
- `server/src/coordinator.ts` — recovery and the state machine:
  - `startCoordinator` binds, then enters the real `recovering` phase and runs `recoverState()`
    **before** the loop may place anything (plan item 4): `task-list` reconciled against scoped
    `worker-list`, classified per row —
    - dispatched task + supervised row with a positive outcome → adopted **settled** (the stale task
      row loses to worker-list, plan §6.3); the normal ownership path auto-releases it;
    - dispatched task + supervised row without outcome → adopted **active**: counts against the
      concurrency budget and is reconciled like any own worker; never stopped/released on a guess;
    - dispatched task + missing or unsupervised row → **unverifiable**: surfaced in
      `unownedDispatches` / `recovery.unverifiable`, budget-counted, untouched;
    - terminal task + undecided row (`reclaimable`, `release_pending`, `release_unknown`, `active`)
      → adopted settled so the ownership decision executes; already-decided rows are `leftDecided`
      and left exactly as Orca holds them;
    - the summary lands on `/api/run-status` as `recovery` (`RecoverySummary`);
  - `startOne` (plan items 1, 2, 8): mints the durable id, retains it on the attempt until the
    outcome is known, and keeps every receipt (bounded). The old "delete the attempt and retry next
    tick" behavior is **gone**: a failed start settles the attempt as `start_failed` with the
    receipt folded in (the receipt's partial dispatchId is adopted into the projection); the task is
    parked until a human retries. A legacy-lane start that fails after creating its pane closes that
    pane (refusal becomes `close_failed` debt). Receipt-bearing failures stay on the attempt;
    receipt-less infrastructure failures surface on the global error line;
  - `decideTerminalOwnership` for `start_failed` attempts (plan acceptance: failed-before-ready):
    partial Dispatch present → release via the prescribed argv or the direct idempotent call;
    residual resources without an addressable dispatch → `release_unknown` debt listing Orca's
    prescribed recovery commands; positively nothing created → `not_needed` (the cleanest failed
    start — nothing owed);
  - `performRelease` follows the literal prescribed argv when present, otherwise releases under a
    `releaseRequestId` that is **retained across `release_pending` retries** so Orca replays the
    same request instead of repeating it;
  - `retryWorker(idOrTask)` (plan item 9): the explicit safe retry. Refuses anything but a POSITIVE
    failure — unsettled/active attempts, `unverifiable` liveness, open cleanup debt on the dispatch,
    a live supervised dispatch for the task in worker-list, a dispatched task row, and unknown ids —
    each with `retry_not_allowed` / `retry_target_not_found` / `not_running`. Resets the attempt in
    place (receipts retained), repeats harness/model/placement, carries `--retry-of <old dispatch>`
    lineage, and runs under a fresh durable id.
- `server/src/app.ts` — `POST /api/workers/:id/retry` (token + execution gate). The three refusal
  codes answer **409** (state forbids the retry; the request shape is fine).
- `web/src/types.ts` — `RunAttempt` gains `adopted`, `retriedFrom`, `startRequestId`,
  `startReceipt: WorkerStartReceiptView`, `nextAction`; `settledVia` gains `start_failed`;
  `terminalDecision` gains `not_needed`; `RunStatus` gains `recovery: RecoverySummaryView`.
- `web/src/api.ts` — `retryWorker(id)`.
- `web/src/components/RecoveryPanel.tsx` (new) — the recovery surface: adoption summary,
  unverifiable dispatches ("left untouched"), starts still carrying a durable id, failed-start
  receipts (failedStage, recoveryCommands) with the explicit **Retry** button (disabled while the
  coordinator is not running — the server 409s otherwise), and Orca's literal prescribed argv shown
  verbatim. Renders nothing on a boring healthy run.
- `web/src/App.tsx` — RecoveryPanel wired under InboxPanel.
- `server/test/fixtures/fake-orca.mjs` — Phase 4 runtime double: `request-show`; a request store
  that makes same-id replay idempotent (completed → recorded outcome verbatim; pending → lands the
  start exactly once on replay); three lost-response modes (`lost` = landed + response garbage,
  `pending` = probe answers pending, `lost_noreceipt` = nothing recorded); receipt-bearing start
  failures (`error.data.receipt`); `livenessOverride` / `livenessReason`; scripted `nextAction`
  (wire shape or bare argv shorthand); release/retain echo the retry-request id.
- `server/src/coordinator.test.ts` — the acceptance suites listed below.
- `server/src/config.ts` (plan item 10, verified — no change needed): the sanitizer persists only
  viewer preferences (`defaultHarness`, `harnessByTask`, `modelByTask`, `maxConcurrency`, `layout`,
  `runId`, `retainByTask`). No tokens, terminal handles, dispatch ids, or capability state are ever
  stored; transient authority lives only in coordinator memory.

## Acceptance → evidence

| Acceptance criterion (task + plan) | Implementation | Tests |
| --- | --- | --- |
| Process restart during an active DAG: adopt, don't duplicate, don't overflow | `recoverState` active-adoption; adopted attempts are budget-counted like any own worker | `unowned dispatched tasks › adopts a pre-existing active Dispatch (Phase 4)…` (adoption + cap-1 hold + stop report); `…surfaces an unverifiable Dispatch (no supervised row)…` (missing row class) |
| Ambiguous worker-start → `request-show`, replay only per contract, **no second Dispatch** | `resolveAmbiguousStart` + adapter `--retry-request` | `ambiguous worker-start recovery › resolves a lost worker-start response…` (asserts exactly 1 dispatch, 2 start calls sharing ONE durable id, probe ran, dependent task held at cap 1). The pending-probe branch takes the identical same-id replay path inside `resolveAmbiguousStart` (probe state `completed` and `pending` are the same branch) and the fixture retains a `pending` mode for it; the surviving lost-response test exercises that replay machinery end to end. |
| Lost response with no receipt → park, keep receipt, **no auto-retry** | `resolveAmbiguousStart` absent-branch → receipt `failedStage: "response_lost"`; `startOne` parks | `ambiguous worker-start recovery › parks a lost start Orca holds no receipt for…` |
| Failed-before-ready retains its receipt; releasable per Orca's prescribed action | receipt folded into the attempt; ownership from the receipt; `not_needed` when nothing residual | `Phase 4: failed-before-ready starts › keeps the attempt with its receipt, owes no cleanup, never auto-retries, and retries only on request` (receipt fields asserted verbatim; ownership decided `not_needed`; no automatic re-placement asserted across ticks; explicit retry re-places under a fresh durable id) |
| Explicit retry: positive failure only, repeats agent/model/placement | `retryWorker` gates + reset + `--retry-of` lineage | `failed-before-ready starts › …retries only on request`; `ambiguous worker-start recovery › refuses to retry an active attempt, and refuses while cleanup debt is open` (by task id AND by dispatch id). The same `retryWorker` is served verbatim by `POST /api/workers/:id/retry` (409-mapped refusals in `fail()`). |
| Projection classes: active / reclaimable / retained / release_pending / release_unknown / missing / stale | `recoverState` classification + ownership paths | `restart projection classes ›` stale→released, retained→`leftDecided` + untouched, release_unknown→debt + never auto-retried (call count frozen across ticks), release_pending→same durable id across retries until settled |
| Literal `nextAction` (item 6) | `followableNextAction` allowlist + verbatim `runNextAction` | `literal nextAction › follows a prescribed worker-release argv verbatim — no extra id is added`; `…uses the idempotent direct release when no nextAction is prescribed (never invents one)` |
| No concurrency overflow at any point | synchronous slot reservation before `startOne`; adopted + ambiguous attempts all counted | cap-1 assertions in the two-wave suite, the adoption suite, and the ambiguous-recovery test (dependent held while the recovered worker is live) |
| Full checks | see below | below |

## Checks run (all green)

```text
npx tsc -p server/tsconfig.json --noEmit        → clean
npm test -w server                              → 115/115 (34 suites)
npx tsx --test src/coordinator.test.ts          → 24/24 (13 suites), green on three
                                                  consecutive runs incl. the final
                                                  deduplicated test set
npm run build -w web                            → tsc -b + vite build clean
node scripts/check-skill.mjs                    → skill frontmatter ok
node scripts/build-npm.mjs                      → staged dist-npm (0.1.0)
npm pack ./dist-npm → install in /tmp → NO_OPEN=1 boot
  → GET /api/health {"ok":true,…}  ·  GET / serves <div id="root">   (matches CI smoke)
```

Note on test dedup: an earlier interim state carried overlapping Phase 4 suites from a parallel
attempt; they were consolidated into one suite per concern (13 describes, 24 tests) with every
assertion path above still covered by exactly one surviving test.

## Constraints compliance

- `worker-list` and Deliveries are authoritative: restart settlement trusts worker-list over stale
  task rows; the completion boundary queries `worker-list --terminal-state reclaimable` directly.
- Nothing destructive on `unverifiable`/missing status: unverifiable rows are surfaced and
  budget-counted only; `retryWorker` refuses them; no automatic stop/abandon/release exists on any
  ambiguous path (`worker-abandon` appears in no automatic path at all).
- Phases 1–3 preserved: their suites run green in the same 115-test pass; `AGENTS.md` conventions
  (why-comments, strict TS, ESM) kept.
- No authority credentials in `.orca-dag.config.json` (sanitizer whitelist unchanged and verified).
- Nothing committed or pushed; git status shows the same worktree state as handed over plus this
  evidence file.
