# Light two-area orchestration workbench layout

English | [简体中文](ui-layout_zh.md) · [Documentation](README.md)

## Goal and decisions

Help an operator answer, in order: what is happening, what needs my decision,
which task or worker is involved, and what evidence supports the state.
The application implements a light, Apple-inspired two-area workbench
(`workbench.css`, `styles.css`, `chat-dock.css`, `graph-motion.css`), replacing
legacy dark console aesthetics with clean silver-gray surfaces, system typography,
and a responsive two-pane architecture:
- **Desktop (Left Canvas, ~54%)**: Persistent React Flow DAG canvas (`.workbench-canvas`),
  providing continuous dependency visualization without unmounting or viewport collisions.
- **Desktop (Right Operations, ~46%)**: Resizable app-style operations area (`.workbench-operations`)
  with an App Home launcher (`.workbench-nav--home`), a compact bottom dock navigation (`.workbench-nav--dock`),
  in-place task inspection (`NodePanel` in `.workbench-detail`), an integrated Chat application
  (`ChatPanel` in `.workbench-chat`), and full operational sections. Opening chat retains the operations
  panel width rather than crowding a third column or collapsing the canvas.
- **Mobile / Tablet (≤900px)**: A dedicated top pane switch (`.workbench-mobile-switch`) toggles between
  Canvas (`taskView.graph`) and Operations (`workbench.home`). Selecting a task opens the inspector in
  the operations area; closing the inspector automatically returns to the canvas when triggered from canvas.

| Area / Surface | Component / Selector | Content |
| --- | --- | --- |
| Header | Adaptive grid header (`.workbench-header`) | Compact Run picker (with ellipsis truncation, full tooltip, search, history pagination, and exact-ID lookup; no in-page New Run button), progress, coordinator health, icon-only connection status, preview/Stop and execution notices (`.workbench-action-host`), and language toggle. |
| Canvas (Left, Persistent) | `.workbench-canvas`, `DagView` | Persistent lazy-loaded React Flow DAG; icon-only Run/Run again control (`.workbench-launch-host`) beside the Radix View popover, which contains the status legend, hierarchy toggle, layout selector and relayout action. |
| Operations: Home Launcher | `.workbench-nav--home` | Four-column app launcher (three columns below 360px operations width), plus completion and actionable summaries that preserve partial, stale and unknown evidence. |
| Operations: Bottom Dock | `.workbench-nav--dock` | Eight app shortcuts at operations widths ≥640px; below that, Chat, Tasks, Decisions, Executions and All apps form five columns. Other apps remain accessible from Home without horizontal scrolling. |
| Operations: Tasks & Inspection | Tasks section (`TaskList`), Detail (`NodePanel`) | Accessible vertical task list (`TaskList`) and in-place task inspector (`NodePanel` inside `.workbench-detail`) in normal document flow (`position: static; width: 100%`) with heading `h1.node-panel__title`, replacing the section view while retaining route, scroll offset, and selection context. |
| Operations: Decisions | Decisions section | Full actionable operations list (`OperationsAttention` full variant), pending approval gates (`GatePanel`), and interrupted start recovery (`RecoveryPanel`). |
| Operations: Executions | Executions section | Worker fleet view (`WorkerPanel`) with distinct worker fields, capability columns, exact Dispatch identities without duplicate Task ID fallback, neutral `exited` status observation (`#64748b`), archived output reader, search, download, release/retain controls, and coordinator takeover guards. |
| Operations: Activity & Audit | Activity section | Real-time event timeline (`ActivityPanel`) powered by a single shared SSE stream (auto-pausing when hidden), plus mutation ledger (`RequestAuditPanel`). |
| Operations: Resources | Resources section | Workspace lanes (`LanesPanel`) with branch diffs and explicit read/uninspected evidence state (`lane.pending`), plus on-demand workspace cleanup (`CleanupPanel`) with safe merged branch deletion. |
| Operations: Settings | Settings section | Run-level execution configuration defaults, in-flow grouped execution controls (`ExecControls`), and runtime preflight capability diagnostics (`CapabilityPanel`). |
| Operations: Communication | `.workbench-chat`, `ChatPanel` | Integrated chat application retaining panel width, featuring a conversation sidebar (`.chat__sidebar`) with Private threads and Group broadcast modes, urgent/unread/pending badges, live check receipts, audience-based Run broadcast, and scoped chat state via `useScopedChatState`. |

