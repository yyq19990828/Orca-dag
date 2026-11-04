---
name: Orca DAG Viewer
description: Precise, resource-efficient modern sectional orchestration workbench for multi-agent execution supervision
colors:
  paper: "#ffffff"
  paper-subtle: "#f5f7fa"
  paper-muted: "#e9eef5"
  workbench-bg: "#f3f5f8"
  ink: "#18283e"
  ink-soft: "#465b73"
  ink-faint: "#53677d"
  nav-bg: "#14263d"
  nav-hover: "#203b59"
  nav-active: "#284b72"
  nav-text: "#cbd7e5"
  nav-badge-bg: "#eacb84"
  nav-badge-text: "#342700"
  line: "#d8e1eb"
  line-strong: "#b5c3d2"
  line-header: "#dbe2ea"
  sky: "#2865c7"
  sky-ink: "#2054a5"
  sky-wash: "#eaf2ff"
  status-pending: "#64748b"
  status-ready: "#2563a8"
  status-dispatched: "#a9650a"
  status-completed: "#23805a"
  status-failed: "#be3e3e"
  status-blocked: "#a15c1b"
  liveness-exited: "#52647a"
  blush: "#d45a65"
  blush-ink: "#a22d3b"
  blush-wash: "#fff0f1"
  edge-idle: "#aab8c8"
  edge-run: "#b27825"
  edge-done: "#43896b"
  edge-hierarchy: "#8999ac"
typography:
  display:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.2
  headline:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "18px"
    fontWeight: 650
    lineHeight: 1.3
  title:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.25
  body:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.sky}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.sky-ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.nav-text}"
    rounded: "{rounded.md}"
    padding: "11px 12px"
  nav-item-active:
    backgroundColor: "{colors.nav-active}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "11px 12px"
  card-container:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "16px 20px"
  chat-bubble-incoming:
    backgroundColor: "{colors.paper-subtle}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "14px"
  chat-bubble-outgoing:
    backgroundColor: "{colors.sky-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "14px"
---

# Design System: Orca DAG Viewer

## Overview

**Creative North Star: "The Precision Orchestration Workbench"**

The Orca DAG Viewer design system provides an uncluttered, resource-efficient environment tailored for software engineers supervising parallel agent workflows. It completely replaces legacy paper-and-crayon sketches and SVG turbulence filters with a crisp, low-noise modern interface. High-contrast typography, restrained geometry, flat surfaces, and disciplined color hierarchies ensure operators can rapidly assess system state, verify execution evidence, and intervene safely without cognitive fatigue.

The visual atmosphere balances a crisp white and cool-neutral canvas with a deep navy command rail. Execution evidence is privileged over visual novelty: status markers, connection health pills, and progress indicators communicate verified facts directly. The dependency graph serves to clarify orchestration topology, while dedicated sections house detailed task lists, governance decisions, active fleet monitoring, live activity streams, workspace resource management, and run configuration.

**Key Characteristics:**
- **Crisp Structural Clarity:** Flat surfaces bounded by single-pixel rules (`#dbe2ea`, `#d8e1eb`) without heavy drop shadows, neon glows, or pseudo-skeuomorphic textures.
- **Deep Navy Navigation:** A focused command column (`#14263d`) providing predictable access across seven core workflow sections.
- **Evidence-First Feedback:** Distinct, verified status colors for task states, coordinator health, and operation receipts.
- **Resource Efficiency:** Zero external font downloads, no CPU-intensive SVG displacement loops, and lazy loading for heavy canvas components.

## Colors

The palette uses a calm, cool-neutral base grounded by deep navy navigation and purposeful semantic accents for task and execution statuses.

### Primary
- **Command Navy** (`#14263d`): The anchor for global vertical navigation, establishing visual structure and primary hierarchy.
- **Sky Accent** (`#2865c7`): Primary interaction accent, active indicators, interactive links, and focused boundaries.
- **Sky Deep** (`#2054a5`): Pressed, active, and focus-visible outlines for primary action controls.

### Secondary
- **Sky Wash** (`#eaf2ff`): Light tinted background for outgoing user chat messages, active navigation toggles, and selection rows.
- **Navy Muted** (`#284b72`): Active section indicator background within the primary navigation rail.
- **Navy Hover** (`#203b59`): Hover state for navigation options.

