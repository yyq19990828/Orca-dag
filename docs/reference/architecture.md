# Architecture and Coordination Reference

English | [简体中文](architecture_zh.md)

Back to [README](../../README.md) · [Documentation Index](../README.md)

This document details the system architecture, coordination lifecycle, authority model, safety mechanisms, and design boundaries of `orca-dag`.

---

## How It Works

The system cleanly separates **planning** from **visualization and execution**:

1. **The planning brain lives outside (`skill/SKILL.md`):** Your existing agent (Claude Code, Kimi, Cursor, etc.) reads the project workflow, resolves the active Orca CLI, consults the runtime-matched orchestration guide (`orca skills get orchestration`), and decomposes requirements into an Orca task DAG. There is no embedded Claude Agent SDK in the viewer.
2. **The viewer visualizes and coordinates (`server/` + `web/`):** Shipped as the `orca-orchestration-launcher` npm package and standalone binary. It connects to Orca's orchestration state over loopback CLI calls, renders the DAG live, allows per-node harness and placement configuration, and drives a self-contained coordinator loop.

```mermaid
flowchart TD
  subgraph Planning ["Planning Phase (skill/SKILL.md)"]
    User["User Prompt"] --> Agent["Your Agent\n(Claude Code / Kimi / etc.)"]
    Agent -->|"orca orchestration\nrun-create / task-create --deps"| State[("Orca Orchestration State\n(Runs, Tasks, Gates, Dispatches)")]
  end

  subgraph Execution ["Execution Phase (orca-dag Viewer & Coordinator)"]
    State -->|"Poll task-list / gate-list (every 2s)"| Viewer["Viewer UI & DAG Canvas\n(React Flow + Dagre)"]
    Viewer -->|"Select harness / model / placement\nSet Max Parallel"| Viewer
    Viewer -->|"▶ Run with Orca\nBind coordinator terminal via run-use"| Coord["Self-Driven Coordinator Loop"]
    Coord -->|"worker-start --task --agent\n(Parallel Ready Tasks)"| State
    State -->|"Create worker terminal\nInject dispatch"| Workers["Autonomous Workers\n(Claude, Codex, OpenCode...)"]
    Workers -->|"orca orchestration send\n--type worker_done"| State
    State -->|"Mark Task/Dispatch completed/failed\nAdvance dependents to ready"| Coord
  end
```

### End-to-End Execution Flow

1. **Decomposition:** In your agent, prompt for a task decomposition. The agent creates a Run (`orca orchestration run-create`) and writes tasks and dependencies (`orca orchestration task-create --deps ...`).
2. **Polling and Layout:** The viewer polls `orca orchestration task-list --run <id> --json` every 2 seconds, calculates horizontal or vertical Dagre layered layouts, and renders live status colors.
3. **Configuration:** Operators configure Default harness or per-node overrides (harness, model, effort, placement, lanes) and set Max parallel.
4. **Coordinator Loop:** Clicking **"▶ Run with Orca"** binds a dedicated coordinator terminal to the Run (`run-use --from <handle>`). On each tick, the coordinator queries ready tasks and calls `orca orchestration worker-start` in parallel up to the concurrency limit. Orca creates worker terminals, waits for readiness, injects dispatches, and returns Dispatch IDs (`ctx_*`).
5. **Settlement and Accounting:** Workers finish by sending `worker_done` (`orca orchestration send --type worker_done --outcome ...`). Orca marks the Task and Dispatch settled. The viewer archives worker output and executes an explicit terminal accounting decision: default **release**, immediate compatible **reuse** (`worker-start --terminal`), or **retain** on request. Dependents advance to `ready` until the graph is complete.
6. **Replanning:** If tasks or dependencies must change, the operator returns to the agent conversation to redraw the DAG in a fresh Run. Orca provides no API to edit or delete individual tasks in place.

---

## Run, Task, and Dispatch Layers

