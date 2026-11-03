# Readable orchestration layout

English | [简体中文](ui-layout_zh.md) · [Documentation](README.md)

## Goal and decisions

Help an operator answer, in order: what is happening, what needs my decision,
which task or worker is involved, and what evidence supports the state.
Keep the existing paper/crayon identity and canvas layout for wide screens, while
providing an accessible task list default for mobile viewports. Use existing React state,
native disclosure controls and CSS, with no new dependencies or backend contract.

| Reading level | Surface | Content |
| --- | --- | --- |
| Orientation | Run header and stage overview / Task list | Selected objective, completion, six task-state counts, stale-read notice; accessible vertical task list default on mobile |
| Action | Operations: Decisions & recovery | Attention summary, approvals, interrupted starts and recovery |
| Execution | Operations: Workers & workspaces | Task names, liveness, terminal state, host/model, workspace lanes |
| Evidence | Operations: History & diagnostics | Readable request history, exact identifiers on expansion, runtime capabilities |
| Task result | Stage inspector, before configuration | Report summary/body/files, or arbitrary JSON as named fields and lists |

The minimal implementation groups existing panels instead of adding routes or
duplicating action controls. Attention links select the correct category and
focus the existing control; worker links clear conflicting list filters.
Operations opens from its own toolbar button, outside the Activity/Chat tabs.
Both panels share a resizable rail and preserve the last communication tab.
Category state is local to the page. Existing Run scope, launch locks, permissions,
polling guards and requested-versus-observed distinctions remain authoritative.

## Presentation rules

- Known operation and terminal codes have English/Chinese labels. Unknown codes
  remain verbatim; translation never grants permission or implies completion.
- `absent` requests mean no runtime record, not proof that nothing happened.
- Resolve task names from the current DAG. Keep full task, Dispatch, request and
  Run identifiers in expanded evidence; unknown names fall back to their IDs.
- Structured results preserve `false`, `0`, null, empty collections, unknown
  keys, arrays and nested objects. Native disclosures reveal nested collections.
- Worker report fields are type-checked before formatting. Long bodies expand
  independently of diagnostic data. Original JSON remains available verbatim.
- Preserve paper colors and sketch headings. Use the system reading font for
  factual prose, wrapping long values and using tabular numbers for counts.
- Execution notices occupy their own header row, so they cannot cover navigation.
  Below the existing overlay breakpoint the side panel still uses the app's
  mobile layout; category buttons wrap text within three equal columns.

- Four distinct read states avoid conflating connectivity errors with empty data:
  1. *Loading*: Initial load in progress, showing a dedicated loading indicator.
  2. *First-read failure*: The selected Run has no successful task snapshot, or the initial Run list cannot be read before a Run is selected. Show the failure with expandable technical details and a page reload action. Launch preview and execution are unavailable without task data.
  3. *Confirmed empty*: Run list or DAG snapshot loaded cleanly with zero items. Renders an explicit empty prompt, distinctly separate from loading or failure.
  4. *Stale snapshot*: A successful same-Run snapshot exists, but refresh failed. Retain tasks and counts, show a stale-data notice, and keep details readable. **Retry read** refreshes projections without replaying launches or other mutations.
  `RunPicker` exposes its first-list read state (`RunListReadState`: `loaded`, `error`) so the root view correctly differentiates an empty workspace from a connection failure.
- Keyboard navigation and inspector focus:
  - Pressing `Enter` or `Space` on a focused DAG node opens its Stage inspector (`NodePanel`).
  - Opening the inspector automatically moves focus to the title heading (`h3.node-panel__title`, `tabIndex={-1}`) for immediate screen-reader and keyboard orientation.
  - Pressing `Escape` in `NodePanel` closes the inspector and restores focus to the triggering element (via `requestAnimationFrame`).
  - Nested dropdowns (`DoodleSelect` for harness or model selection) consume `Escape` first to close their own menu, preventing unintended closure of the outer inspector panel.
