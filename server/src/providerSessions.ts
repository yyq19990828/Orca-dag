import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { lstat, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { prepareWorkspaceStateFile, workspaceStateReadPath, WORKSPACE_STATE_FILES } from "./workspaceState";
import { validateOpenCodeLaunch, type OpenCodeLaunch } from "./openCode";
import { validateGroupAudience } from "./security";
import type { OrcaDelivery, TaskMessageReceipt, NativeLaunchMode } from "./orca";

const pExecFile = promisify(execFile);
export const SESSIONS_FILE = WORKSPACE_STATE_FILES.sessions;
const STORE_VERSION = 1;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_BINDINGS = 10_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 1_500;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** Provider names whose session IDs can be explicitly bound by this viewer. */
export type ProviderSessionHarness = "claude" | "codex" | "opencode";

/**
 * Liveness evidence for the exact bound provider session. `unknown` means a
 * provider was queried but returned no trustworthy state; `unavailable` means
 * the required local provider API/CLI could not be reached or used.
 */
export type ProviderSessionStatus =
  | "active"
  | "idle"
  | "exited"
  | "unknown"
  | "unavailable";

export type ProviderSessionSource = "manual" | "launch-receipt" | "provider-evidence";

export interface ProviderSessionBindingInput {
  runId: string;
  taskId: string;
  dispatchId: string;
  harness: ProviderSessionHarness;
  sessionId: string;
  /** Exact worker workspace path reported by Orca, which may be a lane path. */
  workspace: string;
  /** `local` or a stable Orca host/environment identity. */
  host: string;
  source: ProviderSessionSource;
}

export interface ProviderSessionBinding extends ProviderSessionBindingInput {
  createdAt: string;
  updatedAt: string;
}

export interface ProviderSessionObservation {
  status: ProviderSessionStatus;
  detail: string;
  observedAt: string;
}

export interface ProbeRecoverySessionInput {
  harness: ProviderSessionHarness;
  sessionId: string;
  workspace: string;
  taskId: string;
  dispatchId: string;
  host: string;
}

export interface MailboxCheckCheckpoint {
  requestId: string;
  runId: string;
  from: string;
  ack: string | null;
  /** A no-wait, unfiltered ordinary check used to drain V3's remaining FIFO. */
  drain?: boolean;
  state: "prepared" | "received" | "pending_input" | "completed" | "unknown";
  delivery: OrcaDelivery | null;
  processedMessageIds: string[];
  pendingQuestionIds: string[];
  replyRequests?: Record<string, { requestId: string; from: string; bodyHash: string; state: "prepared" | "unknown" | "completed" }>;
  /** Stop events are resolved by exact Dispatch evidence, not a fabricated reply. */
  resolvedStopEvents?: Record<string, { dispatchId: string; evidence: string }>;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export interface GuidanceSendCheckpoint {
  requestId: string;
  runId: string;
  requestedTaskId: string;
  requestedDispatchId: string;
  from: string;
  state: "prepared" | "unknown" | "enqueued" | "follow_up" | "refused";
  receipt: TaskMessageReceipt | null;
  creationProven: boolean;
  /** Only bounded native readiness/surface evidence; no send body or effects. */
  startEvidence?: { status: string | null; launchMode?: NativeLaunchMode | null };
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export interface OperatorMessageCheckpoint {
  requestId: string;
  operation: "reply" | "group";
  runId: string;
  target: string;
  from: string;
  /** Original message's thread identity, not the routed destination Run. */
  sourceThreadId?: string | null;
  bodyHash: string;
  state: "prepared" | "unknown" | "completed" | "refused";
  outcome: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionStoreFile {
  version: typeof STORE_VERSION;
  bindings: ProviderSessionBinding[];
  openCodeLaunches?: OpenCodeLaunch[];
  mailboxChecks?: MailboxCheckCheckpoint[];
  guidanceSends?: GuidanceSendCheckpoint[];
  operatorMessages?: OperatorMessageCheckpoint[];
}

type SessionKey = Pick<ProviderSessionBinding, "runId" | "taskId" | "dispatchId">;

const fileQueues = new Map<string, Promise<void>>();

function now(): string {
  return new Date().toISOString();
}

function assertId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new Error(`${name} must be a non-empty identifier`);
  }
}

function assertHost(value: unknown): asserts value is string {
  if (typeof value !== "string" || !HOST_PATTERN.test(value)) {
    throw new Error("host must be a non-empty identifier");
  }
}

function assertWorkspace(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    resolve(value) !== value ||
    value.includes("\0")
  ) {
    throw new Error("workspace must be a normalized absolute path");
  }
}

function assertHarness(value: unknown): asserts value is ProviderSessionHarness {
  if (value !== "claude" && value !== "codex" && value !== "opencode") {
    throw new Error("harness must be claude, codex, or opencode");
  }
}

function assertSource(value: unknown): asserts value is ProviderSessionSource {
  if (value !== "manual" && value !== "launch-receipt" && value !== "provider-evidence") {
    throw new Error("source must be manual, launch-receipt, or provider-evidence");
  }
}

function validateBinding(value: unknown): ProviderSessionBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("session binding must be an object");
  }
  const row = value as Record<string, unknown>;
  const allowed = new Set([
    "runId",
    "taskId",
    "dispatchId",
    "harness",
    "sessionId",
    "workspace",
    "host",
    "source",
    "createdAt",
    "updatedAt",
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key))) {
    throw new Error("session binding contains unknown fields");
  }
  assertId(row.runId, "runId");
  assertId(row.taskId, "taskId");
  assertId(row.dispatchId, "dispatchId");
  assertHarness(row.harness);
  assertId(row.sessionId, "sessionId");
  assertWorkspace(row.workspace);
  assertHost(row.host);
  assertSource(row.source);
  if (!isIsoDate(row.createdAt) || !isIsoDate(row.updatedAt)) {
    throw new Error("session binding timestamps must be valid ISO dates");
  }
  return {
    runId: row.runId,
    taskId: row.taskId,
    dispatchId: row.dispatchId,
    harness: row.harness,
    sessionId: row.sessionId,
    workspace: row.workspace,
    host: row.host,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function recordValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}

