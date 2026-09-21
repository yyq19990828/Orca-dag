# True bidirectional coordinator chat

## Goal

Turn Chat from a worker-report projection into an honest, Run-scoped,
bidirectional conversation. A successful coordinator dispatch or follow-up must
produce a durable outgoing row, worker messages remain the incoming side, and
the coordinator can send guidance to any currently active Task Dispatch.

## Scope

- Persist one outgoing assignment event after a worker start actually succeeds.
- Add an authenticated API for coordinator guidance to an active Task.
- Deliver guidance through Orca's durable `dispatch:<dispatch_id>` mailbox.
- Persist successful guidance and question replies in the existing activity
  journal with the correct Run, Task, and Dispatch identity.
- Let Chat compose a reply for a pending question or proactive guidance for an
  active Dispatch, using one conversation surface.
- Keep historical Runs readable: when no recorded assignment exists, show the
  Task spec as an explicitly reconstructed brief.
- Add server, adapter, activity, and UI build coverage; update both READMEs.

## Non-scope

- No synthetic acknowledgement after every heartbeat or status update.
- No embedded LLM coordinator or access to private Codex/OpenCode transcripts.
- No messaging to settled, missing, or unverifiable Dispatches.
- No new configuration flag, external service, credential, or database.

## Chosen approach

Use Orca as the delivery authority and `.orca-dag.activity.jsonl` as the
viewer-owned history of coordinator-authored actions. The server sends active
guidance with `orchestration send --to dispatch:<id>` from the live coordinator
terminal, then journals the confirmed enqueue. Incoming worker messages continue
to come from the Run coordinator mailbox through `check --all`.

This preserves an important truth boundary: an outgoing bubble means Orca
accepted a durable enqueue, not that the worker read or followed it.

```text
Chat composer
    |
    v
POST /api/tasks/:taskId/messages
    |
    +--> validate Run + active Task/Dispatch + live coordinator ownership
    |
    +--> orca orchestration send --> dispatch:<dispatchId> mailbox
    |
    +--> ActivityJournal --> SSE/activity snapshot --> outgoing Chat bubble

worker ask/status/heartbeat/done
    |
    +--> Run coordinator inbox --> activity snapshot --> incoming Chat bubble
```

## Public interface changes

### HTTP

`POST /api/tasks/:taskId/messages`

Request:

```json
{ "runId": "run_...", "body": "Please add the missing regression test." }
```

Success means Orca durably enqueued the message. The endpoint requires the
existing mutation token and an execution-capable runtime. It returns `409` when
the viewer does not own a live coordinator for the Run or the Task has no active
Dispatch.

### Orca adapter

Add one typed adapter which sends a normal `status` message to
`dispatch:<dispatchId>` with Run, Task, Dispatch, subject, body, and sender
identity. No shell is involved.

### Activity history

Coordinator-started assignments and confirmed guidance use existing
`ActivityEvent` rows with direction `coordinator_to_agent`. Assignment details
carry the full Task spec; Chat collapses the full brief behind disclosure.

## Implementation phases

### Phase 1: truthful outbound persistence

Add an optional non-fatal coordinator activity sink and emit an assignment only
after worker start returns successfully. Render the recorded assignment when it
exists; keep a clearly labelled reconstruction only for older history.

Acceptance: a newly dispatched Task has exactly one outgoing assignment bubble,
and activity-journal failure never changes worker lifecycle state.

### Phase 2: active follow-up messaging

Add the Orca send adapter and authenticated Task-message endpoint. Resolve the
Task from the requested Run, require `dispatched` plus a Dispatch id, and require
this viewer's live coordinator handle for that Run. Journal only after the send
receipt succeeds.

Acceptance: an active Task receives one `send --to dispatch:<id>` call with the
expected identity arguments; stopped/settled/wrong-Run requests are refused
before any send.

### Phase 3: unified Chat composer and documentation

Use the existing composer for pending-question replies; otherwise enable it for
proactive guidance only while the selected Task has an active Dispatch. Refresh
Activity after success and explain delivery semantics in both READMEs.

Acceptance: outgoing guidance appears in the same Task conversation, completed
Tasks cannot be messaged, question replies retain priority over proactive send,
and the complete repository check passes.

## Failure and rollback rules

- A failed Orca send creates no outgoing event.
- A successful send is not retried automatically because enqueue is already
  durable and a lost response could otherwise duplicate guidance.
- Journal failure is explanatory-state loss only; it must not turn a successful
  Orca mutation into an ambiguous HTTP failure.
- Removing the endpoint, composer branch, and assignment sink rolls back the
  feature. Existing JSONL rows remain valid `ActivityEvent` records.

## Verification

- Adapter test checks exact argv and shell-free execution.
- Coordinator/API test checks successful active guidance and refusal paths.
- Activity test checks recorded assignment/guidance ordering and Run scoping.
- `npm run check`
- `npm audit --audit-level=high`
- `npm run build:npm`
- `TARGET=bun-linux-x64 npm run build:binary`
- Browser acceptance: one active conversation shows recorded assignment,
  incoming Agent update, outgoing coordinator guidance, and an enabled composer;
  a completed conversation shows a disabled explanatory footer.

## Fragile assumption

This plan assumes active workers follow the runtime contract and call
`orchestration check` at natural checkpoints. Orca guarantees durable enqueue,
not immediate attention; therefore the UI must say "sent" rather than "read".

## Follow-up: separate telemetry from conversation

The first browser acceptance exposed an information-hierarchy problem: the
last heartbeat and `worker_done` were both rendered as equal chat bubbles, so a
normal "working, then completed" sequence looked like duplicate completion.
The corrective slice is deliberately projection-only:

- Add compact per-Task presence to the Activity snapshot from the newest
  `worker-list` row: liveness, activity/detail, outcome, attention, and any
  runtime-observed agent/model/effort.
- Show that projection in the selected conversation header. Heartbeat and
  status events update this header instead of becoming transcript bubbles;
  questions, replies, assignments, guidance, and outcomes remain messages.
- Give outcome bubbles a shorter actor + heading hierarchy so a long Task title
  is not repeated twice inside every card.
- Parse the known structured Task result into a readable summary, modified-file
  list, and report link while preserving the complete JSON under collapsed
  technical details.

Acceptance: an active thread visibly answers whether the worker is running and
what Orca last observed without exposing the full agent transcript; a completed
thread contains one completion bubble; and the Stage Result is useful without
reading JSON while retaining lossless technical evidence.

## Follow-up: visible coordinator check receipts

The header-only presence projection still hid the coordinator's ongoing work:
successful empty `check --wait` passes disappeared completely, so an unchanged
status could look frozen. Keep a bounded, in-memory receipt list in the live
coordinator instead of persisting three-second telemetry into the Activity
journal. Record every main-loop check after reconciliation with its duration,
delivery/message metadata, error/replay flags, and compact per-attempt runtime
snapshot. Expose those receipts through the existing Activity snapshot and
render them beneath the real chat bubbles as a distinct live check stream.

Acceptance: empty checks visibly advance; a message-bearing check names its
message type; each selected stage shows the observed agent/model/activity and
liveness from that pass; the list is capped; and no check receipt is presented
as a human or agent chat message.