- Responsive presentation and bounded menu sheets:
  - At widths `<=760px`, the primary display defaults to an accessible vertical `TaskList` with task labels, status dots, and blocked/readiness reasons, replacing canvas-only viewing on mobile. A toolbar switch toggles between the task list and the DAG graph. Task item activation opens the inspector and restores focus on close.
  - Execution remains desktop-first; mobile layout is designed for readable inspection and triage, not promised full execution parity.
  - At widths `<=1024px`, the three floating popup menus (`.runpick__menu-panel`, `.view-menu__panel`, `.exec__settings-panel`) switch to fixed, viewport-bound sheets (`position: fixed`, inset by `max(8px, env(safe-area-inset-*))`, max height `calc(100dvh - 16px)` with internal scrolling).
  - Each sheet provides a visible `Close` button (`.menu-close`, minimum 44px touch target) at `<=1024px`.
  - While open, the View toolbar elevates its stacking context (`.app .dag-toolbar:has(.view-menu[open]) { z-index: 40; }`) above the compact header so its close button remains unclipped and clickable.
  - `Escape` closes open menus and returns focus to their summary triggers.
- Structured preflight launch preview:
  - Preflight launch preview (`LaunchPreview`) presents the full plan before execution:
    - Requested defaults (default harness and max concurrency) displayed once at top; the OpenCode interface default appears only when OpenCode is relevant.
    - Common limitations shared across all tasks deduplicated and summarized once at top, avoiding repetitive noise.
    - Full task names, falling back to exact IDs; expand a task to inspect or copy its complete ID. Clipboard refusal gives explicit manual-copy instructions.
    - Tasks with unsupported routes, unknown route/limitation codes, or task-specific limitations are flagged for review and automatically expanded (`open={needsReview || undefined}`).
    - Task-specific requested overrides (harness, model, effort, retention, placement, environment, lane, OpenCode UI) shown distinctly under each task.
  - `DecisionDialog` handles the preview modal, providing:
    - Support for custom `content` separate from text `message`.
    - A details-aware focus trap (`trapKeys`) that only cycles between focusable elements within open details, ignoring invisible elements in collapsed disclosures.
    - Safe cancellation: Cancel / "Not now", `Escape`, or backdrop dismissal never calls `POST /api/run`. Configuration already saved while preparing the preview is not rolled back.
    - Clear authority boundary: Preview reflects current configuration intent and dry preflight rules; it does *not* verify runtime execution, model availability, or worker readiness on the execution host. Worker placement does not provision external test runtimes.

## Implementation and acceptance

`App.tsx` coordinates read states, the mobile view, menus and inspector focus.
`DagView`, `NodePanel` and `DoodleSelect` share the keyboard activation and nested
Escape contract. `TaskList` supplies the narrow-screen index; `RunPicker` reports
its first-list read state. `LaunchPreview` renders requested defaults, common
limits and exact task evidence inside the existing `DecisionDialog`; `ExecControls`
keeps the same explicit confirmation boundary before starting a Run.

Worker and request summaries still reuse the DAG name map. `ResultSummary` and
`StructuredData` preserve report content and raw evidence. Styles extend the
existing theme with `read-state.css`, `task-list.css` and `launch-preview.css`;
new copy stays paired in en/zh.

Run the repository gate with `npm run check`. On macOS, the existing socket tests
need a short, canonical temporary directory: `TMPDIR=/private/tmp npm run check`.
This avoids Unix socket path truncation and `/tmp` versus `/private/tmp` mismatch.

The repeatable browser check uses Playwright CLI and intercepts all API traffic:

```sh
npm run dev:web
# In another terminal, with Playwright CLI available:
mkdir -p output/playwright
playwright-cli open http://localhost:5173
playwright-cli run-code "$(cat scripts/check-ui-layout.js)"
```