The architecture decouples the persistent graph canvas from the operations container.
Navigation between Home, Chat and the seven sections is synchronized with URL hash routing
(`#section=home`, `#section=chat`, `#section=<name>&task=<id>`), preserving browser history
and Run-scoped scroll positions. Reload restores Home or Chat instead of falling back to Tasks.
Selecting a task replaces the operations section with the in-place `NodePanel`; closing restores
the retained section or graph context. One visible page `h1` belongs to the operations header,
or to the inspector while inspecting a task.
## Presentation rules

- Known operation and terminal codes have English/Chinese labels. Unknown codes
  remain verbatim; translation never grants permission or implies completion.
- `absent` requests mean no runtime record, not proof that nothing happened.
- Resolve task names from the current DAG. Keep full task, Dispatch, request, and
  Run identifiers in expanded evidence; unknown names fall back to their IDs.
- Structured results preserve `false`, `0`, null, empty collections, unknown
  keys, arrays, and nested objects. Native disclosures reveal nested collections.
- Worker report fields are type-checked before formatting. Long bodies expand
  independently of diagnostic data. Original JSON remains available verbatim.
- Apple-inspired light design tokens: Crisp 1px structural borders (`var(--line)` `#dcdce1`,
  `var(--line-strong)` `#c9cbd1`), white and silver-gray surfaces (`var(--paper)` `#ffffff`,
  `var(--paper-2)` `#f5f5f7`, `var(--paper-3)` `#eaecef`), dark neutral typography (`var(--ink)` `#1d1d1f`,
  `var(--ink-soft)` `#565b65`, `var(--ink-faint)` `#626771`), Apple system blue accent (`var(--sky)` /
  `var(--sky-ink)` `#0066cc`, `var(--sky-wash)` `#eaf3ff`), and calm semantic status colors:
  completed/success green (`--meadow: #257344`), ready cyan/blue (`--sky: #0066cc`), pending/dispatched amber
  (`--butter: #92600d`, `--lilac: #6554a4`), blocked brown-orange (`--flame: #a45110`), failed/error red
  (`--coral: #b83232`, `--blush: #b83232`), and neutral exited gray (`#64748b`). No dark obsidian backgrounds,
  no SVG `feTurbulence` filters, displacement noise, or external web fonts.
- Preview and Stop portal into the topbar's `.workbench-action-host`, while execution notices,
  errors and running statuses span separate full rows. Run/Run again instead portal into the
  canvas toolbar as a 40px icon button (44px on narrow screens), retaining a translated
  accessible name, tooltip, policy locks and the unchanged preflight confirmation.
  Narrow-screen users switch to the dependency graph to launch; Stop stays globally accessible.
  The Run selector fills the remaining header width
  with ellipsis truncation and a full title. Desktop uses one control row; narrow screens use
  Run/language, execution controls, then connection/progress rows with 44px action targets.
  The viewer does not offer an in-page "New Run" button; Run creation belongs to planning agents or CLI,
  while the viewer reads and coordinates existing Runs (the backend `POST /api/runs` remains public and unchanged).
- Connection uses a link or broken-link icon without visible text. Existing status colors,
  focusable status semantics and detailed accessible/hover descriptions retain unknown,
  failed-read and execution-disabled distinctions; a connected icon never grants execution.
### Read states