function validateMailboxCheck(value: unknown): MailboxCheckCheckpoint {
  const row = recordValue(value, "mailbox checkpoint");
  assertId(row.requestId, "requestId");
  assertId(row.runId, "runId");
  assertId(row.from, "from");
  if (row.ack !== null) assertId(row.ack, "ack");
  if (row.drain !== undefined && typeof row.drain !== "boolean") throw new Error("Invalid mailbox drain flag");
  if (!["prepared", "received", "pending_input", "completed", "unknown"].includes(String(row.state))) throw new Error("Invalid mailbox checkpoint state");
  if (!isIsoDate(row.createdAt) || !isIsoDate(row.updatedAt)) throw new Error("Invalid mailbox checkpoint timestamps");
  if (row.error !== null && typeof row.error !== "string") throw new Error("Invalid mailbox checkpoint error");
  for (const key of ["processedMessageIds", "pendingQuestionIds"] as const) {
    if (!Array.isArray(row[key])) throw new Error(`Invalid mailbox ${key}`);
    for (const id of row[key] as unknown[]) assertId(id, key);
    if (new Set(row[key] as string[]).size !== (row[key] as string[]).length) throw new Error(`Duplicate mailbox ${key}`);
  }
  if (row.replyRequests !== undefined) {
    const replies = recordValue(row.replyRequests, "mailbox reply requests");
    for (const [id, raw] of Object.entries(replies)) {
      assertId(id, "reply message id");
      const reply = recordValue(raw, "mailbox reply request");
      assertId(reply.requestId, "reply requestId");
      assertId(reply.from, "reply from");
      if (typeof reply.bodyHash !== "string" || !/^[a-f0-9]{64}$/.test(reply.bodyHash) ||
          !["prepared", "unknown", "completed"].includes(String(reply.state))) throw new Error("Invalid mailbox reply request");
    }
  }
  if (row.resolvedStopEvents !== undefined) {
    for (const [id, raw] of Object.entries(recordValue(row.resolvedStopEvents, "resolved stop events"))) {
      assertId(id, "stop event id");
      const resolution = recordValue(raw, "stop event resolution");
      assertId(resolution.dispatchId, "stop event dispatchId");
      if (typeof resolution.evidence !== "string" || !resolution.evidence) throw new Error("Invalid stop event evidence");
    }
  }
  if (row.delivery !== null) {
    const delivery = recordValue(row.delivery, "mailbox delivery");
    if (delivery.runId !== row.runId || !Array.isArray(delivery.messages)) throw new Error("Mailbox delivery Run or messages invalid");
    if (delivery.deliveryId !== null) assertId(delivery.deliveryId, "deliveryId");
    for (const raw of delivery.messages) {
      const message = recordValue(raw, "mailbox message");
      assertId(message.id, "message id");
      if (typeof message.run_id !== "string" || typeof message.type !== "string" || typeof message.subject !== "string" ||
          typeof message.body !== "string" || typeof message.from_handle !== "string") throw new Error("Invalid mailbox message identity or body");
    }
  }
  if ((row.state === "received" || row.state === "pending_input") && row.delivery === null) throw new Error("Received mailbox checkpoint needs its delivery");
  return row as unknown as MailboxCheckCheckpoint;
}

function validateGuidanceSend(value: unknown): GuidanceSendCheckpoint {
  const row = recordValue(value, "guidance checkpoint");
  for (const key of ["requestId", "runId", "requestedTaskId", "requestedDispatchId", "from"] as const) assertId(row[key], key);
  if (!["prepared", "unknown", "enqueued", "follow_up", "refused"].includes(String(row.state))) throw new Error("Invalid guidance checkpoint state");
  if (!isIsoDate(row.createdAt) || !isIsoDate(row.updatedAt) || typeof row.creationProven !== "boolean" ||
      (row.error !== null && typeof row.error !== "string")) throw new Error("Invalid guidance checkpoint metadata");
  if (row.receipt !== null) {
    const receipt = recordValue(row.receipt, "guidance receipt");
    if (receipt.runId !== row.runId || receipt.requestedTaskId !== row.requestedTaskId || receipt.requestedDispatchId !== row.requestedDispatchId ||
        !["enqueued", "follow_up", "recipient_run_bound_redirect"].includes(String(receipt.kind))) throw new Error("Guidance receipt lineage mismatch");
    assertId(receipt.taskId, "receipt taskId");
    assertId(receipt.dispatchId, "receipt dispatchId");
    if (receipt.kind === "recipient_run_bound_redirect") {
      assertId(receipt.destinationRunId, "destinationRunId");
      if (receipt.destinationRunId === row.runId || receipt.taskId !== row.requestedTaskId || receipt.dispatchId !== row.requestedDispatchId) throw new Error("Invalid redirect lineage");
    } else if (receipt.destinationRunId != null) throw new Error("Unexpected redirect destination");
    if (receipt.followUpOf !== null) assertId(receipt.followUpOf, "followUpOf");
    if (receipt.requestId !== null && receipt.requestId !== row.requestId) throw new Error("Guidance request identity mismatch");
  }
  if (row.startEvidence !== undefined) {
    const evidence = recordValue(row.startEvidence, "guidance start evidence");
    if (evidence.status !== null && typeof evidence.status !== "string") throw new Error("Invalid guidance start state");
    if (evidence.launchMode !== undefined && evidence.launchMode !== null) {
      const mode = recordValue(evidence.launchMode, "guidance launch mode");
      if (typeof mode.mode !== "string" || !["preferred", "reason", "detail"].every(key =>
        mode[key] === null || typeof mode[key] === "string")) throw new Error("Invalid guidance launch mode");
    }
  }
  if ((row.state === "enqueued" || row.state === "follow_up") && (!row.receipt ||
      ((row.receipt as Record<string, unknown>).kind !== row.state &&
       !(row.state === "enqueued" && (row.receipt as Record<string, unknown>).kind === "recipient_run_bound_redirect")))) throw new Error("Guidance outcome requires its matching receipt");
  if (row.creationProven && (!row.receipt || (row.receipt as Record<string, unknown>).kind !== "follow_up")) throw new Error("Guidance creation proof requires follow-up receipt");
  return row as unknown as GuidanceSendCheckpoint;
}

