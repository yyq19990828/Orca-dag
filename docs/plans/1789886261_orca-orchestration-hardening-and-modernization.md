# Orca orchestration hardening and modernization plan

Status: proposed
Created: 2026-09-20 14:37 CST
Target runtime: Orca 1.4.205 or newer for execution; Orca 1.4.160-1.4.204 remains view-only
Repository baseline: `0d6c334` on `main`

## 1. Executive decision

Modernize `orca-dag` around Orca's current supervised-worker contract instead of extending the existing task-polling loop.

The viewer remains the scheduler: it chooses ready tasks, placement, harness, and concurrency. Orca remains the authority for Dispatch identity, coordinator mail, worker liveness, output, settlement, and terminal ownership. The coordinator must therefore consume and acknowledge its Run inbox, reconcile against `worker-list`, and explicitly reuse, retain, or release every settled worker.

The work is split into independently releasable phases. Security and lifecycle correctness ship before worker reuse, remote placement, or UI expansion. The safe default is to release a settled worker; reuse is an optimization added only after the completion boundary is correct.

This plan touches more than eight files and four communicating components (`web`, Express API, coordinator, Orca runtime). The breadth is intentional because the current defects cross trust, lifecycle, persistence, and presentation boundaries. Each phase below is independently mergeable and leaves the product usable.

## 2. Evidence behind the plan

The repository currently:

- builds the web app and server successfully;
- stages and boots the npm package successfully;
- visualizes Run-scoped tasks and gates correctly;
- starts local workers in dependency-parallel waves;
- drops completed/failed attempts from memory before performing supervised-worker cleanup;
- does not call `orchestration check`, `reply`, `worker-list`, `worker-release`, `worker-retain`, `worker-read`, or `request-show`;
- retries some start failures by freeing an in-memory slot rather than following the mutation receipt;
- hard-codes the executable name `orca`;
- exposes mutation routes through an unrestricted CORS server listening on the default Node host;
- accepts custom commands and OpenCode model values that eventually reach a shell-backed terminal;
- documents worker reuse and reclamation even though the implementation neither reuses nor normally releases settled supervised workers.

The installed Orca 1.4.205 runtime provides the missing primitives: durable FIFO Deliveries, blocking `check --wait`, `ask`/`reply`, fleet-level liveness, `nextAction`, output archives, idempotent request IDs, release/retain/abandon, model effort, exact worktree placement, and connected-server execution.

## 3. Goals

1. Make the local HTTP control plane safe by default.
2. Make every supervised Dispatch reach an explicit, evidence-backed terminal ownership decision.
3. Recover correctly after viewer restart, lost CLI responses, and partial worker startup.
4. Resolve the correct Orca executable and workspace on Linux, macOS, Windows, WSL, npm, and standalone-binary paths.
5. Surface questions, escalations, liveness, output, model effort, and recovery state in the viewer.
6. Add remote execution without weakening local authority or liveness rules.
7. Replace duplicated, drifting Orca instructions with a thin project skill that loads the runtime-matched guide.
8. Add automated coverage for orchestration state transitions and API security.

## 4. Non-goals

- Do not turn the viewer into an Orca plugin; it remains an external browser tab and server.
- Do not add an embedded planning model or Claude Agent SDK.
- Do not change Orca's Run, Task, Dispatch, or Gate schemas.
- Do not add task editing or single-task deletion; rebuilding a DAG in a new Run remains the rule.
- Do not delete `.orca-dag.config.json` during upgrade or uninstall without `--purge`.
- Do not auto-abandon, auto-retry, or auto-release an `unverifiable` worker.
- Do not remove the verified OpenCode legacy path until `worker-start --agent opencode` prompt delivery is revalidated end to end.
- Do not perform a React 19, Express 5, Vite 8, or dagre 3 migration in the same release.

## 5. Hard constraints

- Keep all user-facing strings and primary documentation in English; mirror README changes in `README_zh.md`.
- Preserve `skill/SKILL.md` frontmatter and the published skill name `orca-dag`.
- Keep startup skill installation best-effort, idempotent, and symlink-safe.
- Keep uninstall symmetric with every external artifact startup creates.
- Keep subcommand dispatch before Express app construction.
- Never edit or commit generated/runtime artifacts listed in `AGENTS.md`.
- Preserve rich “why” comments around Orca behavior.
- Keep ESM, TypeScript strict mode, and the existing npm and Bun distribution paths.
- Never substitute `terminal close` for an uncertain supervised-worker release.
- Never infer process exit from missing status, timeout, or lost remote contact.

