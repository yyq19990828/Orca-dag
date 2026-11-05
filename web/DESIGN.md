---
name: Orca DAG Viewer
description: Light Apple-Inspired Workbench · Crisp dual-pane orchestration workbench pairing a persistent React Flow DAG canvas with an app-style operations workspace and integrated chat sidebar
colors:
  paper: "#ffffff"
  paper-subtle: "#f5f5f7"
  paper-muted: "#eaecef"
  workbench-bg: "#f5f5f7"
  ink: "#1d1d1f"
  ink-soft: "#565b65"
  ink-faint: "#626771"
  nav-bg: "#ffffff"
  nav-hover: "#eaf3ff"
  nav-active: "#eaf3ff"
  nav-text: "#1d1d1f"
  nav-badge-bg: "#fff1d5"
  nav-badge-text: "#8a4d00"
  line: "#dcdce1"
  line-strong: "#c9cbd1"
  line-header: "#dcdce1"
  sky: "#0066cc"
  sky-ink: "#0066cc"
  sky-wash: "#eaf3ff"
  status-pending: "#64748b"
  status-ready: "#2563a8"
  status-dispatched: "#a9650a"
  status-completed: "#23805a"
  status-failed: "#be3e3e"
  status-blocked: "#a15c1b"
  liveness-exited: "#52647a"
  blush: "#b83232"
  blush-ink: "#a52c2c"
  blush-wash: "#fceeee"
  edge-idle: "#a3aab4"
  edge-run: "#a9650a"
  edge-done: "#23805a"
  edge-hierarchy: "#818b99"
  slate-900: "#1d1d1f"
  slate-800: "#30333a"
  slate-700: "#44464d"
  slate-600: "#565b65"
  slate-500: "#626771"
  slate-400: "#818b99"
  slate-300: "#a3aab4"
  slate-200: "#c9cbd1"
  slate-100: "#dcdce1"
  slate-50: "#f5f5f7"
  amber-dark: "#8a4d00"
  amber-light: "#fff1d5"
  emerald-vibrant: "#23805a"
  cyan-glow: "#0066cc"
  rose-neon: "#be3e3e"
  connection-ok: "#247041"
  connection-ok-bg: "#eaf6ee"
  connection-warning: "#865b0b"
  connection-warning-bg: "#fff5df"
  warning-hover: "#ffedc5"
  warning-border: "#e8cf9f"
  stale-ink: "#79510d"
  action-hover: "#0055aa"
  app-blue: "#1471c9"
  app-chat: "#18854a"
  app-execution: "#6157a5"
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
  caption:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
  dialog:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.2
  code:
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace'
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
  micro:
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace'
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.2
rounded:
  none: "0px"
  xs: "4px"
  sm: "5px"
  md: "6px"
  base: "7px"
  lg: "8px"
  xl: "10px"
  "2xl": "12px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  "2xl": "32px"
components:
  button-icon:
    backgroundColor: "{colors.paper-subtle}"
    textColor: "{colors.ink-soft}"
    borderColor: "{colors.line-strong}"
    rounded: "{rounded.lg}"
    padding: "0px"
    width: "40px"
    height: "40px"
  button-launch:
    backgroundColor: "{colors.sky-ink}"
    textColor: "#ffffff"
    rounded: "{rounded.lg}"
    padding: "0px"
    width: "40px"
    height: "40px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.md}"
    padding: "7px 14px"
  tooltip-bubble:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.nav-text}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
    height: "48px"
  nav-item-active:
    backgroundColor: "{colors.nav-active}"
    textColor: "{colors.sky-ink}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
    height: "48px"
  card-container:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    borderColor: "{colors.line}"
    rounded: "{rounded.lg}"
    padding: "16px 20px"
---

# Design System: Light Apple-Inspired Workbench

## Overview

**Creative North Star: "Light Apple-Inspired Workbench · 浅色苹果风格双区工作台"**

