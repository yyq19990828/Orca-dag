# Viewer Features Reference

English | [简体中文](viewer-features_zh.md)

Back to [README](../../README.md) · [Documentation Index](../README.md)

This reference provides a categorized overview of the features, interface capabilities, and operational tools available in the `orca-dag` viewer.

For operational step-by-step procedures, consult [Operating the Viewer](../tutorials/viewer-operations.md). For compatibility floors, see the [Compatibility Matrix](compatibility.md). For HTTP endpoints, see the [HTTP API Reference](http-api.md).

---

## Visualization and Layout

- **Hand-Drawn Crayon Aesthetic:** The canvas renders in a warm sketchbook style using SVG `feTurbulence` filters, pencil borders, and hand-drawn UI components.
- **Live DAG Visualization:** Task nodes reflect real-time statuses (`pending`, `ready`, `dispatched`, `completed`, `failed`, `blocked`) with distinct colors and corner harness badges. Polling refreshes every 2 seconds.
- **Switchable Layout Engines:**
  - **Dagre Layered:** Supports left-to-right (LR) and top-to-bottom (TB) hierarchical layouts.
  - **Force-Directed:** Fruchterman–Reingold physics simulation for clustered graphs.
  - **↻ Re-layout:** Resets manual node drags and recomputes the selected layout algorithm. Layout choices persist in `.orca-dag/config.json`.
- **Hierarchy vs. Dependencies:** Orca's `parent_id` is drawn as a calm, dotted bracket with a ring on the child node—visually distinct from pencil dependency arrows. Parent links do not influence task readiness or layout and can be toggled via **Hide/Show parent links**.
- **Drag-to-Arrange:** Nodes can be freely dragged on canvas. Dragged positions are preserved across live polling cycles, while untouched nodes continue to follow the layout algorithm.
- **Execution Animations:** Dispatched (running) nodes receive continuous diagonal crayon scribbles. Outgoing edges animate as swimming dashed lines that transition to solid pencil strokes upon task completion.
- **Explicit Lead Stage:** Operators can designate one Task per Run as the semantic main-agent stage. The selected node receives a double indigo outline and a gold `★ Lead` badge. This is visual viewer metadata and does not grant Orca coordinator authority.

---

## Execution and Coordination

- **Self-Driven Coordinator Loop:** Drives execution through Orca's Run, Task, and Dispatch APIs. Ready tasks with satisfied dependencies and resolved gates fire in parallel up to the concurrency limit.
- **Max Parallel Throttling:** The configured concurrency limit bounds direct worker starts against visible active fleet capacity; it is not a runtime-wide hard limit on helpers.
- **Worker Settlement and Terminal Lifecycle:**
  - **Output Archiving:** Settled worker output is read and archived.
  - **Default Release:** The viewer requests release after accepted settlement. Runtime ownership can retain the pane; a release decision is not a guarantee that every terminal closes.
  - **Immediate Compatible Reuse:** Fresh, exact PTY evidence allows immediate terminal reuse for compatible subsequent tasks (`worker-start --terminal`) for non-OpenCode harnesses.
  - **Retain for Debugging:** Setting **Retain for debugging** keeps worker terminals open for post-run inspection.
- **Decision and Integration Gates:**
  - **Approval Gates:** Operators approve or reject decisions in Activity's expandable Operational details, not floating overlays on the canvas.
  - **Cross-Lane Integration Gates:** Cross-lane dependencies automatically generate an `[orca-dag:integration]` gate offering only an `integrated` resolution. The downstream task remains blocked until an operator manually verifies that branch code has been integrated.
- **Blocked Stage Manual Resolution:** Operational details allows reviewed manual completion or explicit retry for a blocked Task whose Dispatch has positively exited according to fleet records.

---

## Harness, Model, and Effort

