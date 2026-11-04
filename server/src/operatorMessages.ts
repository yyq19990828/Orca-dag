import { createHash } from "node:crypto";
import { newRequestId, OrcaCliError, replyToMessage, sendCoordinatorGroupMessage, showRequest, type OrcaRequestReceipt } from "./orca";
import type { OperatorMessageCheckpoint, ProviderSessionStore } from "./providerSessions";

export interface OperatorMessageDependencies {
  store: Pick<ProviderSessionStore, "listOperatorMessages" | "recordOperatorMessage" | "listMailboxChecks" | "recordMailboxCheck">;
  showRequest?: (id: string) => Promise<OrcaRequestReceipt | null>;
  reply?: typeof replyToMessage;
  sendGroup?: typeof sendCoordinatorGroupMessage;
  newRequestId?: () => string;
}
export interface OperatorReplyInput { runId: string; messageId: string; body: string; from: string; sourceThreadId?: string | null }
export interface OperatorGroupInput { runId: string; audience: string; subject: string; body: string; type: string; priority?: string | null; from: string }
export interface OperatorMessageResult { requestId: string; outcome: Record<string, unknown> }
export type OperatorMessagePreflight =
  | ({ operation: "reply" } & Omit<OperatorReplyInput, "from">)
  | ({ operation: "group" } & Omit<OperatorGroupInput, "from">);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Original thread identifies the reply; its actual mailbox may belong to a nested Run. */
export function replyReceiptMatches(value: unknown, runId: string, messageId: string, sourceThreadId?: string | null): boolean {
  const outcome = record(value);
  const question = record(outcome.question);
  const message = record(outcome.message);
  if (Object.keys(question).length) return question.message_id === messageId && question.run_id === runId;
  if (message.run_id === runId) return true;
  return !!sourceThreadId && typeof message.id === "string" &&
    message.thread_id === sourceThreadId && typeof message.run_id === "string" &&
    message.to_handle === `run:${message.run_id}`;
}

function receiptMatches(row: OperatorMessageCheckpoint, value: unknown): value is Record<string, unknown> {
  const outcome = record(value);
  if (row.operation === "reply") {
    return replyReceiptMatches(outcome, row.runId, row.target, row.sourceThreadId);
  }
  if (!Array.isArray(outcome.messages) || typeof outcome.recipients !== "number" || outcome.recipients !== outcome.messages.length) return false;
  return outcome.messages.every(raw => {
    const message = record(raw);
    // A workspace audience spans Runs; a Run group may also contain the
    // canonical mailbox of a nested coordinator. The exact native request
    // proves enqueue only, never ownership of the destination.
    if (row.target.toLowerCase().startsWith("@worktree:")) {
      return typeof message.id === "string" && typeof message.to_handle === "string" &&
        (typeof message.run_id === "string" || message.run_id === null);
    }
    if (message.run_id === row.runId) return true;
    return typeof message.id === "string" && typeof message.run_id === "string" &&
      message.to_handle === `run:${message.run_id}`;
  });
}

export async function recoverOperatorMessage(row: OperatorMessageCheckpoint, deps: OperatorMessageDependencies): Promise<OperatorMessageResult> {
  let probe: OrcaRequestReceipt | null;
  try { probe = await (deps.showRequest ?? showRequest)(row.requestId); } catch { probe = null; }
  if (!probe || probe.requestId !== row.requestId || probe.state !== "completed" ||
      probe.raw.method !== (row.operation === "reply" ? "orchestration.reply" : "orchestration.send") ||
      !receiptMatches(row, probe.outcome)) {
    throw Object.assign(new OrcaCliError(`Operator request ${row.requestId} remains unresolved; inspect it before retrying`, "operator_message_unknown"), { requestId: row.requestId });
  }
  await deps.store.recordOperatorMessage({ ...row, state: "completed", outcome: probe.outcome, updatedAt: new Date().toISOString() });
  return { requestId: row.requestId, outcome: probe.outcome };
}

