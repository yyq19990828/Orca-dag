# Phase 5 evidence — worker observability, reuse, and launch preferences

Status: complete
Executed: 2026-09-20 (single dispatched worker session)
Task: `task_e78ca57a9693` · Dispatch: `ctx_a0256bff42c6` · Run: `run_0e4e9faf64e0`
Plan: `docs/plans/1789886261_orca-orchestration-hardening-and-modernization.md` §Phase 5

## What was implemented

**Adapter (`server/src/orca.ts`)**
- `readWorkerOutput` passes `--source` / `--cursor`, returns `source`, `cursor`,
  `warnings`, and handles `source_changed` in one place: a cursor pinned to a
  replaced source restarts the read once without the cursor and returns
  `sourceChanged: true` plus an explanatory warning.
- `startSupervisedWorker` gained `effort` (refused without `model`) and
  `terminal` (sends `--terminal <handle>` instead of `--agent`; refuses
  model/effort alongside — the runtime's own contract).
- `WorkerStartReceipt.effective`: tolerant dig of the runtime's echo of
  agent/model/effort/worktree/terminal; unechoed fields stay `null`.
- `OrcaWorkerRow.projection` gained optional `launch`; `normalizeLiveness`
  collapses every unknown verdict to `unverifiable` (never `exited`).

**Config (`server/src/config.ts`, `server/src/security.ts`)**
- `effortByTask` map with modelByTask-style sanitization; files from before
  Phase 5 (key absent) hydrate untouched. `validateEffort` charset-bounds
  levels at the HTTP boundary.

**Coordinator (`server/src/coordinator.ts`)**
- Attempt projection extended: `livenessReason`, `attention`, `stage`
  (agent-wait evidence), `fleetTerminalState`, `agentTerminalHandle`,
  `requested`, `effective`, `reuseOf`; all exposed via `GET /api/run-status`.
- Ownership decision order for a settled supervised worker:
  **retain → reuse → release**.
  - **Reuse**: exactly ONE immediate ready follow-up with the same effective
    harness, no requested model (effort rides only with a model), and the same
    placement (`current`), started via `worker-start --terminal <handle>` and
    awaited to completion **before** the old Delivery is acknowledged (the ack
    gate holds the batch while `terminalDecision === "pending"`). Ownership
    transfers to exactly one new Dispatch (`reuseOf` lineage); the reused
    terminal is never closed nor released.
  - **Forced fresh**: harness mismatch or any model request → the settled
    terminal takes the default release and the follow-up starts with
    `--agent` (+`--model`/`--effort`).
  - **Retain-for-debugging** (`retainByTask`) wins over both: a retained
    terminal is never released and never reused; the follow-up starts fresh.
  - A definitely-failed reuse start releases the unconsumed terminal; an
    ambiguous (`response_lost`) one surfaces `release_unknown` debt instead of
    guessing (Phase 4 rules intact).
- `startOne` records `requested` prefs, sends `--effort` only with `--model`,
  and sets `effective` only from the receipt echo.

**API (`server/src/app.ts`)**
- New `GET /api/workers/:dispatchId/output` — bounded page, `source` enum
  validated, `cursor` length-bound, `limit` clamped 1–200 (default 40);
  read-only/token-free like the other reads.
- `POST /api/run` accepts `effortByTask` and rejects an entry without a model
  for the same task (`400 effort_requires_model`) before any Orca work.
- `PUT /api/config` validates the `effortByTask` shape (pairing enforced at
  run time, so pre-existing files keep loading).

**Web**
- `WorkerPanel.tsx` (new): per-attempt liveness badge (only
  `live`/`unverifiable`/`exited` + the runtime's reason), attention
  categories, agent-wait stage, terminal handle + Orca-vs-viewer accounting,
  requested → effective launch preferences with a visible **requested ≠
  effective** flag, Orca's literal prescribed nextAction, bounded output
  viewer with cursor paging and `source_changed`/warning banners, and
  Release / **Retain for debugging** controls on undecided settled workers.
  Reuses the existing gate/inbox crayon styling; English throughout.
- `NodePanel`: effort picker rendered only when a model is set AND the harness
  supports effort (claude/codex/cursor); "Keep terminal for debugging"
  checkbox persists `retainByTask`.
- `harness.ts`: backward-compatible hydration (absent maps → empty),
  effort/retain accessors, `effortMap`/`retainMap`; clearing a model clears
  its effort.
- `api.ts` / `ExecControls.tsx`: run start carries `effortByTask` and
  `retainByTask` explicitly (avoids the 250 ms config-write debounce race).

**Fixture (`server/test/fixtures/fake-orca.mjs`)**
- Supervised starts mint an `agentTerminal`; a `--terminal` takeover moves the
  old Dispatch's terminal accounting to `released` (same handle on the new
  row); `worker-read` echoes `--source`, and scripts a one-shot
  `source_changed` for cursor reads.

**Docs** — README.md and README_zh.md updated in lockstep: the retired
"spun up on demand, reused while idle, reclaimed when done" claims replaced
with the actual lifecycle (archive → release / immediate-compatible reuse via
`--terminal` / explicit retain), plus effort, the Workers panel, the new API
rows, and code-layout entries.

## Acceptance mapping

| Criterion (task + plan §Phase 5) | Evidence |
| --- | --- |
| Archived output readable after release | Output is read before the ownership action and kept on the attempt (`run-status.output`); `worker-read` works post-release (adapter test `propagates…`, and the archive fixture answers after `released`); coordinator tests assert `output archived` for every settled attempt incl. reused. |
| Liveness renders only live/unverifiable/exited + reason | `normalizeLiveness` (orca.test.ts: unknown/absent → `unverifiable`), UI badge styles, WorkerPanel shows the reason. |
| Reuse transfers ownership to exactly one new Dispatch, terminal not closed | coordinator.test.ts `reuses the settled terminal…` (one new Dispatch, same handle, zero releases for the old dispatch, ack-after-start ordering asserted) and the two-wave test (C on B's terminal via `--terminal`, no `--agent`). |
| Different harness/model forces release + fresh worker | coordinator.test.ts `forces a fresh worker…` (model) and `…different harness`. |
| Requested/effective model/effort visible, mismatch flagged | `WorkerStartReceipt.effective` (orca.test.ts effective-echo tests), coordinator test asserting `requested.effort === "high"` + `--model opus --effort high` argv, WorkerPanel requested→effective rendering with mismatch flag. |
| Per-task effort only with a supported model | Adapter refuses effort-without-model / effort-with-terminal (orca.test.ts), API rejects unpaired effort (`effort_requires_model`, app.test.ts), UI gates the picker on model + `EFFORT_SUPPORTED`. |
| Config hydration backward compatible | config.test.ts (pre-Phase-5 file, non-object map, malformed entries), harness.ts hydration. |
| Retain-for-debugging explicit control | coordinator.test.ts `explicit retain-for-debugging prevents…` + pre-existing retain test; WorkerPanel/NodePanel controls; README documented. |
| Full tests / typechecks / build / package smoke / git diff --check | Commands and results below. |

## Exact commands and results

```text
npx tsc -p server/tsconfig.json --noEmit
  → clean (exit 0, no output)

npm run build -w web          # tsc -b && vite build
  → ✓ 249 modules transformed, built in ~1.3s (tsc -b green)

npm test -w server            # tsx --test src/*.test.ts
  → # tests 140  # pass 140  # fail 0

npm run build:npm
  → ✅ Staged npm package → dist-npm (version 0.1.0)

npm pack ./dist-npm --pack-destination /tmp/opencode/pkg-smoke
  → orca-dag-0.1.0.tgz

cd /tmp/opencode/pkg-smoke && npm init -y && npm install ./orca-dag-0.1.0.tgz
  → install=OK; node_modules/orca-dag contains dist/server/index.mjs,
    web/dist/index.html, skill/SKILL.md

PORT=3999 NO_OPEN=1 ORCA_DAG_NO_SKILL=1 WORKSPACE_DIR=<ws> node node_modules/orca-dag/bin/orca-dag.mjs
  GET /api/health           → {"ok":true,"workspace":"<ws>","worktree":"path:<ws>"}
  GET /api/readiness        → {"cli":"orca","version":"1.4.205","executionEnabled":true}
  GET /                     → 200 text/html (SPA index)
  GET /some/route           → 200 text/html (SPA fallback)
  GET /api/nope             → 404 {"error":"not found","code":"not_found"}
  POST /api/run-stop (no token) → 403
  server log: bound to 127.0.0.1 · execution enabled

git diff --check
  → clean (exit 0)
```

Focused suites run during the checkpoint sequence (all green at completion,
counts included in the 140 above): `orca.test.ts` 70/70 (foundations),
`coordinator.test.ts` 31 tests incl. 5 reuse/retain + 2 API tests,
`app.test.ts` +2 effort-validation tests, `config.test.ts` 4/4.

Live CLI contract facts the implementation relies on (observed from the
installed Orca 1.4.205 via `orca orchestration worker-start --help` and
`worker-read --help`): `--effort` requires `--model`; neither combines with
`--terminal`; reuse requires `--worktree` for the terminal; `worker-read`
takes `--source auto|transcript|terminal` and `--cursor`, and a cursor is
pinned to its source (`source_changed` → start a fresh read).

## Known limitations

1. **Reuse accounting on the live runtime is fixture-modeled.** The fake
   encodes "a `--terminal` takeover moves the old Dispatch's terminal state to
   released". If the live runtime instead keeps the old row `reclaimable`, the
   completion boundary will hold the Run in `awaiting_input` with an explicit
   reclaimable debt row (user releases it once) rather than mis-claiming
   completion — safe by construction, but worth watching on the first real
   reuse run.
2. **Effort levels are free-text** (charset-validated; UI offers
   low/medium/high). Orca owns the authoritative per-model level list; an
   unsupported level surfaces as a runtime-side start failure with a retained
   receipt (never a silent drop).
3. **opencode** (legacy lane) has no effort support and its viewer-created
   terminal is never a reuse candidate (legacy terminals are closed on
   settlement, as in Phase 3).
4. An **effort entry without a model** is rejected at `POST /api/run` but
   tolerated if hand-edited into `.orca-dag.config.json`; the coordinator then
   normalizes it away (never sent), keeping the store backward compatible.
5. **Web has no test runner yet** (per AGENTS.md there is no web test target);
   web verification for this phase is `tsc -b` via `npm run build -w web`
   plus the existing manual flows. Server-side behavior (the actual contract)
   is covered by the 140 tests.
6. The **Bun binary build** (`build:binary`) was not exercised in this
   session; the npm package path (the publishable artifact) is the one smoked.
7. WorkerPanel "Load more" appends cursor pages client-side; if the output
   source changes mid-paging, the next page restarts from the top and says so
   (`sourceChanged` + warning) rather than stitching discontinuous rows.

Rollback (per plan): disable reuse (the reuse block is the only new mutation
path; removal returns to release-after-settlement); observability additions
are read-only and may remain.