## 6. Chosen architecture

```text
React viewer
  |  same-origin HTTP + per-process mutation token
  v
Express app --------------------------------------------------+
  |                                                         |
  | read APIs                                                | mutation APIs
  v                                                         v
Orca adapter <---- typed receipts / capability checks ---- Coordinator state machine
  |                                                         |
  | task-list, gate-list, worker-list, worker-read           | check --wait / reply
  |                                                         | worker-start / stop
  +--------------------- resolved Orca argv ----------------+ release / retain
                            |
                            v
                     Orca 1.4.205 runtime
                            |
                  local or connected worker host
```

### 6.1 Authority boundaries

- The browser may request actions but never constructs Orca argv.
- The Express server validates every mutation and converts validated values into typed coordinator commands.
- The coordinator owns scheduling policy and the bound Run inbox.
- Orca owns Dispatch authority, worker liveness, output evidence, and terminal cleanup.
- A remote execution host owns process, filesystem, transcript, stop, and cleanup facts for its workers.

### 6.2 Coordinator completion boundary

A Run is complete only when all of the following are true:

1. No task is `ready` or `dispatched`.
2. Every expected Dispatch has an accepted `worker_done` or an explicit failed/stopped outcome.
3. Every consumed Delivery has been fully processed and acknowledged.
4. `worker-list --run <id> --terminal-state reclaimable` returns no rows.
5. Every settled worker is recorded as reused, retained by explicit user choice, or released.
6. The coordinator terminal closes successfully or reports a cleanup error to the UI.

### 6.3 State ownership

`worker-list` and coordinator Deliveries are authoritative. The in-memory `attempts` map becomes a cache derived from Orca state, not the source of truth.

The coordinator state exposed through `/api/run-status` becomes:

```text
idle | binding | recovering | running | awaiting_input | stopping | completed | error
```

It includes active Dispatches, pending questions/escalations, unresolved cleanup actions, last successful reconciliation, and the literal recovery action supplied by Orca where present.

## 7. Public interface changes

### 7.1 HTTP security contract

- Listen on `127.0.0.1` by default, not all interfaces.
- Remove unrestricted `cors()` from production.
- Generate a cryptographically random token at process start.
- Add `GET /api/session`, returning the token with `Cache-Control: no-store`.
- The web client fetches the token once and sends `X-Orca-Dag-Token` on every `POST` and `PUT`.
- Reject missing or invalid tokens with HTTP 403 before parsing action-specific input.
- Keep read-only endpoints token-free on loopback.
- Allow arbitrary custom harness commands only when `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` is set. Known Orca agent IDs remain zero-setup.
- Validate OpenCode model IDs against the same `provider/model` grammar used by model enumeration.

No remote network-listen mode is added in this plan. Remote workers are reached through Orca's connected-server contract while the viewer itself remains loopback-only.

### 7.2 Readiness and status APIs

Add:

- `GET /api/readiness` — resolved CLI, runtime version, required capabilities, execution-enabled flag, and actionable incompatibility reason.
- `GET /api/workers?run=<id>` — normalized worker accounting and liveness.
- `GET /api/workers/:dispatchId/output?cursor=<cursor>&limit=<n>` — bounded `worker-read` output.
- `POST /api/messages/:id/reply` — reply to a pending worker question.
- `POST /api/workers/:dispatchId/retain` — explicit debug retention.
- `POST /api/workers/:dispatchId/release` — explicit post-settlement release.
- `POST /api/workers/:dispatchId/retry` — retry only a positively failed/stopped Dispatch, repeating its explicit placement.

Change:

- `POST /api/run-stop` returns per-Dispatch stop/abandon/unknown results instead of unconditional `{ ok: true }`.
- `GET /api/run-status` returns coordinator phase, pending Deliveries, worker projections, and cleanup debt.
- `GET /api/health` remains a process-only health endpoint so package CI does not require Orca.

### 7.3 Viewer config schema

Preserve all existing fields and add optional fields through the existing sanitizer:

```text
effortByTask: Record<taskId, effort>
environmentByTask: Record<taskId, savedEnvironmentId>
placementByTask: Record<taskId, exactWorktreeSelector | new-top-level descriptor>
retainByTask: Record<taskId, boolean>
```

Absence preserves current local/current-worktree behavior. Unknown fields remain ignored. Existing config files require no migration rewrite.

## 8. Implementation phases

### Phase 1 — Secure the local control plane

Outcome: the existing viewer keeps its current behavior, but cross-origin and LAN callers cannot invoke orchestration mutations by default.

Files:

- `server/src/index.ts`
- new `server/src/app.ts`
- new `server/src/security.ts`
- `server/package.json`
- `web/src/api.ts`
- `web/src/main.tsx`
- `README.md`
- `README_zh.md`
- `.github/workflows/ci.yml`

Work:

1. Move Express construction and route registration into `createApp()` so it can be tested without binding a fixed port.
2. Bind startup explicitly to `127.0.0.1`.
3. Remove the `cors` runtime dependency.
4. Add a per-process 256-bit mutation token and constant-time validation middleware.
5. Fetch and retain the token in the web API module before enabling mutation controls.
6. Return 403 for missing/invalid tokens and 503 while the client session is not initialized.
7. Reject custom harness commands unless `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` is set; expose the flag state in `/api/session` so the UI can hide or disable “Custom…”.
8. Validate maps, task IDs, run IDs, concurrency, harness names, and model strings at the server boundary rather than relying on TypeScript casts.
9. Keep `/api/health` and static assets accessible without a token.

Acceptance:

- Server socket is loopback-only in `ss`/`lsof` output.
- Same-origin viewer can create a Run, start/stop, resolve a gate, and save config.
- Mutation without `X-Orca-Dag-Token` returns 403 and performs no Orca command.
- A browser page from another origin cannot obtain the token or complete a mutation.
- Custom commands are rejected by default and work only with the explicit environment flag.
- `npm test`, server typecheck, web build, and npm package smoke test pass.

Rollback: revert this phase; no persistent data format or Orca state is migrated.

### Phase 2 — Make CLI and workspace resolution deterministic

Outcome: every Orca call uses one resolved executable/argv and one exact workspace identity.

Files:

- `server/src/orca.ts`
- `server/src/index.ts`
- `server/src/uninstall.ts`
- new `server/src/orca.test.ts`
- `README.md`
- `README_zh.md`
- `AGENTS.md`

Work:

1. Resolve the Orca command once at startup in this order: `ORCA_CLI_COMMAND`, `orca-dev` when `ORCA_DEV_REPO_ROOT` exists, `orca-ide` on Linux outside a managed Orca terminal, otherwise `orca`.
2. Represent the result as `{ executable, prefixArgs }`; parse quoted `ORCA_CLI_COMMAND` into argv without shell expansion and reject operators/redirections.
3. Pass all later CLI calls through that immutable command specification with `shell: false`.
4. Resolve `WORKSPACE_DIR` to an existing real path and run relevant CLI processes with that cwd.
5. If `ORCA_WORKTREE` is absent, use the exact `path:<WORKSPACE_DIR>` selector instead of ambiguous `active`; an explicit `ORCA_WORKTREE` continues to win.
6. Replace the global terminal title with `orca-dag coordinator · <workspace-hash> · <instance-id>`.
7. Detect another connected coordinator for the same workspace and return `coordinator_conflict`; never silently reuse or close it.
8. Keep the stable `orca-dag coordinator` prefix so uninstall can still discover all versions, but report each workspace before closing it.
9. Add `/api/readiness`; require Orca 1.4.205 for execution and allow older supported runtimes to remain read-only.
10. Disable Run, gate resolution, and other mutations in the UI when readiness says execution is unavailable.

Acceptance:

- Tests cover every executable-resolution branch, quoted paths, rejected shell operators, and missing executables.
- `WORKSPACE_DIR=/absolute/B` started from directory A creates coordinator and workers in B.
- Two viewers for different workspaces never reuse each other's coordinator terminal.
- A second viewer for the same workspace reports a conflict without fencing the first.
- Linux outside Orca never invokes `/usr/bin/orca` accidentally.
- npm and standalone-binary startup paths both pass readiness checks.

Rollback: revert this phase; terminal titles created by it remain removable because the prefix is unchanged.