Four distinct read states avoid conflating connectivity errors with empty data:
1. *Loading*: Initial read in progress, rendering a dedicated loading indicator.
2. *First-read failure*: The selected Run has no successful task snapshot, or the initial Run list cannot be read before a Run is selected. Shows explicit error details with expandable technical data and a page reload button. Launch preview and execution remain unavailable without task data.
3. *Confirmed empty*: Run list or DAG snapshot loaded cleanly with zero items. Renders an explicit empty prompt, distinctly separate from loading or failure.
4. *Stale snapshot*: A successful same-Run snapshot exists, but periodic refresh failed. Retains tasks and counts on screen, displays a stale-data banner, and keeps details readable. **Retry read** refreshes projections without replaying mutations, re-executing launches, or reloading the whole page.

`RunPicker` exposes its first-list read state (`RunListReadState`: `loaded`, `error`) so the root view correctly differentiates an empty workspace from a connection failure. Its dropdown menu retains history pagination and exact Run ID lookup; planning/CLI creates Runs, and the picker only reads existing Runs without an in-page New Run button.

### Keyboard navigation and central inspector focus

- Pressing `Enter` or `Space` on a focused DAG node or TaskList item opens its central detail inspector (`NodePanel`).
- Opening the inspector automatically moves focus to the title heading (`h1.node-panel__title`, `id="node-panel-title"`, `tabIndex={-1}`) for immediate screen-reader and keyboard orientation.
- Pressing `Escape` in `NodePanel` closes the inspector and restores focus to the triggering element (via `requestAnimationFrame`).
- Nested dropdowns (`DoodleSelect` for harness or model selection) consume `Escape` first to close their own menu, preventing unintended closure of the outer inspector panel.

### Responsive presentation and mobile pane switch

- **Desktop two-area layout (~54% / ~46%)**:
  - The left canvas (`.workbench-canvas`) occupies approximately 54% of viewport width by default, keeping the React Flow DAG permanently mounted and interactive.
  - The right operations area (`.workbench-operations`) occupies approximately 46% by default and is resizable via a vertical drag handle (`.workbench-chat-resize`). Width is clamped between 380px and 820px (`COMMUNICATION_MIN_WIDTH = 380`, `COMMUNICATION_MAX_WIDTH = 820`), reserving at least 320px for the canvas (`CANVAS_MIN_WIDTH = 320`).
  - The separator supports Left/Right arrows in 32px steps and Home/End for minimum/maximum width. Its ARIA value follows the rendered width, including viewport constraints.
  - Opening chat (`communicationOpen`) retains the operations panel width rather than opening an extra column or squeezing the DAG canvas.
- **Mobile / Tablet breakpoint (≤900px)**:
  - The dual-column layout collapses into a single-pane view switched via `.workbench-mobile-switch` at the top of the workbench.
  - Two mutually exclusive buttons allow toggling between Canvas (`taskView.graph`) and Operations (`workbench.home`).
  - Activating a task from the canvas automatically switches `mobilePane` to `"operations"` to display `NodePanel`.
  - Closing `NodePanel` restores focus and, if focus originated in the canvas, automatically switches back to the `"canvas"` pane.
- **Radix primitives and in-flow settings**:
  - `radix-ui` is the shared primitive library; existing CSS owns visual styling, not a second component theme or direct positioning library.
  - The View menu and coordinator health use portalled Radix Popovers with collision bounds, outside dismissal and Escape focus return. There is no global disclosure-close listener.
  - `DoodleSelect` uses Radix Select for simple enums, including empty-string configured defaults and readable disabled saved choices. Searchable Run/model/environment/lane/audience controls use Popover plus an explicit combobox/listbox; labels, values and hints remain searchable. Run history pagination and exact-ID lookup stay available.
  - Tooltip associates descriptions with the actual focusable trigger. Disabled controls retain adjacent reasons rather than gaining an extra tab stop.
  - Execution settings remain an in-flow native disclosure in Settings. Unlike transient popovers, outside clicks do not collapse this form.