/** Resolve any previous effect before acquiring or binding a coordinator. */
export async function preflightOperatorMessage(input: OperatorMessagePreflight, deps: OperatorMessageDependencies): Promise<OperatorMessageResult | null> {
  const target = input.operation === "reply" ? input.messageId : input.audience;
  if (input.operation === "reply") {
    const checkpoint = (await deps.store.listMailboxChecks(input.runId)).find(row => row.pendingQuestionIds.includes(target));
    const event = checkpoint?.delivery?.messages.find(message => message.id === target);
    if (event?.type === "escalation" && event.payload) {
      let payload: Record<string, unknown> = {};
      try { payload = record(JSON.parse(event.payload)); } catch { /* malformed payload is not stop evidence */ }
      if (["finished", "errored", "needs-input", "exited"].includes(String(payload.stopReason))) {
        throw new OrcaCliError("A worker stop event is not a replyable question", "stop_event_not_question");
      }
    }
    const previous = checkpoint?.replyRequests?.[target];
    if (previous) return performOperatorReply({ ...input, from: previous.from }, deps);
  }
  const rows = await deps.store.listOperatorMessages(input.runId);
  const prior = rows.find(row => row.operation === input.operation && row.target === target && ["prepared", "unknown"].includes(row.state));
  if (!prior) {
    if (input.operation === "reply") {
      const pending = (await deps.store.listMailboxChecks(input.runId)).some(row => row.pendingQuestionIds.includes(target));
      const completed = pending && rows.find(row => row.operation === "reply" && row.target === target && row.state === "completed" && row.outcome);
      if (completed) return performOperatorReply({ ...input, from: completed.from }, deps);
    }
    return null;
  }
  const result = await recoverOperatorMessage(prior, deps);
  const bodyHash = createHash("sha256").update(input.operation === "reply" ? input.body :
    JSON.stringify([input.body, input.subject, input.type, input.priority ?? null])).digest("hex");
  if (input.operation === "reply") {
    await settleMailboxReply({ ...input, from: prior.from }, deps, prior.requestId, prior.from, prior.bodyHash);
  }
  if (prior.bodyHash !== bodyHash) throw Object.assign(new OrcaCliError(`Previous operator request ${prior.requestId} was reconciled; submit the new message again`, "operator_message_reconciled"), { requestId: prior.requestId });
  return result;
}

