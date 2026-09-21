# Epic: Orca Orchestration Operations and Observability

## Status

- **State:** approved for implementation
- **Target repository:** Orca-dag
- **Execution harness:** OpenCode
- **Required model:** `zai-coding-plan/glm-5.3-flash#high`
- **Delivery shape:** seven implementation phases followed by one integration gate
- **Primary runtime baseline:** Orca 1.4.206, while preserving the documented 1.4.205 execution floor

## Problem statement

Orca-dag can already schedule a Run, render its task DAG, show bidirectional coordinator/worker messages, record coordinator checks, inspect worker output, and recover several lifecycle failures. The remaining gap is operational completeness: much of Orca's durable state is either visible only while this viewer process owns the coordinator loop, flattened into presentation-only summaries, or hidden behind runtime capability names that the viewer does not yet recognize.

This epic turns the viewer from a scheduler with good activity rendering into a durable orchestration operations console. A user should be able to answer, without leaving the viewer:

1. Who currently owns the Run, and can this viewer safely mutate it?
2. Which workers exist historically and now, what is each agent doing, and which resources still need a decision?
3. Which messages belong to one thread, which are unread or urgent, and whether displayed history is complete.
4. Why is a task not ready, how is it related to a parent task, and what is the next executable wave?
5. Which recovery request or Orca-prescribed next action explains an ambiguous operation?
6. Can the coordinator safely send one message to a worker or an intentional group?
7. Which local or remote orchestration features are actually supported by the connected runtime?

## Product outcomes

### O1 — Honest runtime capability negotiation

The viewer recognizes Orca's canonical capability identifiers, exposes a readable local/remote capability matrix, and gates controls only on positively advertised support. Unknown or absent capabilities remain unsupported rather than being guessed.

### O2 — Durable Run ownership and health

The selected Run clearly reports whether it is viewer-owned, externally coordinated, unbound, fenced, empty, or internally inconsistent. Empty Tasks with retained messages are explained instead of looking like a rendering failure.

### O3 — Durable worker operations

Historical and live workers render from `worker-list`, not only from the current process's in-memory attempts. `worker-show` enriches a selected row with observation and agent-wait evidence, while `worker-read` remains a bounded, explicitly sourced output surface.

### O4 — Faithful conversation semantics

Chat preserves thread identity, message priority, and read state. Replies can quote their originating question. The viewer tells the user when the global Orca inbox window may have truncated older Run history.

### O5 — Explainable DAG scheduling

The graph distinguishes dependency edges from parent/child structure and exposes the next ready wave plus human-readable reasons for pending or blocked stages.

### O6 — Auditable recovery and messaging

Viewer-originated mutation request IDs, recorded outcomes, and prescribed recovery actions are visible. Group guidance is explicit, audience-scoped, confirmed, and available only to the live viewer coordinator.

## Non-goals

- Replacing Orca's lifecycle authority with viewer-local state.
- Inventing a scheduler inside the Run record; the viewer coordinator remains the scheduler.
- Inferring process exit, message delivery, or capability support from absence.
- Rendering full agent transcripts inside Chat. Full output stays in the worker inspector.
- Adding a second test framework or a new persistent database.
- Making `orchestration reset` appear Run-scoped; it remains a global destructive action.
- Supporting arbitrary shell commands or arbitrary group addresses from the browser.

## Architecture decisions

### A1 — Orca remains authoritative

Run, Task, Dispatch, message, worker, gate, and request facts come from Orca CLI receipts. Viewer journals may preserve explanatory events and request IDs but must label their provenance and must never override Orca status.

### A2 — Separate durable data from process-local control

`GET /api/workers?run=` becomes the durable worker inventory. `GET /api/run-status` remains the current viewer coordinator's process-local control state. The UI may merge the two but must retain their provenance.

### A3 — Capability matching uses canonical names first

Recognize the current canonical identifiers:

- `orchestration.worker-launch-preferences.v1`
- `orchestration.federation-structured-read.v1`
- `orchestration.federation-fleet-snapshot.v1`
- `orchestration.federation-control-mail.v1`
- `orchestration.federation-lifecycle-settlement.v1`
- `orchestration.federation-release-archive.v1`
- `orchestration.worker-stop-verdict.v1`

Documented older aliases may remain as compatibility inputs. An unfamiliar name never enables a feature.

### A4 — OpenCode variants are part of the model identity

OpenCode accepts `provider/model#variant`. Validation, persistence, display, and shell quoting must support a bounded variant suffix such as `zai-coding-plan/glm-5.3-flash#high`. The value remains a single safely quoted argument and must not broaden the accepted shell grammar.

### A5 — Read-only surfaces lead

Worker inspection, Run health, ready-wave explanation, capability display, message metadata, and request receipts are implemented before new mutation controls. Broadcast messaging is added only after the read model and authority indicator are reliable.

### A6 — Bounded history must disclose its boundary

`orchestration inbox` is global and has no Run cursor. The server may continue requesting a bounded window, but it must report whether the global limit was reached and therefore whether older Run history may be missing. Local journals extend only what this viewer observed and stay explicitly labeled.