function validateOperatorMessage(value: unknown): OperatorMessageCheckpoint {
  const row = recordValue(value, "operator message checkpoint");
  for (const key of ["requestId", "runId", "from"] as const) assertId(row[key], key);
  if (row.operation === "reply") assertId(row.target, "reply target");
  else if (row.operation === "group") {
    if (typeof row.target !== "string" || validateGroupAudience(row.target) !== row.target) throw new Error("Invalid operator message target");
  }
  if (row.sourceThreadId != null) assertId(row.sourceThreadId, "source thread id");
  if (!["reply", "group"].includes(String(row.operation)) ||
      !["prepared", "unknown", "completed", "refused"].includes(String(row.state)) ||
      typeof row.bodyHash !== "string" || !/^[a-f0-9]{64}$/.test(row.bodyHash) ||
      !isIsoDate(row.createdAt) || !isIsoDate(row.updatedAt)) throw new Error("Invalid operator message checkpoint");
  if (row.outcome !== null) recordValue(row.outcome, "operator message outcome");
  if (row.state === "completed" && row.outcome === null) throw new Error("Completed operator message requires its receipt");
  return row as unknown as OperatorMessageCheckpoint;
}

function validateInput(value: ProviderSessionBindingInput): ProviderSessionBindingInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("session binding must be an object");
  }
  const row = value as unknown as Record<string, unknown>;
  const allowed = new Set([
    "runId",
    "taskId",
    "dispatchId",
    "harness",
    "sessionId",
    "workspace",
    "host",
    "source",
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key))) {
    throw new Error("session binding contains unknown fields");
  }
  assertId(row.runId, "runId");
  assertId(row.taskId, "taskId");
  assertId(row.dispatchId, "dispatchId");
  assertHarness(row.harness);
  assertId(row.sessionId, "sessionId");
  assertWorkspace(row.workspace);
  assertHost(row.host);
  assertSource(row.source);
  return {
    runId: row.runId,
    taskId: row.taskId,
    dispatchId: row.dispatchId,
    harness: row.harness,
    sessionId: row.sessionId,
    workspace: row.workspace,
    host: row.host,
    source: row.source,
  };
}

function keyOf(key: SessionKey): string {
  assertId(key.runId, "runId");
  assertId(key.taskId, "taskId");
  assertId(key.dispatchId, "dispatchId");
  return JSON.stringify([key.runId, key.taskId, key.dispatchId]);
}

function sameBindingIdentity(
  existing: ProviderSessionBinding,
  incoming: ProviderSessionBindingInput,
): boolean {
  return (
    existing.runId === incoming.runId &&
    existing.taskId === incoming.taskId &&
    existing.dispatchId === incoming.dispatchId &&
    existing.harness === incoming.harness &&
    existing.sessionId === incoming.sessionId &&
    existing.workspace === incoming.workspace &&
    existing.host === incoming.host
  );
}

async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileQueues.get(path) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  fileQueues.set(path, settled);
  void settled.then(() => {
    if (fileQueues.get(path) === settled) fileQueues.delete(path);
  });
  return current;
}

async function readStore(path: string): Promise<SessionStoreFile> {
  let handle;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("session binding store must be a regular file");
    }
    if (info.size > MAX_STORE_BYTES) throw new Error("session binding store is too large");
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: STORE_VERSION, bindings: [] };
    }
    throw error;
  }

  let text: string;
  try {
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  if (Buffer.byteLength(text, "utf8") > MAX_STORE_BYTES) {
    throw new Error("session binding store is too large");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("session binding store contains invalid JSON");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).version !== STORE_VERSION ||
    !Array.isArray((parsed as Record<string, unknown>).bindings)
  ) {
    throw new Error("session binding store has an unsupported format");
  }
  if (Object.keys(parsed as Record<string, unknown>).some((key) => !["version", "bindings", "openCodeLaunches", "mailboxChecks", "guidanceSends", "operatorMessages"].includes(key))) {
    throw new Error("session binding store contains unknown fields");
  }
  const bindings = ((parsed as Record<string, unknown>).bindings as unknown[]).map(validateBinding);
  if (bindings.length > MAX_BINDINGS) throw new Error("session binding store has too many entries");
  const seen = new Set<string>();
  for (const binding of bindings) {
    const key = keyOf(binding);
    if (seen.has(key)) throw new Error("session binding store contains duplicate identities");
    seen.add(key);
  }
  const launches = (parsed as Record<string, unknown>).openCodeLaunches;
  if (launches !== undefined && (!Array.isArray(launches) || launches.length > MAX_BINDINGS)) {
    throw new Error("Invalid OpenCode launch inventory");
  }
  const openCodeLaunches = (launches as unknown[] | undefined)?.map(validateOpenCodeLaunch);
  if (openCodeLaunches && new Set(openCodeLaunches.map(row => row.requestId)).size !== openCodeLaunches.length) {
    throw new Error("Duplicate OpenCode launch request identities");
  }
  const inventories = parsed as Record<string, unknown>;
  if (inventories.mailboxChecks !== undefined && !Array.isArray(inventories.mailboxChecks)) throw new Error("Invalid mailbox checkpoint inventory");
  if (inventories.guidanceSends !== undefined && !Array.isArray(inventories.guidanceSends)) throw new Error("Invalid guidance checkpoint inventory");
  if (inventories.operatorMessages !== undefined && !Array.isArray(inventories.operatorMessages)) throw new Error("Invalid operator message inventory");
  const mailboxChecks = (inventories.mailboxChecks as unknown[] | undefined)?.map(validateMailboxCheck);
  const guidanceSends = (inventories.guidanceSends as unknown[] | undefined)?.map(validateGuidanceSend);
  const operatorMessages = (inventories.operatorMessages as unknown[] | undefined)?.map(validateOperatorMessage);
  for (const rows of [mailboxChecks, guidanceSends, operatorMessages]) {
    if (rows && (rows.length > MAX_BINDINGS || new Set(rows.map(row => row.requestId)).size !== rows.length)) throw new Error("Invalid duplicate or oversized critical checkpoint inventory");
  }
  return { version: STORE_VERSION, bindings, ...(openCodeLaunches ? { openCodeLaunches } : {}),
    ...(mailboxChecks ? { mailboxChecks } : {}), ...(guidanceSends ? { guidanceSends } : {}),
    ...(operatorMessages ? { operatorMessages } : {}) };
}

