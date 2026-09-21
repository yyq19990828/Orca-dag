# Phase 5 evidence — recovery and output audit

Plan: `docs/plans/1789983823_phase-5-recovery-and-output-audit.md`, governed by the
operations Epic (`1789983818_orca-orchestration-operations-epic.md`), outcome O6.
Baseline: Phases 1–4 committed (`0ca2b65`, `8e83f6c`, `49e213f`); nothing committed or
pushed here. (The older `phase5-evidence.md` in this directory belongs to the retired
`1789886261` plan set and was left untouched.)

## What changed

### Server (durable request ledger + read-only audit)

- **`server/src/requestLedger.ts` (new)** — `.orca-dag.requests.jsonl`, an append-only
  JSONL ledger of viewer-originated mutation-request metadata, with the activity
  journal's exact durability shape: serialized append chain, 5 MB→2 MB rotation,
  torn-final-line tolerance. Upsert-by-request-id (first line fixes `createdAt`, last
  wins), newest-first capped loads (200), id/note clamping (128/300 chars, visible
  `...` truncation). Stores **ids, scope, and bounded viewer notes only** — no
  receipts, no transcript bodies, no credentials.
- **`server/src/coordinator.ts`**
  - `StartOpts.onRequestRecord` — best-effort ledger sink, called with the same
    neutrality rules as `onActivity`/`onCheck`.
  - `startOne` records the minted `worker-start` id **before the CLI call** (so a
    crash or lost response still leaves the id inspectable), then appends the
    resolution: Dispatch/Task linkage, `settledLocally`, and a bounded note —
    `response_lost` stays `settledLocally: false` with a "resolve with
    request-show" note.
  - `performRelease` pre-mints `attempt.releaseRequestId`, records before
    `worker-release`, appends the observed state after; the id is still retained
    across `release_pending` retries (same-id replay, not a new mutation).
  - `stopCoordinator` runs every `worker-stop` through `stopWithAudit` — mint
    record before the call, observed state (or bounded failure note) after.
  - `attempt.terminalArchive` — bounded (≤400 char) JSON summary of the last
    terminal receipt's `archive` facts, exposed via `coordinatorStatus()`. Archive
    presence rides alongside `terminalDecision` and never replaces it.
- **`server/src/app.ts`**
  - `POST /api/run` wires `onRequestRecord` into the coordinator.
  - Manual release/retain run through `terminalMutationWithLedger`: scope (Run +
    Task) recorded **only** when this viewer's own coordinator projection proves
    it, otherwise the row stays unscoped ("scope unknown") instead of being
    mis-attributed; the mint record precedes the CLI call and a failed mutation
    still closes its row with a bounded note.
  - **`GET /api/requests?run=<id>`** — Run-scoped audit list; unscoped rows stay
    inspectable under every Run (labeled), rows of other Runs are excluded but
    counted (`otherRunCount`).
  - **`GET /api/requests/:requestId?run=<id>`** — ledger row + a fresh, read-only
    `request-show` probe. Orca's `state`/`interpretation`/`outcome` pass through
    verbatim (`completed` / `pending` / `absent` / anything newer); a failed probe
    degrades to `state: "unknown"`, `probe: "failed"`. Unknown id → 404
    `request_not_found`; a row naming another Run → 404 `request_run_mismatch`.
    The only CLI verb reachable from either route is `request-show`.
- **`server/src/uninstall.ts` + `.gitignore`** — the ledger file joins the
  `--purge` list (mirroring install), and is gitignored like the activity journal.

### Web (audit surface + sharper output inspection)

- `web/src/types.ts` / `web/src/api.ts` — `RequestLedgerRowView`,
  `RequestReceiptView`, `RequestDetailResponse`, `WorkerTerminalReceiptView`,
  `RunAttempt.terminalArchive`; `fetchRequests` / `fetchRequestDetail`;
  `releaseWorker`/`retainWorker` now return the receipt.