### Neutral
- **Base Canvas** (`#f3f5f8`): Cool gray-blue backdrop for the workbench viewport.
- **Surface Paper** (`#ffffff`): Pure white content background for cards, headers, inspectors, and modal dialogs.
- **Surface Subtle** (`#f5f7fa`): Secondary neutral surface for incoming chat messages and table headers.
- **Surface Muted** (`#e9eef5`): Border tint and subtle interactive hover states.
- **Primary Ink** (`#18283e`): Core high-contrast text for headers, body copy, and primary controls.
- **Soft Ink** (`#465b73`): Secondary text for metadata, subtitles, timestamps, and helper labels.
- **Faint Ink** (`#53677d`): Disabled labels, hints, and placeholder text.
- **Divider Line** (`#d8e1eb`): Standard 1px boundary between layout regions.
- **Strong Line** (`#b5c3d2`): Boundary for input fields and selected card states.
- **Header Line** (`#dbe2ea`): Structural 1px rule separating header and content sections.

### Semantic Status
The semantic Task status palette is derived directly from runtime `STATUS_META` (`web/src/types.ts`), preserving distinct visual identities for task lifecycle states without confusing them with general UI theme accents:
- **Pending** (`#64748b`, bg `#f1f5f9`, ink `#475569`): Tasks not yet reached or queued awaiting prerequisite resolution.
- **Ready** (`#2563a8`, bg `#eaf2fb`, ink `#1d4f83`): Runnable tasks with satisfied dependencies and open gates.
- **Dispatched** (`#a9650a`, bg `#fff5e5`, ink `#865008`): Active executing tasks assigned to a worker or agent execution.
- **Completed** (`#23805a`, bg `#e9f6ef`, ink `#176444`): Successfully finished tasks with verified output evidence.
- **Failed** (`#be3e3e`, bg `#fceeee`, ink `#a32f2f`): Tasks encountering fatal execution error, syntax failure, or execution abort.
- **Blocked** (`#a15c1b`, bg `#fff3e7`, ink `#804817`): Tasks awaiting approval gates, manual recovery, or dependency resolution.
- **Exited Liveness** (`#52647a`): Neutral worker process termination indicator; strictly an observation of process exit, not an inference of task success or failure.

General UI theme accents remain distinct from task states:
- **Sky Accent** (`#2865c7`), **Sky Deep** (`#2054a5`), **Sky Wash** (`#eaf2ff`): Primary buttons, focused outlines, active navigation states, and outgoing chat bubbles.
- **Blush Wash** (`#fff0f1`), **Blush Ink** (`#a22d3b`): Error banners and failed chat message callouts.
- **Nav Badge** (`#eacb84`, text `#342700`): Counter pill for actionable items in navigation.
### Named Rules
**The Single Source of Truth Rule.** Color communicates verified state, never anticipation or unverified optimism. Stale data, unread presence, or disconnected coordinators always display explicit warning or neutral indicators.

**The No-Texture Rule.** No background textures, paper grains, canvas noise filters, or raster gradients may be applied to interactive surfaces.

## Typography

