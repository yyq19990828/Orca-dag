# Activity Inbox and Readable Orchestration Plan

Status: implemented

Date: 2026-09-21

## 1. Objective

Turn Orca's structured orchestration records into a persistent, Run-scoped,
human-readable Activity and Inbox surface without presenting terminal output,
lifecycle telemetry, or scheduler decisions as ordinary chat.

The change also reduces detail-panel density by collapsing each Task spec to a
one-line preview by default.

## 2. Live baseline and evidence

A real demonstration Run was created in this workspace:

- Run: `run_162122ddebd4`
- Task: `task_ada7685585e6`
- Dispatch: `ctx_1bf87f7f89cd`
- Harness: `codex`
- Structured status: `Inbox demo status`
- Blocking question: `Which summary format should the inbox demo use?`
- Coordinator phase while captured: `awaiting_input`

The demonstration proved that the current implementation can:

1. Receive a durable worker question through Orca.
2. Hold the coordinator Delivery open until the question is answered.
3. Render the question body, age, Task id, reply input, and Reply action.
4. Show a fleet row for the live worker.
5. Expose a runtime-prescribed inspection command.

It also exposed the following product gaps:

1. `InboxPanel` and `WorkerPanel` are independent absolute cards and overlap in
   the top-left of the DAG canvas.
2. `/api/inbox` follows the live coordinator Run, while the DAG follows the
   selected Run. A question from an executing Run can therefore appear over a
   different selected Run.
3. Ordinary status events are retained in `inbox.recent` but are not rendered.
4. Raw Task, Dispatch, terminal, and CLI details dominate the presentation.
5. The Task card can show a stored harness preference while the fleet row shows
   the effective harness. The effective runtime fact must win in activity UI.
6. The Inbox disappears when no question, escalation, or cleanup debt is open,
   so it cannot serve as history or as a continuous coordinator-agent view.
7. Repeated heartbeats would overwhelm a naive chronological feed.

## 3. Product principles

1. **Run scope is absolute.** Every Activity request and rendered event must be
   tied to the currently selected Run. Data from another Run must never appear.
2. **Runtime facts win.** Effective harness, model, host, liveness, and outcome
   come from Orca receipts and fleet projections, not from saved preferences.
3. **Readable first, raw evidence available.** Users see phase names and plain
   language first. IDs, payload JSON, and prescribed argv live under Technical
   details.
4. **Do not fabricate reasoning.** The viewer may show coordinator actions,
   agent messages, and worker output. It must not invent coordinator thoughts or
   expose hidden chain-of-thought.
5. **Message and output are different.** Structured messages belong in the
   timeline. Terminal output is an expandable evidence attachment.
6. **Questions remain lifecycle-safe.** A Delivery is acknowledged only after
   the existing reply and ownership rules have completed.
7. **The canvas stays primary.** Stage settings remain a compact card, while
   communication uses a bounded workbench that does not replace the DAG.

## 4. Information architecture

Use two independent surfaces:

- **Stage card**: the existing selected-node configuration and evidence panel,
  anchored at the right side of the canvas.
- **Communication center**: a dedicated left rail with **Activity** and
  **Chat** tabs. Activity shows the chronological work log. Chat projects the
  same normalized events into a stage-grouped conversation list and message
  pane, prefixed by the coordinator's dispatched Task brief.

At desktop widths the communication center participates in layout and the DAG
resizes into the remaining canvas, so it never covers graph content. At narrow
widths it becomes a full-height left drawer. Gate, recovery, and worker details
remain under Activity so they do not compete for the same canvas origin.

The Activity tab contains:

1. A Run identity header and live or historical state.
2. Filters: `All`, `Coordinator`, `Agents`, and `Needs reply`.
3. A chronological event list grouped by date and compact time gaps.
4. Inline reply controls only for actionable questions or escalations.
5. Expandable evidence for message bodies, worker output, raw IDs, payloads,
   and prescribed commands.
6. Click-to-focus behavior that selects the corresponding DAG Task.

## 5. Human-readable event model

Introduce a server-owned normalized type. The browser must not independently
reinterpret raw Orca payload shapes.