| Layer | What it is | Owned by | Persistence location |
|---|---|---|---|
| **Run** | Namespace and coordinator inbox; only one coordinator can be bound at a time (`consumer_generation` provides fencing). | Orca | Orca internal database |
| **Task** | A unit of work; `deps` define DAG edges, `run_id` scopes it to a Run. | Orca | Orca internal database |
| **Dispatch** | **One attempt** (`ctx_*`); tracks heartbeats, pane identity, capability credentials, and retry chains (`--retry-of`). | Orca | Orca internal database |
| **Viewer Preferences** | Per-node harness, model, effort, placement, lanes, lead stage, and canvas layout. | Viewer | `.orca-dag/config.json` |
| **Activity Journal** | Explanatory event timeline: starts, deliveries, check receipts, and agent transitions. Never authoritative over task settlement. | Viewer | `.orca-dag/activity.jsonl` |

> **Key Rule:** A Run is a namespace, **not a DAG**. Multiple disconnected graphs can coexist in a single Run. "One Run = one DAG" is a convention enforced by `skill/SKILL.md`, not an Orca constraint.

### Circuit Breaking and Retries (Orca 1.4.226+)

Orca 1.4.226 counts failed `worker-start` invocations along the exact `--retry-of` Dispatch chain:
- The **third** failed start marks the chain `circuit_broken`. Subsequent attempts are rejected with `task_not_startable`.
- A worker that successfully reaches `ready` and later reports `failed` does **not** increment this start-failure counter.
- Stopping/restarting the Run or restarting the viewer process **does not** reset the chain.
- Operators must retry the same Task in the same Run from its exact prior Dispatch, explicitly repeating intended placement parameters (since `--retry-of` does not inherit placement).
- Do not create replacement Tasks or Runs solely to bypass a circuit breaker.
- Standard recovery releases the failed terminal through Orca when ownership permits. User-takeover, explicitly retained, and structured sessions preserve their retain/release protections.
- Archived output remains readable through the exact Dispatch ID after terminal release.

---

## Coordinator Safety and Read Efficiency