### Structured preflight launch preview

- Preflight launch preview (`LaunchPreview` in `DecisionDialog`) presents the full plan before execution:
  - Requested defaults (default harness and max concurrency) displayed once at top; OpenCode interface default appears only when OpenCode is relevant.
  - Common limitations shared across all tasks are deduplicated and summarized once at top, avoiding repetitive noise.
  - Full task names, falling back to exact IDs; expand a task to inspect or copy its complete ID. Clipboard denial provides manual-copy feedback.
  - Tasks with unsupported routes, unknown route/limitation codes, or task-specific limitations are flagged for review and automatically expanded (`open={needsReview || undefined}`).
  - Task-specific requested overrides (harness, model, effort, retention, placement, environment, lane, OpenCode UI) shown distinctly under each task.
- `DecisionDialog` handles the preview modal:
  - Custom `content` rendered independently of text `message`.
  - Radix Dialog owns focus containment, body scroll locking and dismissal. The existing promise queue, required prompt validation, safe initial Cancel focus, and final return to the original trigger remain intact. Collapsed disclosure contents are skipped by keyboard navigation; nested selectors consume Escape before the dialog.
  - Safe cancellation: Cancel, "Not now", `Escape`, or backdrop dismissal never calls `POST /api/run`. Preferences already saved while preparing the preview remain saved.
  - Strict authority boundary: Preview reflects configuration intent and dry preflight rules; it does not verify runtime execution, model availability, or worker readiness on the execution host.

### Dynamic stream management and generation guards

- **Activity SSE stream (`/api/activity/stream`)**: Single shared event stream that automatically pauses and closes when the document is hidden (`document.visibilityState === "hidden"`), verified via controlled document visibility events and live server EventSource. Preserves unread counts and reconnects with a fresh refresh when visibility returns.
- **Generation tokens**: Detail and output views track request and selection generation tokens (`generation.current`, `outputGeneration.current`) to ignore out-of-order or stale async responses across rapid selection and Run changes.

### Operations, governance, and normal-flow panels

- **Normal document flow**: Operational cards and panels (`.gates`, `LanesPanel`, `CleanupPanel`, `WorkerPanel`, `SchedulerPanel`) and the central detail inspector (`.workbench-detail .node-panel`) participate in normal document layout flow (`position: static; width: 100%`). Global `.gates` is no longer absolute, eliminating vertical coordinate collisions where Lane and Cleanup previously overlapped the central heading.
- **Overview vs. Decisions**: Overview hosts a compact `OperationsAttention` summary (`variant="summary"`) showing actionable counts and an in-flow "Open decisions" button (`attention.openDecisions`), while Decisions hosts the full interactive list (`variant="full"`) with per-item focus and resolution controls.
- **Lane evidence state**: `LanesPanel` explicitly reports when lane evidence has not yet been read or is unavailable (`lane.pending`), avoiding false negative assumptions.
- **Worker fleet & Dispatch identity**: `WorkerPanel` presents distinct worker fields, capability columns, and exact Dispatch identities, avoiding duplicate Task ID fallbacks. Agent termination is reported with neutral `exited` liveness (`#52647a`), denoting process termination without implying success or failure.
- **Cleanup panel (`CleanupPanel`)**: On-demand candidate review (`review`), protecting main and active workspaces by rechecking the global complete fleet (`listWorkers(undefined, { includeRemote: true })`) to guard unlisted other-Run chats. Requires per-item typed confirmation and exposes a native safe `deleteBranch` choice (only deletes merged branches) with `preservedBranch` evidence.
- **Canonical approval gate creation (`POST /api/gates`)**: Supported in `NodePanel` for same-Run not-yet-dispatched Tasks, protected by coordinator lifecycle locking.
- **Coordinator control consent**: One-off mutations against inactive, unbound, or externally bound Runs require explicit operator confirmation matching current binding evidence (`coordinatorControl`), refusing implicit takeover.
### Memory limits and technical boundaries

