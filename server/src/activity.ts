import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  CleanupDebtItem,
  CoordinatorCheckReceipt,
  CoordinatorStatus,
} from "./coordinator";
import type { OrcaMessage, OrcaTask, OrcaWorkerRow } from "./orca";

export const ACTIVITY_FILE = ".orca-dag.activity.jsonl";
const JOURNAL_MAX_BYTES = 5 * 1024 * 1024;
const JOURNAL_KEEP_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 500;

export type ActivityKind =
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
  kind: ActivityKind;
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

export interface ActivitySnapshot {
  runId: string;
  events: ActivityEvent[];
  presence: StagePresence[];
  /** Bounded, session-local receipts from the live coordinator check loop. */
  checks: CoordinatorCheckReceipt[];
  pendingCount: number;
  truncated: boolean;
  generatedAt: number;
}

interface PersistedCheckRecord {
  recordType: "coordinator_check";
  id: string;
  runId: string;
  createdAt: string;
  receipt: CoordinatorCheckReceipt;
}

export interface ActivityHistory {
  events: ActivityEvent[];
  checks: CoordinatorCheckReceipt[];
}

/**
 * Compact fleet truth for Chat's stage header. This intentionally stops at
 * the worker-list projection: it communicates whether an attempt is live and
 * what phase Orca last observed, without copying the agent transcript into
 * the browser or pretending polling is a chat message.
 */
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

type Payload = {
  taskId?: string;
  dispatchId?: string;
  outcome?: string;
  phase?: string;
  filesModified?: string[];
  reportPath?: string;
  _orcaLifecycleRejection?: { code?: string; reason?: string };
};

function payloadOf(message: OrcaMessage): Payload {
  if (!message.payload) return {};
  try {
    const parsed = JSON.parse(message.payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Payload) : {};
  } catch {
    return {};
  }
}

function taskLabel(task: OrcaTask | undefined, taskId: string | null): string {
  return task?.display_name?.trim() || task?.task_title?.trim() || (taskId ? taskId : "Worker");
}

function meaningfulSubject(subject: string): boolean {
  const normalized = subject.trim().toLowerCase();
  return Boolean(normalized) && !["alive", "question", "status", "heartbeat"].includes(normalized);
}

function firstSentence(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) return "No additional detail was provided.";
  const match = normalized.match(/^.*?[.!?](?:\s|$)/);
  return (match?.[0] ?? normalized).trim();
}

function workerFor(
  workers: OrcaWorkerRow[],
  taskId: string | null,
  dispatchId: string | null,
  terminalHandle: string,
): OrcaWorkerRow | undefined {
  return workers.find(
    (worker) =>
      (dispatchId !== null && worker.dispatchId === dispatchId) ||
      (dispatchId === null && taskId !== null && worker.taskId === taskId) ||
      (dispatchId === null && taskId === null && worker.agentTerminalHandle === terminalHandle),
  );
}