async function perform(operation: "reply" | "group", input: OperatorReplyInput | OperatorGroupInput, deps: OperatorMessageDependencies): Promise<OperatorMessageResult> {
  const target = operation === "reply" ? (input as OperatorReplyInput).messageId : (input as OperatorGroupInput).audience;
  const hashInput = operation === "reply" ? input.body : JSON.stringify([input.body, (input as OperatorGroupInput).subject, (input as OperatorGroupInput).type, (input as OperatorGroupInput).priority ?? null]);
  const bodyHash = createHash("sha256").update(hashInput).digest("hex");
  const prior = (await deps.store.listOperatorMessages(input.runId)).find(row => row.operation === operation && row.target === target && ["prepared", "unknown"].includes(row.state));
  if (prior) {
    const result = await recoverOperatorMessage(prior, deps);
    if (prior.bodyHash === bodyHash && prior.from === input.from) return result;
    throw Object.assign(new OrcaCliError(`Previous operator request ${prior.requestId} was reconciled; submit the new message again`, "operator_message_reconciled"), { requestId: prior.requestId });
  }
  const now = new Date().toISOString();
  let row: OperatorMessageCheckpoint = { requestId: (deps.newRequestId ?? newRequestId)(), operation, runId: input.runId, target, from: input.from, ...(operation === "reply" ? { sourceThreadId: (input as OperatorReplyInput).sourceThreadId ?? null } : {}), bodyHash, state: "prepared", outcome: null, createdAt: now, updatedAt: now };
  await deps.store.recordOperatorMessage(row);
  let outcome: Record<string, unknown>;
  try {
    outcome = operation === "reply"
      ? await (deps.reply ?? replyToMessage)(target, input.body, input.from, row.requestId)
      : await (deps.sendGroup ?? sendCoordinatorGroupMessage)({ ...(input as OperatorGroupInput), requestId: row.requestId });
  } catch (error) {
    const data = record(record(record((error as OrcaCliError).payload).error).data);
    row = { ...row, state: data.effectsApplied === false ? "refused" : "unknown", updatedAt: new Date().toISOString() };
    await deps.store.recordOperatorMessage(row);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { requestId: row.requestId });
  }
  if (!receiptMatches(row, outcome)) {
    await deps.store.recordOperatorMessage({ ...row, state: "unknown", updatedAt: new Date().toISOString() });
    throw Object.assign(new OrcaCliError(`Operator request ${row.requestId} has an unverified receipt`, "operator_message_unknown"), { requestId: row.requestId });
  }
  await deps.store.recordOperatorMessage({ ...row, state: "completed", outcome, updatedAt: new Date().toISOString() });
  return { requestId: row.requestId, outcome };
}
export async function performOperatorReply(input: OperatorReplyInput, deps: OperatorMessageDependencies): Promise<OperatorMessageResult> {
  const checkpoints = await deps.store.listMailboxChecks(input.runId);
  const checkpoint = checkpoints.find(row => row.pendingQuestionIds.includes(input.messageId));
  const previous = checkpoint?.replyRequests?.[input.messageId];
  const event = checkpoint?.delivery?.messages.find(message => message.id === input.messageId);
  if (event?.type === "escalation" && event.payload) {
    try {
      const payload = record(JSON.parse(event.payload));
      if (["finished", "errored", "needs-input", "exited"].includes(String(payload.stopReason))) {
        throw new OrcaCliError("A worker stop event is not a replyable question", "stop_event_not_question");
      }
    } catch (error) { if (error instanceof OrcaCliError) throw error; }
  }
  if (checkpoint && previous) {
    const bodyHash = createHash("sha256").update(input.body).digest("hex");
    const probe = await (deps.showRequest ?? showRequest)(previous.requestId).catch(() => null);
    const outcome = record(probe?.outcome);
    const original = checkpoint.delivery?.messages.find(message => message.id === input.messageId);
    if (!probe || probe.requestId !== previous.requestId || probe.state !== "completed" || probe.raw.method !== "orchestration.reply" ||
        !replyReceiptMatches(outcome, input.runId, input.messageId, original ? original.thread_id ?? original.id : input.sourceThreadId)) {
      throw Object.assign(new OrcaCliError(`Reply request ${previous.requestId} remains unresolved`, "operator_message_unknown"), { requestId: previous.requestId });
    }
    await settleMailboxReply(input, deps, previous.requestId, previous.from, previous.bodyHash);
    if (bodyHash !== previous.bodyHash) throw Object.assign(new OrcaCliError(`Previous reply ${previous.requestId} was reconciled; submit the new reply again`, "operator_message_reconciled"), { requestId: previous.requestId });
    return { requestId: previous.requestId, outcome };
  }
  if (checkpoint) {
    const hash = createHash("sha256").update(input.body).digest("hex");
    const completed = (await deps.store.listOperatorMessages(input.runId)).find(row =>
      row.operation === "reply" && row.target === input.messageId && row.state === "completed" && row.outcome);
    if (completed?.outcome) {
      await settleMailboxReply(input, deps, completed.requestId, completed.from, completed.bodyHash);
      if (completed.bodyHash !== hash) throw Object.assign(new OrcaCliError(`Previous reply ${completed.requestId} was reconciled; submit the new reply again`, "operator_message_reconciled"), { requestId: completed.requestId });
      return { requestId: completed.requestId, outcome: completed.outcome };
    }
  }
  const result = await perform("reply", input, deps);
  if (checkpoint) await settleMailboxReply(input, deps, result.requestId, input.from, createHash("sha256").update(input.body).digest("hex"));
  return result;
}

async function settleMailboxReply(input: OperatorReplyInput, deps: OperatorMessageDependencies, requestId: string, from: string, bodyHash: string): Promise<void> {
  const checkpoint = (await deps.store.listMailboxChecks(input.runId)).find(row => row.pendingQuestionIds.includes(input.messageId));
  if (!checkpoint) return;
  const pendingQuestionIds = checkpoint.pendingQuestionIds.filter(id => id !== input.messageId);
  await deps.store.recordMailboxCheck({ ...checkpoint, pendingQuestionIds,
    state: checkpoint.state !== "received" && checkpoint.delivery?.deliveryAcknowledged === true && !pendingQuestionIds.length &&
      checkpoint.processedMessageIds.length === checkpoint.delivery.messages.length ? "completed" : checkpoint.state,
    replyRequests: { ...checkpoint.replyRequests, [input.messageId]: { requestId, from, bodyHash, state: "completed" } },
    updatedAt: new Date().toISOString() });
}
export function performOperatorGroupSend(input: OperatorGroupInput, deps: OperatorMessageDependencies): Promise<OperatorMessageResult> { return perform("group", input, deps); }