**Display & Body Font:** Local system sans stack: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`  
**Monospace / Identifier Font:** `ui-monospace, SFMono-Regular, Consolas, monospace` (matching `code, pre, kbd, samp` in `styles.css`)
**Character:** Neutral, highly legible system typography prioritizing rapid scanning and daylight readability over decorative branding.

### Hierarchy
- **Display / H1** (Bold 700, 24px, line-height 1.2): Section titles (`Overview`, `Tasks`, `Decisions`, `Executions`, `Activity`, `Resources`, `Settings`) and central detail inspector title (`NodePanel` heading `h1.node-panel__title`).
- **Headline / H2** (Semi-bold 650, 18px–20px, line-height 1.3): Panel headings, modal titles, and chat dock headers (`.workbench-chat-header h2`).
- **Title / H3** (Semi-bold 650, 16px, line-height 1.25): Card headers, DAG node titles, and inspector section headers.
- **Body** (Regular 400, 16px / 1rem, line-height 1.6): Chat messages, documentation prose, and form instructions. Capped at 65ch for comfortable reading.
- **Label / Meta** (Medium 600, 14px / 0.875rem, line-height 1.4): Table headers, form field labels, status pills, and timestamps.
- **Data / Micro** (Regular 400, 13px–14px, tabular numerals): Counter badges, execution statistics, and timestamp counters.

### Named Rules
**The System Font Rule.** Never load web fonts or remote stylesheets. Typography relies strictly on native system stacks to eliminate network layout shifts and minimize memory overhead.

**The Identifiers in Mono Rule.** Any UUID, Run ID, Dispatch ID, task slug, shell command, or raw file path must render in an explicit monospace stack (`ui-monospace, SFMono-Regular, Consolas, monospace`).

**The Detector Findings Boundary.** A prior design detector scan reported 10 warnings and 217 advisory items in the stylesheet codebase. These advisory findings reflect existing style rules and are non-material; design documentation grounds actual tokens without redefining visual identity, falsely claiming warning-free status, or artificially forcing every advisory rule into a token.
## Layout

The application operates as a three-zone sectional workbench:

1. **Top Header Bar (Adaptive Deterministic CSS Grid):**
   - On wide viewports (`@media (min-width: 1200px)`), the header lays out a single 10-slot grid row (`grid-template-columns: 140px minmax(180px, 270px) 92px minmax(0, 1fr) 128px 128px 156px 156px 44px 60px; grid-template-areas: "brand run progress . health connection preview launch lang chat";`) integrating brand, compact Run selector (with ellipsis and full tooltip; no in-page New Run button), progress, spacer, centered health and connection badges, preview, launch (`156×40px`, nowrap), language toggle, and chat toggle; notices and status span full rows below.
   - On viewports `<1200px`, primary execution actions occupy the second header row (`.workbench-action-host`).
   - Settled no-notice header height measures identically in English and Chinese:
     - **69px** on wide desktop viewports (`1200px`, `1280px`, `1440px`),
     - **117px** on intermediate desktop/tablet viewports (`901px`–`1199px`),
     - **216px** on mobile/narrow viewports (`375px`, `390px`, `900px`).
   - Diagnostic notices expand the header naturally when active, without rigid height capping.
   - On mobile viewports (`<=900px`), adapts to a 4-column 4-row grid.
2. **Left Navigation Rail (200px width on desktop):**
   - Houses vertical navigation across the 7 application sections.
   - On screens `<=900px`, structurally collapses into a horizontally scrollable top strip with touch-friendly padding.
3. **Central Work Area (`.workbench-main`):**
   - Full-width scrollable viewport rendering the active section or central task inspector (`NodePanel`).
   - All operational cards and panels (`.gates`, `LanesPanel`, `CleanupPanel`, `WorkerPanel`, `SchedulerPanel`) and central detail inspector (`.workbench-detail .node-panel`) participate in normal document flow (`position: static; width: 100%`), eliminating absolute positioning bugs.
   - Retains exact scroll position and active route across view toggles (`#section=<name>&task=<id>`).
4. **Persistent Right Chat Dock (`.workbench-chat`):**
   - 440px default width with a draggable split border. Clamped between `COMMUNICATION_MIN_WIDTH = 380` and `COMMUNICATION_MAX_WIDTH = 820` (reserving 200px navigation and 320px central workspace on desktop, fallback 280px minimum under constraint).
   - On viewports `<=900px`, opening chat transforms it into a full-width focused single pane, hiding the central workbench to prevent column cramping.
### Named Rules
**The Retained Context Rule.** Selecting a task replaces the central section with the `NodePanel` detail view; closing the inspector restores the previous section, scroll offset, and selection without reloading data or re-triggering network queries.

## Elevation & Depth

Depth in this design system is created strictly through **tonal layering and crisp 1px borders**, not drop shadows.

### Layer Vocabulary
- **Base Layer (`#f3f5f8`):** The background workbench floor.
- **Surface Layer (`#ffffff`):** Content cards, headers, inspector panels, and modal sheets with 1px border (`#dbe2ea`).
- **Recessed Layer (`#f5f7fa`):** Secondary controls, incoming message bubbles, and table rows with subtle containment.
- **Command Layer (`#14263d`):** The elevated left rail, visually framing the workspace with maximum contrast.

### Named Rules
**The Flat Elevation Rule.** Surfaces are flat at rest. Floating cards do not use blurred drop shadows (`box-shadow: none`). Focus rings use a solid 2px outline with a 2px offset (`outline: 2px solid #2054a5; outline-offset: 2px`).

## Shapes

