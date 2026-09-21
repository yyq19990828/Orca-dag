# Phase 6: Safe Group Messaging

## Objective

Extend the coordinator composer from one-to-one guidance to deliberate, auditable Orca group messages without weakening Run authority or recipient safety.

## Scope

- Add an allowlisted server adapter for supported audiences: `@all`, `@idle`, known harness groups, and exact discovered `@worktree:<id>` values.
- Add a Run-control composer that can choose an audience, subject, priority and status/question type where Orca permits it.
- Preview the audience using current Run worker facts; label the preview as an estimate when Orca cannot prove an exact recipient list.
- Require an in-app confirmation for multi-recipient sends.
- Journal the accepted enqueue receipt and render the outgoing group message distinctly.

## Authority and safety

- The endpoint is enabled only while this viewer is the live coordinator for the selected Run.
- The client cannot provide arbitrary recipient strings.
- Group lifecycle messages such as `worker_done` and heartbeat are forbidden.
- Success means durably enqueued, never read or acted upon.
- Worktree audiences must come from exact Orca-discovered identities rather than free text.

## Likely files

- `server/src/orca.ts`
- `server/src/security.ts`
- `server/src/app.ts`
- corresponding server/security tests
- `web/src/types.ts`
- `web/src/api.ts`
- `web/src/components/ChatPanel.tsx`
- `web/src/components/DecisionDialog.tsx`
- `web/src/styles.css`

## Tests and acceptance

- Tests reject arbitrary addresses, cross-Run attempts, inactive coordinators and lifecycle group messages.
- Tests accept allowlisted Run groups and exact discovered worktree groups.
- UI confirms multi-recipient sends and states the enqueue-only guarantee.
- Outgoing group messages retain audience, priority and provenance.
- `npm run check` passes.

