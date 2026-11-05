---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: []
---

# Surface Brief: Orca DAG Workbench

## Scope & Mode
- Target: `src/App.tsx`
- Mode: `operate`
- Audience: Developers orchestrating multi-agent software engineering tasks in Orca.

## Direction contract
THESIS: Replaces single-canvas monolith and dark console aesthetics with a light, Apple-inspired two-area orchestration workbench: persistent React Flow DAG canvas on the left, resizable app-style operations area on the right with home launcher and compact dock navigation, in-place node inspection, and an integrated chat sidebar.
OWN-WORLD: Crisp light surfaces (`#ffffff`, `#f5f5f7`, `#eaecef`), subtle hairline borders (`#dcdce1`, `#c9cbd1`), Apple system blue accents (`#0066cc`), calm semantic status badges (green completed `#23805a`, amber running `#a9650a`, slate pending `#64748b`, crimson failed `#be3e3e`), authored SVGs, and responsive 2-pane / mobile-switch geometry.
STORY: The operator supervises multi-agent execution with the dependency graph permanently mounted on desktop while navigating tools (Overview, Tasks, Decisions, Executions, Activity, Resources, Settings) via the App Launcher or bottom dock; chat provides private task threads and run-control audience broadcast without losing draft safety or execution custody.
FIRST VIEWPORT: Clean white top header (`.workbench-header`) with Run picker, progress, health badge, icon-only connection status, launch preview and Stop controls. Left pane displays the interactive React Flow graph on a subtle dot grid, with an icon-only Run action beside the View menu; right pane displays the operations launcher or active section/chat, with a Home icon for returning to the launcher and a draggable resize divider. On mobile (<=900px), a toggle switch alternates between canvas and operations.
FORM: Light Apple-Inspired Two-Area Workbench (Canvas + App Launcher + Chat Sidebar).
FINISH: Verified against actual code implementations (`src/App.tsx`, `src/workbench.css`, `src/styles.css`, `src/components/ChatPanel.tsx`); preserves existing security boundaries, coordinator controls, and scoped state safety.