### Phase 3 — Close the supervised-worker lifecycle

Outcome: normal local DAG execution follows the Orca 1.4.205 completion contract and leaves no reclaimable worker terminals.

Files:

- `server/src/orca.ts`
- `server/src/coordinator.ts`
- new `server/src/coordinator.test.ts`
- `server/src/app.ts`
- `web/src/api.ts`
- `web/src/types.ts`
- `web/src/components/ExecControls.tsx`
- new `web/src/components/InboxPanel.tsx`
- `web/src/App.tsx`

Work:

1. Add typed adapter methods for `check`, `reply`, `worker-list`, `worker-release`, `worker-retain`, and `worker-read`.
2. Replace the fixed 3.5-second coordinator sleep with rolling `check --wait --types worker_done,escalation,question` calls and a periodic task/worker reconciliation.
3. Process every row in the returned FIFO Delivery, even when the wake type matched only one row.
4. Validate `worker_done` against the expected active Dispatch and its outcome before treating it as settlement.
5. Default to `worker-release` after accepted success or failure; preserve archived output through `worker-read`.
6. Do not acknowledge a Delivery until all rows and terminal ownership decisions in it are processed successfully.
7. Surface questions and escalations in `InboxPanel`; reply through `orchestration reply`, then continue processing and acknowledge the Delivery.
8. Treat heartbeat and visible activity only as liveness evidence, never as completion.
9. End a Run only after the completion boundary in section 6.2 passes.
10. On explicit Stop, enumerate active Dispatches, invoke `worker-stop`, and report every uncertain/refused result instead of swallowing it.
11. Keep the OpenCode legacy path, but mark its tracking Dispatch as unsupervised and close only its proven viewer-created terminal.

Acceptance:

- A two-wave DAG runs in dependency order and respects `maxConcurrency`.
- Successful and failed workers both archive output and reach `released` unless explicitly retained.
- `worker-list --run <id> --terminal-state reclaimable --json` is empty when the viewer reports completion.
- A worker question appears in the UI, receives a reply, and the same Delivery is acknowledged exactly once afterward.
- Duplicate/replayed `worker_done` does not double-release or advance another task.
- Stop reports live, stopped, unverifiable, and failed cleanup cases distinctly.
- Coordinator tests cover success, failure, question, escalation, replay, release_pending, and release_unknown.

Rollback: stop the coordinator before reverting. Archived worker output and settled Orca records remain valid.

### Phase 4 — Add restart recovery and idempotent mutations

Outcome: viewer crashes, transport failures, and partial starts do not create duplicate workers or lose cleanup ownership.

Files:

- `server/src/orca.ts`
- `server/src/coordinator.ts`
- `server/src/coordinator.test.ts`
- `server/src/app.ts`
- `web/src/types.ts`
- `web/src/components/ExecControls.tsx`
- new `web/src/components/RecoveryPanel.tsx`

Work:

1. Preserve full worker-start receipts: stage, failedStage, setup, effects, residualResources, Dispatch ID, request ID, and recovery commands.
2. Generate one durable retry-request ID per mutation and retain it until the outcome is known.
3. On a lost response, call `request-show`; replay only when Orca reports `pending` and instructs retry with the same ID.
4. On coordinator start, reconcile `task-list` with scoped `worker-list` before dispatching anything.
5. Adopt active Dispatches into the in-memory projection and count them against concurrency.
6. Follow literal `projection.nextAction` only when it contains argv; never invent an action for `none`.
7. Automatically release positively reclaimable settled workers; leave `unverifiable`, retained, or release_unknown rows visible for a user decision.
8. Remove the automatic “delete attempt and retry next tick” behavior.
9. Add an explicit retry action that requires a positively failed/stopped Dispatch and repeats agent, model, effort, environment, and placement.
10. Persist only viewer preferences, not transient authority credentials or Dispatch capabilities, in `.orca-dag.config.json`.

Acceptance:

- Killing and restarting the viewer during an active DAG does not exceed the configured concurrency.
- No second Dispatch is created when the original worker-start outcome is ambiguous.
- Failed-before-ready starts retain their receipt and can be released using Orca's prescribed action.
- `unverifiable` remote or local workers are never stopped, abandoned, retried, or released automatically.
- Restart tests cover active, settled-reclaimable, retained, release_pending, release_unknown, missing-status, and stale-status projections.

