import {
  OrcaCliError,
  bindRun,
  checkInbox,
  closeTerminal,
  closeTerminalStrict,
  ensureCoordinatorTerminal,
  followableNextAction,
  getOrcaRuntime,
  listGates,
  listTasks,
  listTerminals,
  listWorkers,
  newRequestId,
  normalizeLiveness,
  normalizeTerminalReceipt,
  parseCoordinatorTitle,
  parsePeerCapabilities,
  parseWorkerDonePayload,
  readWorkerOutput,
  releaseWorker,
  replyToMessage,
  retainWorker,
  runNextAction,
  showEnvironment,
  showRun,
  startLegacyWorker,
  startSupervisedWorker,
  stopWorkerReceipt,
  taskUpdate,
  type OrcaMessage,
  type OrcaDelivery,
  type OrcaTask,
  type OrcaWorkerRow,
  type StartedWorker,
  type WorkerOutputReceipt,
  type WorkerStartReceipt,
  type WorkerTerminalReceipt,
} from "./orca";
import type { MutationRequestMeta } from "./requestLedger";
import type { PlacementSpec } from "./config";

/**
 * Self-driven coordinator (Phase 3: closed supervised-worker lifecycle).
 *
 * Orca ships no scheduler on purpose — the viewer stays the thing that walks
 * the DAG. What Phase 3 changes is everything AROUND that loop:
 *
 *  - The fixed poll sleep is gone. The loop blocks in `check --wait` on the
 *    Run inbox (wake types: worker_done/escalation/question) and reconciles
 *    tasks + worker accounting after every wake or wait timeout.
 *  - Deliveries are FIFO batches: every row is processed, and the batch is
 *    acknowledged only when every row in it — including any human question —
 *    has been handled. An unacknowledged batch replays, so message ids are
 *    deduped and side effects are idempotent.
 *  - A worker settles only on an accepted `worker_done` for the expected
 *    Dispatch or an explicit terminal task status from Orca. Heartbeats,
 *    output activity, absence, and timeouts are liveness evidence, never
 *    completion.
 *  - Every settled worker gets an ownership decision: release by default
 *    (after a best-effort output archive), retain on explicit request, or —
 *    for the legacy lane — closing the terminal this viewer provably created.
 *  - The Run completes only when the section-6.2 boundary passes: nothing
 *    ready/dispatched, every Dispatch settled, no unacknowledged Delivery,
 *    and zero `reclaimable` workers.
 *
 * Authority: mutations require a live Orca terminal bound to the Run, so the
 * coordinator owns one (`ensureCoordinatorTerminal`) and binds it on start.
 * That fences whoever was bound before — see `startCoordinator`.
 */

/** Launch preferences for one attempt (Phase 5): what we asked for vs what the runtime echoed back. */
export interface LaunchPrefs {
  agent: string | null;
  model: string | null;
  effort: string | null;
  worktree: string | null;
  terminal: string | null;
  /**
   * Saved environment the worker was placed on (Phase 6). `null` = local
   * server — the zero-configuration default, never a synthesized fallback.
   */
  on: string | null;
}

/** One in-flight (or just-settled) attempt, mirroring the Orca Dispatch. */
interface Attempt {
  taskId: string;
  harness: string;
  mode: StartedWorker["mode"];
  dispatchId: string | null;
  /** Worker terminal, ONLY when this viewer created it (legacy lane). */
  handle: string | null;
  startedAt: number;
  // --- liveness (never completion evidence) ---
  failureCount: number;
  lastHeartbeatAt: string | null;
  /** Liveness verdict as reported by the last worker-list reconciliation. */
  liveness: string | null;
  /** The runtime's own reason for the liveness verdict (Phase 5). */
  livenessReason: string | null;
  /** Fleet attention flags on the last reconciliation row (Phase 5). */
  attention: { categories: string[]; requiresAction: boolean } | null;
  /** Agent-wait evidence: stage + activity the fleet last reported (Phase 5). */
  stage: { worker: string; dispatch: string; detail: string | null; activity: string } | null;
  // --- settlement (Orca-authoritative only) ---
  settled: boolean;
  outcome: "succeeded" | "failed" | null;
  /**
   * Which Orca-authoritative evidence settled the attempt. `start_failed` is
   * Phase 4: a start that positively failed before the worker was ready —
   * settled by the receipt, not by a worker, and never auto-retried.
   */
  settledVia: "worker_done" | "task_status" | "start_failed" | null;
  settledAt: number | null;
  // --- post-settlement terminal ownership decision ---
  terminalDecision:
    | "pending" // not decided yet
    | "released"
    | "retained"
    | "closed" // legacy lane: this viewer's own terminal
    | "reused" // Phase 5: terminal transferred to exactly one follow-up Dispatch
    | "not_needed" // positively nothing to clean (start never created a resource)
    | "release_pending" // release deferred by Orca; reconciliation retries
    | "release_unknown" // ambiguous — surfaced as cleanup debt, never auto-retried
    | "close_failed"; // legacy close refused — surfaced as cleanup debt
  terminalDetail: string | null;
  releaseAttempts: number;
  /** Output tail read before release, kept for the UI. */
  output: WorkerOutputReceipt | null;
  // --- Phase 4: recovery + idempotency ---
  /** True when this attempt was adopted from Orca state at startup. */
  adopted: boolean;
  /** Durable retry-request id of the in-flight start, kept until its outcome is known. */
  startRequestId: string | null;
  /**
   * Every worker-start receipt this attempt produced (bounded history across
   * explicit retries). Failed-before-ready receipts are retained forever —
   * they are the release/retry evidence.
   */
  startReceipts: WorkerStartReceipt[];
  /** The literal nextAction argv the last worker-list reconciliation reported. */
  nextAction: { kind: string; argv: string[] } | null;
  /** Durable id carried across release_pending retries so Orca replays, not repeats. */
  releaseRequestId: string | null;
  /**
   * Bounded summary of the last terminal receipt's release-archive facts
   * (Phase 5), e.g. that a transcript archive exists. Evidence only — archive
   * presence is never treated as worker settlement; the fleet row stays
   * authoritative. Null when no receipt carried archive facts.
   */
  terminalArchive: string | null;
  /** Dispatch this attempt explicitly retries (set by the user's retry action). */
  retriedFrom: string | null;
  // --- Phase 5: launch preferences + reuse lineage ---
  /** What THIS viewer asked for at start (harness/model/effort/placement/terminal). */
  requested: LaunchPrefs;
  /**
   * What the runtime echoed back as EFFECTIVE. Null means "no receipt
   * evidence" — the UI reports unknown instead of claiming the requested
   * values were applied. Per-field nulls inside mean that field was unechoed.
   */
  effective: LaunchPrefs | null;
  /** The settled Dispatch whose terminal this attempt reused (via --terminal). */
  reuseOf: string | null;
  /** The worker terminal the fleet last reported for this Dispatch (Phase 5). */
  agentTerminalHandle: string | null;
  /** The terminal-state string Orca last reported for this Dispatch. */
  fleetTerminalState: string | null;
  /**
   * Execution host the fleet last reported for this Dispatch (Phase 6):
   * `{ kind: "local", id: "local" }` for local workers, the environment for
   * remote ones. Null = never reported — placement renders unknown, never
   * "local by assumption".
   */
  host: { kind: string; id: string } | null;
}

/** What startup recovery found and did (plan Phase 4 items 4-7), for the UI. */
export interface RecoverySummary {
  at: number;
  /** Dispatches adopted as still-active (counted against concurrency). */
  activeAdopted: string[];
  /** Positively settled Dispatches adopted with an owed ownership decision. */
  settledAdopted: string[];
  /**
   * Rows we could NOT verify (missing/none projection) — surfaced, never
   * acted on destructively.
   */
  unverifiable: string[];
  /** Already-decided rows (released/retained) left as Orca holds them. */
  leftDecided: number;
}

/** A question/escalation waiting on a human, surfaced in the InboxPanel. */
export interface PendingInboxItem {
  messageId: string;
  kind: "question" | "escalation";
  from: string;
  subject: string;
  body: string;
  createdAt: string;
  taskId: string | null;
  /** Dispatch identity from the worker payload, when the sender supplied it. */
  dispatchId?: string | null;
}

/** Work this coordinator could not finish deciding — blocks completion. */
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

/** One per-Dispatch row of the explicit Stop report (plan §7.2). */
export interface StopResultEntry {
  target: string;
  kind: "supervised" | "legacy_terminal" | "tracking_dispatch" | "coordinator_terminal";
  /** stopped | already_settled | fenced | closed | unknown */
  result: string;
  detail: string | null;
}

export interface StopReport {
  results: StopResultEntry[];
  /** True when every attempted teardown ended in a known state. */
  clean: boolean;
}

/** Options for one coordinator run; also the POST /api/run contract. */
export interface StartOpts {
  runId: string;
  harnessByTask: Record<string, string>;
  /** Per-task model override; only used when the task's harness supports one. */
  modelByTask: Record<string, string>;
  /**
   * Per-task reasoning effort (Phase 5). Only ever sent alongside a model —
   * `worker-start --effort` requires `--model`, and a reused `--terminal`
   * carries neither.
   */
  effortByTask?: Record<string, string>;
  defaultHarness: string;
  maxConcurrency: number;
  /** Worktree the coordinator terminal (and therefore `current` workers) lives in. */
  worktree: string;
  /** Per-task opt-out from automatic release (explicit debug retention). */
  retainByTask?: Record<string, boolean>;
  /**
   * Per-task saved-environment selectors (Phase 6): a task listed here starts
   * on that connected Orca server (`worker-start --on`), while the Run and
   * this coordinator stay authoritative locally. Absent = local.
   */
  environmentByTask?: Record<string, string>;
  /**
   * Per-task exact placement (Phase 6): an existing workspace selector or a
   * new-top-level descriptor. Absent = `current` (the coordinator workspace).
   * Remote `current`/`new-child` never reach Orca — the adapter refuses them.
   */
  placementByTask?: Record<string, PlacementSpec>;
  /** Inbox wait per loop iteration. Tests shrink this; production blocks ~3s. */
  tickWaitMs?: number;
  /**
   * Optional viewer-history sink. It receives only coordinator actions that
   * already succeeded in Orca; failure to persist explanatory UI history must
   * never turn a live worker into a failed or ambiguous attempt.
   */
  onActivity?: (event: CoordinatorActivityNotice) => Promise<void>;
  /**
   * Best-effort sink for meaningful check receipts. The coordinator still
   * keeps every recent pass in memory for live presence, while the viewer
   * persists only deliveries, errors/recoveries, and agent-state changes.
   */
  onCheck?: (receipt: CoordinatorCheckReceipt) => Promise<void>;
  /**
   * Durable mutation-request ledger sink (Phase 5: recovery and output audit).
   * Called BEFORE a `--retry-request`-carrying mutation is spawned (so even a
   * crash or lost response leaves the id inspectable via `request-show`) and
   * again once an outcome is observed (Dispatch/Task linkage + bounded note).
   * Metadata only — never receipts or transcript bodies. Best-effort exactly
   * like onActivity/onCheck: a ledger failure must never turn a live or
   * ambiguous mutation into a different lifecycle decision.
   */
  onRequestRecord?: (meta: MutationRequestMeta) => Promise<void>;
}

export interface CoordinatorActivityNotice {
  kind: "dispatch_started";
  runId: string;
  taskId: string;
  dispatchId: string | null;
  title: string;
  summary: string;
  detail: string;
}

/**
 * One visible receipt for the coordinator's rolling `check --wait` pass.
 *
 * Every recent pass stays in a bounded in-memory operational trace. The
 * viewer may additionally persist meaningful receipts (deliveries,
 * errors/recoveries, and agent-state changes); repetitive empty checks remain
 * memory-only so presence telemetry cannot grow into an endless transcript.
 */
/**
 * One row the checked Delivery carried. A receipt's `messageCount`/`messageTypes`
 * only summarize the batch — without this list the UI cannot expand "5 messages"
 * into the rows behind that number. Deliberately a bounded digest (id, type,
 * sender, subject, time), never the full body: check history is explanatory
 * UI state, and the conversation itself still renders from the activity feed.
 */
export interface CoordinatorCheckMessageSummary {
  id: string;
  type: string;
  from: string;
  subject: string;
  createdAt: string;
}