async function writeStore(path: string, file: SessionStoreFile): Promise<void> {
  // Only settled history can be discarded. Unresolved checks and every
  // follow-up receipt are recovery authority, not rotating audit history.
  const completed = (file.mailboxChecks ?? []).filter(row => row.state === "completed").slice(-100);
  const settledGuidance = (file.guidanceSends ?? []).filter(row => row.state === "enqueued" || row.state === "refused").slice(-100);
  const settledOperator = (file.operatorMessages ?? []).filter(row => row.state === "completed" || row.state === "refused").slice(-100);
  const keptChecks = new Set(completed.map(row => row.requestId));
  const keptGuidance = new Set(settledGuidance.map(row => row.requestId));
  const keptOperator = new Set(settledOperator.map(row => row.requestId));
  const neededByMailbox = (row: OperatorMessageCheckpoint) => row.operation === "reply" &&
    (file.mailboxChecks ?? []).some(check => check.runId === row.runId && check.pendingQuestionIds.includes(row.target));
  const compact: SessionStoreFile = { ...file,
    ...(file.mailboxChecks ? { mailboxChecks: file.mailboxChecks.filter(row => row.state !== "completed" || keptChecks.has(row.requestId)) } : {}),
    ...(file.guidanceSends ? { guidanceSends: file.guidanceSends.filter(row => !["enqueued", "refused"].includes(row.state) || keptGuidance.has(row.requestId)) } : {}),
    ...(file.operatorMessages ? { operatorMessages: file.operatorMessages.filter(row => !["completed", "refused"].includes(row.state) || keptOperator.has(row.requestId) || neededByMailbox(row)) } : {}) };
  let encoded = `${JSON.stringify(compact, null, 2)}\n`;
  // If payloads fill the store, discard only completed history before failing.
  if (Buffer.byteLength(encoded) > MAX_STORE_BYTES) {
    if (compact.mailboxChecks) compact.mailboxChecks = compact.mailboxChecks.filter(row => row.state !== "completed");
    if (compact.guidanceSends) compact.guidanceSends = compact.guidanceSends.filter(row => !["enqueued", "refused"].includes(row.state));
    if (compact.operatorMessages) compact.operatorMessages = compact.operatorMessages.filter(row => !["completed", "refused"].includes(row.state) || neededByMailbox(row));
    encoded = `${JSON.stringify(compact, null, 2)}\n`;
  }
  if (Buffer.byteLength(encoded) > MAX_STORE_BYTES) throw new Error("session binding store is full");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("session binding store must be a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Workspace-local, atomic bindings between Orca Dispatch identity and one
 * exact provider session. Orca task/worker evidence must be checked by the
 * caller before bind(); this store never manufactures session IDs.
 */
export class ProviderSessionStore {
  private readonly path: string;

  constructor(private readonly workspaceDir: string) {
    if (!isAbsolute(workspaceDir)) throw new Error("workspaceDir must be absolute");
    this.path = join(resolve(workspaceDir), SESSIONS_FILE);
  }

  async list(runId?: string): Promise<ProviderSessionBinding[]> {
    if (runId !== undefined) assertId(runId, "runId");
    const { bindings } = await readStore(workspaceStateReadPath(this.workspaceDir, SESSIONS_FILE));
    return runId === undefined ? bindings : bindings.filter((binding) => binding.runId === runId);
  }

  async get(key: SessionKey): Promise<ProviderSessionBinding | null> {
    const identity = keyOf(key);
    const { bindings } = await readStore(workspaceStateReadPath(this.workspaceDir, SESSIONS_FILE));
    return bindings.find((binding) => keyOf(binding) === identity) ?? null;
  }

  async bind(input: ProviderSessionBindingInput): Promise<ProviderSessionBinding> {
    const normalized = validateInput(input);
    const identity = keyOf(normalized);
    return withFileLock(this.path, async () => {
      prepareWorkspaceStateFile(this.workspaceDir, SESSIONS_FILE, true);
      const file = await readStore(this.path);
      const current = file.bindings.find((binding) => keyOf(binding) === identity);
      if (current) {
        if (!sameBindingIdentity(current, normalized)) {
          throw new Error("this Run/Task/Dispatch is already bound to a different provider session");
        }
        return current;
      }
      if (file.bindings.length >= MAX_BINDINGS) {
        throw new Error("session binding store is full");
      }
      const timestamp = now();
      const binding = validateBinding({
        ...normalized,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await writeStore(this.path, {
        ...file,
        version: STORE_VERSION,
        bindings: [...file.bindings, binding],
      });
      return binding;
    });
  }

  async listOpenCodeLaunches(runId?: string): Promise<OpenCodeLaunch[]> {
    if (runId !== undefined) assertId(runId, "runId");
    const file = await readStore(workspaceStateReadPath(this.workspaceDir, SESSIONS_FILE));
    return (file.openCodeLaunches ?? []).filter(row => !runId || row.runId === runId);
  }

  /** Critical identity journal: unlike presentational history this fails closed. */
  async recordOpenCodeLaunch(input: OpenCodeLaunch): Promise<void> {
    const row = validateOpenCodeLaunch(input);
    assertWorkspace(row.workspace);
    await withFileLock(this.path, async () => {
      prepareWorkspaceStateFile(this.workspaceDir, SESSIONS_FILE, true);
      const file = await readStore(this.path);
      const launches = file.openCodeLaunches ?? [];
      const existing = launches.find(v => v.requestId === row.requestId);
      if (existing) {
        for (const key of ["runId", "taskId", "sessionId", "workspace", "terminalTitle", "frontend", "requestedModel"] as const) {
          if (JSON.stringify(existing[key]) !== JSON.stringify(row[key])) throw new Error("OpenCode launch identity cannot change");
        }
        // The one allowed refinement resolves a journaled, not-yet-created
        // session's effective model before any terminal or Dispatch exists.
        if (JSON.stringify(existing.model) !== JSON.stringify(row.model) &&
            !(existing.model === null && row.model !== null && existing.state === "prepared" &&
              !existing.terminal && !existing.dispatchId && !row.terminal && !row.dispatchId && row.state === "prepared")) {
          throw new Error("OpenCode launch identity cannot change");
        }
        if ((existing.terminal && existing.terminal !== row.terminal) ||
            (existing.dispatchId && existing.dispatchId !== row.dispatchId) ||
            (existing.state === "closed" && row.state !== "closed") ||
            (existing.state === "retained" && !["retained", "closed"].includes(row.state))) {
          throw new Error("OpenCode launch ownership cannot be replaced");
        }
      } else {
        if (launches.length >= MAX_BINDINGS) throw new Error("OpenCode launch inventory is full");
        // Check inside the shared write lock, not just before preparation:
        // concurrent callers must never reserve two live sessions for one Task.
        if (launches.some(v => v.runId === row.runId && v.taskId === row.taskId && ["prepared", "bound"].includes(v.state))) {
          throw new Error("An unresolved OpenCode preparation already exists for this Task");
        }
      }
      await writeStore(this.path, { ...file, openCodeLaunches: [...launches.filter(v => v.requestId !== row.requestId), row] });
    });
  }

  async listMailboxChecks(runId?: string): Promise<MailboxCheckCheckpoint[]> {
    if (runId !== undefined) assertId(runId, "runId");
    const file = await readStore(workspaceStateReadPath(this.workspaceDir, SESSIONS_FILE));
    return (file.mailboxChecks ?? []).filter(row => runId === undefined || row.runId === runId);
  }

  async recordMailboxCheck(input: MailboxCheckCheckpoint): Promise<void> {
    const row = validateMailboxCheck(input);
    await withFileLock(this.path, async () => {
      prepareWorkspaceStateFile(this.workspaceDir, SESSIONS_FILE, true);
      const file = await readStore(this.path);
      const rows = file.mailboxChecks ?? [];
      const existing = rows.find(item => item.requestId === row.requestId);
      if (existing) {
        if (existing.runId !== row.runId || existing.from !== row.from || existing.ack !== row.ack || existing.drain !== row.drain || existing.createdAt !== row.createdAt ||
            (existing.state === "completed" && row.state !== "completed") ||
            existing.processedMessageIds.some(id => !row.processedMessageIds.includes(id)) ||
            (existing.delivery && JSON.stringify(existing.delivery) !== JSON.stringify(row.delivery))) {
          throw new Error("Mailbox checkpoint identity or processed evidence cannot change");
        }
        if (existing.pendingQuestionIds.some(id =>
          !row.pendingQuestionIds.includes(id) && row.replyRequests?.[id]?.state !== "completed" && !row.resolvedStopEvents?.[id])) {
          throw new Error("Pending input cannot be cleared without durable resolution");
        }
        for (const [id, old] of Object.entries(existing.resolvedStopEvents ?? {})) {
          if (JSON.stringify(row.resolvedStopEvents?.[id]) !== JSON.stringify(old)) throw new Error("Stop event resolution cannot change");
        }
        for (const [id, old] of Object.entries(existing.replyRequests ?? {})) {
          const next = row.replyRequests?.[id];
          if (!next || next.requestId !== old.requestId || next.from !== old.from || next.bodyHash !== old.bodyHash ||
              (old.state === "completed" && next.state !== "completed")) throw new Error("Mailbox reply identity cannot change");
        }
      } else if (rows.length >= MAX_BINDINGS) throw new Error("Mailbox checkpoint inventory is full");
      await writeStore(this.path, { ...file, mailboxChecks: [...rows.filter(item => item.requestId !== row.requestId), row] });
    });
  }

  async listGuidanceSends(runId?: string): Promise<GuidanceSendCheckpoint[]> {
    if (runId !== undefined) assertId(runId, "runId");
    const file = await readStore(workspaceStateReadPath(this.workspaceDir, SESSIONS_FILE));
    return (file.guidanceSends ?? []).filter(row => runId === undefined || row.runId === runId);
  }

  async recordGuidanceSend(input: GuidanceSendCheckpoint): Promise<void> {
    const row = validateGuidanceSend(input);
    await withFileLock(this.path, async () => {
      prepareWorkspaceStateFile(this.workspaceDir, SESSIONS_FILE, true);
      const file = await readStore(this.path);
      const rows = file.guidanceSends ?? [];
      const existing = rows.find(item => item.requestId === row.requestId);
      if (existing) {
        if (existing.runId !== row.runId || existing.from !== row.from || existing.requestedTaskId !== row.requestedTaskId ||
            existing.requestedDispatchId !== row.requestedDispatchId || existing.createdAt !== row.createdAt ||
            (existing.startEvidence && JSON.stringify(existing.startEvidence) !== JSON.stringify(row.startEvidence)) ||
            (existing.creationProven && !row.creationProven) ||
            (existing.receipt && (!row.receipt || existing.receipt.kind !== row.receipt.kind ||
              existing.receipt.runId !== row.receipt.runId || existing.receipt.taskId !== row.receipt.taskId ||
              existing.receipt.dispatchId !== row.receipt.dispatchId ||
              (existing.receipt.destinationRunId ?? null) !== (row.receipt.destinationRunId ?? null) ||
              (existing.receipt.followUpOf !== null && existing.receipt.followUpOf !== row.receipt.followUpOf) ||
              (existing.receipt.requestId !== null && existing.receipt.requestId !== row.receipt.requestId))) ||
            (["enqueued", "follow_up", "refused"].includes(existing.state) && existing.state !== row.state)) {
          throw new Error("Guidance checkpoint identity or accepted outcome cannot change");
        }
      } else if (rows.length >= MAX_BINDINGS) throw new Error("Guidance checkpoint inventory is full");
      await writeStore(this.path, { ...file, guidanceSends: [...rows.filter(item => item.requestId !== row.requestId), row] });
    });
  }

  async listOperatorMessages(runId?: string): Promise<OperatorMessageCheckpoint[]> {
    if (runId !== undefined) assertId(runId, "runId");
    const file = await readStore(workspaceStateReadPath(this.workspaceDir, SESSIONS_FILE));
    return (file.operatorMessages ?? []).filter(row => runId === undefined || row.runId === runId);
  }

  async recordOperatorMessage(input: OperatorMessageCheckpoint): Promise<void> {
    const row = validateOperatorMessage(input);
    await withFileLock(this.path, async () => {
      prepareWorkspaceStateFile(this.workspaceDir, SESSIONS_FILE, true);
      const file = await readStore(this.path);
      const rows = file.operatorMessages ?? [];
      const existing = rows.find(item => item.requestId === row.requestId);
      if (existing) {
        if (existing.operation !== row.operation || existing.runId !== row.runId ||
            existing.target !== row.target || existing.from !== row.from || existing.bodyHash !== row.bodyHash ||
            existing.sourceThreadId !== row.sourceThreadId || existing.createdAt !== row.createdAt ||
            (["completed", "refused"].includes(existing.state) && JSON.stringify(existing) !== JSON.stringify(row))) {
          throw new Error("Operator message identity or settled outcome cannot change");
        }
      } else {
        if (rows.length >= MAX_BINDINGS) throw new Error("Operator message inventory is full");
        if (rows.some(item => item.runId === row.runId && item.operation === row.operation &&
          item.target === row.target && ["prepared", "unknown"].includes(item.state))) {
          throw new Error("An operator message to this target remains unresolved");
        }
      }
      await writeStore(this.path, { ...file, operatorMessages: [...rows.filter(item => item.requestId !== row.requestId), row] });
    });
  }

  async probe(binding: ProviderSessionBinding): Promise<ProviderSessionObservation> {
    const validated = validateBinding(binding);
    const stored = await this.get(validated);
    if (!stored || !sameBindingIdentity(stored, validated)) {
      return observation("unknown", "No matching stored binding exists for this Run/Task/Dispatch.");
    }
    return probeRecoverySession(validated);
  }
}

function observation(status: ProviderSessionStatus, detail: string): ProviderSessionObservation {
  return { status, detail, observedAt: now() };
}

function isLocalHost(host: string): boolean {
  // Orca projections encode locality as `local:local`. Environment IDs are
  // opaque here, so the provider CLI must never be run for them on this host.
  return host === "local:local";
}

async function localWorkspace(input: ProbeRecoverySessionInput): Promise<string | null> {
  try {
    assertId(input.taskId, "taskId");
    assertId(input.dispatchId, "dispatchId");
    assertId(input.sessionId, "sessionId");
    assertHarness(input.harness);
    assertHost(input.host);
    assertWorkspace(input.workspace);
    if (!isLocalHost(input.host)) return null;
    return await realpath(input.workspace);
  } catch {
    return null;
  }
}

/**
 * Probe only an explicitly bound provider session. Provider status is not
 * Stage completion: `done`/`idle` leaves Orca Task reconciliation to the
 * coordinator, and absence from an index never proves the session exited.
 */
export async function probeRecoverySession(
  input: ProbeRecoverySessionInput,
): Promise<ProviderSessionObservation> {
  const workspace = await localWorkspace(input);
  if (!workspace) {
    return observation(
      "unavailable",
      "The worker workspace is missing or the bound host is not this local machine.",
    );
  }
  if (input.harness === "claude") return probeClaude(input, workspace);
  if (input.harness === "opencode") return probeOpenCode(input, workspace);
  return probeCodex(input, workspace);
}

/**
 * Talk to the already-running local Codex App Server. A new app-server process
 * would report another process's live thread as `notLoaded`, which is not an
 * exit verdict. The shared daemon socket gives the strongest public status
 * available on this host. Never start or resume a thread while probing.
 */
async function codexRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  const codexHome = process.env.CODEX_HOME && isAbsolute(process.env.CODEX_HOME)
    ? process.env.CODEX_HOME
    : join(homedir(), ".codex");
  const socket = join(codexHome, "app-server-control", "app-server-control.sock");
  // Codex publishes a symlink here to its per-user /tmp daemon socket.
  const info = await stat(socket);
  if (!info.isSocket()) throw new Error("Codex App Server endpoint is not a socket");
  return new Promise((resolveRequest, rejectRequest) => {
    const ws = new WebSocket(`ws+unix:${socket}:/`, { maxPayload: MAX_PROVIDER_RESPONSE_BYTES });
    const timer = setTimeout(() => finish(new Error("Codex App Server timed out")), PROBE_TIMEOUT_MS);
    let settled = false;
    function finish(value: unknown, success = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (success) resolveRequest(value);
      else rejectRequest(value);
    }
    ws.on("open", () => ws.send(JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "orca-dag", version: "0.1.0" }, capabilities: { experimentalApi: true } },
    })));
    ws.on("message", (bytes) => {
      let message: Record<string, unknown> | null;
      try { message = asRecord(JSON.parse(String(bytes))); } catch { finish(new Error("Codex App Server returned invalid JSON")); return; }
      if (!message) return;
      if (message.id === 1) {
        if (message.error) { finish(new Error("Codex App Server initialization failed")); return; }
        ws.send(JSON.stringify({ method: "initialized" }));
        ws.send(JSON.stringify({ id: 2, method, params }));
      } else if (message.id === 2) {
        if (message.error) finish(new Error("Codex App Server rejected the session query"));
        else finish(message.result, true);
      }
    });
    ws.on("error", () => finish(new Error("Codex App Server is unavailable")));
    ws.on("close", () => finish(new Error("Codex App Server closed the session query")));
  });
}