Rollback: stop new scheduling first; existing Dispatches remain owned by Orca and can be recovered by its version-matched orchestration guide.

### Phase 5 — Add worker observability, reuse, and launch preferences

Outcome: the viewer uses current local orchestration capabilities without weakening the lifecycle guarantees established earlier.

Files:

- `server/src/config.ts`
- `server/src/orca.ts`
- `server/src/coordinator.ts`
- `server/src/app.ts`
- `web/src/api.ts`
- `web/src/harness.ts`
- `web/src/types.ts`
- `web/src/components/NodePanel.tsx`
- `web/src/components/ExecControls.tsx`
- new `web/src/components/WorkerPanel.tsx`

Work:

1. Add worker projection fields: fleet liveness, attention categories, agent wait evidence, terminal state, requested/effective launch preferences, and next action.
2. Add bounded output viewing with source label, cursor, clipping warnings, and source_changed restart behavior.
3. Add per-task effort selection only when a model is set and the selected harness supports it.
4. Compare requested and effective model/effort and display the effective values; never claim a requested preference was applied without receipt evidence.
5. Reuse a settled terminal only for an immediate ready follow-up with the same agent and compatible placement; start it with `worker-start --terminal <handle>` before acknowledging the old Delivery.
6. Release the worker when no compatible immediate follow-up exists.
7. Add an explicit “Retain for debugging” control; retained workers remain visible until manually released.
8. Remove README claims that exceed the implemented behavior and update them again only when acceptance proves reuse.

Acceptance:

- Output remains readable after worker release.
- Liveness displays only `live`, `unverifiable`, or `exited` and includes the reported reason.
- Reuse transfers ownership to exactly one new Dispatch and does not close the reused terminal.
- Different harness/model/placement choices force release plus a fresh worker.
- Model/effort requested/effective mismatch is visible.
- Config hydration remains backward compatible with files lacking the new maps.

Rollback: disable reuse and return to release-after-settlement; observability endpoints are read-only and may remain.

### Phase 6 — Add connected-server and exact-placement execution

Outcome: a node can run on a saved Orca environment while the Run and coordinator remain authoritative on the local server.

Files:

- `server/src/config.ts`
- `server/src/orca.ts`
- `server/src/coordinator.ts`
- `server/src/app.ts`
- `web/src/api.ts`
- `web/src/harness.ts`
- `web/src/types.ts`
- `web/src/components/NodePanel.tsx`
- `web/src/components/WorkerPanel.tsx`
- `README.md`
- `README_zh.md`

Work:

1. Discover saved targets with `orca environment list --json` and inspect selected targets with `environment show`.
2. Discover exact repositories/workspaces through `project setups`, `repo list`, and `worktree list` on the selected environment.
3. Support only two remote placement forms: an exact existing workspace selector or `new-top-level` with exact repo selector and explicit name.
4. Reject remote `current` and `new-child` before invoking Orca.
5. Pass `--on` only to `worker-start`; address all later reads, messages, stop, and cleanup by Dispatch ID.
6. Reconcile remote workers with `worker-list --include-remote` and honor execution-host liveness over local absence.
7. Gate model/effort and structured-read UI on peer-advertised capabilities.
8. If a host is unavailable or lacks fleet-snapshot capability, render `unverifiable` and preserve the Dispatch without synthetic local fallback.
9. Keep local/current placement as the zero-configuration default.

Acceptance:

- Local and remote workers can run in the same DAG while sharing one local Run.
- Remote exact-workspace and new-top-level placement both complete and release on their execution host.
- Disconnecting the remote host produces `unverifiable`, never exited, and triggers no automatic stop/retry/release.
- Reconnecting restores liveness and allows the original Dispatch to settle.
- Mixed-version peers hide unsupported controls and continue with documented older behavior only where Orca explicitly permits it.

Rollback: disable remote placement in config/UI. Existing remote Dispatches stay visible and must be settled through Orca before downgrading.

### Phase 7 — Align the published skill, dependencies, CI, and release docs

Outcome: installed instructions cannot drift silently from the runtime and every supported path is continuously checked.

Files:

- `skill/SKILL.md`
- `scripts/check-skill.mjs`
- `package.json`
- `package-lock.json`
- `server/package.json`
- `web/package.json`
- `.github/workflows/ci.yml`
- `README.md`
- `README_zh.md`
- `AGENTS.md`

