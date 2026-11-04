# HTTP API Reference

English | [简体中文](http-api_zh.md)

Back to [README](../../README.md) · [Documentation Index](../README.md)

The `orca-dag` viewer provides a loopback HTTP REST and SSE API for DAG inspection, coordinator control, worker supervision, and workspace management.

---

## Security Model

The viewer acts as a control plane into Orca. Starting a Run binds the Run coordinator, and dispatching tasks launches real worker processes and terminals. Security protections are strictly enabled by default:

- **Loopback Binding Only:** The server listens on `127.0.0.1` only. It cannot be accessed over external network interfaces or LANs.
- **No Cross-Origin Resource Sharing (CORS):** The API sets no `Access-Control-*` headers. Web pages from other origins cannot read responses or access tokens.
- **Per-Process Mutation Token:** Every mutating endpoint (`POST` and `PUT` under `/api`) requires the `X-Orca-Dag-Token` header. This token is a cryptographically random 256-bit value generated at server startup. Same-origin clients fetch it via `GET /api/session`. Requests lacking a valid token are rejected immediately with `403 Forbidden` before executing route logic or calling the Orca CLI.
- **Verified Harnesses and Rejection of Unverified Presets:** Built-in choices are `claude`, `codex`, `opencode`, `omp`, and `antigravity`, within their [recorded execution limits](compatibility.md). The unverified harnesses (`gemini`, `grok`, `cursor`, `droid`, `kimi`) have not been concretely verified as supervised worker harnesses and are not available for viewer launch. Any attempt to start (`POST /api/run`) or retry (`POST /api/workers/:id/retry`) a Task with an unverified harness is rejected upfront with HTTP 400 (`unverified_harness`). Old worker attempt history and ledger rows recorded under these names remain readable in read APIs (`GET /api/workers`), but new attempts are strictly refused without silent substitution or auto-migration.
- **OMP / Antigravity Native Boundary:** Current or exact Existing placement requires running runtime and resolved CLI ≥ 1.4.245. Creating new Git worktrees (`new-child`, `new-top-level`) or any workspace lane requires BOTH running runtime and resolved CLI ≥ 1.4.246. Local Linux only; remote environments, macOS, and Windows are rejected. New child placement requires a positively identified local managed Git parent; new top-level requires an exact repository identifier (`id:...` or absolute `path:/...`) pointing to a verified local Git repo (rejects ambiguous names, plain folders, foreign hosts, and auto git-init). Coordinator admission and plan preview inspect the lane's seed placement and fail before mutation if runtime or CLI is older than 1.4.246 (`503 execution_disabled` or validation refusal). Workspace lanes share workspace ONLY: first Task creates or adopts it, dependency-ordered followups reuse exact Existing; every Task receives a fresh native agent session and Dispatch (never generic terminal reuse, `--terminal`, `--surface` override, or fallback after refusal). All nonempty effort overrides remain rejected (including alongside an explicit model). Model text is an opaque native selector, not OpenCode `provider/model[#variant]` syntax; an absent override omits `--model`. Native `worker-start --agent` follows Orca's Chat/Terminal preference without inspection or override; Native Chat is not a rejection gate, but has explicit [fleet status limitations and verification boundaries](../tutorials/viewer-operations.md#known-limitations). When resolved CLI is ≥ 1.4.246, `runOrca` appends `--full` to orchestration commands (using the cached readiness probe) to obtain full Run/Task/receipt schemas from concise-by-default CLIs; CLI 1.4.245 rejects `--full`, and uncertain mutations are never retried (verified via single-request `POST /api/runs` creating `run_2a67b90e6a94` without 500 errors). Native receipts and English diagnostics remain verbatim.
- **Custom Harness Command Opt-In:** Arbitrary user-defined commands require launching the server with `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`; otherwise, they fail with HTTP 400 `custom_commands_disabled`. Custom commands are strictly an opt-in experimental escape hatch and do NOT constitute a verified support claim; they run only on the local compatibility path without isolated placement. Furthermore, the five unverified bare IDs (`gemini`, `grok`, `cursor`, `droid`, `kimi`) are rejected with `unverified_harness` even when `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` is enabled (they cannot be passed as bare identifiers to bypass verification).
- **Strict HTTP Input Validation:** Task IDs, Run IDs, gate IDs, model identifiers, placement payloads, and concurrency values are strictly validated before being converted into CLI arguments.
- **Spawn Without Shell:** The resolved Orca binary is executed directly with `shell: false`. Shell operators and command injections are rejected.

---

## Readiness and View-Only Mode

The `GET /api/readiness` endpoint reports runtime environment status:
```json
{
  "cli": "orca",
  "workspace": "/path/to/project",
  "worktree": "path:/path/to/project",
  "cliVersion": "1.4.242",
  "version": "1.4.242",
  "runtimeState": "ready",
  "executionEnabled": true,
  "reason": null
}
```

- **Execution gate:** Requires CLI ≥ 1.4.205 and the selected runtime positively `ready` with a stable appVersion ≥ 1.4.205. Unknown, unreachable, or starting runtimes remain view-only even with a newer CLI.
- `cliVersion` describes the executable; `version` and `runtimeState` describe its selected runtime. Refresh the page after reconnecting; execution routes independently recheck the short-lived server probe.
- **Orca 1.4.160–1.4.204:** **View-only mode**. Read endpoints function normally. Execution endpoints (`POST /api/runs`, `POST /api/run`, gate resolution) return `503 Service Unavailable` with `execution_disabled`.
- **Coordinator Conflict:** Attempting to start the coordinator in a workspace already coordinated by another active viewer instance returns `409 Conflict` (`coordinator_conflict`).

---

## Route Inventory

All `POST` and `PUT` endpoints require the `X-Orca-Dag-Token` header. `GET` endpoints are read-only and open on loopback.

### Session and Readiness

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/session` | Returns `{ token, allowCustomCommands }`. Provides the per-process mutation token to same-origin clients (`Cache-Control: no-store`). |
| `GET` | `/api/readiness` | Reports the resolved CLI/build version, selected runtime version/state, workspace selector, and execution permission with an actionable disabled reason. |
| `GET` | `/api/capabilities` | Returns runtime readiness, raw advertisements and recognized orchestration support (public contract 1 via `orchestration.contract.v1`, runtime protocol 3, federation lifecycle settlement protocol 3, control mail protocol 2, and `orchestration.federation-lifecycle-settlement.v1`), including auto-release, keep-open, implicit-Run advertisement, retained bindings, turn-stop reports and immediate ask receipts. Advertising implicit Run support does not enable implicit creation in the viewer. |
| `GET` | `/api/health` | Basic health check returning the current workspace directory. |

---

### Runs and DAG State

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/runs` | Lists Runs whose Task creator identity matches this workspace (`::${workspaceDir}@@` marker), plus the current/persisted empty Run. |
| `GET` | `/api/runs/page?cursor=&limit=` | Cursor-paginated, bounded workspace-scoped `run-list` page. Accepts `limit` integer 1..100 (default 100) and opaque `cursor`. Evaluates workspace ownership evidence; candidate pages are filtered to owned runs (may be empty with non-null `nextCursor`). Historical traversal cursor is preserved across refreshes. |
| `GET` | `/api/runs/:runId` | Fetches single Run details (`run-show`) and workspace ownership evidence as `{ run, workspace: { owned, evidence } }`. Foreign Runs remain visible with `workspace.owned: false`. Returns 404 only on definite Orca absence. |
| `POST` | `/api/runs` | `{ objective? }`: Creates a new empty Run in the current workspace using a temporary coordinator terminal. Requires `executionEnabled`. |
| `GET` | `/api/run-health?run=<id>` | Evaluates Run ownership (`viewer_coordinator`, `viewer_coordinator_other_run`, `external_coordinator`, `unbound`, or `unverifiable`), per-source counts, warnings, and nullable `health.removedWork` summary. |
| `GET` | `/api/runs/:runId/removed-work?cursor=` | On-demand cursor-paginated removed-work ledger page (`{ page: { entries, page: { hasMore, nextCursor } } }`). Bounded at 200 entries/page. Opaque cursor (1–2048 chars); validates advance (502 on stuck cursor, 400 on invalid cursor). Reports historical `activeAtRemoval` and safe `unreadable: true` for unknown kinds. Read-only, no reset endpoint. |
| `GET` | `/api/dag?run=<id>` | Returns DAG structure: `{ runId, nodes, edges, hierarchy, gates, readyWave, readiness, generatedAt }`. |

#### One-Off Mutation Authority and Coordinator Control

One-off coordinator mutations against an inactive, unbound, or externally coordinated Run require explicit confirmation matching fresh Run binding evidence:

```json
{
  "coordinatorControl": {
    "confirmed": true,
    "coordinatorHandle": "term_coord_1",
    "consumerGeneration": 1
  }
}
```

Omitting `coordinatorControl` or submitting mismatched evidence fails with HTTP 409 `coordinator_control_required`. The server never implicitly fences or takes over an external coordinator without explicit operator consent.

#### Run Health and Removed-Work Ledger

`GET /api/run-health` includes optional removal evidence, and `GET /api/runs/:runId/removed-work` loads history entries on demand:

```json
{
  "health": {
    "runId": "run_01j7...",
    "ownership": "viewer_coordinator",
    "ownershipDetail": "...",
    "coordinatorHandle": "term_coord_1",
    "consumerGeneration": 1,
    "counts": { "tasks": 4, "messages": 1, "workers": 2, "gates": 0, "pendingGates": 0 },
    "evidenceComplete": true,
    "removedWork": {
      "coverage": "complete",
      "recordedSince": "2026-10-29T00:00:00Z",
      "tasks": 2,
      "dispatches": 2,
      "workers": 1,
      "terminals": 1,
      "activeWorkersAtRemoval": 0,
      "lastRemovedAt": "2026-10-29T01:00:00Z"
    },
    "warnings": []
  }
}
```

```json
{
  "page": {
    "entries": [
      {
        "seq": 1,
        "id": "worker_01j7...",
        "kind": "worker",
        "removedAt": "2026-10-29T01:00:00Z",
        "activeAtRemoval": false
      }
    ],
    "page": {
      "hasMore": false,
      "nextCursor": null
    }
  }
}
```

- **Nullable `removedWork` Summary:** The internal `showRun` adapter preserves `{ run, removedWork }`; HTTP clients read the summary through `health.removedWork`. An omitted or malformed optional summary is `null`, including on older hosts or when the optional ledger read failed. Missing evidence is never padded with zeroes.
- **On-Demand Scoped Pagination:** Removed-work entries are loaded only when explicitly opened in the UI, bounded to Orca's official limit of 200 rows per page.
- **Opaque Cursor Validation:** Cursor tokens must be strings (1–2048 characters). Malformed tokens return `400 invalid_cursor`. If `page.hasMore` is `true` but `nextCursor` fails to advance (is `null` or matches the current cursor), the server returns `502 invalid_page_cursor`.
- **Historical Activity vs Live State:** A worker entry's `activeAtRemoval: true` means it may still have been running when tracking was removed. It is not proof of either historical or current process liveness.
- **Kind Resilience:** Known kinds (`task`, `dispatch`, `worker`, `terminal`, `remote_worker`, `federated_worker`) retain their fields. Unknown string kinds are tagged with `unreadable: true`; malformed pages fail rather than becoming empty history.
- **Read-Only Viewer:** There is no reset button, wipe command, or removal-ledger mutation endpoint in the viewer.

---

### Coordinator Control

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/run` | Starts the self-driven coordinator loop for the specified Run.<br>**Body:** `{ runId, harnessByTask?, modelByTask?, effortByTask?, retainByTask?, environmentByTask?, placementByTask?, worktreeLanes?, laneByTask?, defaultHarness?, maxConcurrency? }`.<br>Binds coordinator terminal, fences previous coordinator, and starts ready tasks. |
| `POST` | `/api/run-stop` | Stops the running coordinator loop, interrupts active external processes, and reconciles worker terminal cleanup. |
| `GET` | `/api/run-status` | Returns live coordinator loop metrics: `{ running, busy, attempts, inbox, cleanupDebt, recovery, ... }`. |
| `GET` | `/api/terminals` | Lists active Orca terminals. |

---

### Workspaces, Repositories, and Lanes

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/worktrees` | Lists Orca-discovered local workspaces (`worktree list`). Together with scoped `GET /api/workers?run=<id>`, provides on-demand candidate review inventory for safe cleanup. |
| `GET` | `/api/worktrees/:worktreeId` | Fetches durable identity for one worktree via `worktree show`. |
| `POST` | `/api/worktrees/remove` | `{ worktree, deleteBranch?: boolean, runHooks?: boolean, force?: boolean, allowFailedArchiveHook?: boolean, evidenceRequestId?: string, runId?: string }`: Removes an Orca worktree via `orca worktree rm --worktree <worktree>`. When `deleteBranch: true` is passed, safely removes merged branches only; unmerged branches are preserved. Returns `{ ok: true, requestId, receipt: { worktree, archiveHookOverride, preservedBranch, raw } }`. Requires confirmed settled ownership and queries the global complete fleet (`listWorkers(undefined, { includeRemote: true })`) to guard unlisted other-Run chats; returns `removal_evidence_required` if active workers or locks remain. |
| `GET` | `/api/repos` | Lists Orca-registered local repositories (`repo list`) for new-top-level placement. |
| `GET` | `/api/worktree-lanes?run=<id>` | Returns planned workspace lanes and their Orca runtime status (`planned`, `creating`, `active`, `integration_required`, `settled`, `unverifiable`, `removal_blocked`, `removed`). |
| `POST` | `/api/worktree-lanes/:laneId/open-changed` | Opens changed files/diffs for a lane workspace in the Orca editor. |
| `POST` | `/api/worktree-lanes/:laneId/remove` | Removes a settled lane's worktree using `orca worktree rm` with confirmation. |

---

### Activity, Chat, and Messaging

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/activity?run=<id>&after=&limit=` | Fetches readable Activity event timeline, stage presence, and coordinator check receipts. |
| `GET` | `/api/activity/stream?run=<id>` | Real-time Server-Sent Events (SSE) feed of activity snapshots for the specified Run. Pauses/closes when the document is hidden (`document.visibilityState === 'hidden'`); refreshes and reconnects on return, preserving rail-closed unread counts. |
| `GET` | `/api/inbox?run=<id>` | Returns pending questions, escalations, stop events, and cleanup debt for the Run. Items distinguish `kind: "question"` (replyable) from `kind: "stop_event"` (stopReason escalations like `finished`, `errored`, `needs-input`, `exited`, which are events resolved by exact Dispatch steering, operator decisions, or authoritative later settlement, not synthesized replies). |
| `POST` | `/api/tasks/:taskId/messages` | `{ runId, body, subject?, threadId? }`: Sends guidance to a verified active Task Dispatch under this viewer's live coordinator. Returns typed `TaskMessageReceipt` (`ok: true, kind: "enqueued" | "follow_up" | "recipient_run_bound_redirect", runId, taskId, dispatchId, requestedTaskId, requestedDispatchId, followUpOf, requestId, destinationRunId`). Positively evidenced nested coordinator redirects distinguish originating Task/Dispatch Run from actual destination mailbox/Run without child authority adoption or false worker creation. |
| `POST` | `/api/messages/:id/reply` | `{ body, runId, coordinatorControl? }`: Sends a reply to a pending worker question or escalation using durable operator helper (`operatorMessages.ts`) and `sessions.json` checkpoint. Merge input questions (`[orca-dag:merge-inputs-v3]`, a local contract marker) are answered with immutable commit SHAs from StageGit. Native reply does not create follow-up tasks. Requires `coordinatorControl` if not currently coordinated by this viewer instance. |
| `POST` | `/api/messages/:id/acknowledge-stop-event` | `{ runId, dispatchId }`: Records operator acknowledgement of a stop event for an exact live-viewer Run/Dispatch without synthesizing Task success. |
| `GET` | `/api/audiences?run=<id>` | Previews allowable group-messaging targets (`@all` and discovered worktrees) with discovery health. |
| `POST` | `/api/messages/group` | `{ runId, audience, body, subject?, type?, priority?, coordinatorControl? }`: Broadcasts a coordinator message via durable operator helper (`operatorMessages.ts`). Rejects lifecycle signal types (`forbidden_group_type`). Handles `recipient_run_bound_redirect` warnings. |
| `POST` | `/api/gates` | `{ runId, taskId, question, coordinatorControl? }`: Canonical approve/reject gate creation for same-Run NOT-yet-dispatched Tasks (`--options '["approved","rejected"]'`). Guarded by coordinator lifecycle lock (`withLifecycleMutation`) and request auditing in `requests.jsonl`. Rejects if task is dispatched, gated, absent, or host observations are incomplete (`gate_not_eligible`). Requires `coordinatorControl` if not currently coordinated by this viewer instance. |
| `POST` | `/api/gates/:id/resolve` | `{ resolution, runId, coordinatorControl? }`: Resolves an approval gate or cross-lane integration gate (`integrated`). Requires `coordinatorControl` if not currently coordinated by this viewer instance. |

#### Guidance Delivery, Recovery, and Follow-Up Lifecycle

`POST /api/tasks/:taskId/messages` validates that this viewer owns the live coordinator for `runId`, that the task has an active Dispatch, and that fleet capacity (which includes visible helpers and pending ambiguity) permits the send.
- **Typed Receipts & Identity Distinction:** The route returns `{ ok: true, ...receipt }`, distinguishing requested IDs (`requestedTaskId`, `requestedDispatchId`) from actual returned IDs (`taskId`, `dispatchId`). `kind: "enqueued"` represents delivery to the same active Dispatch without starting new work, while `kind: "follow_up"` represents a started or routed follow-up task (`followUpOf` captures the parent lineage).
- **Durable Journaling & Sanitized Start Evidence:** Before calling native Orca, the coordinator persists a `guidanceSends` checkpoint in `.orca-dag/sessions.json` with the request and requested worker identities. An accepted native receipt adds `creationProven` and sanitized immutable `startEvidence` (`status`, `launchMode`); missing evidence is not fabricated.
- **Reconciliation vs New Delivery (`guidance_reconciled`):** If an earlier send to the same target remains unconfirmed (`prepared` or `unknown`), a subsequent send triggers read-only recovery (`recoverTaskGuidance`) via `request-show` without sending a new body. If that prior send is successfully reconciled, the call throws `guidance_reconciled` ("Previous guidance request was reconciled; submit the new guidance again"). This indicates that the prior operation resolved, NOT that the newly submitted body was delivered. If the prior send remains unresolved, it throws `guidance_unknown`; unresolved guidance holds fleet capacity debt and blocks blind resends.
- **Stop Ownership & Capacity Debt:** The coordinator tracks only creation-proven follow-up roots (`creationProven: true`) or exact journal-owned roots. `POST /api/run-stop` attempts teardown of all owned roots, including follow-ups, and returns `{ ok: true, clean, results }`. Unresolved sends or teardown outcomes keep `clean: false`; each result names its `target`, `kind`, `result`, and `detail`.
---

### Workers, Supervision, and Interventions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workers?run=<id>` | Fetches typed `WorkerInventory` (`{ workers: OrcaWorkerRow[], partialHostErrors: unknown[] }`) for the Run. Preserves and aggregates `partialHostErrors` across all pages. Missing remote hosts make absence unsuitable for lifecycle decisions; host errors never clear debt or infer exit. |
| `GET` | `/api/workers/:dispatchId?run=<id>` | Returns detailed durable row and `worker-show` evidence (PTY facts, observation, agent wait status) for a Dispatch. |
| `GET` | `/api/workers/:dispatchId/output?run=<id>` | Reads bounded worker output pages (`?run=<id>&source=auto\|terminal\|transcript&cursor=&limit=`, limit clamped 1–200). Requires explicit `run` scope. |
| `POST` | `/api/workers/:dispatchId/stop` | Halts one positively identified active Dispatch with a durable request ID. Returns `502 response_lost` if response verification drops. |
| `POST` | `/api/workers/:dispatchId/abandon` | Fences orchestration state via `worker-abandon` for positively exited or outcome-unknown attempts. Refused if Orca proves worker is live. |
| `POST` | `/api/workers/:dispatchId/focus` | Focuses the local worker terminal (`terminal switch`) when positive `agentWait` evidence exists. |
| `POST` | `/api/workers/:id/release` | `{ runId }`: Explicitly releases a settled worker's terminal. Requires body `runId`. |
| `POST` | `/api/workers/:id/retain` | `{ runId }`: Explicitly retains a settled worker's terminal for debugging. Requires body `runId`. |
| `POST` | `/api/workers/:id/retry` | Re-places a positively failed attempt using the identical harness, model, effort, and placement. |
| `POST` | `/api/workers/:dispatchId/resolve-blocked` | `{ runId, result, acknowledgeUnknownProvider: true, coordinatorControl? }`: Manually records an operator-reviewed result on a blocked Task. Requires `coordinatorControl` if not currently coordinated by this viewer instance. |

The output response is `{ output: ... }`. Native output receipts can include optional `fallbackReason`, `sourceExact`, `archived`, `provider`, and `sourceIdentity` evidence. Missing or null means unknown, not false; an explicit `false` is meaningful and strictly preserved. These fields describe the returned source, not full history, Task settlement, or authority to clean up. `sourceChanged` indicates a source reset; paging remains bounded. Native start receipts may also include `launchMode` (`mode`, `preferred`, `reason`, `detail`) when Orca provides it. This is surface evidence, distinct from supervised/legacy adapter mode; do not infer a surface from a terminal handle. Start receipts also report `keepOpen` dispositions (`retained`, `already_released`, `release_pending`, `no_owned_resource`, or `unknown`); an accepted start remains accepted even if subsequent retention encounters issues, without fallback launches or unintended release.
---

### Session Recovery and Mutation Audit

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/session-bindings?run=<id>` | Lists recorded provider session bindings for the Run from `.orca-dag/sessions.json`. |
| `PUT` | `/api/session-bindings/:dispatchId` | Attaches a known `{ runId, taskId, harness, sessionId }` binding after validating worker identity. |
| `POST` | `/api/session-bindings/:dispatchId/probe` | Probes status of a bound provider session on demand. Results represent external observation, not Task settlement. |
| `GET` | `/api/requests?run=<id>` | Returns bounded list of recorded mutation request IDs from `.orca-dag/requests.jsonl`. |
| `GET` | `/api/requests/:requestId?run=<id>` | Reads a ledger row and runs a live `request-show` probe (`completed`, `pending`, `absent`, `unknown`). |

#### Critical State Recovery and Hot-Downgrade Safeguard

`.orca-dag/sessions.json` stores critical recovery journals in addition to provider session bindings:
- `mailboxChecks`: Durable checkpoints of consuming checks and legacy ACKs, caching `requestId`, `delivery`, `processedMessageIds`, `pendingQuestionIds`, and per-question `replyRequests`. On restart, pending questions and draining batches are recovered before new checks.
- `guidanceSends`: Durable checkpoints of coordinator guidance sends, tracking `requestId`, `state` (`prepared`, `unknown`, `enqueued`, `follow_up`, `refused`), `receipt`, `creationProven`, and sanitized `startEvidence`.
- `operatorMessages`: Durable checkpoints of inactive operator reply and group send requests, persisting `requestId`, `target`, `from`, `bodyHash`, `state` (`prepared`, `unknown`, `completed`, `refused`), and outcome before Orca calls. Read-only recovery via `request-show` resolves pending requests without blind resends.

These records are **recovery authority**, not rotating audit history. Unsupported older readers will throw `session binding store contains unknown fields` when reading these new inventories; therefore, active `sessions.json` state cannot safely be hot-downgraded across unsupported readers without settling or archiving it first.
---

### Editor and Files

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/files/open` | `{ path, worktree? }`: Opens a file in the Orca editor within the proven workspace. |
| `POST` | `/api/files/diff` | `{ path, worktree? }`: Opens diff view for a file in the Orca editor. |
| `POST` | `/api/files/open-changed` | `{ worktree }`: Opens all changed files for a worktree in the Orca editor. |

---

### Remote Environments and Models

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/environments` | Lists saved connected remote environments (`environment list`) and their peer capabilities. |
| `GET` | `/api/environments/:envId/worktrees?repo=` | Discovers exact workspace selectors (`id:<repoId>::<path>`) on a remote environment. |
| `GET` | `/api/environments/:envId/repos` | Lists repositories registered on a remote environment for new-top-level placement. |
| `GET` | `/api/environments/:envId/projects` | Lists project groupings visible on a remote environment. |
| `GET` | `/api/models/:harness` | Advisory model discovery scoped strictly to the local viewer workspace (`scope: "local-workspace"`). Returns `{ harness, status, models, diagnostic, scope }`. |

#### Model Discovery Response (`GET /api/models/:harness`)

```json
// Success / populated catalog (local workspace)
{
  "harness": "opencode",
  "status": "available",
  "models": [
    "anthropic/claude-3-5-sonnet-20241022",
    "deepseek/deepseek-chat"
  ],
  "diagnostic": null,
  "scope": "local-workspace"
}
```

```json
// Discovery failure (controlled English diagnostic)
{
  "harness": "opencode",
  "status": "unavailable",
  "models": [],
  "diagnostic": "OpenCode model discovery timed out after 20 seconds",
  "scope": "local-workspace"
}
```

- **Scope:** Scoped strictly to `local-workspace` (the current local viewer workspace where `opencode models` executes). It does not probe remote execution environments or alternate worktrees.
- **Status & Diagnostic:**
  - `status: "available"`: `models` contains catalog strings matching `^[A-Za-z0-9._-]{1,128}/[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}(?:#[A-Za-z0-9._-]{1,128})?$`. A successful query with no models returns `{ status: "available", models: [], diagnostic: null }`. Non-OpenCode harnesses return `available` with empty `models`.
  - `status: "unavailable"`: Discovery failed (e.g., CLI not found → `"OpenCode CLI was not found"`, 20s timeout → `"OpenCode model discovery timed out after 20 seconds"`, process exit code → `"OpenCode model command failed (exit code <N>)"`, generic failure → `"OpenCode model discovery failed"`). `models` is empty. Stderr and internal process stack traces are never leaked.
- **Advisory Semantics:** Model discovery is purely advisory for local workspace selection. A failed discovery or empty catalog does not prevent manual model entry, nor does a successful catalog entry guarantee execution-host availability.

---

### Viewer Configuration

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/config` | Reads persisted viewer preferences from `.orca-dag/config.json`. |
| `PUT` | `/api/config` | Merges and writes viewer preferences into `.orca-dag/config.json`. |