async function probeCodex(
  input: ProbeRecoverySessionInput,
  workspace: string,
): Promise<ProviderSessionObservation> {
  let response: unknown;
  try {
    response = await codexRequest("thread/read", { threadId: input.sessionId, includeTurns: false });
  } catch {
    return observation("unavailable", "The shared local Codex App Server could not read this exact thread.");
  }
  const thread = asRecord(asRecord(response)?.thread);
  if (thread?.id !== input.sessionId || typeof thread.cwd !== "string") {
    return observation("unknown", "Codex did not confirm the exact thread ID and workspace.");
  }
  try {
    if ((await realpath(thread.cwd)) !== workspace) {
      return observation("unknown", "Codex reports this thread under a different workspace.");
    }
  } catch {
    return observation("unknown", "Codex's reported thread workspace no longer exists locally.");
  }
  const status = asRecord(thread.status)?.type;
  if (status === "active") return observation("active", "Codex reports this exact loaded thread as active.");
  if (status === "idle") return observation("idle", "Codex reports this exact loaded thread as idle; the Orca Task remains separate.");
  if (status === "notLoaded") return observation("unknown", "This Codex App Server has not loaded the thread; that does not prove its process exited.");
  return observation("unknown", "Codex did not provide a conclusive state for this exact thread.");
}

