# Sectional orchestration workbench layout

English | [简体中文](ui-layout_zh.md) · [Documentation](README.md)

## Goal and decisions

Help an operator answer, in order: what is happening, what needs my decision,
which task or worker is involved, and what evidence supports the state.
The application replaces legacy paper-and-crayon aesthetics and canvas-only containers
with a precise, resource-efficient modern sectional workbench (`workbench.css`, `styles.css`,
`chat-dock.css`, `graph-motion.css`). It pairs a stable command header, a deep navy
navigation rail, a full-width central reading area with in-place task inspection, and a
persistent, resizable right communication dock.

| Reading level | Surface | Content |
| --- | --- | --- |
| Header & Overview | Adaptive header grid (single-row on wide screens ≥1200px, 2-row on <1200px), Overview section | Compact Run picker (with ellipsis and full tooltip, without in-page New Run button), centered coordinator health badge and connection pill, stage completion progress, portaled execution actions, six task status counts, compact actionable operations summary (`OperationsAttention` summary variant with in-flow jump to Decisions), and the scheduler's ready wave with blocking reasons. |
| Tasks & Inspection | Tasks section (List & Graph), Central detail (`NodePanel`) | Accessible vertical task list (`TaskList`) and lazy-loaded DAG canvas (`DagView`); selecting a task mounts `NodePanel` in the central reading area (`.workbench-detail`) in normal document flow (`position: static; width: 100%`) with heading `h1.node-panel__title`, replacing the central view while preserving route, scroll offset, and selection context. |
| Decisions | Decisions section | Full actionable operations list (`OperationsAttention` full variant), pending approval gates (`GatePanel`), cross-lane integration gates, and interrupted start recovery (`RecoveryPanel`). |
| Executions | Executions section | Worker fleet view (`WorkerPanel`) with distinct worker fields, capability columns, exact Dispatch identities without duplicate Task ID fallback, worker liveness (including neutral `exited` status observation `#52647a`), archived output reader, search, download, release/retain controls, and coordinator takeover guards. |
| Activity & Audit | Activity section | Real-time event timeline (`ActivityPanel`) powered by a single shared SSE stream (pausing when hidden), plus mutation ledger (`RequestAuditPanel`). |
| Resources | Resources section | Workspace lanes (`LanesPanel`) with branch diffs and explicit read/uninspected evidence state (`lane.pending`), plus on-demand workspace cleanup (`CleanupPanel`) with safe merged branch deletion. |
| Settings | Settings section | Run-level execution configuration defaults, in-flow grouped execution controls (`.exec__settings-panel`, `ExecControls`), and runtime preflight capability diagnostics (`CapabilityPanel`). |
| Communication | Pinned chat dock (`.workbench-chat`) | Persistent right communication dock with conversation threads, live check receipts, audience previews, and granular scoped state via `useScopedChatState`. |

The architecture separates the graph from the application container. The DAG explains
dependencies; it is not the entire viewport. Navigation between the 7 workbench sections
is synchronized with URL hash routing (`#section=<name>&task=<id>`), preserving browser
history and scroll position. Selecting a task replaces the central view with the
in-place `NodePanel` inspector rather than overlaying a drawer; closing the inspector
returns directly to the retained list or graph scroll context.

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
- Modern design tokens: Crisp 1px borders (`#dbe2ea`, `#d8e1eb`), flat CSS surfaces,
  light cool-neutral background (`#f3f5f8`, `#ffffff`), deep navy navigation (`#14263d`),
  and local system sans typography. No SVG `feTurbulence` filters, displacement noise,
  or external web fonts.
- Execution notices portal into `.workbench-action-host`: on wide viewports (`@media (min-width: 1200px)`),
  primary `Preview launch` and `Run with Orca` / `Stop` buttons join the topbar grid directly in DOM focus order
  (`display: contents;` on non-semantic wrappers, action buttons `156×40px` with `white-space: nowrap`),
  while execution notices, errors, and running statuses span full separate rows below without crowding controls.
  On viewports `<1200px`, primary actions occupy the second header row. The header features a compact Run selector
  (`224×40px` trigger with ellipsis truncation and full tooltip) and centered coordinator health and connection badges.
  The viewer does not offer an in-page "New Run" button; Run creation belongs to planning agents or CLI,
  while the viewer reads and coordinates existing Runs (the backend `POST /api/runs` remains public and unchanged).

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

