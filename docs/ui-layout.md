# Orchestration Panel Dual-Surface UI Layout

English | [简体中文](ui-layout_zh.md) · [Documentation](README.md)

## Current Architecture: Dual-Surface IDE Workbench + Compact Orca Sidebar

**Orchestration Panel** (`web/src/main.tsx`) renders two tailored surfaces from one SPA codebase depending on `?view=sidebar`:

1. **Full Workbench Tab (`App.tsx`, `styles/ide-workbench.css`)** — Dual-theme (Light & Dark monochrome Zinc/Obsidian palette following Orca's host theme with manual override) 4-zone IDE workbench:
   - **Top Header**: Fork-join DAG emblem (`DagBrandMark`) + **Orchestration Panel** title, Run Picker, Run Health badge, Connection indicator, Command Palette (`⌘/Ctrl+K`), Keyboard Shortcuts, Theme toggle, Language toggle (`中 / EN`), and primary `Run` / `Stop` controls.
   - **Zone A (Left Sidebar Explorer)**: Live Fleet list, Decision Gates list, Coordinator status card, and stage view navigation (`DAG Canvas`, `Status Board`, `Run History`, `Workspaces & Cleanup`, `Execution & Capabilities`).
   - **Zone B (Center Stage)**: Persistent lazy-loaded React Flow DAG canvas (LR/TB Dagre layout, minimap, parent-lineage toggle, flow-list toggle) or operational views.
   - **Zone C (Resizable Bottom Dock)**: `Activity Stream`, `Worker Output` (`WorkerOutputDockView` over `OutputTail` SSE), and `Request Ledger`.
   - **Zone D (Resizable Right Contextual Inspector)**: Gate Inspector (`GateInspector`) or compact `ChatPanel` (`.odag-inspector--compact-chat`) with 4 sibling tabs: **Messages** (monochrome chat bubbles + avatars + unified auto-growing composer), **Session** (`NodeSessionPanel` collapsible live tool cards), **Task** (`NodePanel`), and **Config**.
2. **Right-Sidebar Companion (`SidebarApp.tsx`, `components/sidebar-app.css`, `?view=sidebar`)** — Streamlined narrow-panel (`320–450px`) surface hosted natively inside Orca's `orchestration-panel` plugin:
   - **Compact 2-Row Header**: Run Picker, portaled Run/Stop icon button, a **single** `↗ Tab` button (`POST /api/open-tab`, opening or reviving the full Tab in-place), native `<progress>` bar, and horizontal status filter chips.
   - **3 Flat Primary Tabs**: **Tasks** (compact cards with status glyph, harness badge, and live summary), **Pending** (Gates, worker questions, permission prompts, stop events, and resumable failed workers), and **Live** (recent Run activity rows).
   - **Single-Task Drill-in Detail**: Back bar with **Focus terminal** and **Resume** (L1 native resume) actions, plus 3 sibling tabs aligned in naming and visual style with the full workbench:
     - **Messages** (`chat.view.messages`): embeds `<ChatPanel embeddedMessagesOnly />` inside `.odag-inspector--compact-chat`, guaranteeing 100% identical chat bubbles, avatars, recovered briefs, reply quotes, status summary, and unified composer.
     - **Session** (`ide.inspector.tabSession`): mounts `NodeSessionPanel` for live collapsible tool-call cards.
     - **Output** (`sb.detailOutput`): mounts `WorkerOutputDockView` for raw terminal/transcript tailing.
   - **Bottom Status Capsule**: The coordination mode and handle stay centered below the scrollable list or task detail without covering either. Open the capsule to see Run health and the full handle above it.

---

## Previous Two-Area Workbench Notes (Historical Reference)

English | [简体中文](ui-layout_zh.md) · [Documentation](README.md)

### Goal and decisions

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
  an integrated Chat application (`ChatPanel` in `.workbench-chat`), and full operational sections.
  Clicking a node on the canvas opens that Task's private chat at Messages (`#section=chat&task=<id>`),
  with complete Task details/configuration (`NodePanel`) hosted as a sibling tab alongside Messages and Inbox checks.
  Opening chat retains the operations panel width rather than crowding a third column or collapsing the canvas.
- **Mobile / Tablet (≤900px)**: A dedicated top pane switch (`.workbench-mobile-switch`) toggles between
  Canvas (`taskView.graph`) and Operations (`workbench.home`). Selecting a task opens that Task's private chat
  in the operations area; the mobile switch allows toggling back to canvas.
| Area / Surface | Component / Selector | Content |
| --- | --- | --- |
| Header | Adaptive grid header (`.workbench-header`) | Compact Run picker (with ellipsis truncation, full tooltip, search, history pagination, and exact-ID lookup; no in-page New Run button), progress, coordinator health, icon-only connection status, preview/Stop and execution notices (`.workbench-action-host`), and language toggle. |
| Canvas (Left, Persistent) | `.workbench-canvas`, `DagView` | Persistent lazy-loaded React Flow DAG; icon-only Run/Run again control (`.workbench-launch-host`) beside the Radix View popover, which contains the status legend, hierarchy toggle, layout selector and relayout action. |
| Operations: Home Launcher | `.workbench-nav--home` | Four-column app launcher (three columns below 360px operations width) presenting 7 apps (Chat plus Overview, Decisions, Executions, Activity, Resources, Settings), plus completion and actionable summaries that preserve partial, stale and unknown evidence. |
| Operations: Bottom Dock | `.workbench-nav--dock` | Seven app shortcuts at operations widths ≥640px (Chat, Overview, Decisions, Executions, Activity, Resources, Settings); below that, Chat, Decisions, Executions and All apps form four columns. Other apps remain accessible from Home without horizontal scrolling. |
| Operations: Decisions | Decisions section | Full actionable operations list (`OperationsAttention` full variant), pending approval gates (`GatePanel`), and interrupted start recovery (`RecoveryPanel`). |
| Operations: Executions | Executions section | Worker fleet view (`WorkerPanel`) with distinct worker fields, capability columns, exact Dispatch identities without duplicate Task ID fallback, neutral `exited` status observation (`#64748b`), archived output reader, search, download, release/retain controls, and coordinator takeover guards. |
| Operations: Activity & Audit | Activity section | Real-time event timeline (`ActivityPanel`) powered by a single shared SSE stream (auto-pausing when hidden), plus mutation ledger (`RequestAuditPanel`). |
| Operations: Resources | Resources section | Workspace lanes (`LanesPanel`) with branch diffs and explicit read/uninspected evidence state (`lane.pending`), plus on-demand workspace cleanup (`CleanupPanel`) with safe merged branch deletion. |
| Operations: Settings | Settings section | Run-level execution configuration defaults, in-flow grouped execution controls (`ExecControls`), and runtime preflight capability diagnostics (`CapabilityPanel`). |
| Operations: Communication & Task Detail | `.workbench-chat`, `ChatPanel`, `NodePanel` | Task-private conversations (Messages, Task details/configuration tab, Inbox checks) and one Run group chat. Selecting a node opens private Messages; the Task tab hosts complete stage details, launch parameters, and gate creation without an independent heading or modal close controls. Narrow panels use list → conversation → back navigation with scoped drafts and shared send guards. |

The architecture decouples the persistent graph canvas from the operations container.
Navigation between Home, Chat and the six operational sections is synchronized with URL hash routing
(`#section=home`, `#section=chat`, `#section=<name>`, canonical node route `#section=chat&task=<id>`), preserving browser history
and Run-scoped scroll positions. Legacy `#section=tasks` routes normalize to Chat. Reload restores Home or Chat.
Selecting a task opens that Task's private chat at Messages; the stable `taskSelection` is maintained across background polls.
The operations header owns the only visible page `h1`; the conversation header uses `h2` within ChatPanel.
NodePanel has no independent `h1`, Close button, Escape-to-close handler, or auto-focus; it mounts on first visit and
remains mounted across sibling-tab switches for that conversation.
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

### Keyboard navigation and task private chat

- Pressing `Enter` or `Space` on a focused DAG node navigates to `#section=chat&task=<id>`, opening that Task's private chat in Chat at the Messages view.
- Inside private chat, operators switch between the sibling **Messages**, **Task**, and **Inbox checks** tabs. Complete Task details and launch configuration (`NodePanel`) are embedded under the Task tab without an independent `h1` or Close button, preserving tab-based keyboard navigation.
- Nested dropdowns (`DoodleSelect` for harness or model selection) consume `Escape` first to close their own menu.
- `NodePanel` does not intercept `Escape` or maintain a modal focus trap; navigation back to conversation list is performed via the conversation back button (`chat__back`).
### Responsive presentation and mobile pane switch

- **Desktop two-area layout (~54% / ~46%)**:
  - The left canvas (`.workbench-canvas`) occupies approximately 54% of viewport width by default, keeping the React Flow DAG permanently mounted and interactive.
  - The right operations area (`.workbench-operations`) occupies approximately 46% by default and is resizable via a vertical drag handle (`.workbench-chat-resize`). Width is clamped between 380px and 820px (`COMMUNICATION_MIN_WIDTH = 380`, `COMMUNICATION_MAX_WIDTH = 820`), reserving at least 320px for the canvas (`CANVAS_MIN_WIDTH = 320`).
  - The separator supports Left/Right arrows in 32px steps and Home/End for minimum/maximum width. Its ARIA value follows the rendered width, including viewport constraints.
  - Opening chat (`communicationOpen`) retains the operations panel width rather than opening an extra column or squeezing the DAG canvas.
- **Mobile / Tablet breakpoint (≤900px)**:
  - The dual-column layout collapses into a single-pane view switched via `.workbench-mobile-switch` at the top of the workbench.
  - Two mutually exclusive buttons allow toggling between Canvas (`taskView.graph`) and Operations (`workbench.home`).
  - Activating a task from the canvas automatically switches `mobilePane` to `"operations"` to display that Task's private chat.
- **Radix primitives and in-flow settings**:
  - `radix-ui` is the shared primitive library; existing CSS owns visual styling, not a second component theme or direct positioning library.
  - The View menu and coordinator health use portalled Radix Popovers with collision bounds, outside dismissal and Escape focus return. There is no global disclosure-close listener.
  - `DoodleSelect` uses Radix Select for simple enums, including empty-string configured defaults and readable disabled saved choices. Searchable Run/model/environment/lane/@Task controls use Popover plus an explicit combobox/listbox; labels, values and hints remain searchable. Run history pagination and exact-ID lookup stay available.
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

- **Normal document flow**: Operational cards and panels (`.gates`, `LanesPanel`, `CleanupPanel`, `WorkerPanel`, `SchedulerPanel`) and the task configuration panel (`.chat__task .node-panel`) participate in normal document layout flow (`position: static; width: 100%`). Global `.gates` is no longer absolute, eliminating vertical coordinate collisions where Lane and Cleanup previously overlapped the central heading.
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
## Chat architecture and shared Task messages

The communication dock (`.workbench-chat`) is integrated into the right operations area
(`workbench-operations`), retaining the operations panel width (~46% on desktop) rather than
opening an intrusive third column or collapsing the DAG canvas. Body text is 16px (`1rem`)
with a 1.6 line height; metadata is 14px (`0.875rem`) or 12px (`0.75rem`), and conversation
titles are 16px semi-bold. Outgoing messages use Apple system blue wash (`var(--sky-wash)` `#eaf3ff`),
incoming messages use soft light-neutral (`var(--paper-2)` `#f5f5f7`), and error messages use
blush wash (`var(--blush-wash)` `#fceeee`). Message bubbles are capped at comfortable reading
widths with word-break safeguards (`overflow-wrap: anywhere`).

Chat launcher and Dock entries use the same outlined speech-bubble icon.
The runtime summary (`.chat-runtime-summary`) centers wrapping status and detail rows. Last-check
time and counts belong to **Inbox checks**, not the message timeline.

- **Conversation sidebar (`.chat__sidebar`)**:
  - A 228px sidebar uses Radix ToggleGroup for Private/Group lists. Private search matches loaded
    task names, exact IDs, harnesses and models without changing the selected recipient.
  - Private contains only Task/Agent conversations, not Run control. Rows show an avatar, two-line
    title, task state, last-message preview and evidence-backed unread/priority/pending markers.
    Unread remains Orca inbox evidence, not whether the operator opened a conversation.
  - Group first shows one **Run group chat** row; changing the tab does not enter it on narrow panels.
  - The identity Popover holds full Task/Dispatch IDs, model details and **Open stage**.
    Escape restores focus to its information button.
- **Harness avatars**: Local official marks identify Claude, Codex (its official extension's OpenAI
  Blossom), OpenCode, Oh My Pi and Antigravity; `opencode2` shares OpenCode's mark. Unknown harnesses
  stay neutral. The group header is a neutral conversation icon, not the latest speaker's brand.
  [HarnessAvatar](../web/src/components/HarnessAvatar.tsx) records primary asset URLs, MIT notices
  and trademark restrictions. Public availability is not trademark authorization; no permission
  or endorsement is claimed. MIT notices also travel inside the relevant SVG assets.
  Chat and the worker fleet share the same Dispatch-scoped identity lookup. When a settled fleet row
  omits launch/provider identity, use exact Run/Task/Dispatch launch history or effective `worker-show`
  evidence. Never borrow another attempt's brand or today's saved harness defaults; unknowns stay neutral.
- **Shared group/private messages**:
  - Both views use the same Run-scoped Activity events. Task messages show `@Coordinator`; outgoing
    group-view messages show the actual event's `@Task`. Clicking a Task avatar opens its private chat.
  - Incoming senders show the Task name and full, selectable Task ID, with observed harness/model as
    secondary metadata. If the DAG row is unavailable, retain the message's Task label or exact ID.
    Coordinator messages keep their own name; the recipient Task is never presented as the sender.
  - Choose an explicit Task with the searchable Radix-backed recipient picker. The composer reuses
    private guidance or that Task's pending-question reply path, including coordinator control checks.
    It never selects a recipient from the latest speaker, falls back to another Task or broadcasts
    to `@all`. Unavailable recipients remain unsendable.
  - Real mailbox status messages are chat content; synthetic progress and heartbeats remain runtime
    signals. Historical audience broadcasts retain their original metadata. The public HTTP broadcast
    API is unchanged, but no longer drives the chat composer.
- **Inbox checks**: Radix Tabs separates messages/composer from `MailboxChecks`. The latter retains
  source, duration, delivery/replay, errors, original message digests and agent snapshots, grouping
  only adjacent compatible checks. Both panels stay mounted; hidden panels cannot overwrite message
  scroll position. Neither opening a check nor viewing a message sends an Orca acknowledgement.
- **Responsive container queries (`@container chat-panel (max-width: 640px)`)**:
  - Start with the full conversation list; clicking a row enters a single conversation pane.
    Back restores the same Private/Group list and its selected-row focus. The hidden pane is not
    keyboard-focusable. This follows panel width, not whole-window width.
- **Reading position**: Follow new entries only when already at the end. Scrolling back preserves the
  reading position; "Jump to latest" returns to the end and focuses the history region. This also covers
  the bounded timeline replacing its oldest row without changing total height. Position remains scoped
  to Run/conversation and no scroll operation marks Orca messages read.
- **Composer and receipts**: Use a full-width textarea with a separate send toolbar. Enter inserts a
  newline; Ctrl/Command+Enter sends, except during IME composition or repeated keydown. Show the
  shortcut beside the action. Receipt identities/raw JSON expand on demand, while enqueue outcomes,
  unknown-send warnings and follow-up navigation stay visible. Failed/unknown sends retain the draft
  and existing resend guards; a receipt never claims that a worker read the message.
- **Scoped chat state**: Chat state is isolated via `useScopedChatState` with precise boundaries:
  - Unknown-guidance flags are Run/Task scoped and shared between group and private views.
  - Drafts use `[runId, mode, recipientTaskId, questionId/dispatchId]`; switching views does not retarget
    an unsent body or let a late response clear another draft.
  - Busy/error/receipt state uses `[runId, recipientTaskId]`, so the other view cannot bypass an
    in-flight send. Timeline limits, scroll and expanded checks use the viewed conversation scope.
  - Group recipient selection and separate Private/Group list selections are Run scoped.
  - Switching Runs or recipients isolates in-progress drafts, preventing unintended message delivery or state clobbering.

## Node launch controls

The stage configuration panel (`NodePanel`), hosted in the Task sibling tab within a Task's private chat, presents launch parameters in dependency order:
Harness/Agent, model, supported effort, placement/environment, and OpenCode interface mode.
It enforces Orca's immutable task contract: once a task has been dispatched, its configuration
is permanently locked.

- **OpenCode model selection**: Displays local-workspace advisory suggestions via searchable
  dropdown, with fallback to manual free-text input (`provider/model[#variant]`). Format
  validation feedback ensures syntax correctness before persistence.
- **Locked fields**: Disabled controls use high-contrast readable text, solid borders,
  and a subtle background tint (`opacity: 1; color: var(--ink); background: var(--paper-2); cursor: not-allowed;`)
  rather than faded gray fields or dashed frames. The explicit lock reason remains visible in adjacent hint text.
- **Mount persistence and operational jumps**: `NodePanel` mounts on first visit to the Task tab and remains mounted across sibling-tab switches for that conversation. It retains all operational action buttons (`reviewGate`, `reviewFailedStart`, `viewWorkerHistory`) jumping directly to the corresponding Operations section (`decisions` or `executions`).

## Implementation and verification

`App.tsx` coordinates the desktop two-area workbench, mobile pane switching (`mobilePane`: `"canvas"` | `"operations"`),
App Home launcher (`operationHome`), compact bottom dock navigation (`.workbench-nav--dock`), URL hash routing
(`#section=home`, `#section=chat`, `#section=<name>`, `#section=chat&task=<id>`), read states, portaled execution controls, and stable task selection.

`DagView` is lazily loaded on first access (`React.lazy`) and retained in memory once mounted. Nodes use
exact dimensions of 280×120px (`NODE_W = 280`, `NODE_H = 120` from `layout.ts`) with
title 16px (line-height 20px, weight 650) and summary 14px (line-height 20px). Dependency
edges are rendered with static solid strokes (`edge--idle`, `edge--run`, `edge--done`)
and dashed hierarchy links, eliminating perpetual animation loops. A gentle executing
pulse (`@keyframes graph-executing`) is scoped to positively evidenced running tasks and
pauses when hidden, inactive, or under `prefers-reduced-motion: reduce`.

### Chat refinement smoke evidence

The built viewer was exercised in English and Chinese at 1440, 1024, 900, 768, 390 and 320px:
48 combinations of private list, private conversation, Run group conversation and Inbox checks
had no page or chat-region horizontal overflow. The live development surface was also opened.
Real-data checks covered avatar-to-exact-Task navigation, identity Popover Escape focus restoration,
one group-list item, no check rows inside message history and no fresh production page errors.

A removed, isolated browser fixture loaded the real `ChatPanel` and intercepted every API request.
Five official marks plus the OpenCode 2 alias decoded; unknown harnesses retained a neutral avatar.
Forty bilingual layout combinations at 820, 640, 440, 390 and 320px with 568px height covered the
private list, active private/group composers and separate checks without horizontal overflow.
Keyboard tab switching, list/back focus, draft and reading-position restoration, grouped original
check evidence and check pagination from 100 to 110 groups were exercised. The 100-message group
window followed new arrivals only at the end and preserved an older reading anchor during eviction.

Controlled sends covered exact `@Task` guidance, replying only to that Task's pending question,
shared incoming status messages, outgoing mentions, avatar navigation, shared cross-view busy/unknown
guards, late-response and Task/Run draft isolation. Inactive-coordinator and removed-target cases
stayed unsendable without redirecting. No audience-preview or broadcast call was issued by the
targeted-send scenario. No real worker received test messages; these checks do not certify
screen-reader behavior, native OS IMEs or backend delivery.

### Radix workbench smoke evidence

Browser checks on the local viewer covered Home, Chat and all operational sections in English and
Chinese at widths 1440, 1024, 900, 768, 390 and 320px: no page or Dock
horizontal overflow, and exactly one visible page heading. The 390×844 task view had a
133px settled header and about 542px of main content height; these are sample measurements,
not guarantees for every warning or receipt state.

Historical verification on earlier iterations exercised Home/Chat reload and browser Back, retained task filtering, historical central inspector focus
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
     7 app tiles (Chat, Overview, Decisions, Executions, Activity, Resources, Settings).
   - Click an app tile: verify the view switches to the corresponding section and the compact bottom dock
     (`.workbench-nav--dock`) appears with 7 desktop columns (Chat, Overview, Decisions, Executions, Activity, Resources, Settings), or 4 columns (Chat, Decisions, Executions, All apps) on narrow operations containers (<640px).
   - Activate the Home icon in the operations header (accessible name "Back to home"): verify the Home launcher opens. The header button has no visible text; the compact Dock retains its separate All apps entry.
   - Use the bottom dock to switch between sections directly without returning to Home.
3. **Persistent DAG canvas and View menu**:
   - In the canvas header, open the View popover (`.view-menu`): verify the Task status, Connections
     and Layout groups, six aligned status counts, solid/dotted line samples, parent-links switch,
     horizontal/vertical choices (`layered-lr`, `layered-tb`) and an adjacent icon-only Re-layout action
     with an accessible name and reset-warning Tooltip. Use compact spacing while retaining 44px controls. Retired `force`
     preferences migrate to horizontal in server config and the browser mirror.
   - Verify arrow/Space keyboard layout selection, persistence after reload, and Re-layout resetting
     a manually dragged node. Short screens scroll the panel without clipping keyboard-reachable actions.
   - Press `Escape`: verify the popover closes and focus returns to its trigger button.
4. **Task private chat and complete Task detail tab**:
   - Click a node on the canvas: verify URL hash updates to `#section=chat&task=<id>` and operations area displays that Task's private chat open to the **Messages** tab.
   - Verify the conversation header displays task label, harness avatar, lead stage badge (if marked), and details popover with full Task and Dispatch IDs.
   - Private conversation sibling tabs show **Messages**, **Task**, and **Inbox checks** (with count badge).
   - Click the **Task** tab: verify complete Task details and configuration (`NodePanel`) mount in-place with status, readiness reasons, lead stage toggle, gate creation, launch-lock notices, harness, model, effort, placement/environment, and lane configuration.
   - Switch between Messages, Task, and Inbox checks: verify Task configuration mounts on first visit and remains mounted across sibling-tab switches for that conversation.
   - Group chat: verify Run group chat has Messages and Inbox checks tabs, but no individual Task tab.
   - Operational links: verify buttons to review gate, review failed start, or view worker history successfully navigate to the corresponding Operations section (`decisions` or `executions`).
5. **Mobile / Tablet pane switch (≤900px)**:
   - Resize viewport to ≤900px: verify the top switch bar (`.workbench-mobile-switch`) appears with Canvas
     and Operations buttons.
   - Selecting a node from the canvas switches `mobilePane` to `"operations"` to display that Task's private chat.
   - Toggle between Canvas and Operations using the switch bar.
6. **Shared group/private chat**:
   - Private lists contain Tasks only; Group lists one Run group chat before entering it.
   - Verify `@Coordinator` / `@Task` markers, avatar-to-private navigation and the same incoming messages
     in both views. Send only to the explicitly selected Task through the existing guidance/reply routes.
   - Verify Inbox checks are absent from the message timeline but retain their raw evidence.
   - On narrow panels, verify list/detail/back focus, drafts, reading position, shared busy/unknown-send
     guards and Task/Run isolation under delayed responses.
7. **Read states and retry**:
   - Verify distinct loading state on initial read.
   - Verify first-read failure displays error details, page reload button, and disables execution controls.
   - Verify confirmed empty state displays empty project prompt.
   - Verify stale snapshot displays stale banner with "Retry read" button that refreshes projections without page reload.
