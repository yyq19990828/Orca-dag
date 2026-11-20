import { isAbsolute, normalize } from "node:path";
import {
  OrcaCliError,
  listGates,
  listTasks,
  listTerminals,
  listWorkers,
  newRequestId,
  runOrca,
  showRequest,
  showWorkerDetail,
  ordinaryGateApproved,
  startSupervisedWorker,
  type OrcaTask,
  type OrcaWorkerRow,
  type StartedWorker,
  type WorkerDetailView,
} from "./orca";
import { INTEGRATION_GATE_MARKER, INTEGRATION_RESOLUTION } from "./coordinator";
import type { PluginBridge } from "./pluginBridge";
import {
  ProviderSessionStore,
  type ProviderSessionHarness,
  type ResumeAttemptCheckpoint,
} from "./providerSessions";
import { isUnverifiedHarness } from "./security";

const RESUMABLE_HARNESSES = ["claude", "codex", "opencode", "opencode2"];
const FAILED_DISPATCH_STATES = new Set(["failed", "stopped", "abandoned", "errored", "cancelled", "timed_out"]);
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface ResumeCandidateSession {
  sessionId: string;
  agent: string;
  title: string;
  updatedAt: number;
  running: boolean;
}

export interface NativeResumePreview {
  eligible: boolean;
  reason: string | null;
  code: string | null;
  runId: string;
  taskId: string | null;
  dispatchId: string;
  harness: string | null;
  sessionId: string | null;
  sessionSource: "binding" | "explicit" | null;
  workspaceId: string | null;
  workspacePath: string | null;
  hostKind: string | null;
  pluginConnected: boolean;
  hasLaunchCapability: boolean;
  candidateSessions: ResumeCandidateSession[];
  unresolvedRequestId: string | null;
}

export interface NativeResumeResult {
  requestId: string;
  taskId: string;
  dispatchId: string;
  retriedFrom: string;
  harness: string;
  sessionId: string;
  workspaceId: string;
  resumedTerminalId: string;
  startedNewPane: boolean;
}

export interface NativeResumeDeps {
  pluginBridge: PluginBridge;
  providerSessions: ProviderSessionStore;
  noteRequest?: (row: {
    requestId: string;
    operation: string;
    runId: string;
    taskId: string | null;
    dispatchId: string | null;
  }) => Promise<void>;
  // Injectable Orca adapters for unit tests.
  showWorkerDetail?: typeof showWorkerDetail;
  listWorkers?: typeof listWorkers;
  listTasks?: typeof listTasks;
  listGates?: typeof listGates;
  listTerminals?: typeof listTerminals;
  showRequest?: typeof showRequest;
  startSupervisedWorker?: typeof startSupervisedWorker;
  waitForTuiIdle?: (terminalHandle: string, timeoutMs: number) => Promise<void>;
}

function parseTaskDeps(task: OrcaTask): string[] {
  if (typeof task.deps === "string") {
    try {
      const parsed = JSON.parse(task.deps) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((d): d is string => typeof d === "string");
    } catch {
      return [];
    }
  }
  return [];
}

function extractWorktreePath(detail: WorkerDetailView, row: OrcaWorkerRow): string | null {
  const projWs = row.projection?.workspace as string | { id?: string | null } | null | undefined;
  const candidates = [
    detail.terminal?.worktreePath,
    detail.launch?.resolvedWorktreeId,
    typeof projWs === "string" ? projWs : projWs?.id,
    detail.terminalResource?.worktreeId,
    row.resource?.worktreeId,
  ];
  let workspace: string | null = null;
  for (const raw of candidates) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const idx = raw.indexOf("::");
    const pathPart = idx >= 0 ? raw.slice(idx + 2) : raw.startsWith("path:") ? raw.slice(5) : raw;
    if (!isAbsolute(pathPart)) continue;
    const path = normalize(pathPart);
    if (workspace && workspace !== path) return null;
    workspace = path;
  }
  return workspace;
}

function normalizeHarness(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  return cleaned;
}