Work:

1. Keep the project skill focused on PRD, technical design, DAG creation, and launching the viewer.
2. Make it resolve the correct CLI and load `skills get orchestration` before issuing orchestration commands.
3. Remove copied lifecycle/recovery rules now owned by the runtime-matched guide.
4. Fix the contradiction claiming tasks/dependencies can be adjusted after creation.
5. Update the documented execution baseline to Orca 1.4.205 and explain view-only behavior on 1.4.160-1.4.204.
6. Add root scripts: `typecheck`, `test`, `check:skill`, and `check`.
7. Use Node's built-in test runner through existing `tsx`; do not add a second test framework.
8. Run the existing package and binary smoke tests after all new tests.
9. Refresh the lockfile to patched compatible versions, including Express 4.22.3, qs 6.16.0, and patched build-time dependencies; defer all major upgrades.
10. Extend `check-skill.mjs` to reject bare hard-coded Orca guidance that bypasses runtime guide loading while preserving frontmatter checks.
11. Keep install/uninstall round-trip coverage and add workspace-specific coordinator cleanup coverage.

Acceptance:

- `npm run check` performs skill validation, server typecheck, web typecheck/build, and tests.
- `npm audit` reports no fixable high-severity findings under the compatible dependency ranges.
- CI stages, packs, boots, and uninstalls the npm artifact.
- The Bun binary embeds the updated skill and SPA and passes its smoke test.
- README and README_zh describe identical features and safety boundaries.
- A newly installed skill loads the version-matched orchestration guide before planning a DAG.

Rollback: dependency and documentation changes can be reverted independently; published npm versions remain immutable, so a release regression requires a new patch version.

## 9. Test strategy

### 9.1 Unit tests

- Orca command resolution and no-shell argv parsing.
- JSON success, structured failure, non-zero receipt, malformed output, timeout, and lost-response parsing.
- Task-to-DAG projection and dependency filtering.
- Config sanitization for every existing and new field.
- HTTP token validation, input schemas, custom-command policy, and loopback binding.
- Coordinator reducer/state transitions for every message and worker projection class.

### 9.2 Integration tests with a fake Orca executable

Add a deterministic fixture executable under `server/test/fixtures/fake-orca.mjs`. It reads argv, emits versioned JSON fixtures, records mutations, and supports scripted FIFO Deliveries. Tests must cover:

- two parallel roots followed by a dependent task;
- worker success and failure;
- question/reply and Delivery replay before ack;
- release_pending and release_unknown;
- viewer restart with active Dispatches;
- ambiguous worker-start followed by `request-show`;
- explicit stop with mixed results;
- local/remote liveness disagreement;
- OpenCode legacy tracking Dispatch.

### 9.3 Live Orca acceptance

Run against Orca 1.4.205 in a disposable Run; never use orchestration reset.

1. Create a fresh Run with two root tasks, one dependent task, one question-producing task, and one gated task.
2. Execute with concurrency two using Claude/Codex and verify task ordering.
3. Verify inbox reply, gate resolution, worker output archive, and zero reclaimable workers.
4. Restart the viewer during a worker and verify adoption without duplicate Dispatch.
5. Stop an active worker and verify the exact result is shown.
6. Execute one OpenCode task with an enumerated model.
7. When Phase 6 lands, repeat one task on a saved remote environment and disconnect/reconnect the host once.

### 9.4 Distribution checks

```bash
npm ci
npm run check
npm run build:npm
npm pack ./dist-npm --pack-destination /tmp
TARGET=bun-linux-x64 npm run build:binary
```

Boot the packed npm artifact and binary with `NO_OPEN=1`, verify `/api/health`, `/api/readiness`, `/`, token-protected mutations, skill installation, and uninstall symmetry.

## 10. Migration and compatibility

- No Orca database migration is performed.
- Existing Runs, Tasks, Gates, and Dispatches remain in Orca.
- Existing `.orca-dag.config.json` files continue to load; new fields are optional.
- Stored custom harness values remain visible but disabled until `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` is supplied.
- Orca 1.4.160-1.4.204 can still render Runs/tasks/gates when compatible read commands work, but execution controls remain disabled with an upgrade message.
- Runtime 1.4.205+ is capability-checked at startup; optional remote controls remain hidden when the peer lacks required capabilities.
- The coordinator terminal title prefix remains backward compatible with uninstall discovery.

