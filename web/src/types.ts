export type TaskStatus =
  | "pending"
  | "ready"
  | "dispatched"
  | "completed"
  | "failed"
  | "blocked";

/** Canvas layout algorithms the viewer can arrange the DAG with. */
export type LayoutKind = "layered-lr" | "layered-tb" | "force";

export const LAYOUTS: { kind: LayoutKind; label: string; icon: string; title: string }[] = [
  { kind: "layered-lr", label: "Horiz.", icon: "⇄", title: "Layered, left to right (Sugiyama / dagre)" },
  { kind: "layered-tb", label: "Vert.", icon: "⇅", title: "Layered, top to bottom (Sugiyama / dagre)" },
  { kind: "force", label: "Force", icon: "❋", title: "Force-directed (Fruchterman–Reingold)" },
];

export interface DagNode {
  id: string;
  label: string;
  status: TaskStatus;
  spec: string;
  result: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Current Orca Dispatch (one attempt). Only set while dispatched. */
  dispatchId: string | null;
  /** Terminal running the current attempt. Only set while dispatched. */
  assigneeHandle: string | null;
}

export interface DagEdge {
  id: string;
  source: string;
  target: string;
}

export interface Gate {
  id: string;
  taskId: string | null;
  question: string;
  options: string[];
  status: string;
  resolution: string | null;
}

export interface DagResponse {
  /** Tasks are Run-scoped since Orca 1.4.160 — a DAG always belongs to one Run. */
  runId: string;
  nodes: DagNode[];
  edges: DagEdge[];
  gates: Gate[];
  generatedAt: number;
}

/** A lightweight orchestration Run: namespace + coordinator inbox. */
export interface OrcaRun {
  id: string;
  objective: string;
  coordinator_handle: string | null;
  created_at: string;
}

export interface StatusMeta {
  label: string;
  /** Crayon stroke color — node border, legend dot. */
  color: string;
  /** Soft crayon wash — node fill. */
  bg: string;
  /** Darker crayon ink — status label text, for contrast on the wash. */
  ink: string;
}

// A box of fresh crayons on paper. Each status gets a stroke, a soft wash fill,
// and a darker ink for legible labels.
export const STATUS_META: Record<TaskStatus, StatusMeta> = {
  pending: { label: "Pending", color: "#C6C1B4", bg: "#F3F1EA", ink: "#8A857A" },
  ready: { label: "Ready", color: "#7BB7E0", bg: "#EAF4FB", ink: "#3E7BA6" },
  dispatched: { label: "Running", color: "#F0B94E", bg: "#FDF4E1", ink: "#B37F16" },
  completed: { label: "Done", color: "#7FC98C", bg: "#EBF7EE", ink: "#3E9A55" },
  failed: { label: "Failed", color: "#EA6B5E", bg: "#FCECE9", ink: "#C23B2E" },
  blocked: { label: "Blocked", color: "#B79FE0", bg: "#F2EDFB", ink: "#7B5CB8" },
};

/**
 * Harness presets. These are Orca TUI agent ids: the coordinator passes one to
 * `orca orchestration worker-start --agent <id>`, so Orca owns the launcher and
 * its autonomous flags. Anything Orca doesn't recognize (a custom command) still
 * works — the coordinator falls back to creating the terminal itself.
 */
export const HARNESSES = [
  "claude",
  "codex",
  "opencode",
  "gemini",
  "grok",
  "cursor",
  "droid",
  "kimi",
] as const;
export type Harness = (typeof HARNESSES)[number] | (string & {});

/** Launch preferences for one attempt — requested (ours) vs effective (receipt echo). */
export interface LaunchPrefsView {
  agent: string | null;
  model: string | null;
  effort: string | null;
  worktree: string | null;
  terminal: string | null;
  /** Saved environment the worker was placed on (Phase 6); null = local. */
  on: string | null;
}

/** One page of bounded worker output (GET /api/workers/:id/output). */
export interface WorkerOutputView {
  dispatchId: string;
  source: string;
  cursor: string | null;
  lines: string[];
  contentComplete: boolean;
  clipped: boolean;
  warnings: string[];
  /** True when the requested cursor pinned to a replaced source — the read restarted. */
  sourceChanged: boolean;
}

/**
 * The durable identity fields the launch-lock UI needs from one worker-list
 * row. The server may return richer fleet accounting, but existence of a
 * Task-linked row alone proves that its launch plan has already been used.
 */
export interface WorkerAccountingView {
  dispatchId: string;
  taskId: string;
  runId: string;
}

/**
 * One in-flight (or settled) attempt, mirroring an Orca Dispatch. `supervised`
 * attempts were started by `worker-start` and Orca tracks them; `legacy` ones
 * were composed by hand for a harness Orca doesn't recognize as a configured
 * TUI agent (their tracking Dispatch is unsupervised).
 */