```ts
interface ActivityEvent {
  id: string;
  runId: string;
  taskId: string | null;
  dispatchId: string | null;
  direction: "coordinator_to_agent" | "agent_to_coordinator" | "system";
  actor: {
    role: "coordinator" | "lead" | "worker" | "system";
    label: string;
    harness: string | null;
    model: string | null;
  };
  kind:
    | "dispatch_started"
    | "status"
    | "heartbeat"
    | "question"
    | "reply"
    | "worker_done"
    | "escalation"
    | "gate"
    | "recovery"
    | "release"
    | "cleanup_debt"
    | "unknown";
  severity: "info" | "success" | "warning" | "error";
  title: string;
  summary: string;
  detail: string | null;
  createdAt: string;
  actionable: null | {
    kind: "reply" | "release" | "retain" | "retry";
    targetId: string;
  };
  technical: {
    messageId?: string;
    terminalHandle?: string;
    payload?: unknown;
    argv?: string[];
    provenance: "orca_message" | "fleet" | "coordinator" | "viewer_journal";
  };
}
```

### 5.1 Identity resolution

Resolve display identity in this order:

1. Task `displayName`.
2. Task `task_title`.
3. Short Task id.

Decorate that label with:

- `Lead` when the Task matches `leadTaskByRun[runId]`.
- Effective harness and model from the active or settled attempt.
- Requested values only when effective values are unknown, explicitly labeled
  as requested rather than applied.

Never use a terminal handle as the primary actor label.

### 5.2 Parsing rules

| Raw evidence | Primary user text | Secondary behavior |
| --- | --- | --- |
| `dispatch_started` | `Coordinator started <stage>` | Show effective agent, model, host, and Dispatch under details. |
| `status` | `<stage> reported progress` | Prefer a meaningful subject; body expands below it. |
| repeated `heartbeat` | `<stage> is working: <phase>` | Coalesce adjacent heartbeats by Dispatch and phase, show count and latest time. |
| `question` | `<stage> asks: <question>` | Render reply input and hold the needs-reply badge. |
| `reply` | `Coordinator replied to <stage>` | Show reply body and thread relation. |
| successful `worker_done` | `<stage> completed` | Extract verification, files, and report path into readable sections. |
| failed `worker_done` | `<stage> reported failure` | Show explicit outcome and residual blocker. |
| rejected lifecycle message | `Orca rejected a stale lifecycle signal` | Warning, never present it as a Task outcome. |
| `escalation` | `<stage> needs attention` | Warning or error based on payload; preserve exact reason under details. |
| gate | `Decision needed for <stage>` | Render options through the existing gate resolution path. |
| cleanup debt | `Worker cleanup needs a decision` | Explain Release and Retain in user language. |
| `nextAction` inspect command | `Orca recommends inspecting this worker` | Raw argv appears only after expanding Technical details. |
| unknown type or malformed payload | `Unrecognized orchestration event` | Preserve raw evidence, perform no action, and never infer success. |

### 5.3 Summarizing long worker reports

Use deterministic extraction, not a second model call:

1. Prefer `subject` as the headline when it is not a generic token such as
   `alive`, `Question`, or `status`.
2. Split the body into completion, verification, changed files, residual risk,
   and blocker sections using payload fields first and conservative textual
   markers second.
3. Keep the first complete sentence as the collapsed summary.
4. Preserve the original body verbatim under `Full message`.
5. Never turn an unverified claim in prose into a verified badge.

## 6. Task spec density

The selected Task's Spec section is collapsed by default:

- One normalized line with a real expand control.
- Collapsed text: 12.5 px with one-line clamp.
- Expanded text: 13 px with preserved line breaks and approximately 1.6 line
  height.
- `aria-expanded`, keyboard activation, and visible focus are required.
- Switching selected Tasks resets the Spec to collapsed.
- Result remains a separate evidence block and must not be concatenated into
  the Spec preview.

## 7. Backend design

### 7.1 Run-scoped reads

Replace the unscoped `GET /api/inbox` contract with explicit Run scope:

```text
GET /api/activity?run=<run_id>&after=<cursor>&limit=<n>
GET /api/activity/stream?run=<run_id>
```

Every handler validates the Run id and returns only events whose `runId` equals
the request. A coordinator executing Run A must not cause a client viewing Run B
to receive Run A's events.

Keep `/api/inbox` temporarily as a compatibility view over actionable events,
but require `?run=` and remove it after the web client migration.