interface ClaudeAgentRow {
  sessionId?: unknown;
  pid?: unknown;
  status?: unknown;
  state?: unknown;
  cwd?: unknown;
  directory?: unknown;
  workingDirectory?: unknown;
  worktreePath?: unknown;
}

export interface DiscoverProviderSessionInput {
  runId: string;
  taskId: string;
  dispatchId: string;
  harness: ProviderSessionHarness;
  workspace: string;
  host: string;
  /** Orca's exact worker terminal; required for Claude process correlation. */
  workerHandle?: string | null;
}

/**
 * Bind only when a provider-issued ID has one exact correlation to this
 * Dispatch. This is intentionally not a "latest session" search. Ambiguous,
 * truncated, remote, or older provider records leave the binding absent.
 */
export async function discoverProviderSession(
  input: DiscoverProviderSessionInput,
): Promise<string | null> {
  try {
    assertId(input.runId, "runId");
    assertId(input.taskId, "taskId");
    assertId(input.dispatchId, "dispatchId");
    assertHarness(input.harness);
    assertHost(input.host);
    assertWorkspace(input.workspace);
    if (!isLocalHost(input.host)) return null;
    const workspace = await realpath(input.workspace);
    if (input.harness === "codex") return discoverCodex(input, workspace);
    if (input.harness === "opencode") return discoverOpenCode(input, workspace);
    return discoverClaude(input, workspace);
  } catch {
    return null;
  }
}