The script `scripts/check-ui-layout.js` remains the original automated layout acceptance script. It checks both locales at 1280, 900, 620, 375 and 320 pixels; task result panels at desktop and mobile widths; gate/worker attention navigation; filtered-worker navigation; absent request semantics; nested, falsy and malformed results; literal text safety; full reports; and page/panel overflow. Screenshots go to `output/playwright/`. These are presentation fixtures, not evidence of real worker execution. Live Run data was also inspected without starting or stopping workers. Note that `scripts/check-ui-layout.js` does not exercise the five newer interaction paths (keyboard node activation, four read states, mobile task-list toggle, bounded menu sheets, or preflight preview).

### Scoped manual verification checklist

For the five critique optimizations, manually verify the following interactions:

1. **Keyboard node activation & inspector focus/Escape**:
   - Focus a DAG node with Tab and press `Enter` or `Space`: inspector opens.
   - Verify the inspector title heading (`h3.node-panel__title`) receives focus.
   - Press `Escape`: inspector closes and focus returns to the triggering node.
   - Open a nested `DoodleSelect` (e.g. model or harness dropdown) inside the inspector and press `Escape`: dropdown closes, focus stays on the selector trigger, and inspector remains open.
2. **Four distinct read states and read-only retry**:
   - Initial read in progress shows loading indicator without claiming empty or failed.
   - Simulate initial read failure: verify first-read failure screen appears with error details and page reload button; launch preview and Run buttons are disabled (no false empty or stale UI).
   - Verify confirmed empty state shows distinct empty prompt when no runs or tasks exist.
   - Simulate periodic refresh failure after a valid snapshot: verify existing tasks and counts stay visible, stale read banner appears with error details, and "Retry read" button refreshes projection without page reload or mutation replay.
3. **Mobile task list and graph switch (<=760px)**:
   - At <=760px (e.g. 375px), verify display defaults to readable `TaskList`.
   - Toggle toolbar switch to "Graph" and back to "Tasks".
   - Click/tap task item: inspector opens; closing inspector returns focus to the task item via `rAF`.
   - Confirm execution controls remain desktop-first, with mobile focused on readable triage.
4. **Bounded menu sheets and close buttons (<=1024px)**:
   - Open Run options menu, View menu, and Execution settings menu at <=1024px.
   - Verify all three open as fixed sheets bounded within viewport (`max(8px, env(safe-area-inset-*))`, max height `calc(100dvh - 16px)`).
   - Verify visible Close button (`.menu-close`, min 44px height) is present and functional.
   - Verify View toolbar stacking context is raised (`z-index: 40`) so View menu's Close button is clickable.
   - Verify `Escape` closes menu and returns focus to summary trigger.
5. **Structured preflight launch preview**:
   - Click "Preview launch" or "Run with Orca" to open preview dialog.
   - Verify shared defaults and deduplicated common limits appear at top.
   - Verify task list displays full task names, exact task IDs, and route/reason.
   - Verify tasks with unsupported routes, unknown codes, or task-specific limits are auto-expanded.
   - Click "Copy ID" on a task: verify feedback changes to "ID copied" (or graceful fallback on clipboard denial).
   - Test Tab / Shift+Tab cycling in `DecisionDialog`: verify focus trap only hits visible elements and respects closed `<details>`.
   - Cancel or press `Escape` in Start confirmation: no `/api/run` call occurs. Preferences saved during preview preparation remain saved.

### Evidence boundary

These checks use Chromium viewport emulation with isolated UI API data. The
six-width matrix covers 1280, 900, 620, 390, 375 and 320 pixels in both locales.
Synthetic native touch input can exercise list tapping and scrolling, but is
not physical-device or Safari evidence. No UI fixture establishes live Orca
worker execution or full WCAG compliance.

The whole-tree style detector still reports inherited Chat/attention side accents
and elastic crayon easing. Those existing decorations are intentionally unchanged
in this five-issue interaction pass; successful smoke checks do not imply that
every legacy stylesheet is detector-clean.

Rollback is limited to frontend source and this check/documentation. No database,
configuration schema, release, commit or external state migration is required.