Technical documentation and performance reviews must clearly distinguish between **V8 JavaScript heap memory** and **browser renderer/GPU process memory**:
- JavaScript heap metrics measure memory allocated to JS objects and closures inside the V8 engine.
- Browser renderer process and GPU compositor memory (textures, layer backing stores, canvas rendering contexts, DOM node tree backing) are managed separately by the browser and operating system.
- Replacing continuous SVG filter evaluations, eliminating perpetual animation loops, and lazy-loading graph components lowers CPU and compositor work; however, memory and performance claims must be grounded in actual measured evidence. No quantified CPU, compositor, or memory gains have been benchmarked or certified. Historical Run 533 baseline recorded JS heap old 5708840 / new 5769648, with zero GPU or total renderer memory reduction. Never claim GPU or renderer memory reductions based solely on JS heap measurements, and never describe performance optimization plans as measured gains.
## Chat architecture and broadcast semantics

The communication dock (`.workbench-chat`) is integrated into the right operations area
(`workbench-operations`), retaining the operations panel width (~46% on desktop) rather than
opening an intrusive third column or collapsing the DAG canvas. Body text is 16px (`1rem`)
with a 1.6 line height; metadata is 14px (`0.875rem`) or 12px (`0.75rem`), and conversation
titles are 16px semi-bold. Outgoing messages use Apple system blue wash (`var(--sky-wash)` `#eaf3ff`),
incoming messages use soft light-neutral (`var(--paper-2)` `#f5f5f7`), and error messages use
blush wash (`var(--blush-wash)` `#fceeee`). Message bubbles are capped at comfortable reading
widths with word-break safeguards (`overflow-wrap: anywhere`).

Chat launcher and Dock entries use the same outlined speech-bubble icon.
The runtime summary (`.chat-runtime-summary`) uses centered, wrapping rows for status,
detail and last-check metadata. The status dot stays grouped with its label; long translated
labels and check counts do not create intrinsic-width columns wider than the conversation.

- **Conversation sidebar (`.chat__sidebar`)**:
  - Pinned sidebar (`flex: 0 0 150px`) with a view switcher (`chatView === "private" | "group"`).
  - **Private mode**: Displays the thread list (`.chat__thread-list`) containing real task conversations
    and the coordinator thread (`COORDINATOR_THREAD`). Each thread item shows the task label, its exact ID
    when distinct, unread status, urgent flag, and count of pending replies needed.
    Coordinator control sits in a stable system slot, preventing control plane traffic from masquerading
    as a peer agent.
  - **Group mode**: Displays an informational note (`chat.sidebar.groupNote`) explaining that group
    broadcast sends to active run targets via the discovered audience composer rather than creating a
    persistent group room.
- **Actual group broadcast semantics**:
  - Group messaging is strictly Run-control audience-based broadcast. It connects to the existing
    coordinator broadcast mechanism and does **not** invent persistent group conversations, persistent
    chat rooms, or synthetic group recipients.
  - The composer provides `DoodleSelect` dropdowns for allowlisted audience targets (such as `@all`,
    `@idle`, active harness groups, and discovered `@worktree:<id>`), message type (`status` vs. `question`),
    and priority levels (`low`, `normal`, `high`, `urgent`).
  - Audience estimation displays discovered active candidate recipients and counts.
  - The composer requires a non-empty body and an available selected audience; the subject is optional.
    It is available when this viewer coordinates the Run, and every broadcast requires confirmation.
- **Responsive container queries (`@container (max-width: 440px)`)**:
  - When the operations area is resized below 440px, the sidebar stacks vertically above the message
    timeline as a compact horizontal scrolling thread strip, preserving thread access without clipping.