/** The launch title is an exact, viewer-owned marker, never a task title. */
export function openCodeSessionTitle(runId: string, taskId: string, dispatchId: string): string {
  assertId(runId, "runId");
  assertId(taskId, "taskId");
  assertId(dispatchId, "dispatchId");
  return `orca-dag:${runId}:${taskId}:${dispatchId}`;
}

async function discoverOpenCode(
  input: DiscoverProviderSessionInput,
  workspace: string,
): Promise<string | null> {
  const title = openCodeSessionTitle(input.runId, input.taskId, input.dispatchId);
  const matches = new Set<string>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  const deadline = Date.now() + 4_000;
  for (let page = 0; page < 20; page++) {
    if (Date.now() > deadline) return null;
    const path = cursor ? `/api/session?cursor=${encodeURIComponent(cursor)}` : "/api/session";
    const result = await runOpenCodeApi(workspace, path);
    if (!result.ok) return null;
    const body = asRecord(result.body);
    if (!Array.isArray(body?.data)) return null;
    for (const value of body.data) {
      const row = asRecord(value);
      const location = asRecord(row?.location);
      if (row?.title === title && location?.directory === workspace &&
          typeof row.id === "string" && ID_PATTERN.test(row.id)) matches.add(row.id);
    }
    const next = asRecord(body.cursor)?.next;
    if (next === null || next === undefined) return matches.size === 1 ? [...matches][0] : null;
    if (typeof next !== "string" || seen.has(next)) return null;
    seen.add(next);
    cursor = next;
  }
  return null;
}

async function discoverCodex(
  input: DiscoverProviderSessionInput,
  workspace: string,
): Promise<string | null> {
  const matches = new Set<string>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  const deadline = Date.now() + 4_000;
  for (let page = 0; page < 20; page++) {
    if (Date.now() > deadline) return null;
    const response = asRecord(await codexRequest("thread/list", {
      cwd: workspace,
      cursor,
      limit: 100,
    }));
    if (!Array.isArray(response?.data)) return null;
    for (const value of response.data) {
      const thread = asRecord(value);
      const preview = thread?.preview;
      // Codex's first user message is Orca's injected preamble. Match BOTH
      // immutable IDs as whole tokens; a matching cwd or newest thread alone
      // is never enough. Do not store or log the preview, which may be private.
      if (thread?.cwd === workspace && typeof thread.id === "string" && ID_PATTERN.test(thread.id) &&
          typeof preview === "string" &&
          hasExactMarker(preview, input.taskId) && hasExactMarker(preview, input.dispatchId)) {
        matches.add(thread.id);
      }
    }
    if (response.nextCursor === null || response.nextCursor === undefined) {
      return matches.size === 1 ? [...matches][0] : null;
    }
    if (typeof response.nextCursor !== "string" || seen.has(response.nextCursor)) return null;
    seen.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  return null;
}

function hasExactMarker(text: string, id: string): boolean {
  let index = text.indexOf(id);
  while (index >= 0) {
    const before = index === 0 ? "" : text[index - 1];
    const after = text[index + id.length] ?? "";
    // Orca's generated Run/Task/Dispatch IDs use letters, digits and `_`.
    // Ordinary preamble punctuation such as a trailing period is a boundary.
    if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) return true;
    index = text.indexOf(id, index + 1);
  }
  return false;
}

