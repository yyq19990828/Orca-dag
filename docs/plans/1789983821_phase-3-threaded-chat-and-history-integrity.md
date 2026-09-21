# Phase 3: Threaded Chat and History Integrity

## Objective

Preserve Orca's real conversation metadata and make history completeness explicit without turning agent transcripts into chat messages.

## Scope

- Carry `thread_id`, `priority` and durable `read` state through the activity normalization layer.
- Render reply-to-question relationships and compact thread context.
- Add unread and high/urgent indicators to conversation rows and messages.
- Report global inbox window metadata before Run filtering, including whether the configured limit was reached.
- Surface a clear history completeness warning when older Run messages may be missing.
- Preserve and label viewer journal and inferred-check provenance.

## Data requirements

Message history responses must distinguish:

- complete within the observed global window;
- global window saturated, older history possibly unavailable;
- viewer journal rows;
- Orca durable rows;
- inferred external coordinator checks.

Do not claim a message was unread when `read` is absent. Do not reconstruct a reply link without `thread_id` or an existing evidence-backed rule.

## Likely files

- `server/src/orca.ts`
- `server/src/activity.ts`
- `server/src/activityJournal.ts`
- server activity/app tests
- `web/src/types.ts`
- `web/src/components/ChatPanel.tsx`
- `web/src/components/ActivityPanel.tsx`
- `web/src/styles.css`

## Constraints

- Preserve the vertical, interleaved check timeline and expandable aggregation.
- Continue coalescing repetitive heartbeats and quiet checks.
- Do not expose messages from another Run.
- Do not describe inference as native Orca check history.

## Tests and acceptance

- Threaded question/reply/acknowledgement fixtures render in order.
- Missing `read` is rendered as unknown, not unread.
- High/urgent messages are distinguishable and accessible.
- A saturated global inbox produces a warning even when the selected Run has few messages.
- Existing chat/check tests remain green and `npm run check` passes.

