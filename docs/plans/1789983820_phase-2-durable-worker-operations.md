# Phase 2: Durable Worker Operations

## Objective

Replace the process-local worker panel with a Run-scoped, durable operations view backed by Orca fleet accounting and on-demand worker inspection.

## Scope

- Expand the `/api/workers` view model beyond launch-lock identity fields.
- Add a Run-scoped worker detail endpoint backed by `worker-show --dispatch`.
- Preserve the distinction between fleet liveness and PTY observation.
- Render historical and active workers even when this viewer is not coordinating the selected Run.
- Add filters for terminal/accounting state and attention categories.
- Keep bounded `worker-read` output in the inspector with explicit source, cursor, clipping and source-change information.
- Show agent-wait evidence when Orca provides it; absence remains unknown.
- For the documented fleet gaps `missing_status` and `capability_unsupported`, merge an exact execution-host `worker-show` observation into the presentation. A proven live terminal/agent must read as `Agent working · terminal live · supervised liveness unavailable`, not the misleading generic `Connection unknown`; keep both evidence layers visible and never promote a merely live PTY into supervised fleet liveness.

## UX requirements

- A worker row shows task, dispatch, outcome, liveness, host, provider/model, terminal ownership and attention.
- Details show observation evidence, requested/effective launch preferences, next action and output controls.
- Destructive actions remain unavailable unless their existing lifecycle preconditions are positively proven.
- Raw receipts may appear only in an expandable diagnostic section.

## Likely files

- `server/src/orca.ts`
- `server/src/app.ts`
- corresponding server tests
- `web/src/types.ts`
- `web/src/api.ts`
- `web/src/components/WorkerPanel.tsx`
- `web/src/styles.css`

## Constraints

- `worker-list` remains fully paginated and Run-scoped.
- Remote workers require `--include-remote`.
- Never promote `worker-show.observation.status` over fleet liveness except for the runtime-documented capability-gap reasons.
- Do not put full worker transcripts into Chat.
- Preserve release/retain/retry safety checks.

## Tests and acceptance

- Tests cover worker-list history with the coordinator stopped and after process restart.
- Tests cover agent-wait present, null and absent.
- Tests cover an unsupervised/context-only OpenCode Dispatch whose fleet verdict is `unverifiable/missing_status` while `worker-show` proves the exact agent terminal live; Chat and Worker Operations render the qualified working state rather than a false disconnect.
- UI renders active, released, retained, reclaimable and unverifiable rows.
- Output pagination and source-change warnings still work.
- `npm run check` passes.