## Data and API additions

The implementation may refine names, but must preserve these semantics:

- `RuntimeCapabilityView`: canonical id, supported state, scope, explanation.
- `RunHealthView`: ownership state, coordinator handle, consumer generation, task/message/worker/gate counts, warnings.
- `WorkerDetailView`: durable worker row plus `worker-show` observation, agent-wait evidence, launch/provider facts, ownership state and next action.
- `MessageMetaView`: thread id, priority, read state and source completeness.
- `DagNode`: optional parent id and readiness explanation.
- `DagResponse`: ready task ids, dependency blockers, hierarchy links, health metadata where appropriate.
- `MutationAuditEntry`: request id, operation, target, state, interpretation, recorded outcome and timestamp.
- `GroupAudience`: allowlisted Orca groups with a previewed recipient count where Orca evidence permits one.

New mutation endpoints remain token-protected and loopback-only. Read endpoints remain strictly Run-scoped wherever the CLI permits it.

## Delivery DAG

```text
Phase 1: capability + Run health foundation
  ├── Phase 2: durable worker operations ── Phase 5: recovery/output audit ─┐
  ├── Phase 3: threaded chat + completeness ─ Phase 6: safe group mail ───┼── Phase 7: integration and release evidence
  └── Phase 4: hierarchy + ready-wave explanation ────────────────────────┘
```

Execution may use a single worker at a time in the shared checkout even when Tasks are dependency-independent. DAG independence describes product dependencies, not permission to create merge conflicts.

## Phase documents

1. `1789983819_phase-1-capability-and-run-health.md`
2. `1789983820_phase-2-durable-worker-operations.md`
3. `1789983821_phase-3-threaded-chat-and-history-integrity.md`
4. `1789983822_phase-4-dag-hierarchy-and-ready-waves.md`
5. `1789983823_phase-5-recovery-and-output-audit.md`
6. `1789983824_phase-6-safe-group-messaging.md`
7. `1789983825_phase-7-integration-docs-and-acceptance.md`

## Global invariants

- Preserve all user changes and do not rewrite unrelated files.
- Keep all user-facing strings and project documentation in English.
- Keep `README.md` and `README_zh.md` synchronized when product behavior changes.
- Keep TypeScript strict and avoid unused declarations.
- Use `apply_patch` for source edits.
- Preserve the `runOrca` no-shell boundary. The only shell-composed OpenCode command must retain strict validation and quoting.
- Never infer `exited`, `delivered`, `read`, `supported`, or `local` from missing data.
- Do not weaken token, loopback, request-size, selector, harness, model, or text validation.
- Do not edit or commit generated/runtime artifacts.
- Every phase must finish with focused tests and `npm run check` unless a prior unrelated failure is recorded precisely.
- A worker must report its actual modified files and test evidence through `worker_done`.

## Acceptance criteria

The Epic is complete only when:

1. Canonical Orca 1.4.206 capabilities are recognized and tested; unknown capabilities stay gated off.
2. `zai-coding-plan/glm-5.3-flash#high` passes OpenCode model validation and remains one quoted argv value.
3. The selected Run visibly distinguishes viewer-owned, external, unbound and inconsistent states.
4. Historical workers remain inspectable after a viewer restart or when the selected Run is not the active coordinator Run.
5. Worker detail presents `worker-show` evidence without treating PTY liveness as agent liveness.
   For the documented `missing_status`/`capability_unsupported` fleet gaps, a positive exact-worker observation is shown as qualified live evidence instead of the generic `Connection unknown` label.
6. Chat renders thread, priority and unread semantics and warns when history completeness is unprovable.
7. Parent/child Task structure and dependency edges are visually distinct, and the next ready wave is readable.
8. Mutation request receipts and archived output can be inspected without replaying a mutation.
9. Group guidance is allowlisted, authority-gated and visibly distinct from one-to-one guidance.
10. Server tests cover new adapters and HTTP boundaries; `npm run check` passes.
11. README documentation explains the new operations surfaces and epistemic limits.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Mixed Orca versions reshape optional receipts | Parse tolerantly, gate on advertised capabilities, retain raw details only behind expandable diagnostics. |
| Parallel workers conflict in shared TypeScript types | Execute with concurrency one or assign non-overlapping ownership; integration phase resolves only proven remaining differences. |
| Global inbox cap silently loses old messages | Return explicit completeness metadata and preserve viewer-observed history with provenance. |
| `worker-show` PTY state is mistaken for agent liveness | Keep fleet liveness authoritative except for the documented capability-gap cases. |
| Broadcast reaches unintended workers | Allowlist audiences, preview scope, require confirmation and require the live viewer coordinator. |
| Request ledger becomes a second authority | Store identifiers and receipts only; refresh through `request-show` and label absent as unknown. |
| OpenCode variant widens shell injection surface | Accept only a bounded provider/model plus optional bounded `#variant`, then quote it as one argument. |
