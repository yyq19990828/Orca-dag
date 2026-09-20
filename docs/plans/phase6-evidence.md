# Phase 6 evidence — connected-server and exact-placement execution

Status: complete
Executed: 2026-09-20 (single dispatched worker session)
Task: `task_6333ec24e528` · Dispatch: `ctx_97bd5f1b4e89` · Run: `run_0e4e9faf64e0`
Plan: `docs/plans/1789886261_orca-orchestration-hardening-and-modernization.md` §Phase 6

## What was implemented

**Config (`server/src/config.ts`)**
- `PlacementSpec` — a three-shape discriminated union (`current` / `existing.selector` /
  `new-top-level.repo+name`). Remote-ambiguous forms are **inexpressible**: there is no
  `new-child` kind and no free-string placement. `environmentByTask` (saved-environment
  selectors) and `placementByTask` added to `ViewerConfig`; the sanitizer rebuilds each
  entry field-by-field and DROPS malformed ones (degrade to local/current, never a guessed
  remote shape). Pre-Phase-6 files hydrate untouched (absent keys stay absent).

**Adapter (`server/src/orca.ts`)**
- Discovery: `listEnvironments` / `showEnvironment` (`environment list|show`; `show`
  returns `null` only for Orca's own `invalid_argument`/`not_found` — transport failures
  throw, an unreachable host is never "no such environment"), and `listRepos` /
  `listWorktrees` / `listProjects` scoped through the global `--environment` flag.
- Tolerant row parsers: `parseEnvironmentRow` (id/name spellings, boolean + status-string
  reachability, capability fields as string arrays / name rows / boolean records) and
  `parseAdvertisedCapabilities` / `parsePeerCapabilities` (case + `.`/`-`/`_` folding).
  **Gating direction: absent advertisement ⇒ all gates off** (`modelEffort`,
  `transcriptRead`, `fleetSnapshot`), with the verbatim `raw` list kept for the UI.
- Placement: `assertValidWorkerStart` is the LAST gate before the CLI — refuses remote
  `current`/`active`, remote `new-child`, `--on`+`--terminal`, remote `new-top-level`
  without exact `--repo` + explicit `--name`, and creation flags outside new worktrees,
  all WITHOUT spawning. `buildWorkerStartArgv` is the single argv builder shared by the
  direct path and the request-show/idempotent replay (a replay can no longer drift);
  `--on` appears on `worker-start` only. `listWorkers` gained `includeRemote`
  (`--include-remote`); worker rows carry `projection.host`; start receipts echo
  `effective.on`; ambiguous-start adoption reconciles with `--include-remote`.

**Coordinator (`server/src/coordinator.ts`)**
- `StartOpts.environmentByTask` / `placementByTask`; attempts track `host` and
  `requested.on` / `effective.on`. `startOne` resolves placement per node and routes
  `--on`/`--worktree`/`--repo`/`--name` to the adapter.
- Capability gate (remote starts): `environment show` per start; unknown environment →
  `environment_unknown`; uninspectable → `environment_unavailable`; unadvertised
  model/effort → `capability_not_advertised`. All three fail the start CLOSED as retained
  `start_failed` records — dropping the override silently would make "requested" lie, and
  a local fallback is forbidden.
- Legacy paths (opencode, unconfigured-agent fallback) refuse remote placement outright —
  they can only create LOCAL terminals, so honoring a remote request through them would be
  the synthetic local fallback the plan forbids.
- Reconciliation uses `worker-list --include-remote` everywhere (tick, restart recovery,
  retry's live-Dispatch gate, completion boundary's reclaimable query). A remote Dispatch
  missing from the fleet ⇒ liveness forced `unverifiable` with a fresh disconnect reason
  (stale pre-disconnect reason overwritten), `nextAction` nulled, and **no** stop / abandon /
  release / retry; the row's return restores liveness for the SAME Dispatch.
- Reuse narrowed to provably identical placement: both the settled attempt and the
  candidate must be coordinator-local `current` with no environment — remote terminals are
  never reuse sources (their handles are never substituted) and remote/exact-placed
  follow-ups never inherit a terminal. All later operations stay Dispatch-ID-routed.

**API (`server/src/app.ts`, `server/src/security.ts`)**
- Read routes (token-free): `GET /api/environments` (rows carry parsed `peer`
  capabilities), `/api/environments/:envId/worktrees?repo=`, `…/repos`, `…/projects`.
- `POST /api/run` and `PUT /api/config` validate `environmentByTask` /
  `placementByTask`. `validatePlacementSpec` returns the SAME discriminated union the
  config store and coordinator use — no widening. Codes: `invalid_placement`
  (kind-level, incl. `new-child`), `invalid_selector` (selector sub-fields),
  `invalid_environment` (environment selectors). Whether a selector names a real
  environment is checked at start time (`environment_unknown`) — the HTTP layer needs no
  CLI round-trip.