## 11. Release strategy

Each phase is a narrow commit and releasable checkpoint. Do not combine all phases into one review.

Recommended release slices:

1. `security: lock down the local orchestration control plane`
2. `fix: resolve Orca CLI and workspace identity deterministically`
3. `fix: close the supervised worker lifecycle`
4. `feat: recover orchestration state and mutations after restart`
5. `feat: expose worker output, liveness, reuse, and effort`
6. `feat: support connected Orca execution hosts`
7. `docs: align skill and release checks with Orca 1.4.205`

Before every release:

- require a clean tree and `main === origin/main` through the existing release script;
- run `npm run check` and `npm run build:npm` locally;
- inspect `npm audit` and explain any remaining non-fixable advisory;
- verify the npm package and one Bun binary smoke test;
- use the tag as the version of record;
- do not cut a new version for a credential-only publish failure.

## 12. Rollback and failure handling

- Application rollback is a package/binary downgrade; no project files are rewritten except the backward-compatible viewer config.
- Never roll back while a coordinator is actively scheduling. Stop it, inspect worker accounting, and settle or retain every Dispatch first.
- A failed release does not justify resetting orchestration state.
- If a new coordinator cannot interpret a response, preserve the raw receipt, stop new scheduling, and expose the state as unknown rather than guessing.
- If remote contact is lost, leave the worker `unverifiable` until the execution host returns or the user explicitly chooses an Orca-supported recovery action.
- If the OpenCode workaround becomes incompatible, disable OpenCode launch while preserving other harnesses; do not fall back to unquoted shell injection.

## 13. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Runtime contract changes again | Coordinator drift | Require 1.4.205 for execution, load runtime-matched guidance, capability-check optional behavior, and keep typed raw receipts. |
| Inbox event handling deadlocks | DAG stops progressing | Keep FIFO Delivery visible, never ack partially processed batches, expose pending action and add replay tests. |
| Release response is ambiguous | Terminal ownership unknown | Preserve release_pending/release_unknown and follow Orca's exact next action. |
| Viewer restart duplicates workers | Cost and file conflicts | Reconcile `worker-list` and `request-show` before any new dispatch. |
| Remote host disappears | Incorrect stop/retry | Render unverifiable and take no destructive action from absence. |
| Security token breaks dev proxy | Mutations unusable in dev | Fetch through Vite's same-origin `/api` proxy and cover it in the dev smoke check. |
| Custom command restriction surprises users | Existing workflow blocked | Preserve stored value, provide explicit opt-in env, and document the security reason. |
| Broad refactor destabilizes packaging | npm/binary regression | Keep each phase independently packageable and run both artifact smoke paths in CI. |

## 14. Premise-collapse check

This plan assumes Orca 1.4.205's supervised-worker and Delivery contracts are the stable execution floor. If that assumption fails, execution must disable itself through `/api/readiness`; DAG visualization stays available, raw receipts remain visible, and the viewer must not fall back to the old polling-only scheduler or guessed cleanup behavior.

## 15. Surface delta

New environment variable:

- `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` — explicitly enables arbitrary custom harness commands.

New HTTP routes are listed in section 7.2. No new service, account, API key, database, language runtime, or user-installed dependency is required. Remote execution uses Orca environments the user has already saved; the viewer does not manage pairing credentials.

## 16. Definition of done

The modernization is complete when:

- the viewer is loopback-only and all mutations require a valid per-process token;
- no untrusted model value is interpolated into a shell command;
- every supervised worker has an explicit reuse/retain/release outcome;
- coordinator Deliveries are processed fully and acknowledged exactly once;
- restarts and ambiguous mutations do not create duplicate Dispatches;
- local and remote liveness are represented without treating absence as exit;
- questions, escalations, output, model/effort, and recovery state are visible and actionable;
- `worker-list --terminal-state reclaimable` is empty after a completed local Run;
- the project skill loads the runtime-matched orchestration guide;
- `npm run check`, npm package smoke, Bun binary smoke, install/uninstall round trip, and live Orca acceptance all pass;
- README, README_zh, AGENTS.md, API docs, and actual behavior agree.