- **Mailbox protocol and version terminology:** Upstream official public orchestration contract is `contract 1` (`orchestration.contract.v1`), runtime protocol is 3, federation lifecycle settlement protocol is 3 (`ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION`), and control mail protocol is 2; `orchestration.federation-lifecycle-settlement.v1` is the settlement capability. Local V3 migration and the `[orca-dag:merge-inputs-v3]` handshake marker are local viewer contracts/markers, NOT a global upstream version; never rename persisted markers. Legacy FIFO checks replay the oldest unacknowledged Delivery; process every message and drain any next batch returned by ACK. Consuming checks acknowledge on read, and ACK alone does not fetch another batch. Transport acknowledgement on read is distinct from local processing completion: durable consuming-check UUIDs, batch deliveries, processed message IDs, pending questions, and operator message checkpoints are preserved in `.orca-dag/sessions.json` (`mailboxChecks`, `guidanceSends`, `operatorMessages`) and survive restarts. A lost consuming response is recovered via read-only `request-show` using the original request identity, never a fresh mutation. Acknowledged batches continue draining while human questions remain pending. `--peek` is observation only; never consume a worker's mailbox for monitoring.
- **Guidance, Follow-Up Lifecycle, and Nested Routing:** Guidance persists its request and requested worker identity in `guidanceSends` before native effects. Accepted receipts distinguish requested from actual Task/Dispatch IDs, and `enqueued` from `follow_up`; guidance also supports positively evidenced `recipient_run_bound_redirect`, distinguishing originating Task/Dispatch Run from actual destination mailbox/Run (`destinationRunId`) without child authority adoption or false worker creation. The journal records `creationProven` and sanitized immutable start evidence (`status`, `launchMode`). Unknown guidance holds fleet capacity and blocks blind resends. Read-only reconciliation of a prior operation returns `guidance_reconciled`, never acknowledgment of the new body. Run Stop covers every viewer-owned follow-up root and reports unresolved sends or teardown outcomes as explicit debt.
- **Stop Events vs Actual Questions:** Native `stopReason` escalations (`finished`, `errored`, `needs-input`, `exited`) are events in `PendingInboxItem.kind === 'stop_event'`, distinct from replyable questions (`kind === 'question'`). Resolution must follow exact Dispatch steering, operator decisions, or authoritative later settlement; the viewer does not fabricate replies or synthesize task success.
- **Historical launch-mode reads:** Worker detail can restore an immutable follow-up start-mode tuple from the critical journal after Stop or restart. It must match the actual Run, Task and Dispatch, never the requested parent. Missing/unreadable evidence stays unknown; display recovery does not grant mutation authority.
- **Committed Stage Merge Handshake:** Cross-workspace merges requiring committed Git handoff declare both `[orca-dag:merge-prep]` and `[orca-dag:merge-inputs-v3]`. Native 1.4.247 `ask` has no `--subject` or `--payload` flags (the native subject is fixed to `'Question'`, and `payload.question` contains the entire question text). The worker asks before any Git edit with the entire question text exactly `[orca-dag:merge-inputs-v3]`. The coordinator verifies current merge Task/Dispatch ownership, sender handle, and clean dependencies before replying with immutable commit SHAs from StageGit. Legacy runnable merge specs are refused at plan validation and must replan in a fresh Run.
- **Critical Recovery & No Hot Downgrade:** `.orca-dag/sessions.json` stores critical recovery journals (`mailboxChecks`, `guidanceSends`, and `operatorMessages`) that serve as recovery authority, not rotating audit logs. Inactive operator reply and group send helpers (`operatorMessages.ts`) checkpoint UUID, body hash, and scope in `operatorMessages` before Orca CLI calls, recovering unknown states via read-only `request-show` (`operator_message_reconciled` on prior completion with different body, `operator_message_unknown` on unresolved). Unsupported older readers throw `session binding store contains unknown fields` on these inventories; active `sessions.json` state cannot safely be hot-downgraded across unsupported readers.
- **Cleanup Debt & Incomplete Remote Observations:** Reclaimable cleanup debt is rechecked against fresh fleet state on every cycle; external releases clear debt automatically. `listWorkers` returns typed `WorkerInventory` (`{ workers: OrcaWorkerRow[], partialHostErrors: unknown[] }`), preserving and aggregating `partialHostErrors` across all pages. Missing remote hosts make absence unsuitable for lifecycle decisions; host errors never clear debt or infer worker exit. Worktree removal safety queries the global complete fleet (`listWorkers(undefined, { includeRemote: true })`) rather than only the selected Run, ensuring other-Run Native Chat workers absent from terminal-list still protect shared workspaces from accidental teardown.
- **Helper Custody:** Workers created as helpers within the same Run remain under the custody of their active creator. The viewer verifies exact Dispatch lineage rather than inferring ownership from `parent_id`. Helpers are adopted only after positive creator settlement. Visible active workers consume concurrency admission budget, but external helpers mean **Max parallel is an admission throttle, not a hard runtime-wide cap**.
- **Terminal Reuse Preconditions:** Automatic terminal reuse requires fresh, exact, connected PTY evidence for the identical agent and workspace. Chat handles do not establish PTY proof. OpenCode, OMP and Antigravity workers are excluded from generic reuse to preserve frontend, fresh-session and model identity.
- **Scoped Operations & In-Flight Presentation Sharing:** Worker output, terminal release, and retention are strictly scoped to the selected Run (query `run` for GET, body `runId` for mutations). Unscoped request audit inspection stays available. Concurrent GET requests share identical in-flight CLI reads, scoped by Run and options; in-flight presentation cache never serves as final mutation custody proof. Activity EventSource closes/pauses when hidden (`document.visibilityState === 'hidden'`), retaining unread counts and refreshing on return.

---

## The Authority Model

Every orchestration call flows through `resolveRunScope`:

```
Reads (task-list, gate-list)  ---> Allowed without consumer binding (pass --run <id>)
Mutations (dispatch, gates)   ---> Requires active Run binding (--from <coordinator-handle>)
```

Because the viewer runs as an external OS process without an ambient Orca session, it creates and manages a dedicated coordinator terminal:
- **Terminal Title:** `orca-dag coordinator · <workspace-hash> · <instance-id>`.
- **Binding and Fencing:** Binding with `run-use --from <handle>` fences any prior coordinator (such as an agent chat terminal). The viewer prompts for explicit operator confirmation before taking over. One-off mutations (`asCoordinator`) on inactive, unbound, or externally coordinated Runs require explicit confirmation matching current Run binding evidence (`coordinatorControl: { confirmed: true, coordinatorHandle: string | null, consumerGeneration: number | null }`), throwing `409 coordinator_control_required` otherwise. The server never silently takes over or binds a temporary terminal without consent.
- **Handoff and Workers (1.4.242+):** Dispatched workers cannot bind their own or ancestor Run and cannot use `--takeover-legacy`. They communicate using the live preamble. Coordinators can yield or hand off to separate Runs cleanly.
- **Workspace Scoping:** The `<workspace-hash>` scopes the coordinator to a single real workspace path. Two viewers in different workspaces operate independently. A second viewer started in the **same** workspace refuses startup with `coordinator_conflict` (HTTP 409) rather than clobbering the existing coordinator.
- **Teardown:** On Stop or clean shutdown, the viewer closes its coordinator terminal and releases the Run binding.