**Web (`web/src/types.ts`, `api.ts`, `harness.ts`, `NodePanel.tsx`, `WorkerPanel.tsx`,
`ExecControls.tsx`, `styles.css`)**
- NodePanel: environment picker (Local default + discovered environments only — nothing
  invented client-side) and a placement editor shown ONLY for a remote environment,
  offering ONLY exact-existing (discovered worktree dropdown, selector stored verbatim)
  or new-top-level (discovered repo dropdown + explicit name). Remote `current`/
  `new-child` are unexpressible. Model/effort pickers hide when the selected peer does
  not advertise `modelEffort` (with an explanatory hint).
- WorkerPanel: execution host line (`local` / `environment <id>` / `unknown` — never
  synthesized), "contact lost is NOT exit" note on unverifiable remote rows, and a
  transcript read source picker gated on `peer.transcriptRead` (auto always available).
- ExecControls sends `environmentMap` + `placementMap` explicitly (no 250 ms config-write
  debounce race). `harness.ts` hydrates both maps backward-compatibly (absent stays
  absent; malformed entries dropped, mirroring the server sanitizer) and clears a node's
  placement when its environment is cleared.

**Docs** — README.md and README_zh.md updated in lockstep: feature bullets (environment +
exact placement; Workers panel host/unverifiable/transcript), `POST /api/run` params, four
new API rows, config description, code-layout entries, and a design-notes boundary
("Remote placement is exact or it doesn't happen").

**Fixture (`server/test/fixtures/fake-orca.mjs`)** — serves `environment list|show` and
`repo/worktree/project list`; records `--on` on dispatch rows; plain `worker-list` hides
remote rows, `--include-remote` reveals them with `projection.host`; start receipts echo
`on`/`worktree`/`agent` (the effective half of the pair).

## Acceptance mapping

| Criterion (plan §Phase 6) | Evidence |
| --- | --- |
| Local and remote workers run in the same DAG sharing one local Run | coordinator.test.ts `starts local and remote workers in one run…` — one coordinator, one Run, `--worktree current` local vs `--on env_remote --worktree id:…::/srv/remote-ws` remote, both settle and release, phase `completed`. |
| Remote exact-workspace AND new-top-level placement both complete and release | Exact-existing: the mixed-DAG test (complete + `worker-release` addressed by Dispatch ID). New-top-level: argv pinned (`--worktree new-top-level --repo id:repoA --name phase6-wt --on env_remote`) + adapter validation tests. Completion/release ON A LIVE HOST: **not exercised — see the honest limitation below.** |
| Disconnecting the remote host produces `unverifiable`, never `exited`, no automatic stop/retry/release | coordinator.test.ts disconnect test: row removed from the fake's fleet → liveness `unverifiable` with reason `execution host env_remote has not reported this dispatch`, `nextAction` nulled, zero `worker-stop`/`worker-release`/`worker-abandon` calls, phase never `completed`. |
| Reconnecting restores liveness and the original Dispatch settles | Same test: row restored → liveness `live` → `worker_done` accepted → `terminalDecision released` → `callsOf("worker-release", --dispatch, rDispatch).length === 1` (the ORIGINAL dispatch id). |
| Mixed-version peers hide unsupported controls; documented older behavior only | `parsePeerCapabilities` gates OFF on absent/unfamiliar advertisement (orca.test.ts); coordinator refuses model/effort forwarding to a non-advertising peer (`capability_not_advertised`, start_failed retained); NodePanel hides model/effort for such peers; WorkerPanel offers transcript reads only where advertised. No behavior is invented for unknown capability names — they degrade to the documented older path. |
| Rollback (per plan: disable remote placement in config/UI; existing remote Dispatches stay visible and settle through Orca before downgrading) | Remote behavior is keyed off `environmentByTask`/`placementByTask`: both absent in config ⇒ byte-identical pre-Phase-6 wire shape (asserted: `buildWorkerStartArgv` local case; local-start argv assertions in coordinator tests). No persistent format migration exists to undo; a downgraded viewer still lists remote Dispatches via `worker-list --include-remote` reads and they remain settleable through Orca's own CLI. |

Work-item mapping (plan items 1–9): discovery endpoints + adapter (1, 2); PlacementSpec
union + NodePanel editor + adapter gate (3, 4); `--on` on worker-start only + Dispatch-ID
routing pinned by the mixed-DAG release assertion (5); `--include-remote` reconciliation +
host-over-absence rule (6); capability gating across adapter/coordinator/UI (7);
missing-row + missing-capability ⇒ `unverifiable`, never a local substitute (8);
local/current default byte-identical and zero-config (9).

## Honest limitation: live connected-host validation was NOT possible

This machine has **no saved remote environment** (`orca environment list` returns `[]` —
only the local runtime is registered), so every REMOTE claim above is verified against:

