# Viewer Features Reference

English | [简体中文](viewer-features_zh.md)

Back to [README](../../README.md) · [Documentation Index](../README.md)

This reference provides a categorized overview of the features, interface capabilities, and operational tools available in the `orca-dag` viewer.

For operational step-by-step procedures, consult [Operating the Viewer](../tutorials/viewer-operations.md). For compatibility floors, see the [Compatibility Matrix](compatibility.md). For HTTP endpoints, see the [HTTP API Reference](http-api.md).

---

## Dual-Surface Workbench, Native Plugin, and Visualization

- **Full Workbench Tab (4-Zone Dual-Theme IDE Layout):** A crisp monochrome Light & Dark IDE workbench (`styles/ide-workbench.css`, automatically following Orca's host theme with manual toggle) with custom fork-join DAG emblem (`DagBrandMark`), Left Fleet & Gates explorer, Center persistent React Flow DAG canvas / Status Board / Run History / Workspaces & Cleanup / Execution & Capabilities, Resizable Bottom Dock (`Activity Stream`, `Worker Output`, `Request Ledger`), and Right Contextual Inspector (`Messages`, `Session`, `Task`, `Config`).
- **Streamlined Right-Sidebar Companion (`SidebarApp` in `orchestration-panel`):** Native Orca plugin panel (`?view=sidebar`, `320–450px`) bundled with its own self-hosted embedded backend (`plugin/server/index.mjs`, zero manual terminals required). Shows a compact Run progress strip, 3 tabs (**Tasks** / **Pending** / **Live**), task drill-in reusing the full workbench's exact `ChatPanel` **Messages** bubbles alongside **Session** tool cards and **Output**, and a single `↗ Tab` button (`POST /api/open-tab`) that opens or revives the full workbench Tab in-place.
- **Live Session Tool Cards (`NodeSessionPanel`):** The Sidebar and Tab render collapsible tool-call cards and conversation turns from the exact worker's native `worker-read` transcript over `OutputTail` SSE (`/api/workers/:dispatchId/output/stream`). Agent status, tool and prompt events wake that read by terminal ID; the bridge does not carry previews.
- **L1 Native Session Resume:** The authenticated `POST /api/workers/:dispatchId/resume-preview` is read-only. It checks for exact history in the original local workspace and provider, using the recorded session binding or an explicit selection if none exists. `POST /api/workers/:dispatchId/resume` refuses active sessions and pre-existing panes, then binds only a newly resumed `agent.resume` pane to a fresh Dispatch (`worker-start --terminal --retry-of`). Journaled in `sessions.json` (`resumeAttempts`). OMP and Antigravity do not support this route.
- **Live DAG Visualization:** Task nodes render with fixed dimensions (280×120px; title 16px, summary 14px) and real-time status colors (`pending`, `ready`, `dispatched`, `completed`, `failed`, `blocked`) with corner harness badges. Polling refreshes every 2 seconds.
- **Lazy Graph Loading:** `DagView` is lazy-loaded on first view (`React.lazy`) and retained in memory after initial mount to keep the initial bundle and memory footprint lean.
- **Switchable Layout Engines:**
  - **Dagre Layered:** Supports left-to-right (LR) and top-to-bottom (TB) hierarchical layouts.
  - **↻ Re-layout:** Resets manual node drags and recomputes the selected layout algorithm. Layout choices persist in `.orca-dag/config.json`.
  - **View panel:** Groups six status counts, line-style examples, the parent-links switch and two layout directions. Retired force-layout preferences migrate to horizontal without changing execution settings.
- **Hierarchy vs. Dependencies:** Orca's `parent_id` is drawn as a calm, dotted bracket with a ring on the child node—visually distinct from dependency lines. Parent links do not influence task readiness or layout; the **View → Connections** switch controls their visibility.
- **Drag-to-Arrange:** Nodes can be freely dragged on canvas. Dragged positions are preserved across live polling cycles, while untouched nodes continue to follow the layout algorithm.
- **Static Edges & Scoped Motion:** Dependency lines remain static (`edge--idle`, `edge--run`, `edge--done`) without continuous flowing animations. Positively evidenced running tasks display a gentle pulsing status marker dot (`@keyframes graph-executing`), which automatically pauses offscreen, when the graph is inactive, or when `prefers-reduced-motion: reduce` is set.
- **Task Private Chat & Detail Tab:** Selecting a node on the canvas navigates to `#section=chat&task=<id>`, opening that Task's private conversation in Chat at the **Messages** view. Complete Task details and configuration (`NodePanel`) are presented as a sibling **Task** tab alongside Messages and Inbox checks. Node configuration mounts on first visit and remains mounted across sibling-tab switches for that conversation, without an independent `h1`, Close button, Escape-to-close handler, or auto-focus, while retaining all controls, launch locks, and operational jump destinations.
  The message field and its shortcut/send toolbar fill the same width in both the workbench and the sidebar. In very narrow panels, Send wraps to its own right-aligned row.
- **Persistent Chat Dock:** A resizable operations dock (`.workbench-operations`, clamped between 380–820px with canvas reservation) hosts conversation threads, Task details, checks, and operational sections. On screens ≤900px, a top switch toggles between Canvas and Operations.
- **Explicit Lead Stage:** Operators can designate one Task per Run as the semantic main-agent stage. The selected node receives a double outline and a gold `★ Lead` badge. This is visual viewer metadata and does not grant Orca coordinator authority.
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
  - **Approval Gates:** Operators approve or reject decisions in the dedicated **Decisions** workbench section (`GatePanel`), with actionable summaries also visible in **Overview** (`OperationsAttention`).
  - **Cross-Lane Integration Gates:** Cross-lane dependencies automatically generate an `[orca-dag:integration]` gate offering only an `integrated` resolution. The downstream task remains blocked until an operator manually verifies that branch code has been integrated.
- **Blocked Stage Manual Resolution:** The **Decisions** section (`RecoveryPanel`) allows reviewed manual completion or explicit retry for a blocked Task whose Dispatch has positively exited according to fleet records.

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
    - **Draft Validation and Persistence:** Manual text input validates against `^[A-Za-z0-9._-]{1,128}/[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}(?:#[A-Za-z0-9._-]{1,128})?$`, supporting slash-namespaced model IDs after the first slash (e.g. `openrouter/meta-llama/llama-3.1-70b-instruct#high`). Invalid drafts set `aria-invalid` and are not written to the node configuration store until valid. Emptying input resets to default model (`null`).
    - **Saved Absent Models Retained:** Models saved in node configuration that are absent from the local catalog remain selectable options in the dropdown and are never dropped or wiped.
    - **Launch-Locked Preferences:** Once a Task starts its first Dispatch (or while the coordinator is active), the model dropdown and manual text input are completely disabled (`disabled={launchLocked}`) along with harness, effort, and placement.
  - **Claude:** Free-text model input passed via `worker-start --model`.
  - **Codex:** Local POSIX current/existing workspaces use native model starts on running Orca ≥ 1.4.217. Local Linux new Git worktrees (`new-child` and `new-top-level`) cut over to native starts on running Orca ≥ 1.4.247, CLI ≥ 1.4.247, and Codex CLI ≥ 0.166.0 (`canUseNativeCodexFreshWorktree`), verified in Run `run_44b240b8e6ee`. Older or unknown runtimes and non-Linux hosts retain prestart-and-bind compatibility; remote and Windows use native starts. See [Codex startup boundaries](../tutorials/viewer-operations.md#codex-native-startup-and-compatibility).
  - **OMP / Antigravity:** Free-text opaque selector, passed unchanged as one native `--model` argument, or omitted for the configured default. Current or exact Existing placement requires both running Orca and resolved CLI ≥ 1.4.245. Creating new Git worktrees (`new-child`, `new-top-level`) or any workspace lane requires BOTH running Orca and resolved CLI ≥ 1.4.246. Local Linux only; remote environments, macOS, and Windows are rejected. New child placement requires a positively identified local managed Git parent; new top-level requires an exact repository identifier (`id:...` or absolute `path:/...`) pointing to a verified local Git repo (rejects ambiguous names, plain folders, foreign hosts, and auto git-init). Workspace lanes share workspace ONLY: the first Task creates or adopts it, dependency-ordered followups reuse exact Existing. Every Task receives a fresh native agent session and Dispatch (never generic terminal reuse, `--terminal`, `--surface` override, or fallback after refusal). Native `worker-start --agent` strictly follows the user's Orca Chat/Terminal setting without inspection or override. Terminal TUI and OMP Native Chat 1.4.245 baselines are preserved; real E2E run `run_67072641a11a` on 1.4.246 verified OMP user-default Chat and Antigravity user-default Terminal across 4 lanes (8 Tasks total, serial workspace handoffs, fresh sessions, zero cleanup debt, setup `skip`, configured-default models). Does not certify new-placement active Stop/restart, Antigravity Chat, Orca-runtime restart, setup `run`/`inherit`, or explicit-model new-placement. Every nonempty effort is rejected, even with a model.
- **Reasoning Effort:** Claude, Codex, and OMP (on running Orca ≥ **1.4.263**) expose their supported effort levels alongside a model. Native launches pass `--effort`; compatibility-prestarted Codex receives effort in its launch command. Antigravity (and OMP on Orca < 1.4.263) reject nonempty effort even with a model; saved unsupported values stay visible with an explicit clear action, and clearing the model does not silently remove them.
- **Single-Use Worker Permission Prompts (Orca ≥ 1.4.263):** Pending worker permission requests surface inline in Chat, Operations Attention, and Sidebar **Pending**, supporting single-use **Allow once** (`approve`) or **Deny** (`deny`) via `POST /api/workers/:dispatchId/permission` when coordinator permission approval is enabled in Orca settings.
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
- **Workspace Lanes (Serial Shared Worktrees):** Chains of dependency-ordered tasks can share a single isolated workspace. The first task provisions the workspace; subsequent tasks reuse the exact selector. Concurrent execution within the same lane is prohibited. Native OMP and Antigravity support workspace lanes and new Git worktrees starting at Orca runtime and CLI ≥ 1.4.246 on local Linux. Admission checks and plan preview evaluate the lane's seed placement and fail before any mutation if runtime or CLI is older than 1.4.246. A lane shares the workspace ONLY: each Task receives a fresh native agent session and Dispatch, never reusing terminal processes or falling back after refusal.
- **Orchestration CLI Compatibility:** `runOrca` appends `--full` to orchestration commands when the resolved CLI is ≥ 1.4.246 (using the cached readiness probe) because 1.4.246 defaults to concise JSON output; CLI 1.4.245 rejects `--full`, so version gating occurs before execution, and uncertain mutations are never retried. Real acceptance verified that a single `POST /api/runs` created `run_2a67b90e6a94` without 500-on-concise failures or duplicate mutations.
- **Orca-Native Review, Safe Cleanup, and Teardown:** Open changed files, diffs, or files in the Orca editor via `file open` / `file diff` / `file open-changed`. Worktree removal is executed strictly via `orca worktree rm --worktree <worktree>` with confirmation, blocked if active or unproven workers remain. Cleanup candidate review (`review`) lists discovered workspaces and workers; removal safety rechecks the global complete fleet (`listWorkers(undefined, { includeRemote: true })`) to protect unlisted other-Run chats. An optional native safe `deleteBranch` choice removes branches only if safely merged upstream and displays `preservedBranch` evidence, never force-deleting unmerged branches from Web.

---

## Monitoring and Observability

- **Workspace-Scoped Run Picker:** Displays Runs created within the active workspace using genuinely bounded workspace-scoped pagination (`GET /api/runs/page?limit=1..100&cursor=`), preserving traversal cursors across refreshes and reporting foreign/unknown Runs honestly (`workspace.owned: false`).
- **Run Health Badge & Removed Work:** Real-time badge indicating whether the selected Run is `viewer-owned`, `external`, `unbound`, or `inconsistent`, with per-source counts, warnings, and optional removed-work ledger evidence:
  - **Removed Work Summary (`health.removedWork`):** Displays removal metrics (tasks, dispatches, workers, terminals, coverage `complete`/`partial`, recordedSince, lastRemovedAt, and `activeWorkersAtRemoval`). When unsupported or absent on the host, `removedWork` is `null` and displayed as unavailable; missing evidence is never zero-padded.
  - **On-Demand Paginated History:** History entries are loaded on-demand via `GET /api/runs/:runId/removed-work` only when explicitly expanding "View removed-work details", avoiding eager payload bloat.
  - **Opaque Cursor & Bounded Pages:** Loads up to 200 entries per official page. Supports "Load more" with client-side cycle detection and cursor advance validation (handles 502/503 errors gracefully with inline alerts and retry).
  - **Historical Activity Indicator:** Entries report `activeAtRemoval` to indicate whether the entity was actively running at the moment of removal—a historical snapshot strictly distinct from current live fleet state.
  - **Future Kind Resilience:** Tolerates unknown removal kinds by marking them `unreadable: true` and rendering them safely.
  - **Immutable & No Reset:** The removal ledger is append-only audit data; no reset button or mutation action exists in the viewer.
- **Runtime Capability Matrix:** Evaluates active Orca runtime capability advertisements against canonical orchestration specifications.
- **Scheduler, Ready Queue, and Canonical Gate Creation:** Displays ready tasks in ID order, available worker concurrency, and evidence-backed wait reasons (unmet dependency, gate, concurrency limit, or unknown). The Task detail view (`NodePanel`) provides canonical approval gate creation (`POST /api/gates`) for same-Run not-yet-dispatched Tasks, protected by coordinator lifecycle locking and request auditing.
- **Communication Center (Activity & Chat):**
  - **Activity Timeline:** Real-time Server-Sent Events (SSE) stream of coordinator checks, transitions, and technical receipts with bounded polling fallback. Pauses/closes when the browser tab is hidden (`document.visibilityState === 'hidden'`), retaining unread counts and refreshing on return.
  - **Chat Panel:** Task-private conversations and one Run group chat share the same retained orchestration messages. Task replies mention `@Coordinator`; group sends require an explicit `@Task` and reuse private guidance/reply APIs and authority checks. Task avatars open the corresponding private conversation. Private lists exclude Run control; narrow panels start with a list and return to the same Private/Group list.
  - **Inbox Checks:** A separate Radix tab retains bounded coordinator check receipts, delivery/replay details, errors and agent snapshots without inserting polling records into chat history.
- **Messaging Boundaries:** Group chat does not create a second message store or broadcast to every worker. In-flight/unknown guidance guards are shared across both views of a Task, while drafts remain view/recipient scoped. Historical broadcasts keep their original audience and enqueue-only provenance; the HTTP broadcast API remains separate.
- **Workers Panel:** Fleet inspector showing liveness (`live`, `unverifiable`, `exited`), attention flags, agent wait states, execution host, requested vs. effective settings, partial host errors (`partialHostErrors`), eligible active Keep-open, explicit Release/Retain, native `autoReleaseAt`, and output logs with source badges (`auto`, `terminal`, `transcript`). Selection and request generation guards prevent stale async detail and output responses from rendering under newer selections. NextAction maps inspect/read/release without prescribing abandon; explicit Abandon remains a separately confirmed fencing action. Includes client-side log search and CSV/text download.

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