### Responsive presentation and bounded menu sheets

- **Narrow screens (≤760px)**: The primary display defaults to an accessible vertical `TaskList` with task labels, status dots, and blocked/readiness reasons, bypassing mobile canvas navigation. A toolbar switch toggles between the task list and the DAG graph. Task item activation opens the central inspector and restores focus on close.
- **Tablet / Mobile breakpoint (≤900px)**:
  - The left navigation rail collapses from a 200px column into a horizontally scrollable top strip with touch-friendly padding.
  - The persistent right chat dock adapts to a focused single pane: opening chat hides the main workbench (`.workbench-body--chat-open .workbench-main { display: none; }`), avoiding squeezing three columns on narrow screens.
  - Navigating to any workbench section automatically closes the mobile chat pane, revealing the destination without changing the selected conversation or losing draft state.
- **Menu disclosures and in-flow settings**:
  - The View menu (`.view-menu` in the task toolbar) is an inline `<details>` disclosure with `<summary>` trigger and an absolute dropdown panel (`.view-menu__panel`), without a `.menu-close` button (`.menu-close { display: none; }`). Pressing `Escape` or clicking outside closes the disclosure via the App global close-menu hook and restores focus to the `<summary>` trigger.
  - Run picker options (`.runpick__menu`) open as a relative `<details>` disclosure with an absolute panel (`.runpick__menu-panel`) anchored below its trigger, providing exact ID lookup and history pagination without an in-page create button.
  - Execution settings (`.exec__settings-panel`) render as an in-flow configuration form within the Settings section rather than a popover or viewport-fixed sheet.
  - Pressing `Escape` or clicking outside inside any open disclosure closes that disclosure and returns focus to its trigger.

### Structured preflight launch preview

- Preflight launch preview (`LaunchPreview` in `DecisionDialog`) presents the full plan before execution:
  - Requested defaults (default harness and max concurrency) displayed once at top; OpenCode interface default appears only when OpenCode is relevant.
  - Common limitations shared across all tasks are deduplicated and summarized once at top, avoiding repetitive noise.
  - Full task names, falling back to exact IDs; expand a task to inspect or copy its complete ID. Clipboard denial provides manual-copy feedback.
  - Tasks with unsupported routes, unknown route/limitation codes, or task-specific limitations are flagged for review and automatically expanded (`open={needsReview || undefined}`).
  - Task-specific requested overrides (harness, model, effort, retention, placement, environment, lane, OpenCode UI) shown distinctly under each task.
- `DecisionDialog` handles the preview modal:
  - Custom `content` rendered independently of text `message`.
  - Details-aware focus trap (`trapKeys`) cycling focus only between visible controls, skipping collapsed disclosures.
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
## Implementation and acceptance