1. the **live CLI contract** (`worker-start --help`, `environment --help`,
   `worktree/repo/project list --help`, `worker-list --help`, and the runtime-matched
   `placement-and-remote` guide — exact selectors, `--on` semantics, remote
   current/new-child invalidity, Dispatch-ID routing, `--include-remote` behavior); and
2. the **deterministic fake CLI** (`server/test/fixtures/fake-orca.mjs`), which models the
   documented contract: `--on` rows hidden from local fleet listings, `projection.host`
   reporting, receipt echoes.

Consequently the two criteria that require a real execution host — "remote … placement
both complete and release **on their execution host**" and actual disconnect/reconnect of
a real SSH/connected peer — are proven at the contract level (argv, routing, state
machine, UI gating) but NOT end-to-end against a live remote host. First real-host run
should watch: the true capability vocabulary a peer advertises (the parser gates OFF
anything unrecognized, so worst case is hidden controls, not broken starts) and the
`environment show` row shape (parsed tolerantly; unknown fields are ignored by design).

## Exact commands and results (final pass, this session)

```text
npx tsc -p server/tsconfig.json --noEmit
  → clean (exit 0)

npm test -w server        # tsx --test src/*.test.ts
  → # tests 184  # pass 184  # fail 0
    (Phase 6 additions: orca.test.ts +~30 cases, coordinator.test.ts +7 scenarios
     incl. API case, app.test.ts +5 validation cases, config.test.ts +5 cases)

npm run build -w web      # tsc -b && vite build
  → ✓ 249 modules transformed, built in ~1.1s (tsc -b green)

npm run build:npm
  → ✅ Staged npm package → dist-npm (version 0.1.0)

npm pack ./dist-npm --pack-destination /tmp/opencode/pkg-smoke
  → orca-dag-0.1.0.tgz; installed into a scratch prefix (0 vulnerabilities)
    node_modules/orca-dag contains dist/server/index.mjs, web/dist/index.html, skill/SKILL.md

PORT=3987 NO_OPEN=1 ORCA_DAG_NO_SKILL=1 WORKSPACE_DIR=<ws> node node_modules/orca-dag/bin/orca-dag.mjs
  GET /api/health      → {"ok":true,"workspace":"<ws>","worktree":"path:<ws>"}
  GET /api/readiness   → {"cli":"orca","version":"1.4.205","executionEnabled":true}
  GET /api/environments→ {"environments":[]}            ← Phase 6 route live in the package
  GET /                → 200 text/html (SPA index)
  GET /some/route      → 200 (SPA fallback)
  GET /api/nope        → 404 {"error":"not found","code":"not_found"}
  POST /api/run-stop (no token) → 403 invalid_token
  server log: bound to 127.0.0.1 · execution enabled

npm run build:binary      # bun 1.2.23 present — web build → embed → bun --compile
  → ✅ Built dist/orca-dag (101 MB)

PORT=3988 NO_OPEN=1 ORCA_DAG_NO_SKILL=1 WORKSPACE_DIR=<ws> ./dist/orca-dag
  /api/health → ok · /api/readiness → 1.4.205 executionEnabled · /api/environments → []
  GET / → 200 · POST /api/run-stop (no token) → 403

git diff --check
  → clean (exit 0)
```

Scope check: the working tree's modified/untracked set is exactly the union of the
phase file lists (Phases 1–6); no file outside those lists changed and nothing was
deleted. Nothing committed or pushed.

## Known limitations

1. **Live remote host unverified** — see the dedicated section above; the fixture models
   the documented contract, and capability vocabulary is gated-OFF-when-unknown by design.
2. **`environment show` row shape is parsed tolerantly** (id/name spellings, boolean or
   status-string reachability, three capability field spellings). If the real row differs,
   discovery still works (id is the only required field); reachability would render
   `unknown` and capabilities `not advertised` — safe directions, but worth confirming on
   the first real pairing.
3. **Reuse stays a local-placement optimization** (proven-identical placement rule);
   remote terminal reuse via `--terminal` is refused because remote handles must never be
   substituted — Orca would have to expose a remote-safe reuse contract first.
4. **Web has no test runner yet** (per AGENTS.md; Phase 7 adds scripts). Web verification
   for this phase is `tsc -b` via `npm run build -w web` plus the server-side API tests;
   the server owns every behavior the UI gates on.
5. **Effort levels and model ids remain free-text** (charset-validated) exactly as in
   Phase 5; the peer capability gate now sits in front of them for remote nodes.
6. **Bun binary smoke ran on plain Linux x64 only**; cross-compile targets are the
   release workflow's job (`build-all-binaries.sh`), unchanged by this phase.

Rollback (per plan): disable remote placement by clearing `environmentByTask`/
`placementByTask` (or reverting the Phase 6 commit range) — absence of the maps restores
the exact pre-Phase-6 wire shape; no data migration exists to undo. Existing remote
Dispatches stay visible (`worker-list --include-remote`) and must be settled through
Orca before downgrading.