export interface RunAttempt {
  taskId: string;
  harness: string;
  mode: "supervised" | "legacy";
  dispatchId: string | null;
  handle: string | null;
  startedAt: number;
  /** Orca fails the task after 3 consecutive attempt failures. */
  failureCount: number;
  lastHeartbeatAt: string | null;
  /** Liveness verdict from the last worker-list reconciliation. */
  liveness: string | null;
  /** The runtime's own reason for that verdict (Phase 5). */
  livenessReason: string | null;
  /** Fleet attention flags — e.g. `failure`, `root_completion` (Phase 5). */
  attention: { categories: string[]; requiresAction: boolean } | null;
  /** Agent-wait evidence: stage + activity the fleet last reported (Phase 5). */
  stage: { worker: string; dispatch: string; detail: string | null; activity: string } | null;
  /** Terminal accounting Orca last reported for this Dispatch (Phase 5). */
  fleetTerminalState: string | null;
  /** The worker terminal the fleet last reported (Phase 5). */
  agentTerminalHandle: string | null;
  /**
   * Execution host that owns this worker's process/output facts (Phase 6):
   * `{kind:"local",id:"local"}` or the saved environment. Null = never
   * reported — placement renders unknown, never "local by assumption".
   */
  host: { kind: string; id: string } | null;
  /** What this viewer asked for at start (Phase 5). */
  requested: LaunchPrefsView;
  /** What the runtime echoed back — null/absent fields mean unknown (Phase 5). */
  effective: LaunchPrefsView | null;
  /** The settled Dispatch whose terminal this attempt reused (Phase 5). */
  reuseOf: string | null;
  /** Orca-authoritative settlement (worker_done or terminal task status). */
  settled: boolean;
  outcome: "succeeded" | "failed" | null;
  settledVia: "worker_done" | "task_status" | "start_failed" | null;
  settledAt: number | null;
  /** Post-settlement terminal ownership decision. */
  terminalDecision:
    | "pending"
    | "released"
    | "retained"
    | "closed"
    | "reused"
    | "not_needed"
    | "release_pending"
    | "release_unknown"
    | "close_failed";
  terminalDetail: string | null;
  /** Tail of archived output, captured before release. */
  output: {
    source: string;
    lines: string[];
    contentComplete: boolean;
    clipped: boolean;
    cursor: string | null;
    warnings: string[];
    sourceChanged: boolean;
  } | null;
  // --- Phase 4: recovery + idempotency ---
  /** Adopted from Orca state at coordinator start instead of started here. */
  adopted: boolean;
  /** The Dispatch this attempt explicitly retries (set by the user's retry). */
  retriedFrom: string | null;
  /**
   * The durable retry-request id of an in-flight start, retained until its
   * outcome is known. Null once the start resolved (success or receipt).
   */
  startRequestId: string | null;
  /** Latest worker-start receipt — evidence for failed starts and retries. */
  startReceipt: WorkerStartReceiptView | null;
  /**
   * The literal recovery action Orca prescribes. Followed only when `argv`
   * is non-empty; null/empty argv means "no prescribed action" — never
   * invented.
   */
  nextAction: { kind: string; argv: string[] } | null;
}

/** Full worker-start receipt (Phase 4 item 1), preserved for the UI. */
export interface WorkerStartReceiptView {
  ok: boolean;
  taskId: string | null;
  dispatchId: string | null;
  /** Echo of the durable --retry-request id the start ran under. */
  requestId: string | null;
  status: string | null;
  /** Stage reached (or in-flight when it failed). */
  stage: string | null;
  /** The stage that failed, on a failed start. */
  failedStage: string | null;
  setup: string | null;
  /** Resources a failed start left behind, verbatim. */
  residualResources: unknown;
  /** Orca's own prescribed recovery commands, verbatim. */
  recoveryCommands: string[];
}

/** What startup recovery found and did (Phase 4 items 4-7). */
export interface RecoverySummaryView {
  at: number;
  /** Dispatches adopted as still-active (counted against concurrency). */
  activeAdopted: string[];
  /** Positively settled Dispatches adopted with an owed ownership decision. */
  settledAdopted: string[];
  /** Rows we could not verify — surfaced, never acted on destructively. */
  unverifiable: string[];
  /** Already-decided rows (released/retained) left exactly as Orca holds them. */
  leftDecided: number;
}

/** A worker question/escalation waiting on a human reply. */
export interface PendingInboxItem {
  messageId: string;
  kind: "question" | "escalation";
  from: string;
  subject: string;
  body: string;
  createdAt: string;
  taskId: string | null;
}

