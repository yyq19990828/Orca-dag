import { normalize } from "node:path";
import {
  OrcaCliError,
  RESPONSE_LOST,
  listGates,
  listTasks,
  listTerminals,
  listWorkers,
  newRequestId,
  runOrca,
  showRequest,
  showWorkerDetail,
  startSupervisedWorker,
  type OrcaTask,
  type OrcaWorkerRow,
  type StartedWorker,
  type WorkerDetailView,
} from "./orca";
import type { PluginBridge } from "./pluginBridge";
import {
  ProviderSessionStore,
  type ProviderSessionHarness,
  type ResumeAttemptCheckpoint,
} from "./providerSessions";
import { isUnverifiedHarness } from "./security";

const RESUMABLE_HARNESSES = new Set(["claude", "codex", "opencode", "opencode2", "omp", "antigravity"]);
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
  sessionSource: "binding" | "plugin-live" | "explicit" | null;
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

function extractWorktreePath(detail: WorkerDetailView | null, row: OrcaWorkerRow | null): string | null {
  if (detail?.terminal?.worktreePath) return normalize(detail.terminal.worktreePath);
  const projWs = row?.projection?.workspace as string | { id?: string | null } | null | undefined;
  const candidates = [
    detail?.launch?.resolvedWorktreeId,
    typeof projWs === "string" ? projWs : projWs?.id ?? null,
    detail?.terminalResource?.worktreeId,
  ];
  for (const raw of candidates) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const idx = raw.indexOf("::");
    const pathPart = idx >= 0 ? raw.slice(idx + 2) : raw;
    if (pathPart.startsWith("/")) return normalize(pathPart);
  }
  return null;
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
  terminalHandle: string | null,
  workspacePath: string | null,
): Promise<string | null> {
  const observed = terminalHandle ? pluginBridge.getObservedAgent(terminalHandle) : null;
  if (observed?.workspaceListId) return observed.workspaceListId;
  if (!workspacePath || !pluginBridge.status().connected) return null;
  try {
    const res = await pluginBridge.enqueueCommand("workspace.list", {}, 5_000);
    const list = Array.isArray(res.workspaces) ? res.workspaces : [];
    const match = list.find((w): w is { id: string; path: string } => {
      if (!w || typeof w !== "object") return false;
      const rec = w as Record<string, unknown>;
      return typeof rec.id === "string" && typeof rec.path === "string" && normalize(rec.path) === workspacePath;
    });
    return match?.id ?? null;
  } catch {
    return null;
  }
}

async function fetchCandidateSessions(
  pluginBridge: PluginBridge,
  workspaceId: string | null,
  harness: string | null,
): Promise<ResumeCandidateSession[]> {
  const st = pluginBridge.status();
  if (!st.connected || !st.grantedCapabilities.includes("history:read") || !workspaceId) return [];
  try {
    const res = await pluginBridge.enqueueCommand("agent.listSessions", { workspaceId, limit: 40 }, 5_000);
    const raw = Array.isArray(res.sessions) ? res.sessions : [];
    const expected = harness === "opencode2" ? "opencode" : harness;
    return raw
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        sessionId: typeof item.sessionId === "string" ? item.sessionId : "",
        agent: typeof item.agent === "string" ? item.agent : "",
        title: typeof item.title === "string" ? item.title.slice(0, 120) : "",
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
        running: Boolean(item.running),
      }))
      .filter((s) => s.sessionId && (!expected || s.agent === expected || (expected === "opencode" && s.agent === "opencode2")))
      .slice(0, 15);
  } catch {
    return [];
  }
}

/**
 * Read-only eligibility inspection for L1 native session resume (M3).
 * Re-reads live Orca task/worker/gate state and companion plugin evidence.
 */