function isFailedSettledWorker(row: OrcaWorkerRow): boolean {
  const ds = (row.dispatchStatus ?? "").toLowerCase();
  const ws = (row.workerState ?? "").toLowerCase();
  const outcome = (row.projection?.outcome ?? "").toLowerCase();
  if (ds === "completed" || ws === "succeeded" || outcome === "succeeded") return false;
  return (
    FAILED_DISPATCH_STATES.has(ds) ||
    FAILED_DISPATCH_STATES.has(ws) ||
    FAILED_DISPATCH_STATES.has(outcome)
  );
}

async function defaultWaitForTuiIdle(terminalHandle: string, timeoutMs: number): Promise<void> {
  try {
    await runOrca([
      "terminal",
      "wait",
      "--terminal",
      terminalHandle,
      "--for",
      "tui-idle",
      "--timeout-ms",
      String(timeoutMs),
    ]);
  } catch {
    // Some agents don't report tui-idle cleanly; caller verifies terminal is still connected.
  }
}

async function resolvePluginWorkspaceId(
  pluginBridge: PluginBridge,
  workspacePath: string | null,
): Promise<string | null> {
  if (!workspacePath || !isAbsolute(workspacePath) || !pluginBridge.status().connected) return null;
  try {
    const res = await pluginBridge.enqueueCommand("workspace.list", {}, 5_000);
    if (res.ok !== true || res.truncated === true || !Array.isArray(res.workspaces)) return null;
    const matches = res.workspaces.filter((w): w is Record<string, unknown> => {
      if (!w || typeof w !== "object") return false;
      const rec = w as Record<string, unknown>;
      return (rec.hostId === "local" || rec.hostId === null) &&
        typeof rec.path === "string" && isAbsolute(rec.path) && normalize(rec.path) === workspacePath;
    });
    if (matches.length !== 1) return null;
    // Host API workspace IDs are opaque JSON values, not session tokens.
    // Folder workspaces can use "<repoId>::<absolute path>". Keep the receipt
    // verbatim for the scoped session-history match and the resume checkpoint.
    const id = matches[0].id;
    return typeof id === "string" && id.trim() && id.length <= 512 && !id.includes("\0") ? id : null;
  } catch {
    return null;
  }
}