/** Cleanup work the coordinator refuses to guess its way through. */
export interface CleanupDebtItem {
  key: string;
  kind:
    | "release_unknown"
    | "release_pending"
    | "close_failed"
    | "coordinator_close_failed"
    | "stop_unknown"
    | "reclaimable";
  dispatchId: string | null;
  handle: string | null;
  detail: string | null;
}

/** One readable row in the Run-scoped coordinator/worker activity history. */
export interface ActivityEvent {
  id: string;
  runId: string;
  taskId: string | null;
  dispatchId: string | null;
  direction: "coordinator_to_agent" | "agent_to_coordinator" | "system";
  actor: {
    role: "coordinator" | "lead" | "worker" | "system";
    label: string;
    harness: string | null;
    model: string | null;
  };
  kind:
    | "dispatch_started"
    | "status"
    | "heartbeat"
    | "question"
    | "reply"
    | "worker_done"
    | "escalation"
    | "gate"
    | "recovery"
    | "release"
    | "cleanup_debt"
    | "unknown";
  severity: "info" | "success" | "warning" | "error";
  title: string;
  summary: string;
  detail: string | null;
  createdAt: string;
  groupedCount: number;
  actionable: null | {
    kind: "reply" | "release" | "retain" | "retry";
    targetId: string;
  };
  technical: {
    messageId?: string;
    terminalHandle?: string;
    payload?: unknown;
    argv?: string[];
    provenance: "orca_message" | "fleet" | "coordinator" | "viewer_journal";
  };
}

/** Full Activity snapshot. Every row is guaranteed to belong to `runId`. */
export interface ActivitySnapshot {
  runId: string;
  events: ActivityEvent[];
  presence: StagePresence[];
  /** Recent receipts from the live coordinator's rolling inbox checks. */
  checks: CoordinatorCheckReceipt[];
  pendingCount: number;
  truncated: boolean;
  generatedAt: number;
}

export interface CoordinatorCheckReceipt {
  sequence: number;
  checkedAt: number;
  durationMs: number;
  deliveryId: string | null;
  messageCount: number;
  messageTypes: string[];
  replayed: boolean;
  timedOut: boolean;
  error: string | null;
  agents: CoordinatorCheckAgentSummary[];
  source?: "viewer_loop" | "external_inferred";
  evidence?: string | null;
}

export interface CoordinatorCheckAgentSummary {
  taskId: string;
  dispatchId: string | null;
  liveness: "live" | "unverifiable" | "exited";
  activity: string | null;
  detail: string | null;
  attention: string[];
  agent: string;
  model: string | null;
  effort: string | null;
  outcome: "succeeded" | "failed" | null;
  observedAt: string | null;
}

/** Compact worker-list facts used by the Chat header, never a transcript. */
export interface StagePresence {
  taskId: string;
  dispatchId: string;
  liveness: "live" | "unverifiable" | "exited";
  activity: string | null;
  detail: string | null;
  outcome: string | null;
  attention: string[];
  agent: string | null;
  model: string | null;
  effort: string | null;
  observedAt: string | null;
}

/** One per-Dispatch row of the explicit Stop report. */
export interface StopResultEntry {
  target: string;
  kind: "supervised" | "legacy_terminal" | "tracking_dispatch" | "coordinator_terminal";
  result: string;
  detail: string | null;
}

/**
 * Live status of the self-driven coordinator. `phase` follows the plan §6.3
 * state machine (`recovering` is reserved for Phase 4); `inbox.pending` are
 * the questions/escalations the run is waiting on; `cleanupDebt` blocks
 * completion until resolved.
 */
export interface RunStatus {
  running: boolean;
  phase:
    | "idle"
    | "binding"
    | "running"
    | "awaiting_input"
    | "stopping"
    | "completed"
    | "recovering"
    | "error";
  /** The Run this coordinator bound itself to. */
  runId: string | null;
  /** The Orca terminal the coordinator borrows for mutating calls. */
  coordinatorHandle: string | null;
  busy: number;
  error: string | null;
  startedAt: number;
  lastTick: number;
  lastReconciledAt: number;
  completedAt: number | null;
  attempts: RunAttempt[];
  inbox: {
    pending: PendingInboxItem[];
    pendingDeliveryId: string | null;
    recent: { id: string; type: string; from: string; subject: string; createdAt: string }[];
    lastAckedDeliveryId: string | null;
  };
  cleanupDebt: CleanupDebtItem[];
  lastStopReport: { results: StopResultEntry[]; clean: boolean } | null;
  /** Dispatched tasks this coordinator never started (Phase 4 adopts them). */
  unownedDispatches: string[];
  /** What startup recovery found and did — present after every coordinator start. */
  recovery: RecoverySummaryView | null;
}