- **`web/src/components/RequestAuditPanel.tsx` (new)** — read-only audit card in
  Operational details: one row per recorded request (operation badge, request id,
  Task/Dispatch, `scope unknown` labeling, bounded note), per-row **Inspect**
  running the live probe. Receipt states are buckets with distinct styling and
  honest captions: `completed` (green), `pending` (amber), `absent` (gray, "absence
  is NOT proof that the mutation did not happen"), `unknown` ("Orca could not be
  asked… nothing is inferred"), anything else verbatim (dashed). Header caption:
  "Read-only — this surface never replays a mutation." The local
  `settledLocally` hint is explicitly labeled as a hint ("The live probe above is
  what counts").
- `web/src/components/WorkerPanel.tsx`
  - **Source badges** on the output block (`auto`/`terminal`/`transcript` + clipped
    / complete / source-changed flags) replacing the plain meta line.
  - **Search box filtering only the rows already loaded** — pure client-side, with
    an "n of m loaded rows match — search covers loaded rows only" counter; it can
    never fetch or render an unbounded transcript.
  - **Download loaded rows** — a local Blob export of exactly what was read (no
    server round-trip, nothing further fetched).
  - **Decision receipts**: manual Release/Retain now surface the receipt — state,
    request id (the ledger-recorded one), and Orca's `archive` facts (bounded
    summary) with the caption "Archive presence is evidence, not settlement".
    Coordinator-side `attempt.terminalArchive` renders under the Terminal line
    with the same disclaimer.
- `web/src/App.tsx` mounts `RequestAuditPanel`; `web/src/styles.css` adds the
  audit/output-badge grammar in the existing crayon language.

### Docs

- `README.md` / `README_zh.md` in lockstep: audit feature bullet, Workers-panel
  bullet extended (source badges, bounded search, download, archive facts), two new
  API rows, code-layout entries for `requestLedger.ts` and `RequestAuditPanel.tsx`.

## Acceptance → evidence

| Acceptance criterion | Implementation | Tests / verification |
| --- | --- | --- |
| Lost-response fixtures remain idempotent and become inspectable after reconstructed state | Mint record before the CLI call; resolution appended with Dispatch linkage; same-id replay untouched | `coordinator.test.ts` › "records a worker-start request BEFORE the CLI call…" (mint.dispatchId null, argv ids `[id, id]`, resolution links `ctx_s1`) and "leaves an unresolved lost start inspectable…" (`settledLocally: false`, note names request-show); the Phase 4 lost-response suites still pass unchanged |
| Completed, pending and absent receipts have distinct readable presentation | `RequestAuditPanel` state buckets + captions; server passes Orca's states verbatim, failed probe → `unknown` | `requestAudit.test.ts` › "presents absent, pending and failed-probe receipts as DISTINCT states" (+ completed via the release row); live UI smoke: pending chip + "Orca says: …" rendered (screenshot `ui-audit.png`) |
| Output search does not fetch or render an unbounded transcript | Client-side filter over `output.lines` only, counter says so; server output route still clamped 1–200 | live UI smoke: filter "needle" → "1 of 1 loaded rows match — search covers loaded rows only"; Download exports only loaded rows via Blob |
| No read endpoint replays a mutation | Audit routes can only reach `request-show`; list reads a local file | `requestAudit.test.ts` › "never replays a mutation from a read surface" (argv log after a full GET pass contains only `request-show`; exactly one mutator on record, the deliberate release) |
| Ledger bounded, atomic, no credentials/unbounded bodies | Append-only + rotation + clamps; metadata only | `requestLedger.test.ts` 6/6 (restart durability, upsert, clamping, torn line, rotation, empty-file) |
| The ledger is never lifecycle authority; absent ≠ did-not-happen | Ledger stores ids/notes; state always live-probed; UI captions state it | code review + UI caption assertions (`auditNoReplayCaption`, absent caption) |
| Link start/release/retain/stop entries to Dispatch/Task when known | Ledger rows carry `taskId`/`dispatchId`; scope recorded only when positively known | coordinator tests (start/release/stop rows carry ids + runId); `requestAudit.test.ts` (unscoped manual release row while no coordinator runs; `request_run_mismatch` 404) |
| Release-archive facts exposed without being settlement | `attempt.terminalArchive` + decision-receipt archive summaries, always with the disclaimer | `coordinator.test.ts` › "captures release-archive facts…"; UI decision-receipt caption |
| `npm run check` passes | — | green: skill ok · typecheck both packages · server tests **313/313** (15 new: 6 ledger + 4 audit + 5 coordinator) · vite build |

## Exact commands and results

```text
npx tsc -p server/tsconfig.json --noEmit        → clean
npm test -w server                              → # tests 313  # pass 313  # fail 0
npm run build -w web                            → tsc -b green, vite ✓ 255 modules
npm run check                                   → green (skill · typecheck · 313 tests · build)
git diff --check                                → clean
```

Live end-to-end smoke (real server + real browser, fake Orca in /tmp/opencode/phase5-smoke):

- `GET /api/requests?run=run_smoke` → 3 rows (2 Run-scoped + 1 unscoped, `otherRunCount: 0`).
- `GET /api/requests/:id` → `pending` (with Orca's interpretation), `completed`
  (outcome carries the release + archive facts), `absent` — three distinct states
  through the real HTTP surface.
- Headless-Chrome DOM assertions: audit panel renders 3 rows with the "never replays
  a mutation" caption; Inspect on the pending row renders the live `pending` receipt
  and Orca's interpretation; Read output renders the `terminal` source badge +
  archive lines; search "needle" → "1 of 1 loaded rows match". Screenshots:
  `ui.png` (DAG), `ui-audit.png` (audit panel with expanded pending receipt).

## Constraints compliance

- Ledger is not a second authority: no stored states; every displayed state comes
  from a live probe; notes are viewer-observed and labeled as such.
- `absent` is its own calm gray bucket with an explicit non-proof caption.
- No replay path: audit routes accept no actions; proven by argv-log assertion.
- No credentials or transcript bodies stored: ledger rows are ids + ≤300-char notes;
  archive summaries capped at 400 chars.
- English UI throughout; README/README_zh synced; nothing committed or pushed;
  `.orca-dag.config.json` / runtime artifacts untouched (smoke ran in a throwaway
  workspace); prior phases preserved (all 313 tests green in one pass, no prior-file
  edits outside the phase's wiring).

## Known limitations

1. Unscoped ledger rows (e.g. a manual release while no coordinator runs) appear
   under every Run's audit list, labeled "scope unknown" — deliberate, so a
   lost-response id is always findable; they are 404-guarded only when they
   positively name another Run.
2. The audit list is capped at the 200 newest requests per load; rotation keeps the
   file bounded, so extremely old request ids can age out of the local ledger (the
   ids remain valid for `request-show` — Orca's record outlives the local pointer).
3. `settledLocally` reflects only what the viewer observed during the original call;
   the UI labels it a hint. Web has no test runner of its own (per AGENTS.md) — web
   behavior is covered by `tsc -b` plus the headless-browser smoke above; the server
   contract is covered by the 313 tests.
4. The smoke's fake mirrors the documented `worker-read` shape where the archived
   tail arrives as one chunk; the search counter therefore counts runtime "rows",
   which may be multi-line chunks — the boundedness guarantee is unaffected.