function normalizeMessage(
  message: OrcaMessage,
  taskMap: Map<string, OrcaTask>,
  workers: OrcaWorkerRow[],
  leadTaskId: string | null,
  pendingIds: Set<string>,
): ActivityEvent {
  // Treat the CLI receipt as untrusted JSON despite the compile-time type.
  // Mixed-version peers may omit or reshape presentational fields; Activity
  // should surface an unknown event instead of taking down the whole history.
  const subject = typeof message.subject === "string" ? message.subject : "";
  const body = typeof message.body === "string" ? message.body : "";
  const messageType = typeof message.type === "string" ? message.type : "unknown";
  const terminalHandle = typeof message.from_handle === "string" ? message.from_handle : "unknown";
  const toHandle = typeof message.to_handle === "string" ? message.to_handle : "";
  const addressedDispatchId = toHandle.startsWith("dispatch:") ? toHandle.slice("dispatch:".length) || null : null;
  const outbound = addressedDispatchId !== null;
  const createdAt =
    typeof message.created_at === "string" && !Number.isNaN(Date.parse(message.created_at))
      ? message.created_at
      : new Date(0).toISOString();
  const payload = payloadOf(message);
  const payloadTaskId = typeof payload.taskId === "string" ? payload.taskId : null;
  const payloadDispatchId = typeof payload.dispatchId === "string" ? payload.dispatchId : null;
  const resolvedDispatchId = payloadDispatchId ?? addressedDispatchId;
  // Heartbeats and older status senders do not always repeat the Task id in
  // every payload. A fleet row may still prove the sender terminal's exact
  // Dispatch/Task identity; use that evidence instead of labelling it by the
  // raw terminal handle or guessing from saved preferences.
  const worker = workerFor(workers, payloadTaskId, resolvedDispatchId, terminalHandle);
  const dispatchTask = resolvedDispatchId
    ? [...taskMap.values()].find((candidate) => candidate.dispatch_id === resolvedDispatchId)
    : undefined;
  const taskId = payloadTaskId ?? worker?.taskId ?? dispatchTask?.id ?? null;
  // A worker message can omit one or both identity fields (heartbeats and
  // older harnesses do this). The fleet row is the durable identity source;
  // carry its Dispatch through instead of rendering a Task conversation with
  // an unexplained null Dispatch.
  const dispatchId = resolvedDispatchId ?? worker?.dispatchId ?? null;
  const task = taskId ? taskMap.get(taskId) : undefined;
  const harness = worker?.projection?.launch?.agent ?? worker?.projection?.provider?.id ?? null;
  const model = worker?.projection?.launch?.model ?? worker?.projection?.provider?.model ?? null;
  const label = taskLabel(task, taskId);
  const rejected = Boolean(payload._orcaLifecycleRejection) || /^Rejected\s/i.test(subject);
  const eventId =
    typeof message.id === "string" && message.id
      ? message.id
      : `malformed:${createdAt}:${dispatchId ?? taskId ?? "unknown"}`;
  const base = {
    id: eventId,
    runId: message.run_id,
    taskId,
    dispatchId,
    direction: outbound ? ("coordinator_to_agent" as const) : ("agent_to_coordinator" as const),
    actor: outbound
      ? ({ role: "coordinator", label: "Coordinator", harness: null, model: null } as const)
      : {
          role: taskId && taskId === leadTaskId ? ("lead" as const) : ("worker" as const),
          label,
          harness,
          model,
        },
    createdAt,
    groupedCount: 1,
    technical: {
      messageId: typeof message.id === "string" ? message.id : undefined,
      terminalHandle,
      payload,
      provenance: "orca_message" as const,
    },
  };

  if (rejected) {
    return {
      ...base,
      kind: "unknown",
      severity: "warning",
      title: "Orca rejected a stale lifecycle signal",
      summary: payload._orcaLifecycleRejection?.reason || firstSentence(body || subject),
      detail: body || null,
      actionable: null,
    };
  }

  // A destination Dispatch is durable evidence that this row was authored by
  // the coordinator side of the conversation. `reply` is serialized as a
  // status message whose subject is prefixed with "Re:"; ordinary `send`
  // guidance is also status but keeps its own subject. Render both as outgoing
  // chat bubbles while preserving the real Orca message id as provenance.
  if (outbound) {
    if (messageType === "question") {
      return {
        ...base,
        kind: "question",
        severity: "warning",
        title: "Coordinator asks",
        summary: body || subject || "The coordinator asked the worker a question.",
        detail: null,
        actionable: null,
      };
    }
    if (messageType === "status") {
      const reply = /^Re:\s*/i.test(subject);
      return {
        ...base,
        kind: reply ? "reply" : "status",
        severity: "info",
        title: reply
          ? "Coordinator replied to a worker"
          : subject.trim().toLowerCase() === "coordinator guidance"
            ? "Coordinator sent guidance"
            : meaningfulSubject(subject)
              ? subject
              : "Coordinator sent guidance",
        summary: body || subject || "No additional detail was provided.",
        detail: null,
        actionable: null,
      };
    }
    return {
      ...base,
      kind: "status",
      severity: "info",
      title: meaningfulSubject(subject) ? subject : "Coordinator sent a message",
      summary: body || subject || "No additional detail was provided.",
      detail: null,
      actionable: null,
    };
  }

  switch (messageType) {
    case "heartbeat": {
      const phase = typeof payload.phase === "string" && payload.phase.trim() ? payload.phase.trim() : "working";
      return {
        ...base,
        kind: "heartbeat",
        severity: "info",
        title: `${label} is working`,
        summary: phase,
        detail: body || null,
        actionable: null,
      };
    }
    case "status":
      return {
        ...base,
        kind: "status",
        severity: "info",
        title: meaningfulSubject(subject) ? subject : `${label} reported progress`,
        summary: firstSentence(body),
        detail: body || null,
        actionable: null,
      };
    case "question":
      return {
        ...base,
        kind: "question",
        severity: "warning",
        title: `${label} asks`,
        summary: body || subject || "A worker is waiting for an answer.",
        detail: null,
        actionable: pendingIds.has(eventId) ? { kind: "reply", targetId: eventId } : null,
      };
    case "escalation":
      return {
        ...base,
        kind: "escalation",
        severity: "error",
        title: `${label} needs attention`,
        summary: firstSentence(body || subject),
        detail: body || null,
        actionable: pendingIds.has(eventId) ? { kind: "reply", targetId: eventId } : null,
      };
    case "worker_done": {
      const succeeded = payload.outcome === "succeeded";
      const failed = payload.outcome === "failed";
      return {
        ...base,
        kind: "worker_done",
        severity: succeeded ? "success" : failed ? "error" : "warning",
        title: `${label} ${succeeded ? "completed" : failed ? "reported failure" : "reported an outcome"}`,
        summary: meaningfulSubject(subject) ? subject : firstSentence(body),
        detail: body || null,
        actionable: null,
      };
    }
    case "decision_gate":
      return {
        ...base,
        kind: "gate",
        severity: "warning",
        title: `Decision needed for ${label}`,
        summary: body || subject,
        detail: null,
        actionable: null,
      };
    default:
      return {
        ...base,
        kind: "unknown",
        severity: "info",
        title: meaningfulSubject(subject) ? subject : "Unrecognized orchestration event",
        summary: firstSentence(body),
        detail: body || null,
        actionable: null,
      };
  }
}