---

## CLI and Workspace Resolution

The CLI executable and workspace path resolve once at startup. Readiness is re-probed with a short-lived cache scoped to that resolved runtime; it is not a permanent startup verdict.

### Executable Resolution Order

1. `ORCA_CLI_COMMAND`: Exact executable and quoted argv parsed without a shell. Shell operators (`|`, `>`, `&&`, `$()`) are strictly rejected.
2. `orca-dev`: Used when `ORCA_DEV_REPO_ROOT` is defined.
3. `orca-ide`: Used on **Linux outside an Orca terminal** to prevent collision with GNOME's screen reader (`/usr/bin/orca`).
4. `orca`: Default standard executable on PATH.

Every execution runs via `spawn` with `shell: false` and the workspace directory as `cwd`.

### Workspace Resolution

`WORKSPACE_DIR` defaults to `process.cwd()`, verified for existence and resolved to its canonical real path (symlinks collapsed). It forms the Orca worktree selector `path:<WORKSPACE_DIR>`. An explicit `ORCA_WORKTREE` environment variable overrides this selector.

### Execution Enablement Gate

Checked via `GET /api/readiness`:
- **Execution:** CLI ≥ 1.4.205 plus a positively ready selected runtime with stable appVersion ≥ 1.4.205. A newer CLI alone does not establish readiness.
- **View-only:** Older, unknown, unreachable, or starting runtimes keep execution disabled (`503 execution_disabled`); available read operations remain accessible.
- **Orca < 1.4.160 / Not Found:** Unsupported. Readiness reports the exact attempted CLI resolution and error.

---

## Code Layout