- **Scoped chat state**: Chat state is isolated via `useScopedChatState` with precise boundaries:
  - Uncertainty flags (`uncertainMessages`) are scoped by `runId`.
  - Draft text (`draft`) is scoped by `[runId, conversationId, targetId/dispatchId]` (Run, conversation,
    and target question/Dispatch identity).
  - Busy states (`busy`), errors (`error`), receipts (`messageReceipt`, `operatorReceipt`), timeline limit,
    and expanded checks are scoped by `[runId, conversationId]`.
  - Group broadcast drafts, audience selection, subject, and preview states are scoped by `runId`.
  - Switching Runs or recipients isolates in-progress drafts, preventing unintended message delivery or state clobbering.

## Node launch controls

The central node inspector (`NodePanel`) presents launch parameters in dependency order:
Harness/Agent, model, supported effort, placement/environment, and OpenCode interface mode.
It enforces Orca's immutable task contract: once a task has been dispatched, its configuration
is permanently locked.

- **OpenCode model selection**: Displays local-workspace advisory suggestions via searchable
  dropdown, with fallback to manual free-text input (`provider/model[#variant]`). Format
  validation feedback ensures syntax correctness before persistence.
- **Locked fields**: Disabled controls use high-contrast readable text, solid borders,
  and a subtle background tint (`opacity: 1; color: var(--ink); background: var(--paper-2); cursor: not-allowed;`)
  rather than faded gray fields or dashed frames. The explicit lock reason remains visible in adjacent hint text.
- **Desktop vs. Mobile**: Central inspection mounts inside the operations area (`.workbench-detail`)
  on desktop, preserving the persistent DAG canvas on the left; on viewports ≤900px, inspection opens
  the operations pane, and closing returns cleanly to the canvas when opened from canvas.

## Implementation and verification

`App.tsx` coordinates the desktop two-area workbench, mobile pane switching (`mobilePane`: `"canvas"` | `"operations"`),
App Home launcher (`operationHome`), compact bottom dock navigation (`.workbench-nav--dock`), URL hash routing
(`#section=<name>&task=<id>`), read states, portaled execution controls, and central inspector focus.

`DagView` is lazily loaded on first access (`React.lazy`) and retained in memory once mounted. Nodes use
exact dimensions of 280×120px (`NODE_W = 280`, `NODE_H = 120` from `layout.ts`) with
title 16px (line-height 20px, weight 650) and summary 14px (line-height 20px). Dependency
edges are rendered with static solid strokes (`edge--idle`, `edge--run`, `edge--done`)
and dashed hierarchy links, eliminating perpetual animation loops. A gentle executing
pulse (`@keyframes graph-executing`) is scoped to positively evidenced running tasks and
pauses when hidden, inactive, or under `prefers-reduced-motion: reduce`.

### Radix workbench smoke evidence

Browser checks on the local viewer covered Home, Chat and all seven sections in English and
Chinese at widths 1440, 1024, 900, 768, 390 and 320px (108 combinations): no page or Dock
horizontal overflow, and exactly one visible page heading. The 390×844 task view had a
133px settled header and about 542px of main content height; these are sample measurements,
not guarantees for every warning or receipt state.

Also exercised: Home/Chat reload and browser Back, retained task filtering, inspector focus
return, keyboard resizing, graph first reveal after a narrow-screen load, View/health popovers,
search and disabled/default select options, queued confirm/prompt results, required prompt
validation, collapsed-details focus containment, nested popup Escape and outside cancellation.
An isolated throwaway page used the real components for queue/selector edge cases and was removed.
Route switching did not open additional Activity streams. Controlled GET-only DAG failures
retained the two-task stale snapshot, recovered through Retry read, and disabled preview on
first-read failure; recovery sent no mutation requests. These checks do not certify screen
readers, all execution states, new worker launches, or renderer/GPU memory improvements.

### Historical acceptance claims and baseline

Earlier documentation recorded layout-specific measurements and verification samples for a previous
three-column dark console design:
- Specific header settled heights (**69px** on wide screens ≥1200px, **117px** on 901–1199px, **216px** on ≤900px)
  and fixed 56px navigation rail button heights were measured on the retired three-column dark layout.
