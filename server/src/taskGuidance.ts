import {
  newRequestId, OrcaCliError, parseWorkerStartReceipt, sendCoordinatorMessage,
  showRequest, showWorkerDetail,
  type OrcaRequestReceipt, type TaskMessageReceipt, type WorkerDetailView, type WorkerStartReceipt,
} from "./orca";
import type { GuidanceSendCheckpoint, ProviderSessionStore } from "./providerSessions";

export interface TaskGuidanceInput {
  runId: string;
  taskId: string;
  dispatchId: string;
  from: string;
  subject: string;
  body: string;
  threadId?: string;
}

export interface TaskGuidanceResult {
  receipt: TaskMessageReceipt;
  creationProven: boolean;
  startReceipt?: WorkerStartReceipt;
  createdWorker?: WorkerDetailView;
}

export interface ReconciledTaskGuidance {
  checkpoint: GuidanceSendCheckpoint;
  result: TaskGuidanceResult;
}

export interface TaskGuidanceDependencies {
  store: Pick<ProviderSessionStore, "listGuidanceSends" | "recordGuidanceSend">;
  send?: typeof sendCoordinatorMessage;
  showRequest?: (id: string) => Promise<OrcaRequestReceipt | null>;
  showWorker?: (id: string) => Promise<WorkerDetailView | null>;
  /** Bounded audit only; the checkpoint, not this optional hook, is authority. */
  audit?: (row: GuidanceSendCheckpoint) => Promise<void>;
  newRequestId?: () => string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Only worker-show's Dispatch record proves scope; fleet and request echoes do not. */
export function exactWorkerDispatch(
  detail: WorkerDetailView | null, runId: string, taskId: string, dispatchId: string,
): detail is WorkerDetailView & { dispatch: NonNullable<WorkerDetailView["dispatch"]> } {
  return detail?.dispatch?.id === dispatchId && detail.dispatch.runId === runId && detail.dispatch.taskId === taskId;
}

/** Parse only identities actually returned by Orca. In particular the
 * message's payload describes the original request, not the routed worker. */
export async function normalizeTaskMessageReceipt(
  raw: unknown, input: Pick<TaskGuidanceInput, "runId" | "taskId" | "dispatchId">,
  requestId: string, showWorker: (id: string) => Promise<WorkerDetailView | null> = showWorkerDetail,
): Promise<TaskGuidanceResult> {
  const row = record(raw);
  const started = ["follow_up", "reopened", "started_fresh"].includes(String(row.delivery)) && !!text(row.followUpOf);
  if (row.ok === false || (row.delivery !== undefined && !started)) throw new Error("Unrecognized native send receipt");
  const mutation = record(row.mutation);
  if ((row.requestId !== undefined && row.requestId !== requestId) ||
      (mutation.requestId !== undefined && mutation.requestId !== requestId)) {
    throw new Error("Send receipt request identity mismatched");
  }
  let dispatchId: string | null;
  let taskId: string | null;
  let startReceipt: WorkerStartReceipt | undefined;
  let createdWorker: WorkerDetailView | undefined;
  let destinationRunId: string | null = null;
  if (started) {
    if (row.runId !== input.runId) throw new Error("Follow-up receipt Run identity is missing or mismatched");
    dispatchId = text(row.dispatchId);
    taskId = text(row.taskId);
    if (!taskId || !dispatchId || dispatchId === input.dispatchId || dispatchId === row.followUpOf) {
      throw new Error("Follow-up receipt lacks a distinct Task/Dispatch identity");
    }
    const worker = await showWorker(dispatchId);
    if (!exactWorkerDispatch(worker, input.runId, taskId, dispatchId) ||
        worker.dispatch.creatorDispatchId != null ||
        (worker.dispatch.followUpOf != null && worker.dispatch.followUpOf !== row.followUpOf)) {
      throw new Error("Follow-up creation could not be verified against the exact native Dispatch record");
    }
    createdWorker = worker;
    startReceipt = parseWorkerStartReceipt(row, true);
    startReceipt.requestId ??= requestId;
  } else {
    const message = record(row.message);
    const destination = text(message.to_handle) ?? text(message.to);
    const messageRun = text(message.run_id);
    const redirect = messageRun && messageRun !== input.runId && destination === `run:${messageRun}` &&
      Array.isArray(row.warnings) && row.warnings.some(value => {
        const warning = record(value);
        return warning.code === "recipient_run_bound_redirect" && warning.recipient === `dispatch:${input.dispatchId}`;
      });
    if (redirect) {
      destinationRunId = messageRun;
      dispatchId = input.dispatchId;
      taskId = input.taskId;
    } else {
      if (messageRun !== input.runId) throw new Error("Message receipt Run identity is missing or mismatched");
      dispatchId = destination?.startsWith("dispatch:") ? destination.slice("dispatch:".length) : null;
      taskId = dispatchId === input.dispatchId ? input.taskId : null;
    }
    if (dispatchId && !taskId) {
      const detail = await showWorker(dispatchId);
      if (!detail || detail.dispatchId !== dispatchId || detail.runId !== input.runId || !detail.taskId) {
        throw new Error("Routed follow-up identity could not be verified in the requested Run");
      }
      taskId = detail.taskId;
    }
  }
  if (!dispatchId || !taskId) throw new Error("Send receipt lacks authoritative Task/Dispatch identity");
  const receipt: TaskMessageReceipt = {
    kind: destinationRunId ? "recipient_run_bound_redirect" : dispatchId === input.dispatchId && !started ? "enqueued" : "follow_up",
    runId: input.runId, taskId, dispatchId, requestedTaskId: input.taskId,
    requestedDispatchId: input.dispatchId, followUpOf: started ? text(row.followUpOf) : null, requestId, destinationRunId,
  };
  return { receipt, creationProven: started, ...(startReceipt ? { startReceipt, createdWorker } : {}) };
}

async function saveCheckpoint(deps: TaskGuidanceDependencies, row: GuidanceSendCheckpoint): Promise<void> {
  await deps.store.recordGuidanceSend(row);
  if (deps.audit) await deps.audit(row).catch(() => {});
}

async function acceptReceipt(
  raw: unknown, row: GuidanceSendCheckpoint, deps: TaskGuidanceDependencies,
): Promise<ReconciledTaskGuidance> {
  try {
    const result = await normalizeTaskMessageReceipt(raw, {
      runId: row.runId, taskId: row.requestedTaskId, dispatchId: row.requestedDispatchId,
    }, row.requestId, deps.showWorker);
    if (row.receipt && (row.receipt.kind !== result.receipt.kind ||
        row.receipt.runId !== result.receipt.runId || row.receipt.taskId !== result.receipt.taskId ||
        row.receipt.dispatchId !== result.receipt.dispatchId || row.receipt.followUpOf !== result.receipt.followUpOf ||
        row.receipt.destinationRunId !== result.receipt.destinationRunId || row.creationProven !== result.creationProven)) {
      throw new Error("Recovered guidance identity conflicts with the accepted receipt");
    }
    // Revalidate terminal checkpoints without rewriting their accepted state.
    // A follow-up can have settled even though its original readiness was unknown.
    if (row.state === "enqueued" || row.state === "follow_up") return { checkpoint: row, result };
    const ready = (!result.startReceipt || result.startReceipt.status === "ready") &&
      (!row.startEvidence || row.startEvidence.status === "ready");
    row = { ...row, state: ready ? (result.receipt.kind === "recipient_run_bound_redirect" ? "enqueued" : result.receipt.kind) : "unknown", receipt: result.receipt,
      creationProven: result.creationProven,
      ...(result.startReceipt && !row.startEvidence ? { startEvidence: { status: result.startReceipt.status, launchMode: result.startReceipt.launchMode } } : {}),
      updatedAt: new Date().toISOString(), error: ready ? null : "follow_up_start_unconfirmed" };
    await saveCheckpoint(deps, row);
    return { checkpoint: row, result };
  } catch (error) {
    if (row.state === "prepared") {
      await saveCheckpoint(deps, { ...row, state: "unknown", updatedAt: new Date().toISOString(), error: "receipt_unresolved" });
    }
    throw new OrcaCliError(`Guidance request ${row.requestId} could not be verified: ${String((error as Error).message ?? error)}`, "guidance_unknown");
  }
}

/** Reconcile a durable checkpoint using only the exact native request's
 * recorded receipt. Never retry a mutation or fabricate a guidance body. */
export async function recoverTaskGuidance(
  row: GuidanceSendCheckpoint, deps: TaskGuidanceDependencies,
): Promise<ReconciledTaskGuidance> {
  let probe: OrcaRequestReceipt | null;
  try {
    probe = await (deps.showRequest ?? showRequest)(row.requestId);
  } catch {
    throw new OrcaCliError(`Guidance request ${row.requestId} remains unresolved; inspect it before another send`, "guidance_unknown");
  }
  if (!probe || probe.requestId !== row.requestId || probe.raw.requestId !== row.requestId ||
      probe.state !== "completed" || probe.raw.method !== "orchestration.send" || !probe.outcome) {
    throw new OrcaCliError(`Guidance request ${row.requestId} remains unresolved; inspect it before another send`, "guidance_unknown");
  }
  return acceptReceipt(probe.outcome, row, deps);
}

/** Persist before the native effect, and reconcile ambiguous prior sends by
 * read-only request-show. Never send a new body while any prior send to the
 * same worker is unresolved, including after process restart. */
export async function performTaskGuidance(input: TaskGuidanceInput, deps: TaskGuidanceDependencies): Promise<TaskGuidanceResult> {
  const prior = (await deps.store.listGuidanceSends(input.runId)).find(row =>
    row.requestedTaskId === input.taskId && row.requestedDispatchId === input.dispatchId &&
    (row.state === "prepared" || row.state === "unknown"));
  if (prior) {
    const priorResult = await recoverTaskGuidance(prior, deps);
    if (priorResult.checkpoint.state === "unknown") {
      throw new OrcaCliError(`Follow-up request ${prior.requestId} has unconfirmed readiness; inspect its Dispatch`, "guidance_unknown");
    }
    // The recovered receipt belongs to the previous body, which is not stored.
    // It cannot acknowledge this new input; ask the caller to submit it again.
    throw new OrcaCliError(`Previous guidance request ${prior.requestId} was reconciled; submit the new guidance again`, "guidance_reconciled");
  }
  const timestamp = new Date().toISOString();
  let row: GuidanceSendCheckpoint = {
    requestId: (deps.newRequestId ?? newRequestId)(), runId: input.runId,
    requestedTaskId: input.taskId, requestedDispatchId: input.dispatchId, from: input.from,
    state: "prepared", receipt: null, creationProven: false, createdAt: timestamp, updatedAt: timestamp, error: null,
  };
  await saveCheckpoint(deps, row);
  let raw: unknown;
  try {
    raw = await (deps.send ?? sendCoordinatorMessage)({ ...input, requestId: row.requestId });
  } catch (error) {
    const e = error as OrcaCliError;
    const data = record(record(record(e.payload).error).data);
    const refused = data.effectsApplied === false;
    row = { ...row, state: refused ? "refused" : "unknown", updatedAt: new Date().toISOString(), error: e.code ?? "unknown" };
    await saveCheckpoint(deps, row);
    throw error;
  }
  const accepted = await acceptReceipt(raw, row, deps);
  if (accepted.checkpoint.state === "unknown") {
    throw new OrcaCliError(`Follow-up request ${row.requestId} has unconfirmed readiness; inspect its Dispatch`, "guidance_unknown");
  }
  return accepted.result;
}