- **Corners:**
  - Small (`rounded.sm`, 4px): Status tags, micro badges, and inline code pills.
  - Medium (`rounded.md`, 6px): Navigation buttons, primary buttons, input boxes, and toolbar toggles.
  - Large (`rounded.lg`, 8px): Task node cards, container cards, and inspector panels.
  - Extra Large (`rounded.xl`, 12px): Chat message bubbles.
- **Borders:**
  - Standard 1px solid rule (`#d8e1eb` or `#cbd5e1`).
  - Active / Selected border: 2px solid `#2563a8`.

## Components

### Buttons
- **Primary:** Solid blue (`#2865c7`), white text, 6px radius, padding `8px 16px`. Hover transitions to `#2054a5`.
- **Ghost:** Transparent background, dark text (`#18283e`), 6px radius, 1px border `#cad5e1`. Hover fills with `#f5f7fa`.
- **Toggle / Segmented:** Border 1px `#cad5e1`, 6px radius. Selected state uses `#e8f0ff` fill with `#8eafe5` border and `#174a92` text.

### Navigation Rail Items
- **Style:** Full-width button with fixed 56px height, 20px line-height, 8px 12px padding, 6px radius, neutral muted text (`#cbd7e5`).
- **Hover:** Dark blue background `#203b59` with white text.
- **Active (`aria-current="page"`):** Navy active fill `#284b72` with bold white text. Includes pill badge (`#eacb84`) for pending actionable count.

### Task Node Card (DAG)
- **Dimensions:** Exactly 280px width by 120px height (`NODE_W = 280`, `NODE_H = 120`).
- **Typography:** Title 16px (line-height 20px, font-weight 650), data summary 14px (line-height 20px).
- **Style:** White background, 1px border `#cbd5e1`, 7px radius. Selected state applies 2px outline `#2563a8` with 1px offset.
- **Motion:** Discrete status dot pulsing (`@keyframes graph-executing`, opacity 1 to 0.4 over 1.6s) only for positively evidenced running tasks. Completely paused when `prefers-reduced-motion: reduce`, tab is hidden, or graph is inactive.

### Chat Message Bubbles
- **Incoming / System:** Soft gray (`#f5f7fa`), dark ink (`#18283e`), 12px radius, 14px padding.
- **Outgoing:** Sky blue wash (`#eaf2ff`), dark ink (`#18283e`), 12px radius, 14px padding.
- **Error:** Blush wash (`#fff0f1`), red accent text, 12px radius, 14px padding.
- **Draft Scoping:** Input drafts are bound strictly to `[runId, conversationId, targetId/dispatchId]` via `useScopedChatState`; uncertainty flags are scoped by `runId`; busy and receipts are scoped by `[runId, conversationId]`. Switching Runs or recipients isolates drafts without clobbering.

### Central Detail Inspector (`NodePanel`)
- **Container:** Full-width central replacement view (`.workbench-detail`), scrollable independently.
- **Header:** Sticky or top-anchored title with direct keyboard focus (`h1.node-panel__title`, `tabIndex={-1}`) upon opening.
- **Dismissal:** Accessible Close button and `Escape` key handler returning focus to the originating list or graph item via `requestAnimationFrame`.

## Do's and Don'ts

### Do:
- **Do** use flat CSS surfaces with single-pixel rules (`#dbe2ea`, `#d8e1eb`) and tonal fills for hierarchy.
- **Do** preserve route context via URL hash (`#section=<name>&task=<id>`) so browser back/forward buttons work intuitively.
- **Do** isolate chat drafts and receipts per Run and recipient using `useScopedChatState`.
- **Do** lazy-load heavy graph views (`DagView`) and retain their instances once mounted.
- **Do** respect user motion preferences by disabling continuous animations under `prefers-reduced-motion: reduce`.
- **Do** clearly distinguish JavaScript heap memory from GPU or renderer compositor process memory in technical documentation.

### Don't:
- **Don't** reintroduce SVG `feTurbulence` filters, pencil displacement maps, or hand-drawn crayon borders.
- **Don't** load external or third-party web fonts; always use native system font stacks.
- **Don't** squeeze three full columns on narrow viewports; switch to a focused single-pane layout on screens `<=900px`.
- **Don't** use drop shadows (`box-shadow`) to fake material elevation; depth must be established through tonal background shifts.
- **Don't** silently switch chat recipients or clear message drafts when switching between Runs or tasks.
- **Don't** run infinite canvas animation loops or unthrottled timer-based re-renders when the graph is hidden or offscreen.