async function fetchCandidateSessions(
  pluginBridge: PluginBridge,
  workspaceId: string,
  harness: string,
): Promise<ResumeCandidateSession[]> {
  const st = pluginBridge.status();
  if (!st.connected || !st.grantedCapabilities.includes("history:read")) return [];
  try {
    const res = await pluginBridge.enqueueCommand("agent.listSessions", { workspaceId, limit: 40 }, 5_000);
    if (res.ok !== true || !Array.isArray(res.sessions)) return [];
    const candidates: ResumeCandidateSession[] = [];
    for (const raw of res.sessions) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      if (item.workspaceId !== workspaceId || item.hostId !== "local" || typeof item.running !== "boolean" ||
          typeof item.sessionId !== "string" || !SESSION_ID_RE.test(item.sessionId) ||
          typeof item.agent !== "string" || !sameResumeHarness(item.agent, harness)) continue;
      candidates.push({
        sessionId: item.sessionId,
        agent: item.agent,
        title: typeof item.title === "string" ? item.title.slice(0, 120) : "",
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
        running: item.running,
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

// Both native OpenCode adapters share OpenCode's provider session identity.
function sameResumeHarness(a: string, b: string): boolean {
  return a === b || (a === "opencode" && b === "opencode2") || (a === "opencode2" && b === "opencode");
}

interface ResumeSelection {
  runId: string;
  dispatchId: string;
  sessionId?: string | null;
}

/**
 * Read-only eligibility inspection for L1 native session resume (M3).
 * Re-reads live Orca task/worker/gate state and companion plugin evidence.
 */
export async function previewNativeResume(
  opts: ResumeSelection,
  deps: NativeResumeDeps,
): Promise<NativeResumePreview> {
  return inspectNativeResume(opts, deps);
}

async function inspectNativeResume(
  opts: ResumeSelection,
  deps: NativeResumeDeps,
  settlements?: ResumeAttemptCheckpoint[],
): Promise<NativeResumePreview> {
  const showDetailFn = deps.showWorkerDetail ?? showWorkerDetail;
  const listWorkersFn = deps.listWorkers ?? listWorkers;
  const listTasksFn = deps.listTasks ?? listTasks;
  const listGatesFn = deps.listGates ?? listGates;
  const showRequestFn = deps.showRequest ?? showRequest;

  const pluginStatus = deps.pluginBridge.status();
  const pluginConnected = pluginStatus.connected;
  const hasLaunchCapability = pluginStatus.grantedCapabilities.includes("agent:launch");

  const base: NativeResumePreview = {
    eligible: false,
    reason: null,
    code: null,
    runId: opts.runId,
    taskId: null,
    dispatchId: opts.dispatchId,
    harness: null,
    sessionId: null,
    sessionSource: null,
    workspaceId: null,
    workspacePath: null,
    hostKind: null,
    pluginConnected,
    hasLaunchCapability,
    candidateSessions: [],
    unresolvedRequestId: null,
  };

  const fail = (code: string, reason: string): NativeResumePreview => ({ ...base, eligible: false, code, reason });

  const [detail, inventory, tasks, gates, bindings, resumeHistory] = await Promise.all([
    showDetailFn(opts.dispatchId),
    listWorkersFn(opts.runId, { includeRemote: true }),
    listTasksFn(opts.runId),
    listGatesFn(opts.runId),
    deps.providerSessions.list(opts.runId),
    deps.providerSessions.listResumeAttempts(opts.runId),
  ]);

  if (inventory.partialHostErrors.length > 0) {
    return fail("inventory_incomplete", "Worker inventory has partial host errors; cannot prove no active worker exists.");
  }
  if (!detail || detail.runId !== opts.runId || !detail.taskId) {
    return fail("worker_not_found", "Dispatch does not belong to this Run.");
  }
  base.taskId = detail.taskId;
  const row = inventory.workers.find((w) =>
    w.runId === opts.runId && w.taskId === detail.taskId && w.dispatchId === opts.dispatchId);
  if (!row) {
    return fail("worker_not_found", "Dispatch is missing from Orca worker inventory.");
  }

  const hostKind = row.projection?.host?.kind ?? null;
  base.hostKind = hostKind;
  base.workspacePath = extractWorktreePath(detail, row);

  const binding = bindings.find((b) => b.dispatchId === opts.dispatchId && b.taskId === detail.taskId) ?? null;

  const harness = normalizeHarness(
    detail.launch?.agent ?? detail.requestedLaunch?.agent ?? binding?.harness ?? null,
  );
  base.harness = harness;

  if (!harness) {
    return fail("resume_not_allowed", "Cannot prove which agent harness ran this Dispatch.");
  }
  if (isUnverifiedHarness(harness)) {
    return fail("unverified_harness", `"${harness}" is an unverified harness and cannot be resumed by Orca viewer.`);
  }
  if (!RESUMABLE_HARNESSES.includes(harness)) {
    return fail("resume_not_allowed", `Harness "${harness}" does not support native session resume.`);
  }

  if (detail.dispatch?.status === "circuit_broken") {
    return fail("task_not_startable", "Orca reports this Dispatch as circuit_broken.");
  }
  if (row.projection?.liveness?.verdict !== "exited" || !isFailedSettledWorker(row)) {
    return fail("resume_not_allowed", "Only an exited, failed or stopped Dispatch can be resumed.");
  }
  const activeSibling = inventory.workers.find(
    (w) => w.runId === opts.runId && w.taskId === detail.taskId &&
      (w.dispatchStatus === "dispatched" || w.dispatchStatus === "pending"),
  );
  if (activeSibling) {
    return fail("resume_not_allowed", `Task already has an active Dispatch (${activeSibling.dispatchId}).`);
  }

  const task = tasks.find((t) => t.run_id === opts.runId && t.id === detail.taskId);
  if (!task) return fail("task_not_found", `Task ${detail.taskId} no longer exists in Run ${opts.runId}.`);
  if (task.status === "dispatched" || task.status === "completed") {
    return fail("resume_not_allowed", `Task is currently "${task.status}" and cannot be resumed.`);
  }
  if (task.dispatch_id && task.dispatch_id !== opts.dispatchId) {
    return fail("resume_not_allowed", "The Task points at a different Dispatch.");
  }
  if (parseTaskDeps(task).some((depId) => !tasks.some((t) => t.run_id === opts.runId && t.id === depId && t.status === "completed"))) {
    return fail("resume_not_allowed", "Upstream dependencies are not completed.");
  }
  if (gates.some((gate) => gate.taskId === detail.taskId && !(gate.question.includes(INTEGRATION_GATE_MARKER)
    ? gate.status === "resolved" && gate.resolution === INTEGRATION_RESOLUTION
    : ordinaryGateApproved(gate)))) {
    return fail("resume_not_allowed", "An approval gate is not approved for this Task.");
  }

  // Preview reads every unresolved attempt; only positive native settlement
  // can lift a hold, and a read-only preview does not rewrite the journal.
  for (const unresolved of resumeHistory) {
    if (unresolved.taskId !== detail.taskId ||
        !["prepared", "resumed_terminal", "unknown"].includes(unresolved.state)) continue;
    let settlement: ResumeAttemptCheckpoint | null = null;
    try {
      const reqReceipt = await showRequestFn(unresolved.requestId);
      const outcomeRec =
        reqReceipt?.outcome && typeof reqReceipt.outcome === "object" && !Array.isArray(reqReceipt.outcome)
          ? (reqReceipt.outcome as Record<string, unknown>)
          : null;
      if (reqReceipt?.raw.requestId === unresolved.requestId && reqReceipt.raw.method === "orchestration.workerStart") {
        if (reqReceipt.state === "failed" || reqReceipt.state === "rejected") {
          settlement = { ...unresolved, state: "refused", error: reqReceipt.interpretation, updatedAt: new Date().toISOString() };
        } else if (reqReceipt.state === "completed" && outcomeRec?.runId === opts.runId &&
            outcomeRec.taskId === detail.taskId && outcomeRec.state === "ready" &&
            typeof outcomeRec.dispatchId === "string" && unresolved.resumedTerminalId) {
          const recovered = await showDetailFn(outcomeRec.dispatchId);
          if (recovered?.runId === opts.runId && recovered.taskId === detail.taskId &&
              recovered.dispatchId === outcomeRec.dispatchId &&
              recovered.dispatch?.retryOfDispatchId === unresolved.originalDispatchId &&
              (recovered.terminal?.handle ?? recovered.fleet?.agentTerminalHandle) === unresolved.resumedTerminalId) {
            settlement = { ...unresolved, state: "bound", newDispatchId: recovered.dispatchId, error: null, updatedAt: new Date().toISOString() };
          }
        }
      }
    } catch {
      // Unreadable request-show keeps the hold.
    }
    if (!settlement) {
      base.unresolvedRequestId = unresolved.requestId;
      return fail(
        "resume_unknown",
        `An earlier resume request (${unresolved.requestId}) is unresolved; inspect via request-show before retrying.`,
      );
    }
    settlements?.push(settlement);
  }

  if (hostKind !== "local" || row.projection?.host?.id !== "local" ||
      (detail.terminal?.executionHostId && detail.terminal.executionHostId !== "local")) {
    return fail(
      "resume_not_allowed",
      "Only a positively identified local worker can be resumed. Paired remote (--on) workers must use Safe Retry.",
    );
  }
  if (!pluginConnected) {
    return fail(
      "plugin_not_connected",
      "Companion Orca plugin (orchestration-panel) is not connected; native resume requires it.",
    );
  }
  if (!hasLaunchCapability) {
    return fail(
      "plugin_capability_missing",
      "Companion Orca plugin has not been granted agent:launch permission.",
    );
  }

  const workspaceId = await resolvePluginWorkspaceId(deps.pluginBridge, base.workspacePath);
  base.workspaceId = workspaceId;
  if (!workspaceId) {
    return fail(
      "resume_workspace_missing",
      "Original worktree workspace could not be found on this Orca host; use fresh retry instead.",
    );
  }

  const candidateSessions = await fetchCandidateSessions(deps.pluginBridge, workspaceId, harness);
  const bound = binding && binding.host === "local:local" &&
    normalize(binding.workspace) === base.workspacePath && sameResumeHarness(binding.harness, harness) ? binding : null;
  if (binding && !bound) return fail("resume_not_allowed", "The saved session binding does not match this worker workspace and harness.");

  if (opts.sessionId && opts.sessionId.trim()) {
    const trimmed = opts.sessionId.trim();
    if (!SESSION_ID_RE.test(trimmed)) {
      return fail("invalid_session_id", "sessionId must be a single provider-issued token without whitespace.");
    }
    if (bound && bound.sessionId !== trimmed) {
      return fail("resume_not_allowed", "Choose the session already bound to this Dispatch.");
    }
    base.sessionId = trimmed;
    base.sessionSource = "explicit";
  } else if (bound) {
    base.sessionId = bound.sessionId;
    base.sessionSource = "binding";
  } else {
    base.candidateSessions = candidateSessions.slice(0, 15);
    return fail(
      "session_id_required",
      candidateSessions.length > 0
        ? "No exact session binding was recorded for this Dispatch; pick one of the workspace sessions below to confirm."
        : "No exact session ID is known for this Dispatch; supply one or use Safe Retry.",
    );
  }

  // Positive non-running check via Orca session history and provider probe.
  const matchingSessions = candidateSessions.filter((s) => s.sessionId === base.sessionId);
  if (matchingSessions.length !== 1) {
    return fail("resume_not_allowed", "Orca could not verify this session in the original local workspace.");
  }
  if (matchingSessions[0].running) {
    return fail(
      "resume_session_active",
      `Session ${base.sessionId} is currently running in an Orca terminal; refusing to double-attach.`,
    );
  }
  if (bound) {
    const obs = await deps.providerSessions.probe(bound);
    if (obs.status === "active") {
      return fail(
        "resume_session_active",
        `Provider reports bound session ${base.sessionId} is still active; resolve it first.`,
      );
    }
  }

  return { ...base, eligible: true, code: null, reason: null };
}

/**
 * Execute L1 Native Session Resume (M3):
 * 1. Re-verify all safety gates (`previewNativeResume`).
 * 2. Write durable `ResumeAttemptCheckpoint` (`state: "prepared"`) BEFORE any side effect.
 * 3. Ask companion plugin to call `agent.resume({ workspaceId, agent, sessionId })`.
 * 4. Wait for TUI readiness (`terminal wait --for tui-idle`) & confirm pane is alive.
 * 5. Bind the resumed pane via `startSupervisedWorker({ ..., terminal, retryOf, retryRequestId })`.
 *
 * Refusals or unknown outcomes NEVER trigger a second fresh launch.
 */
export async function executeNativeResume(
  opts: {
    runId: string;
    dispatchId: string;
    sessionId?: string | null;
    runAsCoordinator: (fn: (from: string) => Promise<NativeResumeResult>) => Promise<NativeResumeResult>;
    /** Called while the route holds the lifecycle lock, before it can dispatch again. */
    onStarted?: (meta: { taskId: string; harness: string; retriedFrom: string; terminalId: string }, started: StartedWorker) => void;
  },
  deps: NativeResumeDeps,
): Promise<NativeResumeResult> {
  const settlements: ResumeAttemptCheckpoint[] = [];
  const preview = await inspectNativeResume(opts, deps, settlements);
  if (!preview.eligible || !preview.taskId || !preview.harness || !preview.sessionId || !preview.workspaceId) {
    throw new OrcaCliError(
      preview.reason ?? "Native session resume is not allowed for this Dispatch.",
      preview.code ?? "resume_not_allowed",
    );
  }
  const { taskId, harness, sessionId, workspaceId, workspacePath } = preview;
  return opts.runAsCoordinator(async (from) => {
    for (const row of settlements) await deps.providerSessions.recordResumeAttempt(row);
    return resumeAuthorized({
      from, runId: opts.runId, dispatchId: opts.dispatchId, taskId, harness,
      sessionId, workspaceId, workspacePath, onStarted: opts.onStarted,
    }, deps);
  });
}

async function resumeAuthorized(
  opts: {
    from: string; runId: string; dispatchId: string; taskId: string; harness: string;
    sessionId: string; workspaceId: string; workspacePath: string | null;
    onStarted?: Parameters<typeof executeNativeResume>[0]["onStarted"];
  },
  deps: NativeResumeDeps,
): Promise<NativeResumeResult> {
  const listWorkersFn = deps.listWorkers ?? listWorkers;
  const listTerminalsFn = deps.listTerminals ?? listTerminals;
  const startWorkerFn = deps.startSupervisedWorker ?? startSupervisedWorker;
  const waitIdleFn = deps.waitForTuiIdle ?? defaultWaitForTuiIdle;

  const requestId = newRequestId();
  const createdAt = new Date().toISOString();
  let checkpoint: ResumeAttemptCheckpoint = {
    requestId,
    runId: opts.runId,
    taskId: opts.taskId,
    originalDispatchId: opts.dispatchId,
    harness: opts.harness,
    sessionId: opts.sessionId,
    workspaceId: opts.workspaceId,
    resumedTerminalId: null,
    newDispatchId: null,
    state: "prepared",
    error: null,
    createdAt,
    updatedAt: createdAt,
  };

  // Persist recovery authority BEFORE touching Orca or the plugin.
  await deps.providerSessions.recordResumeAttempt(checkpoint);
  if (deps.noteRequest) {
    await deps.noteRequest({
      requestId,
      operation: "worker-resume",
      runId: opts.runId,
      taskId: opts.taskId,
      dispatchId: opts.dispatchId,
    });
  }

  const persist = async (patch: Partial<ResumeAttemptCheckpoint>): Promise<void> => {
    checkpoint = { ...checkpoint, ...patch, updatedAt: new Date().toISOString() };
    await deps.providerSessions.recordResumeAttempt(checkpoint);
  };

  // Step 1: Resume session via companion plugin (`agent.resume`).
  let resumedTerminalId: string;
  let startedNewPane = false;
  try {
    const resumeReceipt = await deps.pluginBridge.enqueueCommand(
      "agent.resume",
      {
        workspaceId: opts.workspaceId,
        agent: opts.harness,
        sessionId: opts.sessionId,
      },
      25_000,
    );
    if (resumeReceipt.ok === false && resumeReceipt.code !== "action_failed") {
      const msg = typeof resumeReceipt.error === "string" ? resumeReceipt.error : "agent.resume refused";
      await persist({ state: "refused", error: msg });
      throw new OrcaCliError(`Native resume failed: ${msg}`, "resume_failed");
    }
    if (resumeReceipt.ok !== true || typeof resumeReceipt.terminalId !== "string" || !SESSION_ID_RE.test(resumeReceipt.terminalId) ||
        typeof resumeReceipt.started !== "boolean") {
      throw new Error("agent.resume returned no positive pane evidence");
    }
    resumedTerminalId = resumeReceipt.terminalId;
    startedNewPane = resumeReceipt.started;
  } catch (err) {
    if (checkpoint.state === "prepared") {
      await persist({ state: "unknown", error: String((err as Error)?.message ?? err) });
      throw new OrcaCliError("Native session resume outcome is unknown. Inspect the Orca session before retrying.", "resume_unknown");
    }
    throw err;
  }

  // An existing pane may be an interactive session even with no Dispatch.
  // agent.resume's reuse receipt is not a transfer of its owner's custody.
  if (!startedNewPane) {
    await persist({ state: "refused", resumedTerminalId, error: "The session is already open in a pre-existing pane." });
    throw new OrcaCliError("Cannot bind a pre-existing session pane; close it explicitly before retrying.", "resume_session_active");
  }

  await persist({ state: "resumed_terminal", resumedTerminalId });

  // Step 2: Wait for resumed agent TUI to finish initializing and verify pane is still live.
  await waitIdleFn(resumedTerminalId, 45_000);
  const liveTerminals = await listTerminalsFn();
  if (!opts.workspacePath || !liveTerminals.some((t) => t.handle === resumedTerminalId &&
      t.connected === true && t.worktreePath && normalize(t.worktreePath) === opts.workspacePath)) {
    await persist({
      state: "refused",
      error: `Could not verify resumed terminal ${resumedTerminalId} in the original workspace.`,
    });
    throw new OrcaCliError(
      `Could not verify resumed terminal ${resumedTerminalId} in the original workspace.`,
      "resume_terminal_lost",
    );
  }
  const globalFleet = await listWorkersFn(undefined, { includeRemote: true });
  if (globalFleet.partialHostErrors.length) {
    throw new OrcaCliError("Global worker inventory is incomplete; cannot verify terminal custody.", "inventory_incomplete");
  }
  if (globalFleet.workers.some((row) => (row.dispatchStatus === "pending" || row.dispatchStatus === "dispatched") &&
      (row.agentTerminalHandle === resumedTerminalId || (row.runId === opts.runId && row.taskId === opts.taskId)))) {
    throw new OrcaCliError("The resumed terminal or Task already belongs to a live Dispatch.", "resume_session_active");
  }

  // Step 3: Bind resumed pane to the Task via `worker-start --terminal --retry-of`
  // under explicit coordinator authority.
  let started: StartedWorker;
  try {
    started = await startWorkerFn({
      taskId: opts.taskId,
      agent: opts.harness,
      runId: opts.runId,
      from: opts.from,
      terminal: resumedTerminalId,
      retryRequestId: requestId,
      retryOf: opts.dispatchId,
    });
  } catch (err) {
    // A thrown bind may have created a Dispatch even if the CLI did not
    // return it. Preserve the request ID and original session for recovery.
    await persist({ state: "unknown", error: String((err as Error)?.message ?? err) });
    throw err;
  }

  const newDispatchId = started.dispatchId;
  if (!newDispatchId) {
    await persist({
      state: "unknown",
      error: `worker-start returned no dispatchId (requestId: ${requestId}); inspect via request-show.`,
    });
    throw new OrcaCliError(
      `Resumed worker-start returned no dispatchId (requestId: ${requestId}).`,
      "resume_unknown",
    );
  }
  opts.onStarted?.({ taskId: opts.taskId, harness: opts.harness, retriedFrom: opts.dispatchId, terminalId: resumedTerminalId }, started);

  await persist({
    state: "bound",
    newDispatchId,
    error: null,
  });

  // Persist the exact provider session binding on the new Dispatch too when
  // supported by ProviderSessionStore (`claude` | `codex` | `opencode`).
  const bindHarness: ProviderSessionHarness | null =
    opts.harness === "claude" || opts.harness === "codex"
      ? opts.harness
      : opts.harness === "opencode" || opts.harness === "opencode2"
        ? "opencode"
        : null;
  if (bindHarness && opts.workspacePath) {
    try {
      await deps.providerSessions.bind({
        runId: opts.runId,
        taskId: opts.taskId,
        dispatchId: newDispatchId,
        harness: bindHarness,
        sessionId: opts.sessionId,
        workspace: opts.workspacePath,
        host: "local:local",
        source: "provider-evidence",
      });
    } catch {
      // Non-fatal: the resume itself already succeeded and was journaled.
    }
  }

  return {
    requestId,
    taskId: opts.taskId,
    dispatchId: newDispatchId,
    retriedFrom: opts.dispatchId,
    harness: opts.harness,
    sessionId: opts.sessionId,
    workspaceId: opts.workspaceId,
    resumedTerminalId,
    startedNewPane,
  };
}