function debtEvent(runId: string, debt: CleanupDebtItem, createdAt: string): ActivityEvent {
  return {
    id: `debt:${debt.key}`,
    runId,
    taskId: null,
    dispatchId: debt.dispatchId,
    direction: "system",
    actor: { role: "system", label: "Orca", harness: null, model: null },
    kind: "cleanup_debt",
    severity: "warning",
    title: "Worker cleanup needs a decision",
    summary: debt.detail || debt.kind.replaceAll("_", " "),
    detail: null,
    createdAt,
    groupedCount: 1,
    actionable: debt.dispatchId ? { kind: "release", targetId: debt.dispatchId } : null,
    technical: { provenance: "coordinator" },
  };
}

function coalesceHeartbeats(events: ActivityEvent[]): ActivityEvent[] {
  const result: ActivityEvent[] = [];
  for (const event of events) {
    const previous = result[result.length - 1];
    if (
      event.kind === "heartbeat" &&
      previous?.kind === "heartbeat" &&
      event.runId === previous.runId &&
      event.dispatchId === previous.dispatchId &&
      event.summary === previous.summary
    ) {
      previous.groupedCount += event.groupedCount;
      previous.createdAt = event.createdAt;
      previous.id = event.id;
      continue;
    }
    result.push({ ...event });
  }
  return result;
}

/**
 * Viewer actions are journaled immediately so a transient Orca history read
 * cannot make a sent reply disappear. Once `orchestration inbox` exposes the
 * same durable message, prefer that authoritative row (and its real message
 * id) over the optimistic journal copy. Identity + exact body + a narrow time
 * window avoids collapsing two intentional, repeated coordinator messages.
 */
