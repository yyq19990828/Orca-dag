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
- **Custom Harness Command Opt-In:** Only canonical harnesses (`claude`, `codex`, `opencode`, `gemini`, `grok`, `cursor`, `droid`, `kimi`) are allowed by default. Arbitrary commands require launching the server with `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`; otherwise, they fail with `custom_commands_disabled`.
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
  "version": "1.4.242",
  "executionEnabled": true,
  "reason": null
}
```

- **Orca ≥ 1.4.205:** Full execution enabled.
- **Orca 1.4.160–1.4.204:** **View-only mode**. Read endpoints function normally. Execution endpoints (`POST /api/runs`, `POST /api/run`, gate resolution) return `503 Service Unavailable` with `execution_disabled`.
- **Coordinator Conflict:** Attempting to start the coordinator in a workspace already coordinated by another active viewer instance returns `409 Conflict` (`coordinator_conflict`).

---

## Route Inventory

All `POST` and `PUT` endpoints require the `X-Orca-Dag-Token` header. `GET` endpoints are read-only and open on loopback.

### Session and Readiness

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/session` | Returns `{ token, allowCustomCommands }`. Provides the per-process mutation token to same-origin clients (`Cache-Control: no-store`). |
| `GET` | `/api/readiness` | Reports CLI resolution, Orca version, workspace path, worktree selector, and whether execution is enabled. |
| `GET` | `/api/capabilities` | Inspects local Orca capability advertisements and returns parsed support for canonical 1.4.206 orchestration capability IDs. |
| `GET` | `/api/health` | Basic health check returning the current workspace directory. |

---

### Runs and DAG State

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/runs` | Lists Runs whose Task creator identity matches this workspace, plus the current/persisted empty Run. |
| `GET` | `/api/runs/page?cursor=` | Cursor-paginated raw `run-list` page. The opaque `nextCursor` token passes through byte-for-byte (`null` on the last page). |
| `GET` | `/api/runs/:runId` | Fetches single Run details (`run-show`) verified against workspace ownership. Returns 404 only on definite Orca absence. |
| `POST` | `/api/runs` | `{ objective? }`: Creates a new empty Run in the current workspace using a temporary coordinator terminal. Requires `executionEnabled`. |
| `GET` | `/api/run-health?run=<id>` | Evaluates ownership and health state of a Run: `viewer-owned`, `external`, `unbound`, or `inconsistent`, with per-source counts and warnings. |
| `GET` | `/api/dag?run=<id>` | Returns DAG structure: `{ runId, nodes, edges, hierarchy, gates, readyWave, readiness, generatedAt }`. |

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
| `GET` | `/api/worktrees` | Lists Orca-discovered local workspaces (`worktree list`) for exact-existing placement selection. |
| `GET` | `/api/worktrees/:worktreeId` | Fetches durable identity for one worktree via `worktree show`. |
| `POST` | `/api/worktrees/remove` | `{ selector }`: Removes an Orca worktree via `orca worktree rm`. Requires confirmed settled ownership; returns `removal_evidence_required` if workers or locks remain. |
| `GET` | `/api/repos` | Lists Orca-registered local repositories (`repo list`) for new-top-level placement. |
| `GET` | `/api/worktree-lanes?run=<id>` | Returns planned workspace lanes and their Orca runtime status (`planned`, `creating`, `active`, `integration_required`, `settled`, `unverifiable`, `removal_blocked`, `removed`). |
| `POST` | `/api/worktree-lanes/:laneId/open-changed` | Opens changed files/diffs for a lane workspace in the Orca editor. |
| `POST` | `/api/worktree-lanes/:laneId/remove` | Removes a settled lane's worktree using `orca worktree rm` with confirmation. |

---

### Activity, Chat, and Messaging

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/activity?run=<id>&after=&limit=` | Fetches readable Activity event timeline, stage presence, and coordinator check receipts. |
| `GET` | `/api/activity/stream?run=<id>` | Real-time Server-Sent Events (SSE) feed of activity snapshots for the specified Run. |
| `GET` | `/api/inbox?run=<id>` | Returns pending questions, escalations, and cleanup debt for the Run. |
| `POST` | `/api/messages/:id/reply` | `{ body, runId }`: Sends a reply to a pending worker question or escalation. |
| `GET` | `/api/audiences?run=<id>` | Previews allowable group-messaging targets (`@all` and discovered worktrees) with discovery health. |
| `POST` | `/api/messages/group` | `{ runId, audience, body, subject?, type?, priority? }`: Broadcasts a coordinator message. Rejects lifecycle signal types (`forbidden_group_type`). |
| `POST` | `/api/gates/:id/resolve` | `{ resolution, runId }`: Resolves an approval gate or cross-lane integration gate (`integrated`). |

---

### Workers, Supervision, and Interventions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workers?run=<id>` | Fetches cursor-paged, remote-inclusive worker attempt history, liveness, and launch locks for a Run. |
| `GET` | `/api/workers/:dispatchId?run=<id>` | Returns detailed durable row and `worker-show` evidence (PTY facts, observation, agent wait status) for a Dispatch. |
| `GET` | `/api/workers/:dispatchId/output` | Reads bounded worker output pages (`?source=auto\|terminal\|transcript&cursor=&limit=`, limit clamped 1–200). |
| `POST` | `/api/workers/:dispatchId/stop` | Halts one positively identified active Dispatch with a durable request ID. Returns `502 response_lost` if response verification drops. |
| `POST` | `/api/workers/:dispatchId/abandon` | Fences orchestration state via `worker-abandon` for positively exited or outcome-unknown attempts. Refused if Orca proves worker is live. |
| `POST` | `/api/workers/:dispatchId/focus` | Focuses the local worker terminal (`terminal switch`) when positive `agentWait` evidence exists. |
| `POST` | `/api/workers/:id/release` | Explicitly releases a settled worker's terminal. |
| `POST` | `/api/workers/:id/retain` | Explicitly retains a settled worker's terminal for debugging. |
| `POST` | `/api/workers/:id/retry` | Re-places a positively failed attempt using the identical harness, model, effort, and placement. |
| `POST` | `/api/workers/:dispatchId/resolve-blocked` | `{ runId, result, acknowledgeUnknownProvider: true }`: Manually records an operator-reviewed result on a blocked Task. |

---

### Session Recovery and Mutation Audit

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/session-bindings?run=<id>` | Lists recorded provider session bindings for the Run from `.orca-dag/sessions.json`. |
| `PUT` | `/api/session-bindings/:dispatchId` | Attaches a known `{ runId, taskId, harness, sessionId }` binding after validating worker identity. |
| `POST` | `/api/session-bindings/:dispatchId/probe` | Probes status of a bound provider session on demand. Results represent external observation, not Task settlement. |
| `GET` | `/api/requests?run=<id>` | Returns bounded list of recorded mutation request IDs from `.orca-dag/requests.jsonl`. |
| `GET` | `/api/requests/:requestId?run=<id>` | Reads a ledger row and runs a live `request-show` probe (`completed`, `pending`, `absent`, `unknown`). |

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
| `GET` | `/api/models/:harness` | Enumerates selectable models for a harness (such as OpenCode). |

---

### Viewer Configuration

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/config` | Reads persisted viewer preferences from `.orca-dag/config.json`. |
| `PUT` | `/api/config` | Merges and writes viewer preferences into `.orca-dag/config.json`. |