### 7.2 History and live updates

1. Hydrate inbound Run history once through Orca's read-only `check --all`.
2. Bound the initial import by count and response size. Report truncation rather
   than silently dropping old events.
3. Feed new Delivery rows into the normalized event store when the coordinator
   processes them.
4. Record viewer-originated replies, sends, dispatch decisions, and cleanup
   decisions with their Orca request or message identifiers.
5. Deliver live events through Server-Sent Events with event ids and automatic
   browser reconnection.
6. Fall back to bounded cursor polling when SSE is unavailable.

Because Orca currently exposes inbound Run history but not a single central
two-way conversation list, keep a bounded workspace-local journal for
viewer-originated activity. Name it `.orca-dag.activity.jsonl`, add it to
`.gitignore`, rotate it at a documented size, and treat Orca as authoritative
for lifecycle truth. `orca-dag uninstall --purge` must remove it; ordinary
uninstall must retain it as user-created history, matching config semantics.

### 7.3 Mutation routes

Retain the existing token boundary for all mutations:

```text
POST /api/messages/:id/reply
POST /api/activity/send
POST /api/workers/:dispatchId/release
POST /api/workers/:dispatchId/retain
POST /api/workers/:dispatchId/retry
```

The first release should support replies only. Arbitrary coordinator-to-agent
messages are enabled after attempt-specific `dispatch:<id>` addressing is
tested. Broadcast controls are out of scope for the first UI release.

## 8. Delivery phases

### Phase 0: correctness baseline and fixtures

- Preserve the live demo shapes as sanitized server fixtures.
- Add a regression test proving Inbox and Activity never cross Run boundaries.
- Add a regression test for effective harness winning over stored preference.
- Add malformed payload, unknown type, stale Dispatch, and rejected lifecycle
  fixtures.
- Record the existing overlap at desktop and narrow widths.

Acceptance:

- Tests fail against the current unscoped behavior.
- Fixtures contain no machine-specific tokens, capabilities, or user paths.

### Phase 1: Task spec collapse

- Add the accessible collapsed Spec preview.
- Keep expanded content lossless.
- Verify keyboard, desktop, and narrow layouts.

Acceptance:

- The detail panel opens with no multi-paragraph Spec wall.
- Full content is reachable in one explicit action.

### Phase 2: normalized activity parser

- Add `ActivityEvent` and pure parser functions server-side.
- Resolve Task and Dispatch identities against Run-scoped snapshots.
- Implement deterministic report-section extraction and heartbeat coalescing.
- Preserve raw evidence under `technical`.

Acceptance:

- Every supported message type has positive and malformed tests.
- Unknown input is visible but cannot produce a success state or action.

### Phase 3: Run-scoped history and streaming API

- Add bounded history hydration.
- Add cursor API and SSE stream.
- Add the bounded viewer-originated activity journal and purge symmetry.
- Migrate `/api/inbox` to explicit Run scope.

Acceptance:

- Run A events cannot appear while viewing Run B.
- Reconnect resumes from the last event id without duplication.
- A large Run reports truncation and remains responsive.

### Phase 4: unified Stage and Activity inspector

- Replace overlapping cards with one docked inspector.
- Render filters, actor identity, readable events, technical details, and
  click-to-focus.
- Surface pending count and needs-reply state while collapsed.
- Use the existing hand-drawn paper tokens and component vocabulary.

Acceptance:

- No panels overlap at supported desktop and narrow viewport sizes.
- The DAG remains usable with the inspector open and closed.
- Timeline headlines are understandable without opening Technical details.

### Phase 5: safe interaction controls

- Move question and escalation replies into the Activity timeline.
- Preserve reply-before-ack and terminal-ownership invariants.
- Keep release, retain, and retry actions contextual and evidence-gated.
- Add optional attempt-specific coordinator guidance only after direct-send
  receipts and message attribution are tested.

Acceptance:

- Reply success removes the needs-reply state exactly once.
- Failed or ambiguous mutations remain visible and retry-safe.
- No UI action can acknowledge a Delivery before required work completes.

### Phase 6: documentation and end-to-end validation

- Update `README.md` and `README_zh.md` together.
- Document Activity provenance, retention, raw evidence, and privacy boundary.
- Add API tables and runtime artifact behavior.
- Run the complete project check, package smoke, and binary smoke where
  available.