function removeJournalMessageDuplicates(
  journal: ActivityEvent[],
  normalized: ActivityEvent[],
): ActivityEvent[] {
  const durableOutgoing = normalized.filter(
    (event) => event.direction === "coordinator_to_agent" && event.technical.provenance === "orca_message",
  );
  return journal.filter((candidate) => {
    if (
      candidate.technical.provenance !== "viewer_journal" ||
      candidate.direction !== "coordinator_to_agent" ||
      (candidate.kind !== "reply" && candidate.kind !== "status") ||
      candidate.taskId === null ||
      candidate.dispatchId === null
    ) {
      return true;
    }
    const candidateAt = Date.parse(candidate.createdAt);
    return !durableOutgoing.some((durable) => {
      const durableAt = Date.parse(durable.createdAt);
      return (
        durable.taskId === candidate.taskId &&
        durable.dispatchId === candidate.dispatchId &&
        durable.summary.trim() === candidate.summary.trim() &&
        Number.isFinite(candidateAt) &&
        Number.isFinite(durableAt) &&
        Math.abs(durableAt - candidateAt) <= 15_000
      );
    });
  });
}

/** Orca's global inbox exposes a positive durable read bit, but no check log. */
function messageWasRead(message: OrcaMessage): boolean {
  return message.read === 1 || message.read === true;
}

function messageDispatchId(message: OrcaMessage, workers: OrcaWorkerRow[]): string | null {
  const payload = payloadOf(message);
  if (typeof payload.dispatchId === "string" && payload.dispatchId) return payload.dispatchId;
  const destination = typeof message.to_handle === "string" ? message.to_handle : "";
  if (destination.startsWith("dispatch:")) return destination.slice("dispatch:".length) || null;
  return workerFor(
    workers,
    typeof payload.taskId === "string" ? payload.taskId : null,
    null,
    typeof message.from_handle === "string" ? message.from_handle : "",
  )?.dispatchId ?? null;
}

function inferredAgentSummary(
  dispatchId: string,
  batch: OrcaMessage[],
  workers: OrcaWorkerRow[],
  completion: boolean,
): CoordinatorCheckReceipt["agents"][number] | null {
  const worker = workers.find((candidate) => candidate.dispatchId === dispatchId);
  const last = batch.at(-1);
  const payload = last ? payloadOf(last) : {};
  const taskId =
    (typeof payload.taskId === "string" && payload.taskId) ||
    worker?.taskId ||
    null;
  if (!taskId) return null;
  const outcome = payload.outcome === "succeeded" || payload.outcome === "failed" ? payload.outcome : null;
  const verdict = worker?.projection?.liveness?.verdict;
  const liveness = completion && (verdict === "live" || verdict === "exited") ? verdict : "unverifiable";
  return {
    taskId,
    dispatchId,
    liveness,
    activity: completion ? "completion processed" : "coordinator replied",
    detail: completion
      ? "A settled worker record proves the completion batch was checked."
      : "A durable coordinator reply proves the preceding inbox batch was checked.",
    attention: completion ? ["root_completion"] : batch.some((message) => message.type === "question") ? ["input"] : [],
    agent:
      worker?.projection?.launch?.agent ??
      worker?.projection?.provider?.id ??
      "unknown agent",
    model:
      worker?.projection?.launch?.model ??
      worker?.projection?.provider?.model ??
      null,
    effort: worker?.projection?.launch?.effort ?? null,
    outcome,
    observedAt: null,
  };
}

/**
 * Reconstruct meaningful checks performed by a coordinator outside this
 * viewer process. Orca does not expose a check-history endpoint, so this is
 * deliberately evidence-gated:
 *
 * - a coordinator reply proves it consumed the read inbox rows before it;
 * - a settled/released worker proves its read worker_done batch was handled.
 *
 * Quiet/timeout checks leave no durable trace and are never invented. The UI
 * labels every reconstructed receipt as inferred so it cannot be mistaken for
 * a native viewer-loop receipt with an exact Delivery id and duration.
 */