`App.tsx` coordinates sections, URL hash routing, read states, portaled execution controls,
the mobile single-pane chat handoff, and central inspector focus. The header operates as an
adaptive deterministic CSS grid with centered badges. On wide viewports (`@media (min-width: 1200px)`),
it lays out a single 10-slot grid row (`grid-template-columns: 140px minmax(180px, 270px) 92px minmax(0, 1fr) 128px 128px 156px 156px 44px 60px; grid-template-areas: "brand run progress . health connection preview launch lang chat";`)
integrating brand, compact Run selector, progress, spacer, centered health and connection badges, preview, launch, language toggle, and chat toggle; notices and status span full rows. On viewports `<1200px`, actions occupy a second grid row (with the secondary progress slot hidden at 901..1000px to maintain compact alignment). Across settled no-notice states, header height measures exactly:
- **69px** on wide screens (`≥1200px`: `1200px`, `1280px`, `1440px`),
- **117px** on intermediate desktop/tablet screens (`901px`–`1199px`: `901px`, `959px`, `960px`, `1000px`, `1024px`, `1199px`),
- **216px** on mobile/narrow screens (`≤900px`: `375px`, `390px`, `900px`).
Natural-height diagnostic notices may expand the header when active; documentation reflects settled states without claiming a rigid 69px across all possible notification states. Navigation buttons settle at a fixed 56px height with 20px line-height, and Settings peer controls align at 40px × 360px in both languages. User-feedback adjustments (compact Run selector 224×40px with ellipsis tooltip, centered badges with flex/align-center, removal of in-page New Run button, single-row action integration on wide screens) are verified in the current build.
`DagView` is lazily loaded on first access (`React.lazy`) and retained in memory once mounted. Nodes use
exact dimensions of 280×120px (`NODE_W = 280`, `NODE_H = 120` from `layout.ts`) with
title 16px (line-height 20px, weight 650) and summary 14px (line-height 20px). Dependency
edges are rendered with static solid strokes (`edge--idle`, `edge--run`, `edge--done`)
and dashed hierarchy links, eliminating perpetual animation loops. A gentle executing
pulse (`@keyframes graph-executing`) is scoped to positively evidenced running tasks and
pauses when hidden, inactive, or under `prefers-reduced-motion: reduce`.
### Verification and checklist

The obsolete script `scripts/check-ui-layout.js` pinned removed tab counts, classes, and
exact text against stale API fixture shapes; per project test policy, those incidental
assertions have been retired rather than re-pinned. The existing server-side test suite
remains unchanged (`npm test`).

Prior to this deep layout iteration, the full check suite passed (`npm run check`, 841 passed).
Post-build reverification across settled real Run 44 data confirms layout stability across **168 browser samples** (7 routes × 12 widths × 2 languages: 375, 390, 900, 901, 959, 960, 1000, 1024, 1199, 1200, 1280, 1440):
- **Zero document overflow**: Content strictly conforms to viewport boundaries across all tested breakpoints, including the 901px boundary and 375px mobile width.
- **Zero panel-heading intersections**: Operational panels (`.gates`, `LanesPanel`, `CleanupPanel`, `WorkerPanel`, `SchedulerPanel`) and central detail inspector (`NodePanel`) participate in normal document flow (`position: static; width: 100%`), eliminating vertical coordinate collisions.
- **Zero header/nav major-slot geometry mismatches**: Settled no-notice header height measures identically in English and Chinese across all 12 tested viewports (69px at ≥1200px; 117px at 901–1199px; 216px at ≤900px); navigation buttons settle at a fixed 56px height (line-height 20px) in both languages; Settings peer controls align at 40px × 360px at 1280px.
- **Synthetic isolated smoke tests**: 8 phase cases (running, binding, completed, readonly across both languages) verified with 2 primary buttons at 156×40px on the same row with no text clipping, and status/notice spanning a 1416px full row below without invoking mutations or native stop; 5 inspector controls at 44px with H1 title; chat drafts and recipient selection preserved across navigation, language toggle, and mobile transitions; truthful `lane.pending` evidence representation.
- Full check suite passed (`npm run check`, 841 passed) alongside CSS/import build verification (`operations-nav.css` imported in `App.tsx` ensuring B row grid loads).
- Visual and interaction verification artifacts: `web/.impeccable/review/deep-layout-verification.json` and screenshot captures `deep-after-{section}-{lang}.png`.
#### Browser smoke checklist

1. **Sectional navigation and URL hash routing**:
   - Navigate through the 7 sections: Overview, Tasks, Decisions, Executions, Activity, Resources, Settings.
   - Verify active nav item styling (`aria-current="page"`, `#284b72`) and actionable count badge on Decisions.
   - Verify URL hash updates to `#section=<name>` and browser back/forward buttons navigate between sections without page reload.
2. **Tasks: List and Graph switch & DagView lazy loading**:
   - In Tasks section, toggle between "Tasks" (`TaskList`) and "Graph" (`DagView`).
   - Confirm `DagView` loads lazily on first activation, displaying a loading fallback before mounting, and remains retained in DOM/memory on subsequent toggles.
   - Verify nodes render at 280×120px with crisp 1px borders and static dependency lines.
   - Verify executing pulse animation pauses when the tab is hidden, when the graph is switched off, or under `prefers-reduced-motion: reduce`.