async function discoverClaude(
  input: DiscoverProviderSessionInput,
  workspace: string,
): Promise<string | null> {
  if (!input.workerHandle || !ID_PATTERN.test(input.workerHandle) || process.platform !== "linux") return null;
  const { stdout } = await pExecFile("claude", ["agents", "--cwd", workspace, "--json", "--all"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: MAX_PROVIDER_RESPONSE_BYTES,
    windowsHide: true,
  });
  const rows = claudeRows(JSON.parse(stdout));
  if (!rows) return null;
  const matches = new Set<string>();
  for (const row of rows) {
    if (row.cwd !== workspace || typeof row.sessionId !== "string" || !ID_PATTERN.test(row.sessionId) ||
        !Number.isSafeInteger(row.pid) || (row.pid as number) <= 0) continue;
    // Claude's public agent list gives PID and session ID but no Orca handle.
    // Correlate that PID with the exact worker terminal environment. Read only
    // the handle; never retain or log the environment or launch capability.
    try {
      const env = await readFile(`/proc/${row.pid}/environ`);
      if (env.length > MAX_PROVIDER_RESPONSE_BYTES) continue;
      const handle = env.toString("utf8").split("\0")
        .find((entry) => entry.startsWith("ORCA_TERMINAL_HANDLE="))?.slice("ORCA_TERMINAL_HANDLE=".length);
      if (handle === input.workerHandle) matches.add(row.sessionId);
    } catch { /* Process exited or belongs to another user. */ }
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function claudeRows(data: unknown): ClaudeAgentRow[] | null {
  if (Array.isArray(data)) return data.filter((row) => asRecord(row) !== null) as ClaudeAgentRow[];
  const record = asRecord(data);
  if (!record) return null;
  for (const key of ["agents", "backgroundAgents", "items"]) {
    if (Array.isArray(record[key])) {
      return (record[key] as unknown[]).filter((row) => asRecord(row) !== null) as ClaudeAgentRow[];
    }
  }
  return null;
}

async function probeClaude(
  input: ProbeRecoverySessionInput,
  workspace: string,
): Promise<ProviderSessionObservation> {
  let stdout: string;
  try {
    ({ stdout } = await pExecFile("claude", ["agents", "--cwd", workspace, "--json", "--all"], {
      cwd: workspace,
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: MAX_PROVIDER_RESPONSE_BYTES,
      windowsHide: true,
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return observation("unavailable", "The Claude CLI is not installed or is not on PATH.");
    }
    if ((error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return observation("unknown", "The Claude agent listing timed out; no liveness conclusion was made.");
    }
    return observation("unavailable", "The Claude CLI could not provide its public agent listing.");
  }

  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return observation("unknown", "The Claude agent listing was not valid JSON.");
  }
  const rows = claudeRows(data);
  if (!rows) return observation("unknown", "The Claude agent listing used an unrecognized JSON shape.");
  const matches = rows.filter((row) => row.sessionId === input.sessionId);
  if (matches.length === 0) {
    return observation("unknown", "The exact session ID was absent from the agent listing; absence does not prove exit.");
  }
  if (matches.length !== 1) {
    return observation("unknown", "The agent listing returned duplicate rows for this session ID.");
  }

  const row = matches[0];
  const reportedWorkspace =
    row.cwd ?? row.directory ?? row.workingDirectory ?? row.worktreePath;
  if (reportedWorkspace !== undefined) {
    if (typeof reportedWorkspace !== "string" || !isAbsolute(reportedWorkspace)) {
      return observation("unknown", "Claude returned a malformed workspace for the exact session.");
    }
    try {
      const sessionWorkspace = await realpath(reportedWorkspace);
      const withinWorkspace = relative(workspace, sessionWorkspace);
      if (
        withinWorkspace !== "" &&
        (withinWorkspace === ".." || withinWorkspace.startsWith(`..${sep}`) || isAbsolute(withinWorkspace))
      ) {
        return observation("unknown", "Claude reports this session outside the Dispatch workspace.");
      }
    } catch {
      return observation("unknown", "Claude's reported session workspace no longer exists locally.");
    }
  }

  const state = typeof row.state === "string" ? row.state.toLowerCase() : "";
  const status = typeof row.status === "string" ? row.status.toLowerCase() : "";
  if (state === "stopped" || state === "failed") {
    return observation("exited", `Claude reports the exact background session as ${state}.`);
  }
  if (status === "busy") {
    return observation("active", "Claude reports the exact session process as busy.");
  }
  if (status === "idle" || state === "done") {
    return observation("idle", "Claude reports the exact session as idle; this does not settle the Orca Task.");
  }
  return observation(
    "unknown",
    "Claude listed the exact session but its state does not prove that it is active or exited.",
  );
}

async function runOpenCodeApi(
  workspace: string,
  path: string,
): Promise<{ ok: true; body: unknown } | { ok: false; detail: string }> {
  let stdout: string;
  try {
    // `opencode api` discovers the configured background service. Hard-coding
    // its default port would miss alternate service ports and could query a
    // different local OpenCode instance. Arguments stay separate from a shell.
    ({ stdout } = await pExecFile("opencode", ["api", "GET", path], {
      cwd: workspace,
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: MAX_PROVIDER_RESPONSE_BYTES,
      windowsHide: true,
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, detail: "The OpenCode CLI is not installed or is not on PATH." };
    }
    if ((error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return { ok: false, detail: "The OpenCode background service query timed out." };
    }
    return { ok: false, detail: "The OpenCode background service did not provide the requested API response." };
  }
  try {
    return { ok: true, body: JSON.parse(stdout) as unknown };
  } catch {
    return { ok: false, detail: "The OpenCode API response was not valid JSON." };
  }
}

async function probeOpenCode(
  input: ProbeRecoverySessionInput,
  workspace: string,
): Promise<ProviderSessionObservation> {
  const session = await runOpenCodeApi(
    workspace,
    `/api/session/${encodeURIComponent(input.sessionId)}`,
  );
  if (!session.ok) return observation("unavailable", session.detail);
  // OpenCode 2 wraps API payloads in `data`; its old `/session/*` paths now
  // serve the SPA as HTML with a successful exit code. Parse and verify the
  // exact V2 session before considering any liveness signal.
  const sessionRecord = asRecord(asRecord(session.body)?.data);
  if (!sessionRecord) {
    return observation("unknown", "OpenCode returned an unrecognized session response.");
  }
  const location = asRecord(sessionRecord.location);
  if (sessionRecord.id !== input.sessionId || typeof location?.directory !== "string") {
    return observation("unknown", "OpenCode did not confirm both the exact session ID and its workspace.");
  }
  try {
    if ((await realpath(location.directory)) !== workspace) {
      return observation("unknown", "OpenCode reports this session under a different workspace.");
    }
  } catch {
    return observation("unknown", "OpenCode's reported session workspace no longer exists locally.");
  }

  const statuses = await runOpenCodeApi(workspace, "/api/session/active");
  if (!statuses.ok) return observation("unavailable", statuses.detail);
  const statusMap = asRecord(asRecord(statuses.body)?.data);
  if (!statusMap) {
    return observation("unknown", "OpenCode returned an unrecognized status response.");
  }
  const row = asRecord(statusMap[input.sessionId]);
  if (!row) {
    const outcome = typeof sessionRecord.outcome === "string"
      ? sessionRecord.outcome.toLowerCase()
      : "";
    if (outcome === "succeeded" || outcome === "failed" || outcome === "cancelled" || outcome === "interrupted") {
      return observation("exited", `OpenCode reports the exact session execution as ${outcome}.`);
    }
    return observation(
      "unknown",
      "OpenCode returned no active entry or terminal outcome for the exact session; absence is not proof of exit.",
    );
  }
  const state = typeof row?.type === "string"
    ? row.type.toLowerCase()
    : typeof row?.status === "string"
      ? row.status.toLowerCase()
      : "";
  if (state === "running" || state === "busy" || state === "retry") {
    return observation("active", `OpenCode reports the exact session as ${state}.`);
  }
  if (state === "idle") {
    return observation("idle", "OpenCode reports the exact session as idle; this does not settle the Orca Task.");
  }
  return observation("unknown", "OpenCode returned an unrecognized status for the exact session.");
}