export function inferExternalCoordinatorChecks(
  runId: string,
  messages: OrcaMessage[],
  workers: OrcaWorkerRow[],
): CoordinatorCheckReceipt[] {
  const scopedWorkers = workers.filter((worker) => worker.runId === runId);
  const pendingByDispatch = new Map<string, OrcaMessage[]>();
  const inferred: CoordinatorCheckReceipt[] = [];
  const sorted = messages
    .filter((message) => message.run_id === runId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const append = (
    dispatchId: string,
    batch: OrcaMessage[],
    checkedAt: number,
    boundaryId: string,
    completion: boolean,
  ) => {
    if (batch.length === 0 || !Number.isFinite(checkedAt)) return;
    const agent = inferredAgentSummary(dispatchId, batch, scopedWorkers, completion);
    const types = [...new Set(batch.map((message) => message.type).filter(Boolean))];
    inferred.push({
      sequence: inferred.length + 1,
      checkedAt,
      durationMs: 0,
      deliveryId: `inferred:${boundaryId}`,
      messageCount: batch.length,
      messageTypes: types,
      replayed: false,
      timedOut: false,
      error: null,
      agents: agent ? [agent] : [],
      source: "external_inferred",
      evidence: completion
        ? "Inferred from Orca's read marker plus settled worker accounting; exact check duration and Delivery ID are unavailable."
        : "Inferred from Orca's read marker plus the coordinator's durable reply; exact check duration and Delivery ID are unavailable.",
    });
  };

  for (const message of sorted) {
    const dispatchId = messageDispatchId(message, scopedWorkers);
    if (!dispatchId) continue;
    const inbound = message.to_handle === `run:${runId}`;
    if (inbound && messageWasRead(message)) {
      const pending = pendingByDispatch.get(dispatchId) ?? [];
      pending.push(message);
      pendingByDispatch.set(dispatchId, pending);
      continue;
    }
    const outboundReply =
      message.to_handle === `dispatch:${dispatchId}` &&
      message.type === "status" &&
      /^Re:\s*/i.test(message.subject ?? "");
    if (!outboundReply) continue;
    const pending = pendingByDispatch.get(dispatchId) ?? [];
    if (pending.length === 0) continue;
    append(dispatchId, pending, Date.parse(message.created_at) - 1, message.id, false);
    pendingByDispatch.delete(dispatchId);
  }

  // A completion has no mandatory outbound reply. Settlement plus a terminal
  // ownership decision is the durable boundary proving the coordinator read
  // and processed worker_done rather than merely observing an unread row.
  for (const [dispatchId, pending] of pendingByDispatch) {
    const lastDone = [...pending].reverse().find((message) => message.type === "worker_done");
    if (!lastDone) continue;
    const worker = scopedWorkers.find((candidate) => candidate.dispatchId === dispatchId);
    const settled =
      worker &&
      (worker.dispatchStatus === "completed" ||
        worker.dispatchStatus === "failed" ||
        worker.terminalState !== "active");
    if (!settled) continue;
    append(dispatchId, pending, Date.parse(lastDone.created_at) + 1, lastDone.id, true);
  }
  return inferred;
}

export function buildActivitySnapshot(input: {
  runId: string;
  messages: OrcaMessage[];
  tasks: OrcaTask[];
  workers: OrcaWorkerRow[];
  leadTaskId?: string | null;
  status?: CoordinatorStatus | null;
  journal?: ActivityEvent[];
  persistedChecks?: CoordinatorCheckReceipt[];
  now?: number;
}): ActivitySnapshot {
  const { runId } = input;
  const now = input.now ?? Date.now();
  const taskMap = new Map(input.tasks.filter((task) => task.run_id === runId).map((task) => [task.id, task]));
  const workers = input.workers.filter((worker) => worker.runId === runId);
  const scopedStatus = input.status?.runId === runId ? input.status : null;
  const pendingIds = new Set(scopedStatus?.inbox.pending.map((item) => item.messageId) ?? []);
  const scopedMessages = input.messages.filter((message) => message.run_id === runId);
  const truncated = scopedMessages.length > MAX_HISTORY_MESSAGES;
  const normalized = scopedMessages
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => normalizeMessage(message, taskMap, workers, input.leadTaskId ?? null, pendingIds));
  const debts = (scopedStatus?.cleanupDebt ?? []).map((debt) =>
    debtEvent(runId, debt, new Date(scopedStatus?.lastReconciledAt || now).toISOString()),
  );
  const journal = removeJournalMessageDuplicates(
    (input.journal ?? []).filter((event) => event.runId === runId),
    normalized,
  );
  const events = coalesceHeartbeats([...normalized, ...journal, ...debts].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // worker-list is newest-first. Keep only the newest attempt per Task so a
  // retry does not produce competing live-status strips in the same thread.
  const seenTasks = new Set<string>();
  const presence: StagePresence[] = [];
  const attempts = scopedStatus?.attempts ?? [];
  const presenceFrom = (
    taskId: string,
    dispatchId: string,
    projection: OrcaWorkerRow["projection"] | null,
    attempt: (typeof attempts)[number] | undefined,
  ): StagePresence => {
    // The durable fleet row is authoritative when it carries a field. During
    // a live coordinator session, its in-memory attempt also retains the most
    // recent `check`/reconciliation facts and the worker-start receipt. Merge
    // those only as fallbacks so Chat can describe current work without ever
    // mistaking the user's requested launch values for runtime-applied ones.
    const stage = projection?.stage ?? attempt?.stage ?? null;
    const verdict = projection?.liveness?.verdict ?? attempt?.liveness ?? null;
    return {
      taskId,
      dispatchId,
      liveness: verdict === "live" || verdict === "exited" ? verdict : "unverifiable",
      activity: stage?.activity ?? null,
      detail: stage?.detail ?? null,
      outcome: projection?.outcome ?? attempt?.outcome ?? null,
      attention: projection?.attention?.categories ?? attempt?.attention?.categories ?? [],
      agent:
        projection?.launch?.agent ??
        projection?.provider?.id ??
        attempt?.effective?.agent ??
        null,
      model:
        projection?.launch?.model ??
        projection?.provider?.model ??
        attempt?.effective?.model ??
        null,
      effort: projection?.launch?.effort ?? attempt?.effective?.effort ?? null,
      observedAt: attempt?.lastHeartbeatAt ?? null,
    };
  };
  for (const worker of workers) {
    if (seenTasks.has(worker.taskId)) continue;
    seenTasks.add(worker.taskId);
    const attempt = attempts.find(
      (candidate) => candidate.dispatchId === worker.dispatchId || candidate.taskId === worker.taskId,
    );
    presence.push(presenceFrom(worker.taskId, worker.dispatchId, worker.projection, attempt));
  }
  // Binding/recovery can briefly expose a coordinator attempt before the
  // paged fleet read includes its row. Keep that Task visible, but only with
  // the facts the coordinator already observed; never synthesize a Dispatch.
  for (const attempt of attempts) {
    if (!attempt.dispatchId || seenTasks.has(attempt.taskId)) continue;
    seenTasks.add(attempt.taskId);
    presence.push(presenceFrom(attempt.taskId, attempt.dispatchId, null, attempt));
  }
  // Checks belong to the coordinator's CURRENT Run only. They are already
  // deep-copied by coordinatorStatus; keep the extra map here so this API
  // projection remains immutable even if a caller holds and edits a snapshot.
  // The live coordinator retains every recent pass; the journal keeps only
  // meaningful historical passes. They overlap briefly after an append, so
  // merge by observable receipt identity and prefer the live copy.
  const checkMap = new Map<string, CoordinatorCheckReceipt>();
  for (const receipt of [...(input.persistedChecks ?? []), ...(scopedStatus?.checks ?? [])]) {
    const key = [receipt.checkedAt, receipt.deliveryId ?? "", receipt.messageCount, receipt.error ?? ""].join(":");
    checkMap.set(key, {
      ...receipt,
      messageTypes: [...receipt.messageTypes],
      agents: receipt.agents.map((agent) => ({ ...agent, attention: [...agent.attention] })),
    });
  }
  for (const receipt of inferExternalCoordinatorChecks(runId, scopedMessages, workers)) {
    // Prefer a native viewer receipt when one already accounts for the same
    // meaningful batch near the reconstructed boundary. Delivery ids cannot
    // match because Orca does not publish historical Delivery metadata.
    const nativeOverlap = [...checkMap.values()].some(
      (candidate) =>
        candidate.source !== "external_inferred" &&
        candidate.messageCount === receipt.messageCount &&
        Math.abs(candidate.checkedAt - receipt.checkedAt) <= 30_000 &&
        receipt.messageTypes.every((type) => candidate.messageTypes.includes(type)),
    );
    if (nativeOverlap) continue;
    checkMap.set(receipt.deliveryId!, receipt);
  }
  const checks = [...checkMap.values()].sort((a, b) => a.checkedAt - b.checkedAt);
  return { runId, events, presence, checks, pendingCount: pendingIds.size, truncated, generatedAt: now };
}

export function createViewerActivity(input: {
  runId: string;
  kind: ActivityKind;
  title: string;
  summary: string;
  detail?: string | null;
  taskId?: string | null;
  dispatchId?: string | null;
  severity?: ActivityEvent["severity"];
  actionable?: ActivityEvent["actionable"];
  argv?: string[];
}): ActivityEvent {
  const createdAt = new Date().toISOString();
  return {
    id: `viewer:${Date.now()}:${randomUUID()}`,
    runId: input.runId,
    taskId: input.taskId ?? null,
    dispatchId: input.dispatchId ?? null,
    direction: "coordinator_to_agent",
    actor: { role: "coordinator", label: "Coordinator", harness: null, model: null },
    kind: input.kind,
    severity: input.severity ?? "info",
    title: input.title,
    summary: input.summary,
    detail: input.detail ?? null,
    createdAt,
    groupedCount: 1,
    actionable: input.actionable ?? null,
    technical: { argv: input.argv, provenance: "viewer_journal" },
  };
}

/**
 * A tiny workspace-local journal for actions initiated by this viewer. Orca is
 * still the authority for messages and lifecycle outcomes. The journal keeps
 * viewer-only lifecycle events and provides an optimistic fallback while a
 * newly sent message has not reached (or temporarily cannot be read from) the
 * global Orca inbox; authoritative inbox rows are deduplicated above.
 */
export class ActivityJournal {
  readonly path: string;
  /** Serialize append+rotation so parallel worker starts cannot race a rotate. */
  private appendChain: Promise<void> = Promise.resolve();

  constructor(workspaceDir: string) {
    this.path = join(workspaceDir, ACTIVITY_FILE);
  }

  async append(event: ActivityEvent): Promise<void> {
    await this.appendRecord(event);
  }

  async appendCheck(runId: string, receipt: CoordinatorCheckReceipt): Promise<void> {
    const record: PersistedCheckRecord = {
      recordType: "coordinator_check",
      id: `check:${receipt.checkedAt}:${randomUUID()}`,
      runId,
      createdAt: new Date(receipt.checkedAt).toISOString(),
      receipt,
    };
    await this.appendRecord(record);
  }

  private async appendRecord(record: ActivityEvent | PersistedCheckRecord): Promise<void> {
    const write = this.appendChain.then(async () => {
      await this.rotateIfNeeded();
      await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    });
    // Keep the queue usable after one failed write; the caller still receives
    // the original failure and treats the journal as best-effort UI state.
    this.appendChain = write.catch(() => {});
    await write;
  }

  async list(runId: string): Promise<ActivityEvent[]> {
    return (await this.listHistory(runId)).events;
  }

  async listHistory(runId: string): Promise<ActivityHistory> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { events: [], checks: [] };
      throw err;
    }
    const events: ActivityEvent[] = [];
    const checks: CoordinatorCheckReceipt[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as ActivityEvent | PersistedCheckRecord;
        if (!record || record.runId !== runId || typeof record.id !== "string") continue;
        if ((record as PersistedCheckRecord).recordType === "coordinator_check") {
          const receipt = (record as PersistedCheckRecord).receipt;
          if (
            receipt &&
            typeof receipt.checkedAt === "number" &&
            Array.isArray(receipt.messageTypes) &&
            Array.isArray(receipt.agents)
          ) {
            checks.push(receipt);
          }
          continue;
        }
        events.push(record as ActivityEvent);
      } catch {
        // A torn final append must not make the whole activity history unreadable.
      }
    }
    return {
      events: events.slice(-MAX_HISTORY_MESSAGES),
      checks: checks.slice(-MAX_HISTORY_MESSAGES),
    };
  }

  private async rotateIfNeeded(): Promise<void> {
    let size = 0;
    try {
      size = (await stat(this.path)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (size < JOURNAL_MAX_BYTES) return;
    const data = await readFile(this.path);
    const start = Math.max(0, data.length - JOURNAL_KEEP_BYTES);
    const firstNewline = data.indexOf(0x0a, start);
    const kept = firstNewline >= 0 ? data.subarray(firstNewline + 1) : data.subarray(start);
    await writeFile(this.path, kept);
  }
}