export interface CoordinatorCheckReceipt {
  sequence: number;
  checkedAt: number;
  durationMs: number;
  deliveryId: string | null;
  messageCount: number;
  messageTypes: string[];
  /** The individual rows this pass consumed, oldest first, bounded. */
  messages: CoordinatorCheckMessageSummary[];
  replayed: boolean;
  timedOut: boolean;
  error: string | null;
  agents: CoordinatorCheckAgentSummary[];
  /** Native viewer-loop receipt, or a check proven indirectly from durable Orca state. */
  source?: "viewer_loop" | "external_inferred";
  /** Human-readable provenance for inferred receipts; null/absent on native checks. */
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

/**
 * Coordinator phases exposed through /api/run-status (plan §6.3). `recovering`
 * belongs to Phase 4 restart recovery and is never produced yet.
 */
export type CoordinatorPhase =
  | "idle"
  | "binding"
  | "running"
  | "awaiting_input"
  | "stopping"
  | "completed"
  | "recovering"
  | "error";

interface State {
  running: boolean;
  phase: CoordinatorPhase;
  /** Set once the coordinator terminal is bound; null while starting. */
  runId: string | null;
  coordinatorHandle: string | null;
  opts: StartOpts | null;
  attempts: Map<string, Attempt>;
  startedAt: number;
  lastTick: number;
  lastReconciledAt: number;
  completedAt: number | null;
  error: string | null;
  /** FIFO Delivery awaiting full processing (a question is open in it). */
  pendingDeliveryId: string | null;
  /** The open questions/escalations inside the pending Delivery. */
  inbox: PendingInboxItem[];
  /** Message ids already side-effected — replays of the unacked batch skip them. */
  processedMessages: Set<string>;
  /**
   * TaskIds whose worker_done arrived in the still-unacknowledged Delivery.
   * The batch may not be acknowledged until each of these attempts has had its
   * terminal-ownership decision executed (plan §Phase 3 item 6), so a crash
   * between settlement and release replays the batch instead of losing the
   * ownership work.
   */
  pendingOwnership: Set<string>;
  /** Informational inbox rows (status/handoff/…) for the UI, newest first. */
  recentMessages: { id: string; type: string; from: string; subject: string; createdAt: string }[];
  lastAckedDeliveryId: string | null;
  cleanupDebt: CleanupDebtItem[];
  lastStopReport: StopReport | null;
  /** `dispatched` tasks this coordinator never started (Phase 4 adopts them). */
  unownedDispatches: string[];
  /** Last startup recovery summary (Phase 4); null when this instance never recovered. */
  recovery: RecoverySummary | null;
  /** Recent check receipts for the live Chat trace, oldest first. */
  checks: CoordinatorCheckReceipt[];
  checkSequence: number;
}

/** How long each loop iteration blocks in `check --wait` (production default). */
const CHECK_WAIT_MS = 3000;
/** Bounded retries for a `release_pending` terminal before it becomes debt. */
const RELEASE_RETRY_MAX = 40;
/** Question/escalation wake types — see `check --types` (wake filter only). */
const WAKE_TYPES = ["worker_done", "escalation", "question"];
const TERMINAL_TASK_STATUS = new Set(["completed", "failed"]);
/** Orca rejects these agents for `worker-start`; retry them the legacy way. */
const UNCONFIGURED_AGENT_CODES = new Set(["agent_unconfigured", "invalid_argument"]);
/** Keep the informational inbox log bounded. */
const RECENT_MESSAGES_MAX = 30;
/** Keep the replay-dedupe set bounded (deliveries are small; this is generous). */
const PROCESSED_MESSAGES_MAX = 2000;
/** Bounded receipt history per attempt across explicit retries (Phase 4). */
const START_RECEIPTS_MAX = 5;
/** About three minutes at the default cadence; enough context without noise. */
const CHECK_RECEIPTS_MAX = 60;
/** Per-receipt message digest bound — Deliveries are small; this is generous. */
const CHECK_MESSAGES_MAX = 20;

const state: State = {
  running: false,
  phase: "idle",
  runId: null,
  coordinatorHandle: null,
  opts: null,
  attempts: new Map(),
  startedAt: 0,
  lastTick: 0,
  lastReconciledAt: 0,
  completedAt: null,
  error: null,
  pendingDeliveryId: null,
  inbox: [],
  processedMessages: new Set(),
  pendingOwnership: new Set(),
  recentMessages: [],
  lastAckedDeliveryId: null,
  cleanupDebt: [],
  lastStopReport: null,
  unownedDispatches: [],
  recovery: null,
  checks: [],
  checkSequence: 0,
};

/** Reset every coordinator field. Test scaffolding only — never call while a loop is live. */
export function resetCoordinatorForTests(): void {
  state.running = false;
  state.phase = "idle";
  state.runId = null;
  state.coordinatorHandle = null;
  state.opts = null;
  state.attempts = new Map();
  state.startedAt = 0;
  state.lastTick = 0;
  state.lastReconciledAt = 0;
  state.completedAt = null;
  state.error = null;
  state.pendingDeliveryId = null;
  state.inbox = [];
  state.processedMessages = new Set();
  state.pendingOwnership = new Set();
  state.recentMessages = [];
  state.lastAckedDeliveryId = null;
  state.cleanupDebt = [];
  state.lastStopReport = null;
  state.unownedDispatches = [];
  state.recovery = null;
  state.checks = [];
  state.checkSequence = 0;
}

export function coordinatorStatus() {
  return {
    running: state.running,
    phase: state.phase,
    runId: state.runId,
    coordinatorHandle: state.coordinatorHandle,
    error: state.error,
    startedAt: state.startedAt,
    lastTick: state.lastTick,
    lastReconciledAt: state.lastReconciledAt,
    completedAt: state.completedAt,
    attempts: [...state.attempts.values()].map((a) => ({
      taskId: a.taskId,
      harness: a.harness,
      mode: a.mode,
      dispatchId: a.dispatchId,
      handle: a.handle,
      startedAt: a.startedAt,
      failureCount: a.failureCount,
      lastHeartbeatAt: a.lastHeartbeatAt,
      liveness: a.liveness,
      // Phase 5 fleet projection: verdict reason, attention, agent-wait
      // stage, terminal accounting, and the launch-preference pair.
      livenessReason: a.livenessReason,
      attention: a.attention,
      stage: a.stage,
      fleetTerminalState: a.fleetTerminalState,
      agentTerminalHandle: a.agentTerminalHandle,
      /** Execution host the fleet last reported (Phase 6) — local or environment. */
      host: a.host,
      requested: a.requested,
      effective: a.effective,
      reuseOf: a.reuseOf,
      settled: a.settled,
      outcome: a.outcome,
      settledVia: a.settledVia,
      settledAt: a.settledAt,
      terminalDecision: a.terminalDecision,
      terminalDetail: a.terminalDetail,
      /** Bounded release-archive facts from the last terminal receipt (Phase 5). */
      terminalArchive: a.terminalArchive,
      adopted: a.adopted,
      retriedFrom: a.retriedFrom,
      startRequestId: a.startRequestId,
      /** Latest receipt only — the full history is bounded coordinator-side. */
      startReceipt: a.startReceipts.length ? a.startReceipts[a.startReceipts.length - 1] : null,
      nextAction: a.nextAction,
      output: a.output
        ? {
            source: a.output.source,
            lines: a.output.lines.slice(-8),
            contentComplete: a.output.contentComplete,
            clipped: a.output.clipped,
            cursor: a.output.cursor,
            warnings: a.output.warnings,
            sourceChanged: a.output.sourceChanged,
          }
        : null,
    })),
    busy: [...state.attempts.values()].filter((a) => !a.settled).length,
    /**
     * The configured worker-slot budget (Phase 4 scheduler surface). null while
     * no coordinator is running: capacity is then UNKNOWN, never zero — the
     * DAG readiness projection keys off exactly this distinction.
     */
    maxConcurrency: state.opts?.maxConcurrency ?? null,
    inbox: {
      pending: [...state.inbox],
      pendingDeliveryId: state.pendingDeliveryId,
      recent: [...state.recentMessages],
      lastAckedDeliveryId: state.lastAckedDeliveryId,
    },
    cleanupDebt: [...state.cleanupDebt],
    lastStopReport: state.lastStopReport,
    unownedDispatches: [...state.unownedDispatches],
    recovery: state.recovery,
    checks: state.checks.map((receipt) => ({
      ...receipt,
      messageTypes: [...receipt.messageTypes],
      agents: receipt.agents.map((agent) => ({ ...agent, attention: [...agent.attention] })),
    })),
  };
}

/** Public read model consumed by HTTP and the activity normalizer. */
export type CoordinatorStatus = ReturnType<typeof coordinatorStatus>;

/**
 * Bind the Run and start the dispatch loop.
 *
 * Binding is the side effect worth knowing about: it fences whatever terminal
 * was coordinating this Run, so the user's agent terminal will start getting
 * `consumer_fenced` on its own mutations until it runs `run-use` again.
 */
export async function startCoordinator(opts: StartOpts): Promise<void> {
  if (state.running) return;
  state.running = true;
  state.phase = "binding";
  state.opts = opts;
  state.attempts = new Map();
  state.error = null;
  state.runId = null;
  state.completedAt = null;
  state.pendingDeliveryId = null;
  state.inbox = [];
  state.processedMessages = new Set();
  state.pendingOwnership = new Set();
  state.recentMessages = [];
  state.lastAckedDeliveryId = null;
  state.cleanupDebt = [];
  state.unownedDispatches = [];
  state.recovery = null;
  state.checks = [];
  state.checkSequence = 0;
  state.startedAt = Date.now();

  try {
    // Phase 4 restart: the crashed viewer's coordinator terminal is still
    // connected — the pane runs `sleep infinity` independently of the viewer
    // process, so a kill leaves it behind, holding this Run's coordinator
    // slot. The Run record names its coordinator handle: when that handle is
    // one of OUR main-title terminals for this workspace, it is a dead
    // incarnation of THIS Run's coordinator, not another live viewer. Taking
    // the Run over (the user explicitly started it) reclaims the slot: close
    // the stale pane so ensureCoordinatorTerminal's live-viewer conflict check
    // below cannot wedge every restart. A live second viewer for the SAME run
    // loses its authority at bindRun anyway — that fence is the documented,
    // confirmed start behavior — so this adoption creates no new exposure.
    await adoptDeadCoordinatorTerminal(opts.runId);
    const handle = await ensureCoordinatorTerminal(opts.worktree);
    // The user may have hit stop while we were creating/binding — if so the
    // stop already ran with no handle to close, so close it here ourselves.
    if (!state.running) {
      await closeTerminal(handle);
      return;
    }
    await bindRun(opts.runId, handle);
    if (!state.running) {
      await closeTerminal(handle);
      return;
    }
    state.coordinatorHandle = handle;
    state.runId = opts.runId;
    // Phase 4 item 4: reconcile task-list with scoped worker-list BEFORE
    // anything is dispatched — adopt what the previous incarnation left
    // behind, release what is positively settled, and surface what cannot be
    // verified. Only after recovery does the loop enter `running`.
    state.phase = "recovering";
    await recoverState(opts);
    if (!state.running) {
      // Stopped while recovering — stopCoordinator already reported.
      return;
    }
    state.phase = "running";
  } catch (err) {
    state.running = false;
    state.phase = "error";
    state.error = String((err as Error).message ?? err);
    throw err;
  }

  void loop();
}

/**
 * Close the previous incarnation's coordinator terminal before recovery (see
 * startCoordinator). Identification is deliberately narrow — ALL must hold:
 *   1. the Run record's `coordinator_handle` names the terminal (it held THIS
 *      Run's coordinator slot), and
 *   2. the terminal is connected, and
 *   3. its title parses as one of OUR `main` coordinator terminals scoped to
 *      THIS workspace hash.
 * Anything else (foreign instance on another Run, legacy titles, unknown
 * handles) is left strictly alone for the Phase 2 conflict machinery to
 * report. Failures propagate: wedging startup beats silently coordinating
 * next to a pane we could not reclaim.
 */
async function adoptDeadCoordinatorTerminal(runId: string): Promise<void> {
  const run = await showRun(runId);
  const stale = run?.coordinator_handle;
  if (!stale) return;
  const terminals = await listTerminals();
  const found = terminals.find((t) => t.handle === stale);
  if (!found || !found.connected) return;
  const info = parseCoordinatorTitle(found.title);
  if (!info || info.kind !== "main" || info.hash !== getWorkspaceHash()) return;
  await closeTerminalStrict(stale);
}

/** The resolved workspace hash, for coordinator-title scoping checks. */
function getWorkspaceHash(): string {
  return getOrcaRuntime().workspace.hash;
}

/**
 * Startup recovery (plan Phase 4 items 4-7): rebuild the in-memory attempt
 * projection from Orca's authoritative records before the dispatch loop is
 * allowed to place anything.
 *
 * Classification per task (worker-list rows are the terminal truth):
 *  - dispatched task + supervised row with a POSITIVE outcome projection →
 *    adopt as settled; the ownership decision (auto-release of positively
 *    reclaimable workers, retry of release_pending, debt for release_unknown)
 *    runs in the next reconciliation;
 *  - dispatched task + supervised row without a positive outcome → adopt as
 *    ACTIVE: it counts against concurrency, is reconciled like any own
 *    worker, and is never stopped/abandoned/released on a guess;
 *  - dispatched task + unsupervised row or NO row → unverifiable: surfaced in
 *    `unownedDispatches` and counted against concurrency, but never touched;
 *  - completed/failed task + undecided supervised row (reclaimable,
 *    release_pending, release_unknown, active) → adopt settled so the
 *    ownership decision executes (item 7: positively reclaimable rows are
 *    released automatically); already-decided rows (released/retained) are
 *    left exactly as Orca holds them.
 */
async function recoverState(opts: StartOpts): Promise<void> {
  const runId = opts.runId;
  // --include-remote: a crashed viewer's remote Dispatches live on their
  // connected servers; a local-only listing would misread them as lost.
  const [tasks, rows] = await Promise.all([listTasks(runId), listWorkers(runId, { includeRemote: true })]);
  const rowByDispatch = new Map(rows.map((r) => [r.dispatchId, r]));

  const summary: RecoverySummary = {
    at: Date.now(),
    activeAdopted: [],
    settledAdopted: [],
    unverifiable: [],
    leftDecided: 0,
  };

  const freshAttempt = (task: OrcaTask, harness: string): Attempt => ({
    taskId: task.id,
    harness,
    mode: "supervised",
    dispatchId: task.dispatch_id ?? null,
    handle: null,
    startedAt: Date.now(),
    failureCount: 0,
    lastHeartbeatAt: null,
    liveness: null,
    livenessReason: null,
    attention: null,
    stage: null,
    settled: false,
    outcome: null,
    settledVia: null,
    settledAt: null,
    terminalDecision: "pending",
    terminalDetail: null,
    releaseAttempts: 0,
    output: null,
    adopted: true,
    startRequestId: null,
    startReceipts: [],
    nextAction: null,
    releaseRequestId: null,
    terminalArchive: null,
    retriedFrom: null,
    requested: { agent: harness, model: null, effort: null, worktree: null, terminal: null, on: null },
    effective: null,
    reuseOf: null,
    agentTerminalHandle: null,
    fleetTerminalState: null,
    host: null,
  });

  /**
   * Seed an adopted attempt's fleet projection from the authoritative row.
   * The row is where the previous incarnation's worker truth lives: liveness
   * (+ reason), attention, agent-wait stage, the terminal handle, and — when
   * the projection carries a launch echo — the effective launch preferences.
   */
  const seedFromRow = (attempt: Attempt, row: OrcaWorkerRow): void => {
    attempt.fleetTerminalState = row.terminalState;
    attempt.agentTerminalHandle = row.agentTerminalHandle ?? null;
    attempt.liveness = normalizeLiveness(row.projection?.liveness?.verdict ?? null);
    attempt.livenessReason = row.projection?.liveness?.reason ?? null;
    attempt.attention = row.projection?.attention ?? null;
    attempt.stage = row.projection?.stage ?? null;
    attempt.nextAction = row.projection?.nextAction ?? null;
    attempt.host = row.projection?.host ?? null;
    const l = row.projection?.launch;
    if (l) {
      attempt.effective = {
        agent: l.agent ?? null,
        model: l.model ?? null,
        effort: l.effort ?? null,
        worktree: l.worktree ?? null,
        terminal: l.terminal ?? null,
        on: l.on ?? null,
      };
    }
  };

  for (const task of tasks) {
    const row = task.dispatch_id ? rowByDispatch.get(task.dispatch_id) ?? null : null;
    if (task.status === "dispatched") {
      if (!row || row.workerState !== "supervised") {
        // No verifiable supervised worker behind this Dispatch (a crashed
        // legacy lane, or a stale record). Surfacing + budget-count is all we
        // do — the process behind it, if any, is beyond our authority.
        summary.unverifiable.push(task.id);
        continue;
      }
      const outcome = projectionOutcome(row);
      if (outcome !== null) {
        // The row positively knows the attempt settled — the task row is the
        // stale one. Trust worker-list (plan §6.3) and settle the projection.
        const attempt = freshAttempt(task, opts.harnessByTask[task.id] || opts.defaultHarness);
        settleAttempt(attempt, outcome, "task_status");
        seedInheritedTerminalState(attempt, row);
        seedFromRow(attempt, row);
        state.attempts.set(task.id, attempt);
        summary.settledAdopted.push(task.id);
      } else {
        const attempt = freshAttempt(task, opts.harnessByTask[task.id] || opts.defaultHarness);
        seedFromRow(attempt, row);
        state.attempts.set(task.id, attempt);
        summary.activeAdopted.push(task.id);
      }
    } else if (task.status === "completed" || task.status === "failed") {
      if (!row || row.workerState !== "supervised") continue;
      // Only undecided ownership needs adopting; released/retained rows are
      // exactly where previous decisions left them.
      if (["released", "retained"].includes(row.terminalState)) {
        summary.leftDecided += 1;
        continue;
      }
      const attempt = freshAttempt(task, opts.harnessByTask[task.id] || opts.defaultHarness);
      settleAttempt(
        attempt,
        task.status === "completed" ? "succeeded" : "failed",
        "task_status",
      );
      seedInheritedTerminalState(attempt, row);
      // An ACTIVE terminal behind a settled task is accounting lag, not a live
      // worker to protect — but the decision still goes through the normal
      // ownership path (release), never through worker-stop.
      state.attempts.set(task.id, attempt);
      summary.settledAdopted.push(task.id);
    }
  }

  state.recovery = summary;
}

/**
 * Seed an adopted attempt's ownership decision from the terminal state Orca
 * already reported for it (plan Phase 4 item 7): a crashed viewer must not
 * auto-release a worker the previous incarnation saw answer `release_unknown`
 * (unknown stays visible for a user decision), while a deferral stays in the
 * bounded retry path. Everything else (reclaimable, active) starts at
 * `pending`, where the default release decision applies.
 */
function seedInheritedTerminalState(attempt: Attempt, row: OrcaWorkerRow): void {
  if (row.terminalState === "release_unknown") {
    attempt.terminalDecision = "release_unknown";
    attempt.terminalDetail = "inherited release_unknown from the previous coordinator";
    recordDebt(attempt, "release_unknown", attempt.terminalDetail);
  } else if (row.terminalState === "release_pending") {
    attempt.terminalDecision = "release_pending";
    attempt.terminalDetail = "inherited release_pending from the previous coordinator";
  }
}

/** The positive outcome a worker-list row claims, or null when it claims none. */
function projectionOutcome(row: OrcaWorkerRow): "succeeded" | "failed" | null {
  const o = row.projection?.outcome ?? null;
  if (o === "completed") return "succeeded";
  if (o === "failed" || o === "stopped") return "failed";
  return null;
}

/**
 * Explicit Stop (plan §Phase 3 item 10): enumerate active Dispatches, stop the
 * supervised ones, close only the terminals this viewer provably created, and
 * report EVERY outcome — stopped, already settled, fenced, closed, or unknown.
 * Never substitutes a terminal close for an uncertain supervised release, and
 * never releases on Stop: an interrupted worker is not a settled one.
 */
export async function stopCoordinator(): Promise<StopReport> {
  const wasRunning = state.running;
  state.running = false;
  if (wasRunning) state.phase = "stopping";

  const attempts = [...state.attempts.values()];
  const coordinator = state.coordinatorHandle;
  const results: StopResultEntry[] = [];

  // Phase 5: every worker-stop runs under a durable, ledger-recorded request
  // id — recorded BEFORE the call so an interrupted stop stays inspectable,
  // and closed with the observed state after. `runIdAtStop` is captured up
  // front: the state machine starts tearing itself down below.
  const runIdAtStop = state.runId;
  const stopWithAudit = async (taskId: string, dispatchId: string) => {
    const requestId = newRequestId();
    await noteRequest({
      requestId,
      operation: "worker-stop",
      runId: runIdAtStop,
      taskId,
      dispatchId,
    });
    try {
      const receipt = await stopWorkerReceipt(dispatchId, { retryRequestId: requestId });
      await noteRequest({
        requestId,
        operation: "worker-stop",
        runId: runIdAtStop,
        taskId,
        dispatchId,
        settledLocally: true,
        note: `viewer-observed stop state: ${receipt.state}`,
      });
      return receipt;
    } catch (err) {
      await noteRequest({
        requestId,
        operation: "worker-stop",
        runId: runIdAtStop,
        taskId,
        dispatchId,
        settledLocally: false,
        note: `stop failed: ${String((err as Error)?.message ?? err)}`,
      }).catch(() => {});
      throw err;
    }
  };

  for (const a of attempts) {
    if (a.dispatchId && a.mode === "supervised") {
      try {
        const receipt = await stopWithAudit(a.taskId, a.dispatchId);
        results.push({
          target: a.dispatchId,
          kind: "supervised",
          result: receipt.alreadySettled ? "already_settled" : "stopped",
          detail: receipt.warning ?? receipt.state,
        });
      } catch (err) {
        results.push({
          target: a.dispatchId,
          kind: "supervised",
          result: "unknown",
          detail: String((err as Error).message ?? err),
        });
      }
    }
    if (a.dispatchId && a.mode === "legacy") {
      // Tracking Dispatch (unsupervised): fence it so Orca's records settle,
      // but this does NOT touch its terminal process — the terminal below is
      // this viewer's own creation and is the only thing we close.
      try {
        const receipt = await stopWithAudit(a.taskId, a.dispatchId);
        results.push({
          target: a.dispatchId,
          kind: "tracking_dispatch",
          result: receipt.alreadySettled ? "already_settled" : "fenced",
          detail: receipt.warning ?? receipt.state,
        });
      } catch (err) {
        results.push({
          target: a.dispatchId,
          kind: "tracking_dispatch",
          result: "unknown",
          detail: String((err as Error).message ?? err),
        });
      }
    }
    if (a.handle) {
      try {
        await closeTerminalStrict(a.handle);
        results.push({ target: a.handle, kind: "legacy_terminal", result: "closed", detail: null });
      } catch (err) {
        results.push({
          target: a.handle,
          kind: "legacy_terminal",
          result: "unknown",
          detail: String((err as Error).message ?? err),
        });
      }
    }
  }

  if (coordinator) {
    try {
      await closeTerminalStrict(coordinator);
      results.push({
        target: coordinator,
        kind: "coordinator_terminal",
        result: "closed",
        detail: null,
      });
    } catch (err) {
      // The Run is unbound only once the pane dies; a refused close keeps the
      // user's agent fenced, so say so instead of claiming a clean stop.
      results.push({
        target: coordinator,
        kind: "coordinator_terminal",
        result: "unknown",
        detail: String((err as Error).message ?? err),
      });
    }
  }

  state.attempts = new Map();
  state.coordinatorHandle = null;
  state.pendingDeliveryId = null;
  state.inbox = [];
  state.pendingOwnership = new Set();
  state.lastStopReport = {
    results,
    clean: results.every((r) => r.result !== "unknown"),
  };
  state.phase = "idle";
  if (wasRunning && !state.lastStopReport.clean) {
    // The loop is down and workers are accounted for; surface uncertainty via
    // cleanup debt so the UI keeps showing it after the phase resets.
    state.cleanupDebt = results
      .filter((r) => r.result === "unknown")
      .map((r, i) => ({
        key: `stop-${r.target}-${i}`,
        kind: "stop_unknown" as const,
        dispatchId: r.kind === "supervised" || r.kind === "tracking_dispatch" ? r.target : null,
        handle: r.kind === "legacy_terminal" || r.kind === "coordinator_terminal" ? r.target : null,
        detail: r.detail,
      }));
  }
  return state.lastStopReport;
}

/**
 * Answer a pending question/escalation through `orchestration reply`, then
 * acknowledge the Delivery that carried it — exactly once, after the reply
 * landed. Called by POST /api/messages/:id/reply while the loop is running.
 */
export async function answerInboxItem(messageId: string, body: string): Promise<void> {
  const item = state.inbox.find((i) => i.messageId === messageId);
  if (!item) {
    throw new OrcaCliError(
      `No pending question or escalation with id ${messageId} in this coordinator's inbox.`,
      "inbox_item_not_found",
    );
  }
  const from = state.coordinatorHandle;
  if (!from || !state.running) {
    throw new OrcaCliError("Coordinator is not running; cannot reply from its terminal.", "not_running");
  }
  await replyToMessage(messageId, body, from);
  state.inbox = state.inbox.filter((i) => i.messageId !== messageId);
  await acknowledgePendingDeliveryIfResolved();
}

/**
 * Fold an out-of-band worker terminal decision (POST /api/workers/:id/release
 * or /retain resolving cleanup debt) back into the coordinator projection.
 *
 * Only a receipt with a KNOWN terminal state changes anything: a manual
 * release that Orca answers `release_unknown` keeps the debt exactly as it
 * was (the user sees the same uncertainty the coordinator did), and
 * `release_pending` hands control back to the coordinator's bounded retry
 * loop. A known state clears the decision AND every debt row for the
 * dispatch — including boundary-surfaced reclaimable rows, which no attempt
 * projection may hold.
 */
export function noteManualRelease(dispatchId: string, receiptState: string): boolean {
  const resolved =
    receiptState === "released" ||
    receiptState === "already_released" ||
    receiptState === "retained";
  for (const a of state.attempts.values()) {
    if (a.dispatchId !== dispatchId) continue;
    if (resolved) {
      a.terminalDecision = receiptState === "retained" ? "retained" : "released";
      a.terminalDetail = "resolved manually via the viewer";
    } else if (receiptState === "release_pending" && a.terminalDecision === "release_unknown") {
      // A manual attempt Orca deferred is strictly better information than
      // "unknown": track the deferral so reconciliation keeps retrying it.
      a.terminalDecision = "release_pending";
      a.terminalDetail = "manual release deferred by Orca";
    }
  }
  if (!resolved) return false;
  state.cleanupDebt = state.cleanupDebt.filter((d) => d.dispatchId !== dispatchId);
  return true;
}

/** Timer as a promise — used only by the loop's hot-spin floor below. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function briefTaskSpec(spec: string): string {
  const normalized = spec.replace(/\s+/g, " ").trim();
  if (!normalized) return "The coordinator assigned this stage without an additional brief.";
  const sentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? normalized;
  return sentence.length > 220 ? `${sentence.slice(0, 217).trimEnd()}...` : sentence;
}

async function emitCoordinatorActivity(event: CoordinatorActivityNotice): Promise<void> {
  const sink = state.opts?.onActivity;
  if (!sink) return;
  try {
    await sink(event);
  } catch {
    // The worker is already live at this point. Reclassifying that successful
    // start as failed would invite an unsafe duplicate Dispatch, so the viewer
    // journal remains deliberately best-effort and lifecycle-neutral.
  }
}

async function emitCoordinatorCheck(receipt: CoordinatorCheckReceipt): Promise<void> {
  const sink = state.opts?.onCheck;
  if (!sink) return;
  try {
    await sink(receipt);
  } catch {
    // Check history is explanatory UI state, never orchestration authority.
    // A journal failure must not stop inbox processing or worker settlement.
  }
}

/**
 * Best-effort durable record of one viewer-originated mutation request
 * (Phase 5). Called before the CLI call (mint) and after an outcome is
 * observed (linkage + bounded note). Same neutrality rules as the activity
 * journal: the ledger explains, it never decides — a write failure must not
 * reclassify an in-flight mutation.
 */
async function noteRequest(meta: MutationRequestMeta): Promise<void> {
  const sink = state.opts?.onRequestRecord;
  if (!sink) return;
  try {
    await sink(meta);
  } catch {
    // Audit metadata is never lifecycle authority; dropping a note is the
    // honest failure mode (the request id itself stays with Orca).
  }
}

/**
 * Bounded, presentational summary of a terminal receipt's `archive` facts
 * (Phase 5). Archive presence is evidence that output was preserved — it is
 * NOT worker settlement, and the fleet's terminal state stays authoritative.
 * Serialized and sliced so an unexpectedly chatty runtime cannot push an
 * unbounded receipt body through the projection.
 */
function archiveSummary(archive: Record<string, unknown> | null | undefined): string | null {
  if (!archive || typeof archive !== "object") return null;
  try {
    const json = JSON.stringify(archive);
    return json.length > 400 ? `${json.slice(0, 397)}...` : json;
  } catch {
    return null;
  }
}

function checkAgentState(receipt: CoordinatorCheckReceipt): string {
  return JSON.stringify(
    receipt.agents.map((agent) => ({
      taskId: agent.taskId,
      dispatchId: agent.dispatchId,
      liveness: agent.liveness,
      activity: agent.activity,
      detail: agent.detail,
      attention: agent.attention,
      agent: agent.agent,
      model: agent.model,
      effort: agent.effort,
      outcome: agent.outcome,
    })),
  );
}

export function shouldPersistCoordinatorCheck(
  receipt: CoordinatorCheckReceipt,
  previous: CoordinatorCheckReceipt | undefined,
): boolean {
  if (!previous) return true;
  if (receipt.messageCount > 0) return true;
  if (receipt.error !== previous.error) return true;
  return checkAgentState(receipt) !== checkAgentState(previous);
}

async function loop(): Promise<void> {
  const waitMs = state.opts?.tickWaitMs ?? CHECK_WAIT_MS;
  while (state.running) {
    const iterStart = Date.now();
    let delivery: OrcaDelivery | null = null;
    let passError: string | null = null;
    try {
      // Rolling inbox wait: block (bounded) for worker_done/escalation/question
      // mail instead of sleeping through it. Nothing pending → timedOut batch.
      delivery = await checkInbox({
        from: state.coordinatorHandle!,
        types: WAKE_TYPES,
        waitMs,
      });
      await processDelivery(delivery);
    } catch (e) {
      passError = String((e as Error).message ?? e);
      state.error = passError;
    }
    if (state.running) {
      try {
        await reconcile();
      } catch (e) {
        const detail = String((e as Error).message ?? e);
        passError = passError ? `${passError}; reconcile: ${detail}` : detail;
        state.error = detail;
      }
    }
    // Capture AFTER reconciliation so each receipt carries the freshest
    // worker-list projection the same check pass observed. A failed or empty
    // check is still recorded: both are meaningful coordinator health facts.
    const check = recordCheckReceipt(delivery, iterStart, passError);
    if (check.persist) await emitCoordinatorCheck(check.receipt);
    if (!state.running) break;
    // In production `check --wait` consumed the interval already; this floor
    // only matters when the check returned instantly (empty inbox fast path,
    // or a failed call) — without it an erroring loop would hot-spin the CLI.
    const elapsed = Date.now() - iterStart;
    if (elapsed < waitMs) await sleep(waitMs - elapsed);
  }
}

function recordCheckReceipt(
  delivery: OrcaDelivery | null,
  startedAt: number,
  error: string | null,
): { receipt: CoordinatorCheckReceipt; persist: boolean } {
  const previous = state.checks.at(-1);
  const checkedAt = Date.now();
  const receipt: CoordinatorCheckReceipt = {
    sequence: ++state.checkSequence,
    checkedAt,
    durationMs: Math.max(0, checkedAt - startedAt),
    deliveryId: delivery?.deliveryId ?? null,
    messageCount: delivery?.messages.length ?? 0,
    messageTypes: [...new Set((delivery?.messages ?? []).map((message) => message.type))],
    messages: (delivery?.messages ?? []).slice(0, CHECK_MESSAGES_MAX).map((message) => ({
      id: message.id,
      type: message.type,
      from: message.from_handle,
      subject: message.subject,
      createdAt: message.created_at,
    })),
    replayed: delivery?.replayed ?? false,
    timedOut: delivery?.timedOut ?? false,
    error,
    source: "viewer_loop",
    evidence: null,
    agents: [...state.attempts.values()].map((attempt) => ({
      taskId: attempt.taskId,
      dispatchId: attempt.dispatchId,
      liveness: normalizeLiveness(attempt.liveness),
      activity: attempt.stage?.activity ?? null,
      detail: attempt.stage?.detail ?? null,
      attention: [...(attempt.attention?.categories ?? [])],
      agent: attempt.effective?.agent ?? attempt.harness,
      model: attempt.effective?.model ?? null,
      effort: attempt.effective?.effort ?? null,
      outcome: attempt.outcome,
      observedAt: attempt.lastHeartbeatAt,
    })),
  };
  state.checks = [...state.checks, receipt].slice(-CHECK_RECEIPTS_MAX);
  return { receipt, persist: shouldPersistCoordinatorCheck(receipt, previous) };
}

/** True if this message was already handled (replayed Delivery row). */
function markProcessed(id: string): boolean {
  if (state.processedMessages.has(id)) return true;
  state.processedMessages.add(id);
  if (state.processedMessages.size > PROCESSED_MESSAGES_MAX) {
    // Drop the oldest half; deliveries replay only while unacked, so old ids
    // are long-settled by the time this trims.
    const keep = [...state.processedMessages].slice(-PROCESSED_MESSAGES_MAX / 2);
    state.processedMessages = new Set(keep);
  }
  return false;
}

/**
 * Process EVERY row of the FIFO Delivery, then acknowledge it only when
 * nothing in it still waits on a human. Side effects run once per message id
 * (the batch replays until acked). A row that fails validation is recorded
 * and skipped — it never settles a worker and never fails the whole batch.
 */
async function processDelivery(delivery: {
  deliveryId: string | null;
  messages: OrcaMessage[];
  replayed: boolean;
}): Promise<void> {
  for (const message of delivery.messages) {
    if (markProcessed(message.id)) continue;
    switch (message.type) {
      case "worker_done": {
        const settledTaskId = handleWorkerDone(message);
        if (settledTaskId && delivery.deliveryId) {
          // The batch may not be acknowledged until the ownership decision for
          // this worker has actually executed (plan §Phase 3 item 6) — an ack
          // here would let a crash between settlement and release lose the
          // release work, since the batch would never replay again.
          state.pendingOwnership.add(settledTaskId);
          state.pendingDeliveryId = delivery.deliveryId;
        }
        break;
      }
      case "question":
      case "escalation":
        {
        const payload = parseWorkerDonePayload(message);
        const payloadTaskId = payload?.taskId ?? null;
        const payloadDispatchId = payload?.dispatchId ?? null;
        const relatedAttempt = [...state.attempts.values()].find(
          (attempt) =>
            (payloadDispatchId !== null && attempt.dispatchId === payloadDispatchId) ||
            (payloadDispatchId === null && payloadTaskId !== null && attempt.taskId === payloadTaskId) ||
            (payloadDispatchId === null && payloadTaskId === null && attempt.handle === message.from_handle),
        );
        state.inbox = [
          ...state.inbox.filter((i) => i.messageId !== message.id),
          {
            messageId: message.id,
            kind: message.type,
            from: message.from_handle,
            subject: message.subject,
            body: message.body,
            createdAt: message.created_at,
            taskId: payloadTaskId ?? relatedAttempt?.taskId ?? null,
            dispatchId: payloadDispatchId ?? relatedAttempt?.dispatchId ?? null,
          },
        ];
        // Hold the Delivery open: it must not be acknowledged while a human
        // question inside it is unanswered (it replays until then).
        if (delivery.deliveryId) state.pendingDeliveryId = delivery.deliveryId;
        break;
        }
      case "heartbeat":
        noteHeartbeat(message);
        break;
      default:
        state.recentMessages = [
          {
            id: message.id,
            type: message.type,
            from: message.from_handle,
            subject: message.subject,
            createdAt: message.created_at,
          },
          ...state.recentMessages,
        ].slice(0, RECENT_MESSAGES_MAX);
        break;
    }
  }
  await acknowledgePendingDeliveryIfResolved();
}

/**
 * Acknowledge the pending Delivery exactly once, after every row in it is
 * processed AND (plan §Phase 3 item 6) every terminal-ownership decision the
 * batch owes has executed, AND no question/escalation in it is still open.
 * A stale ack (the runtime already retired the batch because a reply marked
 * its last message read) is success, not an error.
 *
 * Concurrent invocations (the loop's replay pass vs. a reply arriving through
 * the API) serialize on a promise chain that re-checks the guards, so two
 * acks for one Delivery can never race out.
 */
let ackChain: Promise<void> = Promise.resolve();
async function runAck(): Promise<void> {
  const deliveryId = state.pendingDeliveryId;
  if (!deliveryId || state.inbox.length > 0) return;
  // Ownership gate: an attempt still sitting at `pending` means its release/
  // retain/close decision has not executed yet — keep the batch open so it
  // replays if we die first. Entries whose attempt vanished (stop, reset)
  // have nothing left to wait for and are dropped.
  for (const taskId of [...state.pendingOwnership]) {
    const attempt = state.attempts.get(taskId);
    if (!attempt) {
      state.pendingOwnership.delete(taskId);
    } else if (attempt.terminalDecision === "pending") {
      return; // decision still owed — the batch keeps replaying
    }
  }
  try {
    await checkInbox({ from: state.coordinatorHandle!, ack: deliveryId });
  } catch (err) {
    const e = err as OrcaCliError;
    if (e?.code !== "stale_delivery") {
      state.error = `Failed to acknowledge delivery ${deliveryId}: ${String(e.message ?? err)}`;
      return; // retry on a later pass — the batch simply replays
    }
  }
  state.pendingDeliveryId = null;
  state.lastAckedDeliveryId = deliveryId;
  state.pendingOwnership.clear();
}
function acknowledgePendingDeliveryIfResolved(): Promise<void> {
  const run = ackChain.then(runAck, runAck);
  ackChain = run;
  return run;
}

/**
 * Validate a worker_done against the expected active Dispatch before treating
 * it as settlement (plan §Phase 3 item 4). The runtime already refuses mail
 * from non-assignee panes, so anything arriving here is authentic — what we
 * are checking is whether it is OURS, CURRENT, and UNAMBIGUOUS:
 *
 *  - unknown task/dispatch        → not ours; recorded, never settles.
 *  - duplicate for a settled row  → replay; idempotent no-op.
 *  - dispatch-id mismatch         → stale cross-task signal; never settles.
 *  - outcome other than the two   → unverifiable; never settles.
 *
 * Returns the taskId whose attempt settled (for Delivery-ack deferral), or
 * null when the row was recorded but did not settle anything.
 */
function handleWorkerDone(message: OrcaMessage): string | null {
  const payload = parseWorkerDonePayload(message);
  const payloadTask = payload?.taskId ?? null;
  const payloadDispatch = payload?.dispatchId ?? null;
  const outcome = payload?.outcome ?? null;

  let attempt: Attempt | null = null;
  if (payloadDispatch) {
    attempt = [...state.attempts.values()].find((a) => a.dispatchId === payloadDispatch) ?? null;
  }
  if (!attempt && payloadTask) attempt = state.attempts.get(payloadTask) ?? null;
  if (!attempt && !payloadTask && !payloadDispatch) {
    // Legacy-lane workers may omit payload ids; their `--from` is the terminal
    // we created, which is the only correlation key we hold.
    attempt = [...state.attempts.values()].find((a) => a.handle && a.handle === message.from_handle) ?? null;
  }

  if (!attempt) {
    noteRecent(message, "worker_done for an unknown Dispatch — not settling anything");
    return null;
  }
  if (attempt.settled) {
    // Duplicate/replayed worker_done: the whole point of idempotent handling —
    // no double release, no advancement of another task.
    noteRecent(message, "duplicate worker_done for an already settled Dispatch — ignored");
    return null;
  }
  if (payloadDispatch && attempt.dispatchId && payloadDispatch !== attempt.dispatchId) {
    noteRecent(message, "worker_done dispatch id does not match the active Dispatch — ignored");
    return null;
  }
  if (outcome !== "succeeded" && outcome !== "failed") {
    noteRecent(message, "worker_done without a verifiable outcome — not treated as completion");
    return null;
  }
  settleAttempt(attempt, outcome, "worker_done");
  return attempt.taskId;
}

/** Heartbeat = liveness evidence ONLY (hard constraint: never completion). */
function noteHeartbeat(message: OrcaMessage): void {
  const payload = parseWorkerDonePayload(message);
  const dispatchId = payload?.dispatchId ?? null;
  for (const a of state.attempts.values()) {
    if (a.settled) continue;
    if (dispatchId ? a.dispatchId === dispatchId : a.handle === message.from_handle) {
      a.lastHeartbeatAt = message.created_at;
    }
  }
}

function noteRecent(message: OrcaMessage, note: string): void {
  state.recentMessages = [
    {
      id: message.id,
      type: `${message.type} · ${note}`,
      from: message.from_handle,
      subject: message.subject,
      createdAt: message.created_at,
    },
    ...state.recentMessages,
  ].slice(0, RECENT_MESSAGES_MAX);
}

function settleAttempt(attempt: Attempt, outcome: "succeeded" | "failed", via: "worker_done" | "task_status"): void {
  attempt.settled = true;
  attempt.outcome = outcome;
  attempt.settledVia = via;
  attempt.settledAt = Date.now();
  attempt.terminalDecision = "pending";
}

/**
 * Reserve a concurrency slot for a task before its (slow, async) start runs,
 * so the next tick can never over-dispatch. `requested` launch preferences
 * are filled in by `startOne`, which knows the effective opts + reuse target.
 */
function reserveAttempt(task: OrcaTask, harness: string): Attempt {
  return {
    taskId: task.id,
    harness,
    mode: "supervised",
    dispatchId: null,
    handle: null,
    startedAt: Date.now(),
    failureCount: 0,
    lastHeartbeatAt: null,
    liveness: null,
    livenessReason: null,
    attention: null,
    stage: null,
    settled: false,
    outcome: null,
    settledVia: null,
    settledAt: null,
    terminalDecision: "pending",
    terminalDetail: null,
    releaseAttempts: 0,
    output: null,
    adopted: false,
    startRequestId: null,
    startReceipts: [],
    nextAction: null,
    releaseRequestId: null,
    terminalArchive: null,
    retriedFrom: null,
    requested: { agent: harness, model: null, effort: null, worktree: null, terminal: null, on: null },
    effective: null,
    reuseOf: null,
    agentTerminalHandle: null,
    fleetTerminalState: null,
    host: null,
  };
}

/**
 * Periodic reconciliation against Orca's authoritative records (plan §6.3):
 * task statuses drive the DAG, worker-list drives terminal accounting, and
 * settled attempts get their ownership decision executed here.
 */
async function reconcile(): Promise<void> {
  const opts = state.opts!;
  const runId = state.runId!;
  state.lastTick = Date.now();

  let tasks = await listTasks(runId);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // Release any task still `blocked` whose entry gate has already been
  // approved. Orca records the gate resolution but does NOT flip the gated
  // task out of `blocked` — and an approval done through the viewer's
  // throwaway coordinator terminal (see `asCoordinator` in app.ts) closes
  // that terminal before the unblock side-effect can land on a live consumer,
  // so the task stays `blocked` and the loop below would otherwise see zero
  // `ready` tasks and stop on the first tick. As the bound consumer (alive
  // for the whole run) we nudge it to `ready` ourselves. `rejected` gates are
  // left `blocked` — turning those into `failed` is a caller's call, not ours.
  const blocked = tasks.filter((t) => t.status === "blocked");
  if (blocked.length > 0) {
    const gates = await listGates(runId);
    const approvedTaskIds = new Set(
      gates
        .filter((g) => g.taskId && g.status === "resolved" && g.resolution === "approved")
        .map((g) => g.taskId!),
    );
    const toRelease = blocked.filter((t) => approvedTaskIds.has(t.id));
    if (toRelease.length > 0) {
      await Promise.all(
        toRelease.map((t) => taskUpdate(t.id, "ready", runId, state.coordinatorHandle!)),
      );
      tasks = await listTasks(runId);
      for (const t of tasks) byId.set(t.id, t);
    }
  }

  // Fleet-level accounting for OUR attempts: one worker-list replaces the old
  // per-attempt worker-show sweep and adds terminal state we previously had
  // no access to. Liveness refresh only — a beating heart is not a finished
  // job, and absence of a row never means exit.
  // Phase 6: --include-remote is MANDATORY for honest accounting — local-only
  // fleet state makes every remote worker read as absent, which must never
  // degrade into a synthetic local substitute or a guessed outcome. All later
  // operations (reads, stop, release) address the Dispatch ID; Orca relays
  // them to the execution host.
  const workerRows = await listWorkers(runId, { includeRemote: true });
  const rowsByDispatch = new Map(workerRows.map((r) => [r.dispatchId, r]));

  // Dispatched tasks we never started — pre-existing Dispatches from a crashed
  // viewer (Phase 4 adopts these; until then they must visibly block both the
  // budget and completion instead of being silently ignored).
  state.unownedDispatches = tasks
    .filter((t) => t.status === "dispatched" && !state.attempts.has(t.id))
    .map((t) => `${t.id}${t.dispatch_id ? ` (${t.dispatch_id})` : ""}`);

  // Unowned Dispatches still consume concurrency budget: count them so a
  // pre-existing worker cannot be double-placed over.
  const unownedCount = tasks.filter(
    (t) => t.status === "dispatched" && !state.attempts.has(t.id),
  ).length;

  // Refresh + settle + decide, one pass per attempt.
  for (const attempt of [...state.attempts.values()]) {
    const task = byId.get(attempt.taskId);
    if (!attempt.dispatchId && task?.dispatch_id) attempt.dispatchId = task.dispatch_id;
    const row = attempt.dispatchId ? rowsByDispatch.get(attempt.dispatchId) : undefined;
    // Phase 5 fleet projection refresh: liveness is NORMALIZED to the three
    // renderable verdicts (anything unknown reads unverifiable, never exited)
    // and its reason, attention, agent-wait stage, terminal handle, and
    // terminal accounting are kept verbatim for the UI. A missing row leaves
    // the last known values in place — absence is never degraded to `exited`.
    if (row) {
      attempt.fleetTerminalState = row.terminalState;
      attempt.agentTerminalHandle = row.agentTerminalHandle ?? attempt.agentTerminalHandle;
      attempt.liveness = normalizeLiveness(row.projection?.liveness?.verdict ?? null);
      attempt.livenessReason = row.projection?.liveness?.reason ?? null;
      attempt.attention = row.projection?.attention ?? null;
      attempt.stage = row.projection?.stage ?? null;
      attempt.host = row.projection?.host ?? attempt.host;
      // The start receipt may omit its normalized effective fields even when
      // Orca's durable fleet projection later reports the applied launch.
      // Fold that runtime echo into the attempt so each check receipt can name
      // the observed agent/model/effort without falling back to user intent.
      const launch = row.projection?.launch;
      if (launch) {
        attempt.effective = {
          agent: launch.agent ?? attempt.effective?.agent ?? null,
          model: launch.model ?? attempt.effective?.model ?? null,
          effort: launch.effort ?? attempt.effective?.effort ?? null,
          worktree: launch.worktree ?? attempt.effective?.worktree ?? null,
          terminal: launch.terminal ?? attempt.effective?.terminal ?? null,
          on: launch.on ?? attempt.effective?.on ?? null,
        };
      }
    } else if (attempt.requested.on) {
      // Phase 6 disconnect rule: a REMOTE Dispatch with no fleet row means the
      // execution host is not currently reporting. The Dispatch is preserved
      // exactly as it is, rendered `unverifiable` — never `exited`, never a
      // reason to stop, retry, release, or fall back to local execution.
      // Reconnection restores the row (and liveness) on a later tick. The
      // reason is overwritten UNCONDITIONALLY: the previous observation's
      // reason (e.g. the last `active`) would otherwise misdescribe the
      // disconnect.
      attempt.liveness = "unverifiable";
      attempt.livenessReason = `execution host ${attempt.requested.on} has not reported this dispatch`;
      // No row = no fleet-prescribed action; a stale argv must not be run
      // against a host we cannot currently see ("absence never earns an argv").
      attempt.nextAction = null;
    }
    // Phase 4 item 6: keep the LITERAL nextAction Orca reports. Decisions may
    // follow it only when it contains argv (see performRelease); a `none` /
    // absent nextAction is respected as "no prescribed action". A missing row
    // (local hiccup or remote disconnect) reports no action at all — absence
    // never earns an argv.
    attempt.nextAction = row?.projection?.nextAction ?? null;

    if (!attempt.settled) {
      // Orca's task status is authoritative settlement evidence: the runtime
      // only moves a task to completed/failed from an accepted worker_done or
      // its own failure handling. Missing rows/absent statuses never settle.
      if (task && TERMINAL_TASK_STATUS.has(task.status)) {
        settleAttempt(attempt, task.status === "completed" ? "succeeded" : "failed", "task_status");
      }
    }

    if (attempt.settled) {
      await decideTerminalOwnership(
        attempt,
        opts,
        tasks.filter((t) => t.status === "ready"),
      );
    }
  }

  state.lastReconciledAt = Date.now();

  // Dispatch ready tasks within the concurrency budget. Only UNSETTLED
  // attempts occupy slots — settled ones stay in the projection for their
  // receipts but no longer hold a worker. Unowned dispatched tasks count
  // against the budget too (a pre-existing worker must not be double-placed
  // over), then the completion boundary is evaluated.
  const ready = tasks.filter((t) => t.status === "ready");
  const activeAttempts = [...state.attempts.values()].filter((a) => !a.settled).length;
  const budget = Math.max(0, opts.maxConcurrency - activeAttempts - unownedCount);
  const batch = ready.filter((t) => !state.attempts.has(t.id)).slice(0, budget);
  if (batch.length === 0) {
    await evaluateCompletionBoundary(tasks);
    return;
  }
  // Reserve every slot synchronously so a slow start can't let the next
  // tick over-dispatch, then start the batch in parallel.
  const reserved = batch.map((task) => {
    const attempt = reserveAttempt(task, opts.harnessByTask[task.id] || opts.defaultHarness);
    state.attempts.set(task.id, attempt);
    return { task, attempt };
  });
  await Promise.all(reserved.map(({ task, attempt }) => startOne(task, attempt, opts, runId)));
}

/**
 * Execute the post-settlement ownership decision for one settled worker:
 * archive output → retain (explicit) or release (default) for supervised
 * workers; close THIS viewer's own terminal for legacy ones. A Phase 4
 * `start_failed` attempt releases the partial resources its receipt
 * recorded — following Orca's literal prescribed nextAction when it carries
 * argv. Failures land in cleanupDebt and block completion — they never
 * silently pass.
 */
async function decideTerminalOwnership(attempt: Attempt, opts: StartOpts, readyTasks: OrcaTask[] = []): Promise<void> {
  // A deferred release re-runs here on every reconciliation until Orca
  // settles it (bounded) or it graduates to permanent debt.
  if (attempt.terminalDecision === "release_pending") {
    attempt.releaseAttempts += 1;
    if (attempt.releaseAttempts > RELEASE_RETRY_MAX) {
      recordDebt(attempt, "release_pending", "release did not settle after repeated retries");
      return;
    }
    applyReleaseReceipt(attempt, await performRelease(attempt));
    return;
  }
  if (attempt.terminalDecision !== "pending") return; // decided (or unknown debt held)

  // Phase 4: a start that failed before the worker was ready. The receipt —
  // not a guess — decides what cleanup is owed.
  if (attempt.settledVia === "start_failed") {
    const receipt = attempt.startReceipts[attempt.startReceipts.length - 1] ?? null;
    if (attempt.dispatchId) {
      // Partial start: Orca recorded a Dispatch. Release it like any settled
      // worker — via the receipt/projection's prescribed action when present.
      applyReleaseReceipt(attempt, await performRelease(attempt));
      return;
    }
    if (receipt && receipt.residualResources) {
      // Resources were left behind but no Dispatch id lets us address them.
      // Orca's own recovery commands are the only safe way forward — surface.
      attempt.terminalDecision = "release_unknown";
      attempt.terminalDetail =
        (receipt.failedStage ? `failed at ${receipt.failedStage}; ` : "") +
        "start left residual resources without an addressable Dispatch" +
        (receipt.recoveryCommands.length
          ? ` — prescribed: ${receipt.recoveryCommands.join("; ")}`
          : "");
      recordDebt(attempt, "release_unknown", attempt.terminalDetail);
      return;
    }
    // Positively nothing was created — the cleanest failed start there is.
    attempt.terminalDecision = "not_needed";
    attempt.terminalDetail = receipt?.failedStage
      ? `start failed at ${receipt.failedStage}; nothing was created`
      : "start never created a resource";
    return;
  }

  // Archive evidence BEFORE the terminal goes away (worker-read keeps working
  // after release, but reading first is the honest order).
  if (!attempt.output) {
    try {
      attempt.output = await readWorkerOutput(attempt.dispatchId ?? attempt.handle ?? "", { limit: 40 });
    } catch (err) {
      attempt.terminalDetail = `output read failed: ${String((err as Error).message ?? err)}`;
    }
  }

  if (attempt.mode === "supervised" && !attempt.dispatchId) {
    // worker-start succeeded but its receipt carried no dispatch id: there is
    // no one to release and no way to verify anything. Debt, not a guess.
    attempt.terminalDecision = "release_unknown";
    attempt.terminalDetail = "worker-start receipt carried no dispatch id; ownership cannot be decided";
    recordDebt(attempt, "release_unknown", attempt.terminalDetail);
    return;
  }

  if (attempt.mode === "legacy") {
    // Legacy lane: the terminal was created by THIS viewer (a bare shell we
    // spawned), so closing it is the one proven action. The tracking Dispatch
    // is unsupervised — worker-release on it records `retained` with no
    // process action, which is the durable no-op decision the boundary wants
    // on file; anything else it reports is kept as detail, never as a blocker.
    if (attempt.dispatchId) {
      const receipt = await releaseWorker(attempt.dispatchId);
      if (
        receipt.state !== "retained" &&
        receipt.state !== "released" &&
        receipt.state !== "already_released"
      ) {
        attempt.terminalDetail =
          `tracking dispatch release reported ${receipt.state}` +
          (receipt.reason ? `: ${receipt.reason}` : "");
      }
    }
    try {
      await closeTerminalStrict(attempt.handle!);
      attempt.terminalDecision = "closed";
    } catch (err) {
      attempt.terminalDecision = "close_failed";
      attempt.terminalDetail = `terminal close refused: ${String((err as Error).message ?? err)}`;
      recordDebt(attempt, "close_failed", attempt.terminalDetail);
    }
    return;
  }

  // Supervised: explicit retain wins first (Phase 5 retain-for-debugging —
  // a retained terminal is the user's inspection session: it is never
  // released AND never handed to a follow-up), then one immediate compatible
  // reuse, then the default release.
  if (opts.retainByTask?.[attempt.taskId]) {
    const receipt = await retainWorker(attempt.dispatchId!);
    if (receipt.state === "release_unknown") {
      attempt.terminalDecision = "release_unknown";
      attempt.terminalDetail = receipt.reason;
      recordDebt(attempt, "release_unknown", receipt.reason);
    } else {
      attempt.terminalDecision = "retained";
      attempt.terminalDetail = receipt.warning ?? receipt.reason;
    }
    return;
  }

  // Phase 5: reuse this settled terminal for ONE immediate compatible
  // follow-up, started via `worker-start --terminal <handle>` right here —
  // BEFORE the delivery that carried the worker_done is acknowledged (the
  // ack gate holds the batch open while terminalDecision is "pending", and
  // the start below is awaited to completion first). Compatibility is
  // deliberately narrow — reuse must not weaken the Phase 3/4 lifecycle:
  //   * the terminal runs ONE agent TUI, so the follow-up's effective
  //     harness must match, and the terminal handle must actually be known;
  //   * the CLI cannot combine --terminal with --model/--effort, so any
  //     model request (effort rides only with a model) forces a fresh start;
  //   * the follow-up must use the same placement the terminal lives in
  //     (Phase 6: both sides must be provably the coordinator-local `current`
  //     workspace with no environment — remote terminals and remote/exact
  //     placements are never reuse candidates, see the filter below);
  //   * at most one candidate: ownership transfers to EXACTLY one new
  //     Dispatch, and the reused terminal is never closed or released.
  const handle = attempt.agentTerminalHandle;
  // Phase 6: reuse requires PROVEN identical placement on both sides. The
  // settled terminal lives in exactly one workspace on exactly one server —
  // a remote-placed worker's terminal lives on its execution host (this
  // viewer never substitutes a remote handle), and a follow-up pinned to a
  // different workspace or environment cannot inherit it. `current`-local on
  // both sides is the only placement this viewer can prove identical, so it
  // is the only one reuse considers.
  const placementCurrent = (attempt.requested?.worktree ?? "current") === "current";
  const settledLocal = !attempt.requested?.on;
  if (handle && placementCurrent && settledLocal) {
    const candidate = readyTasks.find((t) => {
      if (state.attempts.has(t.id)) return false; // already attempted/parked
      const harness = opts.harnessByTask[t.id] || opts.defaultHarness;
      if (harness !== attempt.harness) return false; // different agent → fresh
      if (opts.modelByTask[t.id]) return false; // model/effort → fresh terminal
      // Phase 6: a follow-up pinned to another workspace or a saved
      // environment needs its own worker — it must not inherit this terminal.
      if (opts.environmentByTask?.[t.id]) return false;
      const candidatePlacement = opts.placementByTask?.[t.id] ?? ({ kind: "current" } as PlacementSpec);
      if (candidatePlacement.kind !== "current") return false;
      return true;
    });
    if (candidate) {
      const next = reserveAttempt(candidate, attempt.harness);
      next.reuseOf = attempt.dispatchId;
      next.agentTerminalHandle = handle;
      state.attempts.set(candidate.id, next);
      await startOne(candidate, next, opts, state.runId!, null, handle);
      if (next.settledVia === "start_failed") {
        const receipt = next.startReceipts[next.startReceipts.length - 1] ?? null;
        if (receipt?.failedStage === "response_lost") {
          // Ambiguous reuse start: whether the terminal changed hands is
          // UNKNOWN. Releasing it could kill a landed worker — Phase 4's
          // rule stands: surface debt, decide by hand, never guess.
          attempt.terminalDecision = "release_unknown";
          attempt.terminalDetail =
            "reuse start outcome unknown — the terminal may belong to the new Dispatch; resolve manually";
          recordDebt(attempt, "release_unknown", attempt.terminalDetail);
        } else {
          // Definite failed start: the terminal was never consumed, so the
          // normal default (release) applies to the still-settled worker.
          applyReleaseReceipt(attempt, await performRelease(attempt));
        }
      } else {
        attempt.terminalDecision = "reused";
        attempt.terminalDetail = `terminal transferred to dispatch ${next.dispatchId ?? "?"} (task ${candidate.id}) before delivery ack`;
      }
      return;
    }
  }

  applyReleaseReceipt(attempt, await performRelease(attempt));
}

/**
 * Release a settled worker's terminal, honoring the plan's nextAction rule
 * (Phase 4 item 6): when the authoritative projection prescribes a literal
 * worker-release argv, run EXACTLY that; otherwise issue worker-release under
 * a durable retry-request id that is RETAINED across release_pending retries
 * so Orca replays the request instead of repeating it. `worker-abandon` is
 * deliberately absent from the auto paths — abandoning is never automatic.
 */
async function performRelease(attempt: Attempt): Promise<WorkerTerminalReceipt> {
  const argv = followableNextAction(attempt.nextAction);
  if (argv && argv[1] === "worker-release" && argv.includes("--dispatch")) {
    try {
      const result = (await runNextAction(argv)) as Record<string, unknown>;
      if (result && typeof result === "object") {
        return normalizeTerminalReceipt(result, attempt.releaseRequestId);
      }
    } catch {
      // The prescribed argv failed — fall through to the direct call below so
      // the answer still lands in a typed receipt instead of an exception.
    }
  }
  if (!attempt.dispatchId) {
    // Nothing addressable — caller paths ensure this is handled, but keep the
    // typed shape honest rather than releasing an empty id.
    return {
      dispatchId: "",
      state: "release_unknown",
      reason: "no dispatch id to release",
      processAction: null,
      warning: null,
      archive: null,
      requestId: attempt.releaseRequestId,
    };
  }
  // Phase 5: mint + persist the durable id BEFORE the CLI call, so even a
  // lost release response (or a crash mid-call) leaves the id inspectable
  // via `request-show` from the ledger. The id is then RETAINED across
  // release_pending retries: replaying the SAME request is idempotent;
  // minting a new one each tick would pile up mutations.
  if (!attempt.releaseRequestId) attempt.releaseRequestId = newRequestId();
  await noteRequest({
    requestId: attempt.releaseRequestId,
    operation: "worker-release",
    runId: state.runId,
    taskId: attempt.taskId,
    dispatchId: attempt.dispatchId,
  });
  const receipt = await releaseWorker(attempt.dispatchId, {
    retryRequestId: attempt.releaseRequestId,
  });
  // Keep the id for release_pending retries: replaying the SAME request is
  // idempotent; minting a new one each tick would pile up mutations.
  attempt.releaseRequestId = receipt.requestId ?? attempt.releaseRequestId;
  await noteRequest({
    requestId: attempt.releaseRequestId,
    operation: "worker-release",
    runId: state.runId,
    taskId: attempt.taskId,
    dispatchId: attempt.dispatchId,
    settledLocally: receipt.state !== "release_unknown",
    note: `viewer-observed terminal state: ${receipt.state}`,
  });
  return receipt;
}

function applyReleaseReceipt(
  attempt: Attempt,
  receipt: { state: string; reason: string | null; archive?: Record<string, unknown> | null },
): void {
  // Archive facts ride along as bounded evidence (Phase 5) — presence is
  // never upgraded into "the worker is settled"; the state switch below and
  // the fleet row stay the only authority for that.
  attempt.terminalArchive = archiveSummary(receipt.archive) ?? attempt.terminalArchive;
  switch (receipt.state) {
    case "released":
    case "already_released":
      attempt.terminalDecision = "released";
      attempt.terminalDetail = null;
      clearAttemptDebt(attempt); // a settled release resolves any earlier debt
      break;
    case "retained":
      // Includes unsupervised tracking dispatches (no owned resource).
      attempt.terminalDecision = "retained";
      attempt.terminalDetail = receipt.reason;
      clearAttemptDebt(attempt);
      break;
    case "release_pending":
      attempt.terminalDecision = "release_pending";
      attempt.terminalDetail = receipt.reason;
      break;
    case "release_unknown":
    default:
      attempt.terminalDecision = "release_unknown";
      attempt.terminalDetail = receipt.reason;
      recordDebt(attempt, "release_unknown", receipt.reason);
      break;
  }
}

/** Drop this attempt's cleanup-debt rows (a settled decision resolves them). */
function clearAttemptDebt(attempt: Attempt): void {
  state.cleanupDebt = state.cleanupDebt.filter((d) => d.dispatchId !== attempt.dispatchId);
}

function recordDebt(
  attempt: Attempt,
  kind: "release_unknown" | "release_pending" | "close_failed",
  detail: string | null,
): void {
  const key = `${kind}:${attempt.dispatchId ?? attempt.handle}`;
  state.cleanupDebt = [
    ...state.cleanupDebt.filter((d) => d.key !== key),
    {
      key,
      kind,
      dispatchId: attempt.dispatchId,
      handle: attempt.handle,
      detail,
    },
  ];
}

/**
 * The section-6.2 completion boundary. The Run is complete only when every
 * clause passes; anything less keeps the loop alive in `running` (or parks it
 * in `awaiting_input` when the blocker is a human decision).
 */
async function evaluateCompletionBoundary(tasks: OrcaTask[]): Promise<void> {
  const runId = state.runId!;
  const unsettled = [...state.attempts.values()].filter((a) => !a.settled);
  const undecided = [...state.attempts.values()].filter(
    (a) =>
      a.settled &&
      !["released", "retained", "closed", "not_needed", "reused"].includes(a.terminalDecision),
  );
  // A start that failed before ready leaves its task `ready` in Orca — but the
  // plan removes auto-retry, so that task is PARKED pending an explicit user
  // decision (retry or rebuild). It must not read as work the loop can still
  // place, or the boundary would wait on a dispatch that can never happen.
  const parked = new Set(
    [...state.attempts.values()].filter((a) => a.settledVia === "start_failed").map((a) => a.taskId),
  );
  const readyOrDispatched = tasks.filter(
    (t) => (t.status === "ready" || t.status === "dispatched") && !parked.has(t.id),
  );

  // A question/escalation still open → human input owed, not completion.
  if (state.inbox.length > 0 || state.pendingDeliveryId) {
    state.phase = "awaiting_input";
    return;
  }
  // Ambiguous cleanup (release_unknown / close_failed / overdue pending).
  if (state.cleanupDebt.length > 0 || undecided.length > 0) {
    state.phase = "awaiting_input";
    return;
  }
  // Phase 4: a failed-before-ready start is parked pending an explicit user
  // decision (retry / rebuild) — the run may neither re-place it (no auto
  // retry) nor claim completion while one of its tasks never ran.
  if (parked.size > 0) {
    state.phase = "awaiting_input";
    return;
  }
  if (readyOrDispatched.length > 0 || unsettled.length > 0) {
    state.phase = "running";
    return;
  }

  // Boundary clause 4: the runtime itself must report zero reclaimable
  // workers. Trust the fleet query, not our cache. Debt rows surfaced by a
  // PREVIOUS pass for workers that have since been released (manually, or via
  // the CLI) are pruned here — a stale debt entry must not block completion
  // forever.
  try {
    // --include-remote: a remote worker whose execution host still owes a
    // release blocks completion exactly like a local one would.
    const reclaimable = await listWorkers(runId, { terminalState: "reclaimable", includeRemote: true });
    const reclaimableIds = new Set(reclaimable.map((r) => r.dispatchId));
    state.cleanupDebt = state.cleanupDebt.filter(
      (d) => d.kind !== "reclaimable" || (d.dispatchId !== null && reclaimableIds.has(d.dispatchId)),
    );
    if (reclaimable.length > 0) {
      state.phase = "awaiting_input";
      state.cleanupDebt = [
        ...state.cleanupDebt,
        ...reclaimable
          .filter((r) => !state.cleanupDebt.some((d) => d.dispatchId === r.dispatchId))
          .map((r) => ({
            key: `reclaimable:${r.dispatchId}`,
            kind: "reclaimable" as const,
            dispatchId: r.dispatchId,
            handle: null,
            detail: `worker-list still reports reclaimable (state: ${r.terminalState})`,
          })),
      ];
      return;
    }
  } catch (err) {
    state.error = `reclaimable worker check failed: ${String((err as Error).message ?? err)}`;
    state.phase = "awaiting_input";
    return;
  }

  // Every clause passed. Close the coordinator terminal — clause 6 wants the
  // close verified or its error surfaced, never assumed.
  state.phase = "completed";
  state.completedAt = Date.now();
  state.running = false;
  const coordinator = state.coordinatorHandle;
  state.coordinatorHandle = null;
  if (coordinator) {
    try {
      await closeTerminalStrict(coordinator);
    } catch (err) {
      state.cleanupDebt = [
        ...state.cleanupDebt,
        {
          key: `coordinator-close:${coordinator}`,
          kind: "coordinator_close_failed",
          dispatchId: null,
          handle: coordinator,
          detail: String((err as Error).message ?? err),
        },
      ];
    }
  }
}

async function startOne(
  task: OrcaTask,
  attempt: Attempt,
  opts: StartOpts,
  runId: string,
  retryOf: string | null = null,
  reuseTerminal?: string,
): Promise<void> {
  const from = state.coordinatorHandle!;
  // Phase 4 item 2: one durable retry-request id per mutation, retained on the
  // attempt until the outcome is known — a lost response is resolved through
  // request-show with this exact id (never a blind second start).
  const startRequestId = newRequestId();
  attempt.startRequestId = startRequestId;
  attempt.retriedFrom = retryOf;
  // Phase 5: persist the request id BEFORE the CLI call — after a response
  // loss or a viewer restart this ledger row is the only local pointer to
  // the exact id `request-show` needs. Dispatch/Task linkage is appended
  // once an outcome is observed below.
  await noteRequest({
    requestId: startRequestId,
    operation: "worker-start",
    runId,
    taskId: task.id,
    dispatchId: null,
  });
  // Phase 6: resolve placement BEFORE touching Orca. A task with a saved
  // environment starts on that connected server (`--on`, worker-start only);
  // its exact placement is an existing workspace selector or a new-top-level
  // descriptor. Everything absent = local/current — the zero-configuration
  // default, byte-identical to the pre-Phase-6 wire shape.
  const environment = opts.environmentByTask?.[task.id] ?? null;
  const placement: PlacementSpec = opts.placementByTask?.[task.id] ?? { kind: "current" };
  const placementArgs: { worktree?: string; repo?: string; name?: string } =
    placement.kind === "existing"
      ? { worktree: placement.selector }
      : placement.kind === "new-top-level"
        ? { worktree: "new-top-level", repo: placement.repo, name: placement.name }
        : {};
  // Phase 5: record what THIS start asks for — the "requested" half of the
  // requested/effective pair the UI displays. Effort only ever rides with a
  // model (`--effort requires --model`), so it is normalized here too.
  const model = opts.modelByTask[task.id] ?? null;
  attempt.requested = {
    agent: attempt.harness,
    model,
    effort: model ? opts.effortByTask?.[task.id] ?? null : null,
    worktree: placementArgs.worktree ?? "current",
    terminal: reuseTerminal ?? null,
    on: environment,
  };
  try {
    // Phase 6 capability gate: remote model/effort forwarding happens ONLY
    // when the peer advertises it. The environment row is re-inspected per
    // start (a reconnect can restore capabilities; a vanished environment
    // must surface, never silently fall back to local). An unproven
    // capability is treated as absent: the start FAILS with its reason on
    // record — dropping the override silently would make "requested" lie
    // about what was launched. These refusals are thrown INSIDE the try so
    // they land as retained start_failed records (no auto-retry), exactly
    // like every other failed start.
    if (environment) {
      let caps: ReturnType<typeof parsePeerCapabilities> | null = null;
      try {
        caps = parsePeerCapabilities((await showEnvironment(environment))?.capabilities ?? null);
      } catch (err) {
        throw new OrcaCliError(
          `Cannot start task ${task.id} on environment "${environment}": the environment could not be ` +
            `inspected (${String((err as Error).message ?? err)}). Capabilities are unproven — no ` +
            `local fallback is attempted.`,
          "environment_unavailable",
        );
      }
      if (!caps) {
        throw new OrcaCliError(
          `Cannot start task ${task.id} on environment "${environment}": the environment is not saved ` +
            `on this server. Re-discover it (orca environment list) or clear the node's environment.`,
          "environment_unknown",
        );
      }
      if (!caps.modelEffort && model) {
        throw new OrcaCliError(
          `Cannot start task ${task.id} on environment "${environment}": the peer does not advertise ` +
            `the model/effort capability (advertised: ${caps.raw?.join(", ") || "nothing"}). Remove the ` +
            `model/effort override for this node or update the remote Orca.`,
          "capability_not_advertised",
        );
      }
    }
    let started: StartedWorker;
    // opencode's TUI does not reliably accept `worker-start`'s injected
    // preamble (orca #9951) even though orca recognizes it as an agent — the
    // app opens with no prompt and never runs. Route it straight through the
    // legacy path, which runs `opencode run --auto` in a bare shell instead of
    // pasting into the TUI (verified 2026-08-10). The tracking Dispatch it
    // mints stays marked unsupervised — see decideTerminalOwnership.
    // Phase 6: the legacy path creates a LOCAL terminal in the coordinator
    // worktree — it can never honor a remote environment. Refuse instead of
    // silently executing "remotely requested" work locally (that would be the
    // synthetic local fallback the plan forbids).
    if (attempt.harness === "opencode") {
      if (environment) {
        throw new OrcaCliError(
          `Cannot start task ${task.id} on environment "${environment}": the ${attempt.harness} ` +
            `harness runs through the viewer's local legacy path and cannot honor remote placement. ` +
            `Pick a supervised harness (claude/codex/…) for remote nodes.`,
          "remote_legacy_unsupported",
        );
      }
      started = await startLegacyWorker({
        taskId: task.id,
        harness: attempt.harness,
        runId,
        from,
        worktree: opts.worktree,
        model,
        // Record the terminal the moment it exists so a later failed step can
        // still close the pane we provably created (no orphaned resources).
        onHandle: (handle) => {
          attempt.handle = handle;
        },
      });
    } else {
      try {
        started = await startSupervisedWorker({
          taskId: task.id,
          agent: attempt.harness,
          runId,
          from,
          // Phase 6: exact placement (selector or new-top-level) rides to the
          // adapter, which re-validates the remote current/new-child refusal
          // as the last gate before the CLI.
          worktree: placementArgs.worktree,
          repo: placementArgs.repo,
          name: placementArgs.name,
          on: environment ?? undefined,
          model: model ?? undefined,
          // Phase 5: per-task effort (model-gated) and terminal reuse are
          // mutually exclusive by the CLI's own contract — the adapter
          // refuses the combination, and the reuse candidate filter above
          // already excludes model-carrying follow-ups.
          effort: attempt.requested.effort ?? undefined,
          terminal: reuseTerminal,
          retryRequestId: startRequestId,
          retryOf: retryOf ?? undefined,
        });
      } catch (err) {
        // A harness Orca doesn't know as a configured TUI agent (or a custom
        // command) can't go through worker-start — compose it by hand instead.
        // Phase 6: never for a remote placement — the legacy fallback would
        // run the task on the LOCAL server behind the user's back.
        const code = (err as OrcaCliError).code;
        if (environment || !code || !UNCONFIGURED_AGENT_CODES.has(code)) throw err;
        started = await startLegacyWorker({
          taskId: task.id,
          harness: attempt.harness,
          runId,
          from,
          worktree: opts.worktree,
          model,
          onHandle: (handle) => {
            attempt.handle = handle;
          },
        });
      }
    }
    attempt.mode = started.mode;
    attempt.dispatchId = started.dispatchId;
    attempt.handle = started.handle;
    if (started.receipt) {
      attempt.startReceipts.push(started.receipt);
      if (attempt.startReceipts.length > START_RECEIPTS_MAX) {
        attempt.startReceipts = attempt.startReceipts.slice(-START_RECEIPTS_MAX);
      }
      // Phase 5: the receipt's echo is the only honest source for the
      // "effective" launch preferences — a preference the runtime did not
      // echo stays unknown rather than being assumed applied.
      const e = started.receipt.effective;
      attempt.effective = {
        agent: e.agent,
        model: e.model,
        effort: e.effort,
        worktree: e.worktree,
        terminal: e.terminal,
        on: e.on,
      };
    }
    attempt.startRequestId = null; // outcome known — the id is no longer pending
    await noteRequest({
      requestId: startRequestId,
      operation: "worker-start",
      runId,
      taskId: task.id,
      dispatchId: attempt.dispatchId,
      settledLocally: true,
      note: attempt.dispatchId
        ? `landed as dispatch ${attempt.dispatchId}`
        : "start outcome recorded without a dispatch id",
    });
    const taskSpec = typeof task.spec === "string" ? task.spec : "";
    await emitCoordinatorActivity({
      kind: "dispatch_started",
      runId,
      taskId: task.id,
      dispatchId: attempt.dispatchId,
      title: "Assigned this stage",
      summary: briefTaskSpec(taskSpec),
      detail: taskSpec,
    });
  } catch (err) {
    // Phase 4 item 8: the old "delete the attempt and retry next tick" behavior
    // is GONE. A failed start stays in the projection with its receipt — the
    // user retries explicitly (retryWorker), and nothing is re-placed behind
    // their back.
    const startErr = err as { receipt?: WorkerStartReceipt; code?: string | null; message?: string };
    attempt.startRequestId = null; // the start's outcome IS now known: failed
    if (startErr.receipt) {
      attempt.startReceipts.push(startErr.receipt);
      if (attempt.startReceipts.length > START_RECEIPTS_MAX) {
        attempt.startReceipts = attempt.startReceipts.slice(-START_RECEIPTS_MAX);
      }
      if (startErr.receipt.dispatchId && !attempt.dispatchId) {
        attempt.dispatchId = startErr.receipt.dispatchId;
      }
    }
    attempt.settled = true;
    attempt.outcome = "failed";
    attempt.settledVia = "start_failed";
    attempt.settledAt = Date.now();
    attempt.terminalDecision = "pending"; // ownership decided from the receipt
    attempt.terminalDetail = startErr.message ?? String(err);
    // Phase 5: close the ledger row with what the viewer actually observed.
    // A `response_lost` stage means the outcome stayed UNRESOLVED — the row
    // is exactly the audit trail for reconstructing it via request-show.
    const responseLost = startErr.receipt?.failedStage === "response_lost";
    await noteRequest({
      requestId: startRequestId,
      operation: "worker-start",
      runId,
      taskId: task.id,
      dispatchId: attempt.dispatchId ?? startErr.receipt?.dispatchId ?? null,
      settledLocally: !responseLost,
      note: responseLost
        ? "response lost — outcome unresolved; inspect with request-show"
        : `failed before ready${
            startErr.receipt?.failedStage ? ` at ${startErr.receipt.failedStage}` : ""
          } — receipt retained`,
    });
    if (attempt.handle) {
      // A legacy-lane start can fail after creating its terminal. The pane is
      // provably ours — close it; a refusal becomes cleanup debt, not silence.
      try {
        await closeTerminalStrict(attempt.handle);
        attempt.terminalDecision = "not_needed";
      } catch (closeErr) {
        attempt.terminalDecision = "close_failed";
        attempt.terminalDetail = `terminal close refused after failed start: ${String(
          (closeErr as Error).message ?? closeErr,
        )}`;
        recordDebt(attempt, "close_failed", attempt.terminalDetail);
      }
    }
    state.recentMessages = [
      {
        id: `start_failed:${attempt.taskId}:${Date.now()}`,
        type: `start_failed · receipt retained, no auto-retry`,
        from: "coordinator",
        subject: startErr.message ?? String(err),
        createdAt: new Date().toISOString(),
      },
      ...state.recentMessages,
    ].slice(0, RECENT_MESSAGES_MAX);
    // Infrastructure-level failures (CLI missing etc.) additionally surface in
    // the global error line; receipt-bearing failures stay on the attempt.
    if (!startErr.receipt) {
      state.error = `Failed to start task ${task.id}: ${startErr.message ?? String(err)}`;
    }
  }
}

/**
 * Explicit retry (Phase 4 item 9): re-place ONE attempt whose failure is
 * POSITIVE — a failed-before-ready start (its receipt is the positive
 * evidence, there is provably no worker) or a Dispatch Orca itself reports
 * failed/stopped. Everything ambiguous refuses:
 *
 *  - an unsettled (still active) attempt, or one with unverifiable liveness;
 *  - an attempt with open cleanup debt (release_unknown/pending) — resolve the
 *    terminal first, retrying on top would orphan it;
 *  - any Orca-side evidence of a live Dispatch for the task.
 *
 * The retry repeats the task's harness, model, effort (via StartOpts) and
 * placement, carries `--retry-of <old dispatch>` lineage when a Dispatch
 * exists, and runs under a fresh durable retry-request id.
 */
export async function retryWorker(idOrTask: string): Promise<{
  taskId: string;
  dispatchId: string | null;
  retriedFrom: string | null;
}> {
  if (!state.running || !state.coordinatorHandle || !state.opts || !state.runId) {
    throw new OrcaCliError(
      "Coordinator is not running — start the Run before retrying an attempt.",
      "not_running",
    );
  }
  const opts = state.opts;
  const runId = state.runId;

  // Find the target: by dispatch id (current, receipt-recorded, or retried-from)
  // or directly by task id.
  let attempt = [...state.attempts.values()].find(
    (a) =>
      a.dispatchId === idOrTask ||
      a.startReceipts.some((r) => r.dispatchId === idOrTask) ||
      a.retriedFrom === idOrTask,
  );
  if (!attempt && state.attempts.has(idOrTask)) attempt = state.attempts.get(idOrTask);
  if (!attempt) {
    throw new OrcaCliError(
      `No attempt matching ${idOrTask} in this coordinator's projection.`,
      "retry_target_not_found",
    );
  }

  // --- positive-failure gate (the "safe" in safe retry) ---
  if (!attempt.settled || attempt.outcome !== "failed") {
    throw new OrcaCliError(
      `Refusing to retry ${attempt.taskId}: the attempt is not positively failed ` +
        `(settled=${attempt.settled}, outcome=${attempt.outcome ?? "none"}). ` +
        `Stop it explicitly first if it is still running.`,
      "retry_not_allowed",
    );
  }
  if (attempt.liveness === "unverifiable") {
    throw new OrcaCliError(
      `Refusing to retry ${attempt.taskId}: worker liveness is unverifiable. ` +
        `Resolve the worker's state through Orca first.`,
      "retry_not_allowed",
    );
  }
  if (state.cleanupDebt.some((d) => d.dispatchId && d.dispatchId === attempt.dispatchId)) {
    throw new OrcaCliError(
      `Refusing to retry ${attempt.taskId}: cleanup debt is open for its Dispatch. ` +
        `Resolve the terminal ownership (release/retain) first.`,
      "retry_not_allowed",
    );
  }

  // Orca-side verification: worker-list is authoritative. A live Dispatch for
  // this task (ours or otherwise — local or on a connected server) must never
  // be double-placed over.
  const rows = await listWorkers(runId, { includeRemote: true });
  const liveRow = rows.find(
    (r) =>
      r.taskId === attempt.taskId &&
      r.dispatchStatus === "dispatched" &&
      r.workerState === "supervised",
  );
  if (liveRow) {
    throw new OrcaCliError(
      `Refusing to retry ${attempt.taskId}: worker-list reports a live Dispatch ` +
        `(${liveRow.dispatchId}) for the task.`,
      "retry_not_allowed",
    );
  }

  const tasks = await listTasks(runId);
  const task = tasks.find((t) => t.id === attempt.taskId);
  if (!task) {
    throw new OrcaCliError(`Task ${attempt.taskId} no longer exists in Run ${runId}.`, "task_not_found");
  }
  if (task.status === "dispatched") {
    throw new OrcaCliError(
      `Refusing to retry ${attempt.taskId}: Orca reports the task as dispatched.`,
      "retry_not_allowed",
    );
  }

  // Reset the attempt in place: receipts are RETAINED (bounded history), the
  // attempt goes back to active, and the start re-runs with --retry-of lineage.
  const retryOf = attempt.dispatchId;
  attempt.settled = false;
  attempt.outcome = null;
  attempt.settledVia = null;
  attempt.settledAt = null;
  attempt.terminalDecision = "pending";
  attempt.terminalDetail = null;
  attempt.releaseAttempts = 0;
  attempt.output = null;
  attempt.nextAction = null;
  attempt.releaseRequestId = null;
  attempt.terminalArchive = null;
  attempt.dispatchId = null;
  // Phase 5: a retry is a FRESH start — the old launch echo, reuse lineage,
  // and fleet projection of the dead attempt do not carry over. `requested`
  // is rebuilt by startOne from the (unchanged) opts.
  attempt.effective = null;
  attempt.reuseOf = null;
  attempt.agentTerminalHandle = null;
  attempt.fleetTerminalState = null;
  attempt.host = null;
  attempt.livenessReason = null;
  attempt.liveness = null;
  attempt.attention = null;
  attempt.stage = null;
  await startOne(task, attempt, opts, runId, retryOf);
  return { taskId: attempt.taskId, dispatchId: attempt.dispatchId, retriedFrom: retryOf };
}