export async function previewNativeResume(
  opts: { runId: string; dispatchId: string; sessionId?: string | null },
  deps: NativeResumeDeps,
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
  const row = inventory.workers.find((w) => w.runId === opts.runId && w.dispatchId === opts.dispatchId) ?? detail.fleet ?? null;
  if (!row) {
    return fail("worker_not_found", "Dispatch is missing from Orca worker inventory.");
  }

  const hostKind = row.projection?.host?.kind ?? null;
  base.hostKind = hostKind;
  base.workspacePath = extractWorktreePath(detail, row);

  const terminalHandle =
    detail.terminal?.handle ?? row.agentTerminalHandle ?? detail.terminalResource?.terminalHandle ?? null;
  const observed = terminalHandle ? deps.pluginBridge.getObservedAgent(terminalHandle) : null;
  const binding = bindings.find((b) => b.dispatchId === opts.dispatchId && b.taskId === detail.taskId) ?? null;

  const harness = normalizeHarness(
    detail.launch?.agent ?? detail.requestedLaunch?.agent ?? binding?.harness ?? observed?.agent ?? null,
  );
  base.harness = harness;

  if (!harness) {
    return fail("resume_not_allowed", "Cannot prove which agent harness ran this Dispatch.");
  }
  if (isUnverifiedHarness(harness)) {
    return fail("unverified_harness", `"${harness}" is an unverified harness and cannot be resumed by Orca viewer.`);
  }
  if (!RESUMABLE_HARNESSES.has(harness)) {
    return fail("resume_not_allowed", `Harness "${harness}" does not support native session resume.`);
  }

  if (detail.dispatch?.status === "circuit_broken") {
    return fail("task_not_startable", "Orca reports this Dispatch as circuit_broken.");
  }
  if (row.projection?.liveness?.verdict !== "exited" || !isFailedSettledWorker(row)) {
    return fail("resume_not_allowed", "Only an exited, failed or stopped Dispatch can be resumed.");
  }
  const activeSibling = inventory.workers.find(
    (w) => w.taskId === detail.taskId && (w.dispatchStatus === "dispatched" || w.dispatchStatus === "pending"),
  );
  if (activeSibling) {
    return fail("resume_not_allowed", `Task already has an active Dispatch (${activeSibling.dispatchId}).`);
  }

  const task = tasks.find((t) => t.id === detail.taskId);
  if (!task) return fail("task_not_found", `Task ${detail.taskId} no longer exists in Run ${opts.runId}.`);
  if (task.status === "dispatched" || task.status === "completed") {
    return fail("resume_not_allowed", `Task is currently "${task.status}" and cannot be resumed.`);
  }
  if (parseTaskDeps(task).some((depId) => !tasks.some((t) => t.id === depId && t.status === "completed"))) {
    return fail("resume_not_allowed", "Upstream dependencies are not completed.");
  }
  if (gates.some((g) => g.taskId === detail.taskId && g.status === "pending")) {
    return fail("resume_not_allowed", "A pending approval gate blocks this Task.");
  }

  // Reconcile any unresolved resume checkpoint for this Task before allowing another.
  const unresolved = resumeHistory.find(
    (r) => r.taskId === detail.taskId && ["prepared", "resumed_terminal", "unknown"].includes(r.state),
  );
  if (unresolved) {
    let reconciled = false;
    try {
      const reqReceipt = await showRequestFn(unresolved.requestId);
      const outcomeRec =
        reqReceipt?.outcome && typeof reqReceipt.outcome === "object" && !Array.isArray(reqReceipt.outcome)
          ? (reqReceipt.outcome as Record<string, unknown>)
          : null;
      if (reqReceipt?.state === "failed" || reqReceipt?.state === "rejected") {
        await deps.providerSessions.recordResumeAttempt({
          ...unresolved,
          state: "refused",
          error: reqReceipt.interpretation ?? "Prior resume request failed",
          updatedAt: new Date().toISOString(),
        });
        reconciled = true;
      } else if (reqReceipt?.state === "completed") {
        const recoveredDispatchId =
          typeof outcomeRec?.dispatchId === "string" ? outcomeRec.dispatchId : unresolved.newDispatchId;
        await deps.providerSessions.recordResumeAttempt({
          ...unresolved,
          state: "bound",
          newDispatchId: recoveredDispatchId,
          updatedAt: new Date().toISOString(),
        });
        reconciled = true;
      }
    } catch {
      // Unreadable request-show keeps the hold.
    }
    if (!reconciled) {
      base.unresolvedRequestId = unresolved.requestId;
      return fail(
        "resume_unknown",
        `An earlier resume request (${unresolved.requestId}) is unresolved; inspect via request-show before retrying.`,
      );
    }
  }

  if (hostKind && hostKind !== "local") {
    return fail(
      "resume_not_allowed",
      "Paired remote runtime (--on) workers cannot combine --on with --terminal; use Safe Retry instead.",
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

  const workspaceId = await resolvePluginWorkspaceId(deps.pluginBridge, terminalHandle, base.workspacePath);
  base.workspaceId = workspaceId;
  if (!workspaceId) {
    return fail(
      "resume_workspace_missing",
      "Original worktree workspace could not be found on this Orca host; use fresh retry instead.",
    );
  }

  const candidateSessions = await fetchCandidateSessions(deps.pluginBridge, workspaceId, harness);
  base.candidateSessions = candidateSessions;

  if (opts.sessionId && opts.sessionId.trim()) {
    const trimmed = opts.sessionId.trim();
    if (!SESSION_ID_RE.test(trimmed)) {
      return fail("invalid_session_id", "sessionId must be a single provider-issued token without whitespace.");
    }
    base.sessionId = trimmed;
    base.sessionSource = "explicit";
  } else if (binding) {
    base.sessionId = binding.sessionId;
    base.sessionSource = "binding";
  } else if (observed?.sessionId) {
    base.sessionId = observed.sessionId;
    base.sessionSource = "plugin-live";
  } else {
    return fail(
      "session_id_required",
      candidateSessions.length > 0
        ? "No exact session binding was recorded for this Dispatch; pick one of the workspace sessions below to confirm."
        : "No exact session ID is known for this Dispatch; supply one or use Safe Retry.",
    );
  }

  // Positive non-running check via Orca session history and provider probe.
  const matchedHistory = candidateSessions.find((s) => s.sessionId === base.sessionId);
  if (matchedHistory?.running) {
    return fail(
      "resume_session_active",
      `Session ${base.sessionId} is currently running in an Orca terminal; refusing to double-attach.`,
    );
  }
  if (binding && binding.sessionId === base.sessionId) {
    const obs = await deps.providerSessions.probe(binding);
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
    /** Executes the orchestration `worker-start --terminal` step under coordinator authority. */
    runAsCoordinator: <T>(
      meta: { taskId: string; harness: string; retriedFrom: string; terminalId: string },
      fn: (from: string) => Promise<T>,
    ) => Promise<T>;
  },
  deps: NativeResumeDeps,
): Promise<NativeResumeResult> {
  const preview = await previewNativeResume(
    { runId: opts.runId, dispatchId: opts.dispatchId, sessionId: opts.sessionId },
    deps,
  );
  if (!preview.eligible || !preview.taskId || !preview.harness || !preview.sessionId || !preview.workspaceId) {
    throw new OrcaCliError(
      preview.reason ?? "Native session resume is not allowed for this Dispatch.",
      preview.code ?? "resume_not_allowed",
    );
  }

  const listWorkersFn = deps.listWorkers ?? listWorkers;
  const listTerminalsFn = deps.listTerminals ?? listTerminals;
  const startWorkerFn = deps.startSupervisedWorker ?? startSupervisedWorker;
  const waitIdleFn = deps.waitForTuiIdle ?? defaultWaitForTuiIdle;

  const requestId = newRequestId();
  const createdAt = new Date().toISOString();
  let checkpoint: ResumeAttemptCheckpoint = {
    requestId,
    runId: opts.runId,
    taskId: preview.taskId,
    originalDispatchId: opts.dispatchId,
    harness: preview.harness,
    sessionId: preview.sessionId,
    workspaceId: preview.workspaceId,
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
      taskId: preview.taskId,
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
        workspaceId: preview.workspaceId,
        agent: preview.harness,
        sessionId: preview.sessionId,
      },
      25_000,
    );
    if (resumeReceipt.ok !== true || typeof resumeReceipt.terminalId !== "string" || !resumeReceipt.terminalId) {
      const msg = typeof resumeReceipt.error === "string" ? resumeReceipt.error : "agent.resume failed";
      await persist({ state: "refused", error: msg });
      throw new OrcaCliError(`Native resume failed: ${msg}`, "resume_failed");
    }
    resumedTerminalId = resumeReceipt.terminalId;
    startedNewPane = resumeReceipt.started === true;
  } catch (err) {
    if (checkpoint.state === "prepared") {
      await persist({ state: "refused", error: String((err as Error)?.message ?? err) });
    }
    throw err;
  }

  // If Orca reports the session was already open in an existing pane, make sure
  // no other live Dispatch already owns that terminal before binding.
  if (!startedNewPane) {
    const globalFleet = await listWorkersFn(undefined, { includeRemote: true });
    if (globalFleet.partialHostErrors.length > 0) {
      await persist({
        state: "refused",
        resumedTerminalId,
        error: "Global worker inventory incomplete; refusing to attach to pre-existing pane.",
      });
      throw new OrcaCliError(
        "Global worker inventory is incomplete; cannot verify ownership of existing resumed pane.",
        "inventory_incomplete",
      );
    }
    const existingOwner = globalFleet.workers.find(
      (w) =>
        w.agentTerminalHandle === resumedTerminalId &&
        (w.dispatchStatus === "dispatched" || w.dispatchStatus === "pending"),
    );
    if (existingOwner) {
      await persist({
        state: "refused",
        resumedTerminalId,
        error: `Existing pane is already owned by active Dispatch ${existingOwner.dispatchId}.`,
      });
      throw new OrcaCliError(
        `Refusing to attach: session pane ${resumedTerminalId} is already owned by active Dispatch ${existingOwner.dispatchId}.`,
        "resume_session_active",
      );
    }
  }

  await persist({ state: "resumed_terminal", resumedTerminalId });

  // Step 2: Wait for resumed agent TUI to finish initializing and verify pane is still live.
  await waitIdleFn(resumedTerminalId, 45_000);
  const liveTerminals = await listTerminalsFn().catch(() => null);
  if (liveTerminals && !liveTerminals.some((t) => t.handle === resumedTerminalId && t.connected !== false)) {
    await persist({
      state: "refused",
      error: `Resumed terminal ${resumedTerminalId} disconnected before worker-start binding.`,
    });
    throw new OrcaCliError(
      `Resumed terminal ${resumedTerminalId} exited or disconnected before binding.`,
      "resume_terminal_lost",
    );
  }

  // Step 3: Bind resumed pane to the Task via `worker-start --terminal --retry-of`
  // under explicit coordinator authority.
  let started: StartedWorker;
  try {
    started = await opts.runAsCoordinator(
      {
        taskId: preview.taskId!,
        harness: preview.harness!,
        retriedFrom: opts.dispatchId,
        terminalId: resumedTerminalId,
      },
      async (from) => {
        return await startWorkerFn({
          taskId: preview.taskId!,
          agent: preview.harness!,
          runId: opts.runId,
          from,
          terminal: resumedTerminalId,
          retryRequestId: requestId,
          retryOf: opts.dispatchId,
        });
      },
    );
  } catch (err) {
    const e = err as OrcaCliError;
    if (e instanceof OrcaCliError && e.code === RESPONSE_LOST) {
      await persist({
        state: "unknown",
        error: `worker-start response lost (requestId: ${requestId}); inspect via request-show.`,
      });
    } else {
      await persist({
        state: "refused",
        error: String((err as Error)?.message ?? err),
      });
    }
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

  await persist({
    state: "bound",
    newDispatchId,
    error: null,
  });

  // Persist the exact provider session binding on the new Dispatch too when
  // supported by ProviderSessionStore (`claude` | `codex` | `opencode`).
  const bindHarness: ProviderSessionHarness | null =
    preview.harness === "claude" || preview.harness === "codex"
      ? preview.harness
      : preview.harness === "opencode" || preview.harness === "opencode2"
        ? "opencode"
        : null;
  if (bindHarness && preview.workspacePath) {
    try {
      await deps.providerSessions.bind({
        runId: opts.runId,
        taskId: preview.taskId,
        dispatchId: newDispatchId,
        harness: bindHarness,
        sessionId: preview.sessionId,
        workspace: preview.workspacePath,
        host: "local:local",
        source: "provider-evidence",
      });
    } catch {
      // Non-fatal: the resume itself already succeeded and was journaled.
    }
  }

  return {
    requestId,
    taskId: preview.taskId,
    dispatchId: newDispatchId,
    retriedFrom: opts.dispatchId,
    harness: preview.harness,
    sessionId: preview.sessionId,
    workspaceId: preview.workspaceId,
    resumedTerminalId,
    startedNewPane,
  };
}