- Run a real question/reply/completion demonstration and capture screenshots.

Acceptance:

- `npm run check` passes.
- `npm audit --audit-level=high` passes.
- npm package and standalone binary serve the same Activity UI.
- The final demo settles its worker and leaves zero reclaimable workers.

## 9. Verification matrix

| Scenario | Expected result |
| --- | --- |
| No selected Run | Activity explains that a Run must be selected. |
| Selected idle Run | Historical events render without claiming live execution. |
| Different Run executing | No events leak into the selected Run. |
| Worker status | Readable progress event appears without an action. |
| Repeated heartbeat | One coalesced row updates count and latest time. |
| Worker question | Needs-reply badge and inline reply appear. |
| Successful reply | Thread shows the response and clears pending state once. |
| Worker completion | Outcome, verification, files, and report path are separated. |
| Rejected worker_done | Warning is shown and Task is not marked completed by UI inference. |
| Disconnected remote worker | State remains unverifiable, never shown as exited. |
| Coordinator restart | Inbound history rehydrates; journaled viewer actions remain visible. |
| Large history | Result is bounded, cursorable, and explicitly marked truncated. |
| Narrow viewport | Inspector becomes a drawer and never covers action controls. |
| Keyboard-only use | Tabs, filters, expansion, reply, and close are operable. |

## 10. Risks and mitigations

1. **Large `check --all` receipts**: hydrate once, enforce byte and count limits,
   cache normalized output, and surface truncation.
2. **Duplicate events after replay or reconnect**: deduplicate by Orca message id
   plus viewer journal event id.
3. **Confusing requested and effective launch settings**: make effective values
   primary and label requested-only values explicitly.
4. **Heartbeat noise**: coalesce only adjacent events with the same Run,
   Dispatch, type, and phase; never coalesce questions or outcomes.
5. **Journal drift from Orca truth**: journal viewer actions only, include
   provenance and Orca request ids, and never use the journal to settle Tasks.
6. **Accidental chain-of-thought exposure**: structured messages and bounded
   terminal evidence only; no hidden reasoning extraction or synthetic summary
   labeled as an agent statement.
7. **Lifecycle regression**: keep parsing and rendering read-only; all mutations
   continue through existing coordinator functions and security middleware.

## 11. Out of scope

- Sending arbitrary chat messages when no Orca question is pending. Chat is a
  readable projection and lifecycle-safe reply surface, not a new transport.
- Displaying hidden model reasoning or chain-of-thought.
- Editing Orca Task specs or dependencies after creation.
- Cross-Run broadcast UI.
- Treating output activity or heartbeats as completion evidence.
- Auto-answering questions or auto-resolving cleanup debt.

## 12. Recommended implementation order

Implement Phase 0 and Phase 1 together as the first reviewable slice. Then land
the parser and API before changing the panel architecture. The visual inspector
must consume the normalized contract rather than growing another set of raw
payload assumptions in React.

## 13. Implementation record

Implemented on 2026-09-21:

- Added strict Run scope to Inbox and Activity reads, including mixed-Run CLI
  filtering and cross-Run regression coverage.
- Added the server-owned readable parser, heartbeat coalescing, rejected-signal
  warnings, bounded journal, cursor reads, SSE snapshots, and polling fallback.
- Replaced overlapping canvas cards with a communication workbench; Activity
  and Chat share the normalized stream, while Stage settings remain an
  independent right-side card. Operational gate, recovery, and fleet details
  stay with Activity.
- Added stage-grouped conversations, lead-stage decoration, inbound/outbound
  message bubbles, per-thread pending counts, and lifecycle-safe reply
  composition. Coordinator replies preserve the source Task identity in the
  viewer journal so question and answer remain in one conversation.
- Added the compact accessible Task-spec preview and reset-on-selection behavior.
- Verified two real Runs in the browser: the demo Run showed its status/question,
  while the seven-phase Run showed its own progress, completion, escalation,
  grouped heartbeats, lead identity, and stale-signal warnings with no cross-Run
  leakage.
- `npm run check`, `npm audit --audit-level=high`, the staged Node package smoke,
  and the standalone Bun binary smoke all pass.