```text
skill/
  SKILL.md                 Thin project workflow: PRD → design → task DAG → viewer.
                           Delegates CLI syntax to `orca skills get orchestration`.

server/src/
  index.ts                 Process entry: CLI arguments, workspace resolution, loopback listener.
  app.ts                   Express app (createApp): API route definitions and SPA serving.
  activity.ts              Run-scoped event parser and bounded Activity journal.
  requestLedger.ts         Bounded mutation-request audit ledger (.orca-dag/requests.jsonl).
  providerSessions.ts      Durable sessions.json store with bindings, mailboxChecks, and guidanceSends.
  operatorMessages.ts      Durable operator reply and group send helpers with sessions.json checkpoints.
  taskGuidance.ts          Proactive worker guidance, typed receipts, and read-only recovery.
  stageGit.ts              Git Stage evidence, immutable base commit capture, and merge handshake.
  security.ts              Security enforcement: loopback binding, mutation tokens, input validation.
  coordinator.ts           Self-driven coordinator loop: DAG polling, worker-start, placement, settlement.
  orca.ts                  Orca CLI wrapper: command invocation, version detection, discovery, gates.
  orca.test.ts             Unit tests for CLI resolution, readiness gates, and conflict detection.
  runHealth.ts             Run ownership and health diagnostics (viewer-owned / external / unbound).
  config.ts                Workspace configuration persistence (.orca-dag/config.json).
  workspaceState.ts        State file paths, migration from legacy root files, and safety fallbacks.
  skill.ts                 Automated installation of SKILL.md into local agent directories.
  planning.ts              Managed .gitignore block handling for .orca-dag/.
  uninstall.ts             Uninstallation logic: unlinks skills, closes stale coordinator terminals.
  webAssets.ts             Build-time asset loader for embedded frontend and skill assets.
web/src/
  App.tsx                  Main workbench shell, section navigation, URL hash routing, 2s polling loop, execution state guards.
  components/
    DagView.tsx            Lazy-loaded React Flow DAG canvas, 280x120 node rendering, scoped status dot animation, static edges.
    ExecControls.tsx       Portaled execution action group (header) and execution settings panel (Settings section).
    NodePanel.tsx          Task configuration and detail panel: spec preview, lead-stage toggle, locked preferences, placement, gate creation (rendered in Chat Task tab).
    PlacementEditor.tsx    Placement editor: 4 local modes, 2 remote modes, creation metadata.
    LanesPanel.tsx         Workspace lanes management: runtime state, diffs, and worktree removal.
    ActivityPanel.tsx      Real-time event timeline (single shared SSE), filters, technical evidence inspection.
    ChatPanel.tsx          Shared Run group / Task-private messages, explicit @Task sends, mobile list/detail navigation.
    MailboxChecks.tsx      Separate bounded check evidence, delivery/replay groups, and raw receipt details.
    HarnessAvatar.tsx      Local official harness marks, source/license notices, and neutral unknown fallback.
    useScopedChatState.ts  Scoped drafts and receipts; shared per-Task busy/unknown guards across chat views.
    GatePanel.tsx          Approval gate buttons and cross-lane integration gates.
    RunPicker.tsx          Workspace-scoped Run selector, pagination cursor, and exact Run lookup.
    WorkerPanel.tsx        Fleet view: liveness, output reader, search, download, stop/abandon/focus.
    RequestAuditPanel.tsx  Mutation request audit table with live request-show receipts.
  harness.ts               Reactive state store for preferences, hydrating from /api/config.
  placement.ts             Client-side placement grammar and lane preflight validation.
  layout.ts                Dagre layered layouts (LR/TB, 280x120 nodes).
  types.ts / api.ts        Frontend data contracts and API client.
  workbench.css            Sectional workbench layout, 7-app dock navigation, header, operational sections, and responsive breakpoints.
  chat-dock.css            Persistent right chat dock, message bubbles, thread navigation, and composer layout.
  graph-motion.css         Task node styling (280x120), static edges, and scoped executing dot motion guards.

scripts/
  build-binary.mjs         Bundles Vite web assets + server into a standalone Bun binary.
  build-npm.mjs            Builds web assets and compiles server with esbuild for npm package.
  build-all-binaries.sh    Cross-compiles standalone binaries for all supported platforms.
  check-skill.mjs          Validates SKILL.md frontmatter and guards against CLI syntax drift.
  release.mjs              Automates versioning, tagging, and triggering CI release workflows.
```

---

## Design Notes and Boundaries

- **The Brain Lives Outside:** The viewer does not embed an LLM SDK. Planning is owned by your primary agent.
- **The Viewer is its Own Coordinator:** Orca deliberately does not provide an autonomous scheduler. The viewer coordinates task execution using Orca's primitive APIs (`worker-start`, `send`, `worker-stop`, `worker-release`).
- **Autonomous Workers Required:** Workers must have permission to execute commands and send `worker_done` without manual terminal prompts; otherwise execution stalls.
- **The Dispatch Inject Quirk:** On legacy terminal paths, `dispatch --inject` pastes text into the agent input box but may not submit. The coordinator waits ~2 seconds and issues a harmless trailing Enter.
- **OpenCode Launch Modes:**
  - Standard Auto: Uses native `opencode2` when no model override is provided (Orca ≥ 1.4.220).
  - Explicit Model in Auto: Uses native `opencode` model path on Orca ≥ 1.4.241.
  - Experimental Pinned Full TUI: Activated via `ORCA_DAG_OPENCODE_TUI=1` on Orca ≥ 1.4.222.
- **Exact Placement or Refusal:** Local execution supports exactly 4 modes (`current`, `exact-existing`, `new-child`, `new-top-level`); remote execution supports 2 modes (`exact-existing`, `new-top-level`). Invalid or ambiguous placement requests fail closed before invoking Orca.
- **Orca Owns Worktrees:** Worktrees are created exclusively via `worker-start` and removed exclusively via `orca worktree rm`. Direct Git commands or directory deletions are never used.
- **Immutability of Executed Tasks:** Orca provides no single-task edit, delete, or reset API (`reset --tasks` wipes all Runs globally). Plan modifications require generating a new DAG in a fresh Run.