- The **168 browser sample matrix** (7 routes × 12 widths × 2 languages) was conducted on the retired
  layout baseline (`deep-layout-verification.json`).
- The obsolete test script `scripts/check-ui-layout.js` pinned removed tab counts, classes, and stale API
  fixture shapes; per project test policy, those assertions have been retired rather than re-pinned.

These historical measurements are preserved as context for earlier iterations and do **not** represent
measurements or certified guarantees of the new light two-area workbench layout. In accordance with
project verification policy, no unrun tests, benchmark claims, or WCAG certifications are claimed.

### Functional verification checklist

The following smoke checklist defines the observable behavior of the current light two-area workbench:

1. **Desktop two-area layout and operations resizing**:
   - On desktop (width > 900px), verify the left persistent React Flow DAG canvas (~54% width) and right
     operations area (~46% width) render side-by-side without overlapping.
   - Drag the vertical resize handle (`.workbench-chat-resize`): verify width adjusts smoothly between 380px
     and 820px, maintaining at least 320px for the canvas.
   - Toggle Chat: verify chat opens inside the operations area, retaining the existing operations width without
     displacing or shrinking the canvas.
2. **App Home launcher and bottom dock navigation**:
   - With no hash or section selected, operations displays the App Home launcher (`.workbench-nav--home`) with
     8 app tiles (Chat, Overview, Tasks, Decisions, Executions, Activity, Resources, Settings).
   - Click an app tile: verify the view switches to the corresponding section and the compact bottom dock
     (`.workbench-nav--dock`) appears.
   - Activate the Home icon in the operations header (accessible name "Back to home"): verify the Home launcher opens. The header button has no visible text; the compact Dock retains its separate All apps entry.
   - Use the bottom dock to switch between sections directly without returning to Home.
3. **Persistent DAG canvas and View menu**:
   - In the canvas header, open the View popover (`.view-menu`): verify six-status counts,
     hierarchy link toggle, and layout buttons (`layered-lr`, `layered-tb`, `grid`).
   - Press `Escape`: verify the popover closes and focus returns to its trigger button.
4. **In-place task inspection (`NodePanel`)**:
   - Click a node on the canvas or an item in `TaskList`: operations area switches to `NodePanel`
     (`.workbench-detail`), focusing `h1.node-panel__title`.
   - Close `NodePanel` via Close button or `Escape`: verify previous view and exact scroll position are restored.
   - Inside `NodePanel`, open a nested `DoodleSelect` and press `Escape`: verify the dropdown closes while
     `NodePanel` remains open.
5. **Mobile / Tablet pane switch (≤900px)**:
   - Resize viewport to ≤900px: verify the top switch bar (`.workbench-mobile-switch`) appears with Canvas
     and Apps buttons.
   - Selecting a node from the canvas switches `mobilePane` to `"operations"` to display `NodePanel`.
   - Closing `NodePanel` automatically switches back to the `"canvas"` pane and restores focus to the triggering node.
6. **Chat sidebar and group broadcast**:
   - Open Chat and verify the conversation sidebar (`.chat__sidebar`) displays Private and Group tabs.
   - In Private mode, verify real task threads and coordinator thread display unread, urgent, and pending reply badges.
   - In Group mode, verify the audience composer exposes allowlisted audience selection, message type, priority,
     subject, and estimated recipient list. Confirm no fake group rooms or persistent synthetic recipients are created.
   - Verify draft messages are isolated per Run, conversation, and dispatch target.
7. **Read states and retry**:
   - Verify distinct loading state on initial read.
   - Verify first-read failure displays error details, page reload button, and disables execution controls.
   - Verify confirmed empty state displays empty project prompt.
   - Verify stale snapshot displays stale banner with "Retry read" button that refreshes projections without page reload.