3. **Central detail inspector (`NodePanel`)**:
   - Click a task in `TaskList` or a node in `DagView`: central reading area switches to `NodePanel` (`.workbench-detail`), updating the hash to `#section=tasks&task=<id>`.
   - Verify title heading (`h1.node-panel__title`) receives focus.
   - Close the inspector via the Close button or `Escape`: verify the previous view (list or graph) and exact scroll position are restored.
   - Open a nested `DoodleSelect` inside `NodePanel` and press `Escape`: verify the dropdown closes while the inspector remains open.
4. **Persistent communication dock and scoped drafts**:
   - Open the chat dock via the header toggle: verify right dock opens at 440px default with draggable resize handle clamped between 380px and 820px (`COMMUNICATION_MIN_WIDTH = 380`, `COMMUNICATION_MAX_WIDTH = 820`, reserving navigation and main workspace, fallback 280px under constraint).
   - Enter a draft message for a task or coordinator, switch sections, and return: verify draft is retained.
   - Switch to another Run via `RunPicker`: verify drafts and recipient selection are isolated per Run and never implicitly retargeted.
5. **Mobile layout & focused single-pane chat (≤900px and ≤760px)**:
   - At ≤900px, verify the left navigation rail collapses into a horizontal scrolling bar.
   - At ≤900px, open the chat dock: verify the main workbench is hidden and chat occupies the full viewport.
   - Tap a section in the top navigation bar: verify chat closes and the selected section is revealed.
   - At ≤760px, verify the Tasks section defaults to the vertical `TaskList`.
6. **Menu disclosures and in-flow settings**:
   - Open View menu in task toolbar: verify it renders as an inline `<details>` disclosure with absolute panel `.view-menu__panel`.
   - Verify pressing `Escape` or clicking outside closes open disclosures and returns focus to their `<summary>` triggers.
   - Open Settings section: verify execution configuration renders as an in-flow form (`.exec__settings-panel`) with peer controls aligned at 40px × 360px.
7. **Read states and retry**:
   - Verify distinct loading state on initial read.
   - Verify first-read failure displays error details, page reload button, and disables execution controls.
   - Verify confirmed empty state displays an empty project prompt.
   - Verify stale snapshot displays stale banner with "Retry read" button that refreshes projections without page reload.

## Chat reading refinement

The communication dock (`.workbench-chat`) maintains the clean modern styling of the
workbench. Body text is 16px (`1rem`) with a 1.65 line height; metadata is 14px (`0.875rem`)
or 13px (`0.8125rem`), and conversation titles are 16px semi-bold. Outgoing messages use
a sky blue wash (`#eaf2ff`), incoming messages use soft neutral (`#f5f7fa`), and error
messages use blush wash (`#fff0f1`). Message bubbles are capped at comfortable reading
widths (up to 65ch) with word-break safeguards (`overflow-wrap: anywhere`).

- **Recipient selector**: Compact select dropdown displays available conversation threads,
  lead agent tags, and unread badges without overflowing the dock header.
- **Thread context**: Quoted reply context is evidence-gated; only messages with verified
  `threadId` in the current inbox window display reply quotes.
- **Scoped chat state**: Chat state is isolated via `useScopedChatState` with precise boundaries:
  - Uncertainty flags (`uncertainMessages`) are scoped by `runId`.
  - Draft text (`draft`) is scoped by `[runId, conversationId, targetId/dispatchId]` (Run, conversation, and target question/Dispatch identity).
  - Busy states (`busy`), errors (`error`), receipts (`messageReceipt`, `operatorReceipt`), timeline limit, and expanded checks are scoped by `[runId, conversationId]`.
  - Group broadcast drafts and preview states are scoped by `runId`.
  Switching Runs or recipients isolates in-progress drafts, preventing unintended message delivery or state clobbering.

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
- **Desktop vs. Mobile**: Central inspection replaces the central workbench area on desktop,
  preserving wide viewing angles; on viewports ≤900px, inspection takes priority over chat,
  and closing returns cleanly to the previous state.