- **Multi-Harness Selection:** Nodes can run under `claude`, `codex`, `opencode`, `gemini`, `grok`, `cursor`, `droid`, `kimi`, or opt-in custom commands (`ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`). Unconfigured nodes inherit the toolbar's Default harness.
- **Per-Node Model Overrides:**
  - **OpenCode:** Dropdown populated live via `opencode models`.
  - **Claude / Cursor:** Free-text model input passed via `worker-start --model`.
  - **Codex:** Local POSIX current/existing workspaces use native model starts on running Orca ≥ 1.4.217. Older/unknown runtimes and newly created local workspaces retain prestart-and-bind compatibility; remote and Windows use native starts. See [Codex startup boundaries](../tutorials/viewer-operations.md#codex-native-startup-and-compatibility).
- **Reasoning Effort:** Claude, Codex, and Cursor expose their supported effort levels only alongside a model. Native launches use `--effort`; compatibility-prestarted Codex receives effort in its launch command.
- **OpenCode Interface Selection:**
  - **Auto Mode (Default):** OpenCode Tasks without a model override use native `opencode2` on Orca ≥ 1.4.220. Explicit models use native `opencode` only when all [compatibility conditions](compatibility.md) hold; other requests retain their existing routing. Native refusal never launches a second worker.
  - **Explicit Mini TUI / Full TUI:** Available on Linux current/existing non-lane workspaces (Orca ≥ 1.4.222, OpenCode ≥ 2.1.2).
  - **Experimental Model-Pinned Full TUI:** Enabled via `ORCA_DAG_OPENCODE_TUI=1` on Orca ≥ 1.4.222.
- **Immutable Launch Preferences:** Harness, model, effort, environment, and placement lock permanently once a Task launches its first Dispatch. Retries preserve identical settings across viewer restarts.

---

## Workspaces, Placement, and Lanes

- **Four Local Placement Modes:**
  1. **Current Workspace:** Executes in the coordinator's primary workspace.
  2. **Exact Existing Workspace:** Uses an Orca-discovered worktree from `worktree list`.
  3. **New Child Worktree:** Stacked worktree created on-demand during `worker-start`.
  4. **New Top-Level Worktree:** Independent worktree created from an Orca-registered repository (`repo list`).
- **Bounded Creation Metadata:** New worktree placements accept an explicit or deterministic derived name, setup policy (`run`, `skip`, `inherit`), base branch, display name, and comment.
- **Remote Environment Placement:** Tasks can execute on connected remote environments (`environment list`) using either an exact remote workspace selector or a new top-level worktree. Ambiguous remote current or child placements are rejected.
- **Workspace Lanes (Serial Shared Worktrees):** Chains of dependency-ordered tasks can share a single isolated workspace. The first task provisions the workspace; subsequent tasks reuse the exact selector. Concurrent execution within the same lane is prohibited.
- **Orca-Native Review and Teardown:** Open changed files, diffs, or files in the Orca editor via `file open` / `file diff` / `file open-changed`. Worktree removal is executed strictly via `orca worktree rm` with confirmation, blocked if active or unproven workers remain.

---

## Monitoring and Observability

- **Workspace-Scoped Run Picker:** Displays Runs created within the active workspace, with cursor-based pagination and exact Run ID search.
- **Run Health Badge:** Real-time badge indicating whether the selected Run is `viewer-owned`, `external`, `unbound`, or `inconsistent`.
- **Runtime Capability Matrix:** Evaluates active Orca runtime capability advertisements against canonical orchestration specifications.
- **Scheduler and Ready Queue:** Displays ready tasks in ID order, available worker concurrency, and evidence-backed wait reasons (unmet dependency, gate, concurrency limit, or unknown).
- **Communication Center (Activity & Chat):**
  - **Activity Timeline:** Real-time Server-Sent Events (SSE) stream of coordinator checks, transitions, and technical receipts with bounded polling fallback.
  - **Chat Panel:** Stage-scoped conversations displaying assignment instructions, worker reports, and question/answer threads.
  - **Live Check Receipts:** Live log of coordinator inbox polling passes, message types, and agent summaries.
- **Coordinator Group Messaging:** Send audited announcements to `@all` or discovered worktree audiences from an active coordinator. Lifecycle message types cannot be broadcast.
- **Workers Panel:** Fleet inspector showing liveness (`live`, `unverifiable`, `exited`), attention flags, agent wait states, execution host, requested vs. effective settings, and output logs with source badges (`auto`, `terminal`, `transcript`). Includes client-side log search and CSV/text download.

---

## Recovery and Request Audit

- **Background Session Recovery:** Automatically associates external provider sessions (Claude, Codex, OpenCode) with Orca Dispatches using process, preamble, or window markers, or allows manual ID binding. Probes provide external observation without mutating task state.
- **Per-Dispatch Interventions:**
  - **Stop:** Terminates a positively identified active Dispatch (`worker-stop`).
  - **Abandon:** Fences orchestration state (`worker-abandon`) for confirmed exited or outcome-unknown attempts.
  - **Focus:** Switches focus to a local worker terminal (`terminal switch`) when Orca reports active `agentWait`.
- **Mutation-Request Audit Ledger:** Every mutating request records a durable request ID in `.orca-dag/requests.jsonl` prior to execution. The read-only audit panel probes `request-show` to distinguish `completed`, `pending`, `absent`, and `unknown` receipts without replaying mutations.

---

## Interface Language and Internationalization

- **Bilingual Interface:** Ships in English and Simplified Chinese.
- **Top-Bar Toggle:** The **中 / EN** button switches the interface language instantly with a single click.
- **Browser Locale Auto-Detection:** First-time visits use Simplified Chinese for a `zh`-prefixed `navigator.language`, English otherwise.
- **Client Persistence:** Language preference is stored in browser `localStorage` (`orca-dag:lang`) across sessions.
- **Strict Translation Coverage:** All UI components, DAG nodes, status labels, dialogs, and panels follow the chosen language.
- **Verbatim Server Diagnostics:** Server error messages, readiness failure reasons, and raw Orca CLI output remain in their original English form to facilitate troubleshooting and log correlation.