The Orca DAG Viewer delivers a clean, high-clarity orchestration workbench inspired by modern Apple platform ergonomics and desktop productivity environments. Designed for developers supervising multi-agent software engineering workflows, it eliminates visual clutter and perpetual animation loops while maintaining total operational transparency.

The workbench organizes multi-agent execution into a balanced **two-area workspace**:
1. **Persistent DAG Canvas (Left):** An interactive, hardware-accelerated React Flow dependency graph mounted over a subtle dot grid canvas (`#f5f5f7`), keeping node positions, manual coordinates, and selected context stable while the operator navigates tools.
2. **Operations Application Workspace (Right):** A resizable operations area (`.workbench-operations`) featuring an Apple-style **Home Launcher** (`.workbench-nav--home`) with vibrant app tiles, a compact bottom dock navigation (`.workbench-nav--dock`) when inside applications, an in-place inspector (`NodePanel`), and dedicated workbench modules (Overview, Tasks, Decisions, Executions, Activity, Resources, Settings).
3. **Integrated Chat Application:** Features a dedicated conversation sidebar (`.chat__sidebar`) supporting instant switching between **Private** task threads (real agent/task conversations seeded from DAG events with urgent/unread flags and pending reply badges) and **Group** broadcast mode (grounded in Orca's Run-control audience selector, avoiding fictional persistent group chat rooms).
4. **Adaptive Responsive Layout (<=900px):** On screens <=900px, a high-contrast mobile pane switch (`.workbench-mobile-switch`) provides single-tap toggling between full-screen Canvas and Operations views.

**Key Invariants & Ergonomics:**
- **Calm, High-Contrast Light Surfaces:** Pure crisp cards (`#ffffff`), foundation neutral canvas (`#f5f5f7`), hairline borders (`#dcdce1`, `#c9cbd1`), and Apple system blue interactive accents (`#0066cc`).
- **Steady State Visuals (No Neon / No Flashing):** Elimination of continuous SVG `feTurbulence` filters, neon halos, and scanning lasers. Running states are clearly and reliably indicated via a steady amber border (`#bb842c`), top status bar, and dashed amber dependency edges (`#a9650a`, `stroke-dasharray: 6 5`).
- **Strict Layout Invariant:** Preserves `NODE_W = 280`, `NODE_H = 120` to guarantee exact layout solver accuracy.
- **Local Assets:** Authored SVG icons and system typography require no external font download.
- **Action Placement:** Preview, Stop and language stay in the global header. Run/Run again are icon-only controls beside View in the dependency-graph toolbar, preserving accessible names, tooltips and preflight confirmation. Chat uses the same speech-bubble icon in the launcher and Dock.
- **Operations Home:** Use a house icon without a visible label in the operations header. Keep a localized "Back to home" accessible name and hover title; this is separate from the narrow Dock's All apps entry.
- **One Page Heading:** The operations header owns the visible `h1`; task inspection substitutes its own title. Section content begins directly with data, not a second page title.
- **Spacing:** Section padding is 20px top / 24px horizontal / 28px bottom, with 20px between operational groups. Narrow operations containers use 16px horizontal padding.
- **Interaction Primitives:** Use `radix-ui` Tooltip, Popover, Select and Dialog with the existing CSS tokens. Do not add a parallel positioning or focus-trap system. Searchable selectors retain explicit combobox/listbox semantics within Popover; simple enums use Select.
- **Layering:** Page popovers clear the header; select popovers inside confirmation dialogs clear the modal layer. Escape dismisses the innermost popup first. Dialog cancellation remains a negative result and cannot authorize a launch.

## Palette & Hierarchy

### Backgrounds & Surfaces
- **Foundation Ground Canvas** (`#f5f5f7`): Neutral workspace background for the DAG canvas and operations shell.
- **Paper Surface** (`#ffffff`): Clean white surface for the cockpit header, canvas header, operations cards, and central reading panels.
- **Subtle Surface** (`#eaecef`): Elevated contrast background for secondary controls, segmented switches, and inactive button states.
- **Hairline Borders** (`#dcdce1` primary, `#c9cbd1` strong): 1px structural separation without heavy drop shadows or blurry glow.
- **Soft Shadows** (`0 4px 14px rgba(29, 29, 31, 0.08)`): Subtle tactile elevation for task nodes and floating menus.

### Semantic Status Indicators
Shared between the React Flow canvas, task list, and operator controls:
- **Pending** (`#64748b` color, `#f1f5f9` bg, `#475569` ink): Planned or upstream-waiting stages.
- **Ready** (`#2563a8` color, `#eaf2fb` bg, `#1d4f83` ink): Unblocked stages ready for dispatch.
- **Dispatched / Running** (`#a9650a` color, `#fff5e5` bg, `#865008` ink): Active worker execution with steady amber accent and dashed running edge (`stroke-dasharray: 6 5`).
- **Completed** (`#23805a` color, `#e9f6ef` bg, `#176444` ink): Verified task execution with solid green edge.
- **Failed** (`#be3e3e` color, `#fceeee` bg, `#a32f2f` ink): Interrupted or errored task stages.
- **Blocked** (`#a15c1b` color, `#fff3e7` bg, `#804817` ink): Tasks blocked by dependency or gate conditions.
- **Exited Liveness** (`#52647a` neutral): Observed worker exit status without speculative success.

### Interactive Micro-Tools & Cockpit Actions
Global and canvas actions use compact controls with descriptive tooltips:
1. **Preview Plan (`<EyeIcon />`):** 40x40px icon button.
2. **Run CTA (`<PlayIcon />`):** Blue 40×40px icon button in the canvas toolbar, 44×44px on narrow screens. Run again uses the same location with `<RefreshIcon />`; no visible text label.
3. **Stop Run (`<StopIcon />`):** 40x40px soft crimson button (`#ae3234`, bg `#fff0ef`).
4. **Language Toggle (`中 / EN`):** Compact language switch.
5. **Connection Icon (`<LinkIcon />` / `<LinkOffIcon />`):** Icon-only focusable status with the detailed readiness/version text in its accessible name and hover title. Preserve green/amber/red evidence states; unknown or failed reads use the broken-link icon, and execution-disabled but readable runtime evidence stays distinct from a disconnected service.

### App Launcher & Dock
- **Home App Launcher (`.workbench-nav--home`):** Four columns, or three below 360px operations width, with 52×52px app icons, 12px corners, full category labels and action counters. The summary retains unknown/stale evidence rather than inventing a zero count.
- **Dock Navigation (`.workbench-nav--dock`):** Eight columns at operations widths ≥640px. Below that, show Chat, Tasks, Decisions, Executions and All apps in five columns; secondary apps remain available from Home. Use short visible labels and full accessible names, never horizontal overflow.
- **Routes:** Home (`#section=home`) and Chat (`#section=chat`) share the seven section routes and browser history. Refresh restores the chosen app. Navigation does not unmount the DAG or retarget chat drafts.

### Chat Sidebar & Scoped Communication
- **Sidebar (`.chat__sidebar`):** 150px wide list with Private/Group toggle (`.chat__switch`).
  - **Private:** Shows real task threads seeded from DAG events, actor harness/model tags, unread/urgent indicators, and pending question counters.
  - **Group:** Exposes the Run-control audience selector for broadcast messages (@all, @idle, harness groups, @worktree:<id>).
- **Scope & Safety Invariant:** Message drafts, busy states, and receipts are isolated per `[runId, conversationId, targetId/dispatchId]` via `useScopedChatState`. Switching views or tasks never leaks drafts or triggers implicit sends.
- **Runtime Summary:** Center status, detail and check metadata in separate wrapping rows. Group the status dot with its label, use a single shrinkable column at every pane width, and preserve the underlying Run/worker evidence unchanged.
