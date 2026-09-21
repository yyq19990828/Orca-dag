# Phase 5: Recovery and Output Audit

## Objective

Expose viewer-originated mutation identities, Orca-recorded recovery outcomes and archived worker output as an auditable read model.

## Scope

- Persist bounded viewer-originated request metadata needed to call `request-show` after a response loss or restart.
- Add read-only request inspection and a recovery/audit list scoped to this workspace and Run where the recorded operation supplies that scope.
- Display `completed`, `pending`, `absent` and unresolved states using Orca's interpretation.
- Link worker start/release/retain/stop audit entries to their Dispatch and Task when known.
- Improve output inspection with source badges, search/filter within loaded rows, and a safe local export/download of already-read content if practical.
- Expose release archive facts without treating archive presence as worker settlement.

## Constraints

- The ledger is not a second lifecycle authority.
- `request-show absent` never proves that a mutation did not happen.
- Never replay a mutation from the read-only detail surface.
- Store no credentials and no unbounded transcript bodies in viewer config.
- Keep request metadata bounded and atomic, with the same durability expectations as the activity journal.

## Likely files

- `server/src/orca.ts`
- `server/src/activityJournal.ts` or a focused audit journal
- `server/src/app.ts`
- relevant server tests
- `web/src/types.ts`
- `web/src/api.ts`
- `web/src/components/WorkerPanel.tsx` or a focused audit component
- `web/src/styles.css`

## Tests and acceptance

- Lost-response fixtures remain idempotent and become inspectable after reconstructed state.
- Completed, pending and absent request receipts have distinct readable presentation.
- Output search does not fetch or render an unbounded transcript.
- No read endpoint replays a mutation.
- `npm run check` passes.

