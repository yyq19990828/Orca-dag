// English dictionary — the source of truth for keys. zh must define exactly
// these keys (typed Record<TranslationKey, string> in zh.ts; tsc enforces it).
const en = {
  "topbar.title": "Orca DAG Viewer",
  "topbar.orcaConnected": "Orca connected",
  "topbar.viewOnly": "View-only",
  "topbar.fetchFailed": "Fetch failed",
  "topbar.connDetailConnected": "Connected to Orca",
  "topbar.connDetailReady": "Connected to Orca {version} · {cli} (execution enabled)",
  "topbar.connDetailViewOnly": "Execution unavailable — view-only",
  "topbar.noStages": "No stages",
  "topbar.doneOf": "{done}/{total} done",
  "topbar.failedCount": "⚠ {n} failed",
  "topbar.completedStagesAria": "Completed stages",
  "topbar.progressAria": "{done} of {total} stages complete",
  // Suffix fragment (never shown alone): appended when at least one stage
  // failed, separator included so each language keeps its own punctuation.
  "topbar.progressFailedAria": ", {n} failed",
  "toolbar.activityChat": "Activity / Chat",
  "toolbar.activity": "Activity",
  "toolbar.chat": "Chat",
  "toolbar.operations": "Operations",
  "toolbar.openOperationsCount": "Open Operations, {n} actionable items",
  "toolbar.openOperationsAtLeast": "Open Operations, at least {n} actionable items",
  "toolbar.openOperationsUnknown": "Open Operations, actionable count unknown",
  "toolbar.taskDepCount": "{tasks} tasks · {deps} deps",
  "toolbar.view": "View",
  "toolbar.viewTitle": "Status colors, graph relations, and layout options",
  "toolbar.statusLegendAria": "Stage status legend",
  "toolbar.relationLegendAria": "Relation legend",
  "toolbar.dependency": "dependency",
  "toolbar.dependencyTitle": "Dependency: work that must finish before the target stage may start",
  "toolbar.parent": "parent",
  "toolbar.parentTitle": "Ownership: parent/child structure — never a dependency, never an order",
  "toolbar.hierarchyToggleTitle": "Show or hide parent/child links on the graph (they are never dependencies)",
  "toolbar.hideParentLinks": "Hide parent links",
  "toolbar.showParentLinks": "Show parent links",
  "toolbar.layout": "Layout",
  "toolbar.layoutAria": "Layout algorithm",
  "toolbar.relayout": "↻ Re-layout",
  "toolbar.relayoutTitle": "Re-run auto-layout (discards manual drags)",
  "toolbar.communicationCenterAria": "Run communication center",
  "toolbar.communicationViewAria": "Communication view",
  "toolbar.closeCommunicationAria": "Close communication center",
  "toolbar.resizeCommunicationAria": "Resize communication panel",
  "toolbar.resizeCommunicationTitle": "Drag or use Left/Right arrow keys to resize",
  "empty.pickRunTitle": "Pick a Run first",
  "empty.pickRunBody": "Since Orca 1.4.160 tasks belong to a Run — they are no longer global. Pick one with the Run dropdown in the header, or have your agent run",
  "empty.pickRunBodyTail": "to start a new one.",
  "status.pending": "Pending",
  "status.ready": "Ready",
  "status.dispatched": "Running",
  "status.completed": "Done",
  "status.failed": "Failed",
  "status.blocked": "Blocked",
  "priority.urgent": "Urgent",
  "priority.low": "Low priority",
  "priority.normal": "Normal priority",
  "priority.high": "High priority",
  "layout.label.layered-lr": "Horiz.",
  "layout.label.layered-tb": "Vert.",
  "layout.label.force": "Force",
  "layout.title.layered-lr": "Layered, left to right (Sugiyama / dagre)",
  "layout.title.layered-tb": "Layered, top to bottom (Sugiyama / dagre)",
  "layout.title.force": "Force-directed (Fruchterman–Reingold)",
  // Coordinator phases (§6.3) — the label ExecControls shows while a Run is
  // live. These are keys: PHASE_KEY in ExecControls.tsx maps phase -> key.
  "phase.idle": "Idle",
  "phase.binding": "Binding…",
  "phase.running": "Running",
  "phase.awaitingInput": "Waiting for you",
  "phase.stopping": "Stopping…",
  "phase.completed": "Completed",
  "phase.recovering": "Recovering",
  "phase.error": "Error",
  // Execution panel (ExecControls): launch settings, live badges, stop report.
  // Counts are interpolated; singular and plural are separate keys because zh
  // has no plural form (same shape as topbar.doneOf).
  "exec.lockHistoryError": "Launch settings are locked while Dispatch history could not be verified. Wait for worker history to recover before editing.",
  "exec.lockHistoryLoading": "Launch settings are locked while Dispatch history is loading. Wait for worker history to finish before editing.",
  "exec.lockRunning": "Launch settings are frozen while this Run is executing. Stop the coordinator to edit Tasks that have not started.",
  "exec.lockStarting": "Launch settings are frozen while this Run is starting. Wait for coordinator binding and recovery to finish before editing.",
  // The env-var name is a command token: it stays verbatim in every language.
  "exec.customOffHint": "Custom commands are disabled — start the viewer with ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1",
  "exec.settingsAria": "Execution settings: {harness}, maximum {n} parallel workers",
  "exec.noDefaultHarness": "no default harness",
  "exec.noHarness": "No harness",
  "exec.settingsTitle": "Choose the fallback harness and maximum parallel workers",
  "exec.settings": "Settings",
  "exec.summaryMax": "{harness} · max {n}",
  "exec.groupAria": "Execution settings",
  "exec.defaultHarness": "Default harness",
  "exec.custom": "Custom…",
  "exec.customDisabled": "Custom (disabled)",
  "exec.commandPlaceholder": "command",
  "exec.customCommandAria": "Custom default harness command",
  "exec.maxParallel": "Max parallel",
  "exec.stop": "⏹ Stop",
  "exec.stopPendingTitle": "Stop becomes available after Orca binds this Run",
  "exec.bindingRecovering": "Binding and recovering…",
  "exec.busyWorkersOne": "{n} worker",
  "exec.busyWorkersMany": "{n} workers",
  "exec.settledTitle": "Settled workers released/retained/closed",
  "exec.settledCount": "✓ {released}/{settled} settled",
  "exec.retrying": "↻ {n} retrying",
  "exec.runAgain": "▶ Run again",
  "exec.runAgainTitle": "Run again",
  "exec.completedReleasedOne": "✓ Completed · {n} worker released",
  "exec.completedReleasedMany": "✓ Completed · {n} workers released",
  "exec.doneShort": "✓ Done",
  "exec.completedAt": "Completed at {time}",
  "exec.runWithOrca": "▶ Run with Orca",
  "exec.bindRunTitle": "Bind this Run and execute in dependency order",
  "exec.execUnavailableTitle": "Execution is unavailable on this Orca runtime",
  "exec.outcomeUnknown": "outcome unknown",
  "exec.stopCleanOne": "✓ Stop clean · {n} action",
  "exec.stopCleanMany": "✓ Stop clean · {n} actions",
  "exec.stopUncertainOne": "⚠ Stop finished with {uncertain} uncertain · {n} action",
  "exec.stopUncertainMany": "⚠ Stop finished with {uncertain} uncertain · {n} actions",
  // Lock notices wrap a <code> run id, so each sentence is a prefix + suffix
  // pair (the id keeps its element; see empty.pickRunBody for the same shape).
  "exec.runPrefix": "Run",
  "exec.otherRunExecSuffix": "is executing; its Stop control appears when you select that Run.",
  "exec.otherRunStartingSuffix": "is binding in this viewer; select it after startup to inspect or stop it.",
  // Modal copy. The orca command and the consumer_fenced error code stay
  // verbatim; only the prose around them is translated.
  "dialog.confirmRunTitle": "Let Viewer coordinate this Run?",
  "dialog.confirmRunMessage":
    "Starting execution transfers coordinator authority to the Viewer. Any agent terminal " +
    "currently coordinating this Run will be fenced, so its orchestration mutations will fail " +
    "with consumer_fenced. It can take authority back with:\n\n" +
    "orca orchestration run-use --id {id}",
  "dialog.startRun": "Start Run",
  "dialog.notNow": "Not now",
  "dialog.cancel": "Cancel",
  "dialog.close": "Close",
  "dialog.continue": "Continue",
  // This panel's own refusals. Server-supplied reasons (readiness.reason, fetch
  // errors) stay in whatever language the server sent them in.
  "err.pickRunFirst": "Pick a Run first",
  "err.executionUnavailable": "Execution is unavailable on this Orca runtime.",
  "err.pickDefaultHarness": "Pick a default harness",
  "err.launchLocked": "Launch settings are temporarily locked.",
  "err.runStarting": "Run {id} is already starting in this viewer.",
  "err.runExecuting": "Run {id} is already executing in this viewer. Pick that Run to stop it.",
  "err.placementFix": "Placement plan needs a fix before this Run can start — {detail}",
  // Node panel (NodePanel) — the largest surface: stage actions, ownership,
  // lead-stage marking, launch-lock notices, and the per-node launch cluster
  // (harness/model/effort/environment/placement/workspace lane). The lock
  // sentences reuse the exec.lock* keys verbatim (they are the same copy);
  // only the first-Dispatch variant is node-specific.
  "node.operationsAria": "Stage operations",
  "node.reviewGate": "Review gate",
  "node.reviewFailedStart": "Review failed start",
  "node.viewWorkerHistory": "View worker history",
  "node.subStageOf": "Sub-stage of",
  "node.subStageHint": "ownership only — not a dependency",
  "node.parentOfOne": "Parent of {n} sub-stage: {list}",
  "node.parentOfMany": "Parent of {n} sub-stages: {list}",
  "node.readinessAria": "Why this stage is not running yet",
  "node.readyDispatchable": "Ready — dispatchable now.",
  "node.leadStage": "Lead stage",
  "node.leadStageHint": "Semantic main-agent ownership for Run {id}",
  "node.markLead": "Mark as lead stage",
  "node.markLeadTitle":
    "Mark this Task as the semantic lead stage; this does not change Orca coordinator authority",
  "node.clearLeadAria": "Clear lead stage for {label}",
  "node.clear": "Clear",
  "node.checkingHistory": "Checking Dispatch history…",
  "node.historyUnverified":
    "Could not verify Dispatch history; launch settings remain locked until verification recovers.",
  "node.lockAfterDispatch":
    "Launch settings locked after the first Dispatch. Safe retry preserves the original launch plan.",
  "node.launchLockedTitle": "Launch settings are locked",
  "node.agentGroupAria": "Agent settings",
  "node.agentGroup": "Agent",
  "node.harnessKey": "Harness (which agent runs this node)",
  "node.defaultHarnessOption": "Default ({harness})",
  "node.customPlaceholder": "command, e.g. aider",
  "node.modelKey": "Model ({harness})",
  // Suffix fragment (never shown alone): appended while no model is stored.
  "node.modelDefaultSuffix": " · default",
  "node.defaultModel": "(default model)",
  "node.modelPlaceholder": "model name, e.g. {example}",
  "node.effortKey": "Effort ({harness})",
  "node.defaultEffort": "(default effort)",
  "node.effortHint": "Reasoning effort for the selected model.",
  "node.workspaceGroupAria": "Workspace settings",
  "node.workspaceGroup": "Workspace",
  "node.actualWorktreeKey": "Worktree used by this Dispatch",
  "node.worktreeLoading": "Loading recorded worktree…",
  "node.worktreeError": "Could not load worktree evidence.",
  "node.worktreeNotReported": "Worktree not reported by Orca.",
  "node.branchLabel": "Branch: {branch}",
  "node.dispatchOtherAttempts": "Dispatch {id} · other attempts are in worker history.",
  "node.environmentKey": "Environment (which server executes this node)",
  "node.environmentLaneTitle":
    "This task runs in a local workspace lane — remove it from the lane to pin a remote environment.",
  "node.environmentLocal": "Local (this server)",
  "node.environmentMissing":
    "Saved environment “{id}” is no longer listed — re-discover it or switch back to Local.",
  "node.environmentNoModelEffort":
    "This peer does not advertise model/effort — those controls are hidden for this node.",
  "node.laneKey": "Workspace lane (serial tasks sharing one workspace)",
  "node.laneNone": "(no lane — per-task placement)",
  "node.newLane": "＋ New lane…",
  "node.laneNoSeed": "(no seed — pick a placement below)",
  "node.lanePlacementTitle": "Lane placement (shared by every task in the lane)",
  "node.laneMembers": "Lane members (run one after another): {members}",
  "node.laneRemoveTitle":
    "Remove this task from the lane (the lane itself stays if other tasks still use it)",
  "node.removeFromLane": "Remove from lane",
  "node.laneHint":
    "Tasks in one lane never run concurrently; different lanes may. Leave empty for per-task placement.",
  "node.requestedPlacementLocal": "Requested placement (local workspace)",
  "node.requestedPlacementRemote": "Requested placement on {env}",
  "node.remotePlacementHint":
    "Pick an exact workspace or a new top-level worktree — remote “current” is not a valid placement.",
  "node.retainLabel": "Keep terminal for debugging after this node settles",
  "node.currentDispatch": "Current Dispatch (this attempt)",
  "node.workerTerminal": "Worker terminal",
  // Suffix fragment: the command that follows is a literal orca invocation.
  "node.inspectOutputWith": " · inspect output with",
  "node.specKey": "Spec",
  "node.collapse": "Collapse",
  "node.expand": "Expand",
  "node.specHint": "To change the spec or deps, have your agent redraw the DAG in a fresh Run.",
  "node.resultKey": "Result",
  // Worker report summary (NodePanel's ResultSummary). Only the field LABELS
  // are translated — the parsed report's own values (outcome, provenance,
  // ids, paths) are server data and render verbatim.
  "report.resultAria": "Stage result summary",
  "report.workerReport": "Worker report",
  "report.filesModifiedOne": "{n} file modified",
  "report.filesModifiedMany": "{n} files modified",
  "report.reportLabel": "Report:",
  "report.fullDetails": "Full report and technical details",
  "report.details": "Technical details",
  "report.reportedBy": "Reported by",
  "report.completedBy": "Completed by",
  "report.message": "Message",
  "report.provenance": "Provenance",
  // Placement editor (PlacementEditor) — one grammar, three scopes. Discovery
  // payloads (selectors, repo ids, names) are echoed verbatim; only the
  // surrounding words are keys.
  "placement.mode.current": "Current workspace (default)",
  "placement.mode.existing": "Existing workspace…",
  "placement.mode.newChild": "New child worktree…",
  "placement.mode.newTopLevel": "New top-level worktree…",
  "placement.noRepos": "no repositories discovered",
  "placement.hint.current":
    "Runs in the coordinator workspace. No creation fields apply, and setup never reruns.",
  "placement.hint.existing":
    "Existing workspaces are reused as-is — no creation fields apply, and setup never reruns.",
  "placement.hint.exactWorkspace": "Exact workspace:",
  "placement.hint.newChild":
    "Orca creates a stacked child worktree anchored on the current workspace’s repo.",
  "placement.hint.remoteNameMissing":
    "A remote new worktree needs an explicit name — the coordinator would refuse to start without one.",
  "placement.field.repository": "Repository",
  "placement.field.nameRequired": "Name (required)",
  "placement.field.nameOptional": "Name (optional)",
  "placement.field.setupHooks": "Setup hooks",
  "placement.field.baseBranch": "Base branch (optional)",
  "placement.field.displayName": "Display name (optional)",
  "placement.field.comment": "Comment (optional)",
  "placement.placeholder.nameRequired": "worktree name",
  "placement.placeholder.nameDerived": "derived from the Run if empty",
  "placement.placeholder.baseBranch": "e.g. main or feature/x",
  "placement.placeholder.displayName": "shown in the Orca IDE",
  "placement.placeholder.comment": "stored in Orca worktree metadata",
  // Setup policy values stay verbatim in the option text; only the glosses
  // ("default" / "from base") are translated.
  "placement.setup.run": "run (default)",
  "placement.setup.skip": "skip",
  "placement.setup.inherit": "inherit (from base)",
  // One-liners built by placement.ts (placementLabel / placementKindLabel) for
  // node-panel lane rows and chips. The "kind · payload" shape is structural:
  // only the words change, the echoed selector/name/repo stays as discovered.
  "placement.label.current": "Current workspace",
  "placement.label.existing": "Existing workspace ({selector})",
  "placement.label.newChildNamed": "New child worktree “{name}”",
  "placement.label.newChildDerived": "New child worktree (derived name)",
  "placement.label.newTopLevel": "New top-level worktree in {repo}",
  "placement.label.newTopLevelNamed": "New top-level worktree in {repo} · “{name}”",
  "placement.kind.current": "Current",
  "placement.kind.existing": "Existing",
  "placement.kind.newChild": "New child",
  "placement.kind.newTopLevel": "New top-level",
  // Field-level problems with a creation spec (placement.ts). Shown as hints
  // under the fields they belong to.
  "placementProblem.name": "Name must be a short token: letters/digits, then . _ - allowed (max 64).",
  "placementProblem.baseBranch":
    "Base branch must look like a git ref (no leading dash, “..”, or trailing “/”/“.”).",
  "placementProblem.displayName": "Display name is limited to {n} characters.",
  "placementProblem.comment": "Comment is limited to {n} characters.",
  // Lane plan preflight (placement.ts, lanePlanProblems). These surface in
  // ExecControls' err.placementFix and in the node panel; a message starting
  // with laneProblem.lanePrefix is lane-scoped — NodePanel filters on exactly
  // that prefix (via laneProblemPrefix) to show only its own lane's problems.
  "laneProblem.lanePrefix": "Lane {lane}:",
  "laneProblem.missing": "Task {task} references lane {lane}, which no longer exists.",
  "laneProblem.directPlacement":
    "Task {task} is in lane {lane} and also carries a direct placement — remove one.",
  "laneProblem.environment":
    "Task {task} is in a local lane and also pinned to a saved environment — remove one.",
  "laneProblem.unordered":
    "Lane {lane}: {a} and {b} share a workspace but no dependency orders them — " +
    "add a dependency between them or move one out of the lane.",
  "laneProblem.cycle": "Lane {lane}: {a} and {b} depend on each other in a cycle.",
  // Workspace lanes runtime panel (LanesPanel) — what the coordinator did with
  // the lane plan. State tokens and every Orca-reported fact (selectors,
  // paths, branches, hashes, warnings, server notes) render verbatim.
  "lane.badge": "Workspace lanes · shared serial workspaces",
  "lane.none": "No lanes are configured for this Run.",
  "lane.taskCountOne": "{n} task",
  "lane.taskCountMany": "{n} tasks",
  // Suffix fragments (never shown alone): the " · " separator is part of each
  // key so translations own their punctuation.
  "lane.activeDispatchOne": " · {n} active dispatch",
  "lane.activeDispatchMany": " · {n} active dispatches",
  "lane.via": " · via {source}",
  "lane.selectorLabel": "Selector:",
  "lane.selectorUnknown": "unknown (no positive evidence yet)",
  "lane.worktreeLabel": "Worktree:",
  "lane.pathLabel": "Path:",
  "lane.branchLabel": "Branch: {branch}",
  "lane.headLabel": "Head:",
  "lane.createdByDispatch": "Created by dispatch",
  "lane.state.planned":
    "The lane is configured but no worker has created or opened its workspace yet.",
  "lane.state.creating": "A worker-start is creating the lane's worktree right now.",
  "lane.state.active": "The lane's workspace is positively identified and a worker is using it.",
  "lane.state.integration_required":
    "Work in this lane finished, but a downstream task in another lane waits on a human integration gate.",
  "lane.state.settled":
    "Every task in the lane settled; the workspace is retained until you explicitly remove it.",
  "lane.state.unverifiable":
    "The lane's workspace identity could not be positively recovered — nothing will be guessed or recreated.",
  "lane.state.removal_blocked":
    "The worktree cannot be removed right now — check the warnings for the blocking evidence.",
  "lane.state.removed": "The worktree was removed through Orca (`orca worktree rm`).",
  // Fallback for a runtime state this viewer does not know (shown verbatim).
  "lane.state.other": "The runtime reported this state verbatim.",
  "lane.changedFiles": "Changed files",
  "lane.diff": "Diff",
  "lane.openChangedFilesTitle": "Open the workspace's changed files through Orca",
  "lane.openDiffTitle": "Open the workspace's diff through Orca",
  "lane.needsWorkspace": "Needs a positively identified workspace",
  "lane.removeWorktree": "Remove worktree…",
  "lane.removeWorktreeTitle":
    "Remove the worktree through orca worktree rm (asks for typed confirmation)",
  "lane.removeNeedsSettled": "Removal needs settled ownership — this lane is {state}",
  // Removal confirmation. The orca command stays verbatim; the typed token is
  // a worktree identity, so it is interpolated as-is (see lane.removeFieldLabel).
  "lane.removeTitle": "Remove this worktree?",
  "lane.removeMessageWithPath":
    "This runs `orca worktree rm` on the lane's workspace:\n\n{path}\n\n" +
    "Uncommitted work is lost and this cannot be undone. Type {token} to confirm.",
  "lane.removeMessageNoPath":
    "This runs `orca worktree rm` on the lane's workspace.\n\n" +
    "Uncommitted work is lost and this cannot be undone. Type {token} to confirm.",
  "lane.removeFieldLabel": "Type {token}",
  "lane.removeConfirm": "Remove worktree",
  "lane.confirmMismatch": "The confirmation text did not match — nothing was removed.",
  // Action receipts and notes. Server-supplied reasons/notes stay verbatim;
  // these keys only frame them.
  "lane.receipt": "Removal receipt: {state}",
  "lane.receiptUnknownState": "unknown",
  "lane.receiptReason": " — {reason}",
  "lane.receiptRequest": " · request {id}…",
  "lane.openedFiles": "Opened files through Orca",
  "lane.openedDiff": "Opened diff through Orca",
  "lane.openedIn": " in {workspace}",
  "lane.openedNote": " — {note}",
} as const;
export default en;
export { en };
