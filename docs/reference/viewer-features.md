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
  - **Immediate Compatible Reuse:** Fresh, exact PTY evidence allows immediate terminal reuse for compatible subsequent tasks (`worker-start --terminal`). OpenCode, OMP and Antigravity are excluded to preserve fresh-session and model identity.
  - **Retain for Debugging:** Setting **Retain for debugging** keeps worker terminals open for post-run inspection.
- **Decision and Integration Gates:**
  - **Approval Gates:** Operators approve or reject decisions in Activity's expandable Operational details, not floating overlays on the canvas.
  - **Cross-Lane Integration Gates:** Cross-lane dependencies automatically generate an `[orca-dag:integration]` gate offering only an `integrated` resolution. The downstream task remains blocked until an operator manually verifies that branch code has been integrated.
- **Blocked Stage Manual Resolution:** Operational details allows reviewed manual completion or explicit retry for a blocked Task whose Dispatch has positively exited according to fleet records.

---

## Harness, Model, and Effort

- **Verified Built-in Selection:** `claude`, `codex`, `opencode`, `omp`, and `antigravity` are selectable within their [recorded version and placement limits](compatibility.md). Unconfigured nodes inherit the toolbar's Default harness (`claude`). Native baselines do not imply unrun viewer/restart checks passed.
- **Unverified Harnesses Refused for Launch:** `gemini`, `grok`, `cursor`, `droid`, and `kimi` have not been concretely verified as supervised worker harnesses and are not exposed as built-in presets or launchable harnesses in the viewer. Any node or saved configuration attempting to launch with these unverified harnesses is rejected upfront with an explicit `unverified_harness` refusal—they are neither silently substituted nor auto-migrated. Historical worker runs and ledger records under those names remain readable in the viewer.
- **Opt-In Custom Commands:** Experimental user-defined custom commands remain strictly opt-in via `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` and run through the legacy local path without isolated placement. Opting into custom commands is an experimental escape hatch and is NOT a verified support claim. The five unverified bare IDs (`gemini`, `grok`, `cursor`, `droid`, `kimi`) are rejected even when custom commands are enabled (they cannot be passed as bare IDs to bypass verification).
- **Skill Installation and Planning Independent:** Bundled skill installation and planning support for detected agents (such as Claude Code, Codex, Cursor, OpenCode, Gemini, Grok, Droid, and Kimi) remain supported separately, as agent skill-capable planning and installation are distinct from supervised worker execution verification.
- **Per-Node Model Overrides:**
  - **OpenCode:**
    - **Advisory Discovery & Live Dropdown:** Populated via local workspace discovery (`GET /api/models/opencode`). Discovery is strictly scoped to `local-workspace`; failures produce controlled English diagnostics without leaking stderr. Distinguishes a verified empty catalog (`status: "available"`, `models: []`) from discovery failure (`status: "unavailable"`).
    - **Dropdown and Manual Free-Text Input:** Supports selecting discovered models or free-text input formatted as `provider/model[#variant]`.
    - **Draft Validation and Persistence:** Manual text input validates against `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(?:#[A-Za-z0-9._-]{1,64})?$`. Invalid drafts set `aria-invalid` and are not written to the node configuration store until valid. Emptying input resets to default model (`null`).
    - **Saved Absent Models Retained:** Models saved in node configuration that are absent from the local catalog remain selectable options in the dropdown and are never dropped or wiped.
    - **Launch-Locked Preferences:** Once a Task starts its first Dispatch (or while the coordinator is active), the model dropdown and manual text input are completely disabled (`disabled={launchLocked}`) along with harness, effort, and placement.
  - **Claude:** Free-text model input passed via `worker-start --model`.
  - **Codex:** Local POSIX current/existing workspaces use native model starts on running Orca ≥ 1.4.217. Older/unknown runtimes and newly created local workspaces retain prestart-and-bind compatibility; remote and Windows use native starts. See [Codex startup boundaries](../tutorials/viewer-operations.md#codex-native-startup-and-compatibility).
  - **OMP / Antigravity:** Free-text opaque selector, passed unchanged as one native `--model` argument, or omitted for the configured default. Requires both running Orca and resolved CLI ≥ 1.4.245, local Linux Current/exact Existing, no lane. Native `worker-start --agent` leaves Chat/Terminal choice to Orca settings without checking or overriding the preference. Terminal TUI baselines used OMP 18.15.0 and Antigravity 1.4.12; Native Chat is unexercised, not blocked. No prelaunch-bind, fallback, generic reuse, new-worktree, remote or Windows path is provided.
- **Reasoning Effort:** Claude and Codex expose their supported effort levels only alongside a model. Native launches use `--effort`; compatibility-prestarted Codex receives effort in its launch command. OMP/Antigravity reject every nonempty effort even with a model; saved unsupported values stay visible with an explicit clear action, and clearing the model does not silently remove them.
- **OpenCode Interface Selection & Native Route Boundaries:**
  - **Auto Mode (Default):** OpenCode Tasks without a model override use native `opencode2` on Orca ≥ 1.4.220. Plain explicit models (without `#variant`, reasoning effort, lane, non-Windows, current/existing placement, not TUI) use Orca's distinct native `opencode` launcher on Orca ≥ 1.4.241+; local catalog discovery is advisory and does not prove execution-host availability.
  - **Compatibility Retention:** Mini TUI, Full TUI, model variants (`#variant`), effort, lanes, new worktrees, and remote placements retain their respective adapters and compatibility routes.
  - **Pre-Launch Route Selection & Refusal:** Launch routing is chosen before dispatch; a native start refusal never authorizes a second or fallback worker.
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
- **Run Health Badge & Removed Work:** Real-time badge indicating whether the selected Run is `viewer-owned`, `external`, `unbound`, or `inconsistent`, with per-source counts, warnings, and optional removed-work ledger evidence:
  - **Removed Work Summary (`health.removedWork`):** Displays removal metrics (tasks, dispatches, workers, terminals, coverage `complete`/`partial`, recordedSince, lastRemovedAt, and `activeWorkersAtRemoval`). When unsupported or absent on the host, `removedWork` is `null` and displayed as unavailable; missing evidence is never zero-padded.
  - **On-Demand Paginated History:** History entries are loaded on-demand via `GET /api/runs/:runId/removed-work` only when explicitly expanding "View removed-work details", avoiding eager payload bloat.
  - **Opaque Cursor & Bounded Pages:** Loads up to 200 entries per official page. Supports "Load more" with client-side cycle detection and cursor advance validation (handles 502/503 errors gracefully with inline alerts and retry).
  - **Historical Activity Indicator:** Entries report `activeAtRemoval` to indicate whether the entity was actively running at the moment of removal—a historical snapshot strictly distinct from current live fleet state.
  - **Future Kind Resilience:** Tolerates unknown removal kinds by marking them `unreadable: true` and rendering them safely.
  - **Immutable & No Reset:** The removal ledger is append-only audit data; no reset button or mutation action exists in the viewer.
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