/**
 * Viewer configuration persisted server-side in `.orca-dag.config.json`
 * (workspace root) — Orca tasks have no metadata field for harness choices,
 * so the viewer keeps its own store instead of browser localStorage.
 */
export interface ViewerConfig {
  defaultHarness: string;
  harnessByTask: Record<string, string>;
  /**
   * Per-task model override. Only meaningful for harnesses that support model
   * selection (opencode via `-m`, claude/codex/cursor via `worker-start
   * --model`); empty string / absent means the agent's default model.
   */
  modelByTask: Record<string, string>;
  /** Per-task reasoning effort — only ever set alongside a model (Phase 5). */
  effortByTask: Record<string, string>;
  /**
   * Per-task retain-for-debugging: a settled worker's terminal is kept alive
   * and visible until manually released (Phase 5).
   */
  retainByTask: Record<string, boolean>;
  /** Per-task saved-environment selectors; absent/empty = local (Phase 6). */
  environmentByTask: Record<string, string>;
  /** Per-task exact placement; absent = current (Phase 6). */
  placementByTask: Record<string, PlacementSpec>;
  /** Explicit semantic lead stage for each Run; presentation metadata only. */
  leadTaskByRun: Record<string, string>;
  maxConcurrency: number;
  layout: LayoutKind | "";
  /** Last Run the user was viewing; restored on reload. */
  runId: string;
}

/**
 * Harness → model-selection capability. opencode gets an enumerable dropdown
 * (`opencode models`); claude/codex/cursor get free-text. Everything else has
 * no viewer-side model control.
 */
export type ModelPickerKind = "select" | "text" | "none";

export const MODEL_PICKER: Record<string, ModelPickerKind> = {
  opencode: "select",
  claude: "text",
  codex: "text",
  cursor: "text",
};

/**
 * Harnesses that accept `worker-start --effort` (Phase 5). Orca's contract:
 * effort requires a model, and opencode (the legacy path) has no effort flag —
 * so the effort picker renders only for these, and only when a model is set.
 */
export const EFFORT_SUPPORTED: ReadonlySet<string> = new Set(["claude", "codex", "cursor"]);

/** Common reasoning-effort levels. Orca owns the authoritative list per model. */
export const EFFORT_LEVELS = ["low", "medium", "high"] as const;

// --- Phase 6: saved environments, peer capabilities, exact placement ---------

/**
 * One exact placement choice, mirrored from server/src/config.ts. The two
 * remote-capable shapes (existing selector / new-top-level descriptor) are
 * the only ones the UI offers for a remote environment; remote `current` and
 * `new-child` are deliberately inexpressible here.
 */
export type PlacementSpec =
  | { kind: "current" }
  | { kind: "existing"; selector: string }
  | { kind: "new-top-level"; repo: string; name: string };

/** Which remote operations a peer advertised (parsed server-side). */
export interface PeerCapabilitiesView {
  modelEffort: boolean;
  transcriptRead: boolean;
  fleetSnapshot: boolean;
  /** Everything the peer advertised, verbatim (null = nothing/unknown). */
  raw: string[] | null;
}

/** One saved Orca runtime environment (GET /api/environments). */
export interface OrcaEnvironmentView {
  id: string;
  name: string;
  /** Reachability as reported; null = unknown (renders unverifiable). */
  connected: boolean | null;
  /** Advertised capability names, verbatim. */
  capabilities: string[] | null;
  version: string | null;
  /** Parsed gates the UI disables controls on. */
  peer: PeerCapabilitiesView;
}

/** One exact workspace on an environment (GET /api/environments/:id/worktrees). */
export interface OrcaWorktreeView {
  id: string;
  repoId: string | null;
  path: string | null;
  displayName: string | null;
  branch: string | null;
  hostId: string | null;
  parentWorktreeId: string | null;
  isMainWorktree: boolean | null;
}

/** One repository registered on an environment (GET /api/environments/:id/repos). */
export interface OrcaRepoView {
  id: string;
  path: string | null;
  displayName: string | null;
  kind: string | null;
  hostId: string | null;
}

/**
 * Server-side readiness probe (Phase 2): which Orca CLI was resolved, what
 * version it reports, and whether the viewer may execute at all. When
 * `executionEnabled` is false, `reason` carries the actionable explanation
 * shown by the disabled Run/gate/reset controls (e.g. Orca 1.4.160–1.4.204 is
 * view-only: execution needs 1.4.205+).
 */
export interface OrcaReadiness {
  cli: string;
  workspace: string;
  worktree: string;
  version: string | null;
  executionEnabled: boolean;
  reason: string | null;
}
