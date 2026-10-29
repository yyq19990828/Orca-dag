import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import type { ProviderSessionBinding } from "./providerSessions";

const execute = promisify(execFile);
const TOKEN = /^[A-Za-z0-9._-]{1,128}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface OpenCodeModel { providerID: string; id: string; variant?: string }
// The full TUI truncates long titles in OSC-0. Keep all 128 UUID bits within
// its title budget rather than accepting truncated/non-unique prefixes.
export function openCodeTuiTitle(requestId: string): string {
  return `odag:${requestId.replaceAll("-", "")}`;
}
export interface OpenCodeLaunch {
  requestId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  workspace: string;
  /** Missing on historical full-TUI rows; the reader normalizes it to tui. */
  frontend?: "mini" | "tui";
  requestedModel?: OpenCodeModel | null;
  /** Null only before a session model is resolved, with no pane/Dispatch. */
  model: OpenCodeModel | null;
  terminal: string | null;
  terminalTitle: string;
  dispatchId: string | null;
  /** Unknown effects stay prepared, never silently classified as closed. */
  state: "prepared" | "bound" | "closed" | "retained";
}

/** A selected frontend never falls back to another worker after refusal. */
export async function verifyOpenCodeVersion(workspace: string): Promise<void> {
  try {
    const { stdout } = await execute("opencode", ["--version"], {
      cwd: workspace, shell: false, timeout: 3_000, maxBuffer: 4096, encoding: "utf8",
    });
    const match = /^(?:opencode v?|v)?(\d+)\.(\d+)\.(\d+)$/.exec(stdout.trim());
    if (match) {
      const [, major, minor, patch] = match.map(Number);
      if (major > 2 || major === 2 && (minor > 1 || minor === 1 && patch >= 2)) return;
    }
  } catch { /* No diagnostic passthrough: launch environments may carry credentials. */ }
  throw new Error("Explicit OpenCode UI requires a verified OpenCode >= 2.1.2 in the worker workspace");
}

/** Unspecified variant means use the provider's default, not discard a requested variant. */
export function assertOpenCodeModelSelection(requested: OpenCodeModel | null, selected: OpenCodeModel): void {
  if (requested && (requested.providerID !== selected.providerID || requested.id !== selected.id ||
      requested.variant !== undefined && requested.variant !== selected.variant)) {
    throw new Error("OpenCode did not preserve the requested session model/variant");
  }
}
export interface OpenCodeEvidence {
  source: "opencode-api";
  sessionId: string;
  state: "input_unproven" | "input_accepted" | "turn_started";
  userMessageId: string | null;
  assistantMessageId: string | null;
  model: OpenCodeModel | null;
  userOwned: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function validateOpenCodeModel(value: unknown): OpenCodeModel {
  const row = record(value);
  if (typeof row.providerID !== "string" || !TOKEN.test(row.providerID) ||
      typeof row.id !== "string" || !MODEL_ID.test(row.id) ||
      (row.variant !== undefined && (typeof row.variant !== "string" || !TOKEN.test(row.variant))) ||
      Object.keys(row).some(key => !["providerID", "id", "variant"].includes(key))) {
    throw new Error("Invalid OpenCode Model.Ref");
  }
  return { providerID: row.providerID, id: row.id, ...(row.variant ? { variant: row.variant as string } : {}) };
}

/**
 * V2 session.create canonicalizes an omitted variant to `default` (observed
 * with OpenCode 2.0.28). That wire sentinel means no override, not a wildcard:
 * provider/model and every explicitly selected variant must still match.
 */
export function sameOpenCodeModel(value: unknown, expected: OpenCodeModel): boolean {
  const actual = validateOpenCodeModel(value);
  return actual.providerID === expected.providerID && actual.id === expected.id &&
    (actual.variant ?? "default") === (expected.variant ?? "default");
}

/** #variant and effort are two spellings of the same V2 Model.Ref field. */
export function parseOpenCodeModel(value: string, effort?: string | null): OpenCodeModel {
  // Some providers (e.g. OpenRouter) namespace their model ID with slashes.
  // Only the FIRST slash separates provider from model; JSON carries the rest.
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9][A-Za-z0-9._:/-]*)(?:#([A-Za-z0-9._-]+))?$/.exec(value);
  if (!match) throw new Error("OpenCode model must be provider/model[#variant]");
  if (effort && match[3] && effort !== match[3]) throw new Error("OpenCode effort conflicts with the model variant");
  return validateOpenCodeModel({ providerID: match[1], id: match[2], ...(effort || match[3] ? { variant: effort || match[3] } : {}) });
}

/** Same discovery/authentication as the full TUI; never hard-code a service port. */
export async function openCodeApi(workspace: string, method: string, path: string, body?: unknown): Promise<unknown> {
  try {
    const { stdout } = await execute("opencode", ["api", method, path,
      ...(body === undefined ? [] : ["--data", JSON.stringify(body)])], {
      cwd: workspace, shell: false, encoding: "utf8", timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch {
    // CLI diagnostics can contain request bodies or credentials. Do not expose
    // those in the viewer's activity journal or HTTP errors.
    throw new Error(`OpenCode API ${method} ${path.split("?")[0]} unavailable or invalid`);
  }
}

/** V2 session.create leaves model empty unless given one. Ask the official
 * resolver for this workspace's default, never choose the first listed model.
 * Model.Info also contains provider settings; copy only the public reference. */
export async function readOpenCodeDefaultModel(workspace: string): Promise<OpenCodeModel> {
  const response = record(await openCodeApi(workspace, "GET", `/api/model/default?location[directory]=${encodeURIComponent(workspace)}`));
  const selected = record(response.data);
  if (selected.enabled !== true) throw new Error("OpenCode default model is unavailable in this workspace");
  return validateOpenCodeModel({ providerID: selected.providerID, id: selected.id,
    ...(selected.variant === undefined ? {} : { variant: selected.variant }) });
}

export async function verifyOpenCodeModel(workspace: string, model: OpenCodeModel, resolved = false): Promise<void> {
  const response = record(await openCodeApi(workspace, "GET", `/api/model?location[directory]=${encodeURIComponent(workspace)}`));
  const rows = Array.isArray(response.data) ? response.data.map(record) : [];
  const matches = rows.filter(row => row.providerID === model.providerID && row.id === model.id && row.enabled === true);
  // V2 reports the resolved default as a sentinel, absent from variants[].
  // Only trust that sentinel on an actual session response, not a free-text override.
  if (matches.length !== 1 || (model.variant && !(resolved && model.variant === "default") &&
      (!Array.isArray(matches[0].variants) || !matches[0].variants.some(v => record(v).id === model.variant)))) {
    throw new Error("The requested OpenCode model/variant is not uniquely available in this workspace");
  }
}

export async function verifyOpenCodeSession(launch: OpenCodeLaunch): Promise<Record<string, unknown>> {
  const data = record(record(await openCodeApi(launch.workspace, "GET", `/api/session/${encodeURIComponent(launch.sessionId)}`)).data);
  const directory = record(data.location).directory;
  if (data.id !== launch.sessionId || typeof directory !== "string" || await realpath(directory) !== launch.workspace) {
    throw new Error("OpenCode session identity/workspace mismatch");
  }
  return data;
}
export interface OpenCodeBoundRead {
  status: "active" | "idle" | "exited" | "unknown" | "unavailable";
  statusDetail: string;
  model: OpenCodeModel | null;
  modelSource: "assistant-message" | "session" | null;
  messages: Record<string, unknown>[];
  complete: boolean;
  userOwned: boolean;
}

function marker(text: string, id: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`).test(text);
}

export function safeToolInput(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[depth limited]";
  if (Array.isArray(value)) return value.slice(0, 40).map(item => safeToolInput(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" ? value.slice(0, 2_000) : value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    if (/auth|token|secret|password|credential|api.?key|setting/i.test(key)) continue;
    result[key] = safeToolInput(item, depth + 1);
  }
  return result;
}

/** Read only an already-bound one-shot session; never discover by recency. */
export async function readOpenCodeBoundSession(binding: ProviderSessionBinding): Promise<OpenCodeBoundRead> {
  const title = `orca-dag:${binding.runId}:${binding.taskId}:${binding.dispatchId}`;
  const workspace = await realpath(binding.workspace).catch(() => null);
  if (binding.harness !== "opencode" || binding.host !== "local:local" || workspace !== binding.workspace) {
    throw new Error("Bound OpenCode session is not on this canonical local workspace.");
  }
  const session = record(record(await openCodeApi(workspace, "GET", `/api/session/${encodeURIComponent(binding.sessionId)}`)).data);
  const directory = record(session.location).directory;
  if (session.id !== binding.sessionId || session.title !== title || typeof directory !== "string" ||
      await realpath(directory).catch(() => null) !== workspace) {
    throw new Error("OpenCode session identity, title, or workspace did not match its durable binding.");
  }
  const messages: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const deadline = Date.now() + 8_000;
  let cursor: string | null = null;
  let complete = false;
  // CLI 2.2.0 can exit successfully with truncated JSON on large history
  // responses. Small pages keep ordinary tool-heavy sessions readable; the
  // same 800-message/time bounds still make oversized history explicit.
  for (let page = 0; page < 160 && Date.now() < deadline; page++) {
    const path = `/api/session/${encodeURIComponent(binding.sessionId)}/message?limit=5` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "&order=asc");
    const response = record(await openCodeApi(workspace, "GET", path));
    if (!Array.isArray(response.data) || !response.cursor || typeof response.cursor !== "object") {
      throw new Error("OpenCode returned a malformed message page.");
    }
    messages.push(...response.data.map(record));
    const next = record(response.cursor).next;
    if (next === null) { complete = true; break; }
    if (typeof next !== "string" || seen.has(next)) throw new Error("OpenCode returned an invalid message cursor.");
    seen.add(next);
    cursor = next;
  }
  const users = messages.filter(message => message.type === "user");
  const assigned = users.filter(message => typeof message.text === "string" &&
    marker(message.text, binding.taskId) && marker(message.text, binding.dispatchId));
  if (assigned.length !== 1) throw new Error("OpenCode history did not prove exactly one assigned Task/Dispatch preamble.");
  const assignedIndex = messages.indexOf(assigned[0]);
  const laterUser = messages.findIndex((message, index) => index > assignedIndex && message.type === "user");
  const userOwned = laterUser >= 0 || users.length > 1;
  const scoped = messages.slice(assignedIndex + 1, laterUser < 0 ? undefined : laterUser);
  const assistant = scoped.find(message => message.type === "assistant" && message.model);
  let model: OpenCodeModel | null = null;
  let modelSource: OpenCodeBoundRead["modelSource"] = null;
  if (assistant) {
    try { model = validateOpenCodeModel(assistant.model); modelSource = "assistant-message"; } catch { /* effective model remains unknown */ }
  }
  if (!model && session.model) {
    try { model = validateOpenCodeModel(session.model); modelSource = "session"; } catch { /* effective model remains unknown */ }
  }
  const activeResponse = record(await openCodeApi(workspace, "GET", "/api/session/active"));
  if (!activeResponse.data || typeof activeResponse.data !== "object" || Array.isArray(activeResponse.data)) {
    throw new Error("OpenCode returned a malformed active-session map.");
  }
  const active = record(record(activeResponse.data)[binding.sessionId]);
  let status: OpenCodeBoundRead["status"] = "unknown";
  let statusDetail = "OpenCode returned no conclusive state for this exact session.";
  const activeState = typeof active.type === "string" ? active.type.toLowerCase() : typeof active.status === "string" ? active.status.toLowerCase() : "";
  if (["running", "busy", "retry"].includes(activeState)) {
    status = "active"; statusDetail = `OpenCode reports the exact session as ${activeState}.`;
  } else if (activeState === "idle") {
    status = "idle"; statusDetail = "OpenCode reports this exact session as idle; Task outcome remains separate.";
  } else if (complete && !Object.keys(active).length && ["succeeded", "failed", "interrupted", "cancelled"].includes(String(session.outcome).toLowerCase())) {
    status = "exited"; statusDetail = `OpenCode reports this exact session execution as ${String(session.outcome).toLowerCase()}.`;
  }
  return { status, statusDetail, model, modelSource, messages: scoped, complete, userOwned };
}


export function validateOpenCodeLaunch(value: unknown): OpenCodeLaunch {
  const row = record(value);
  const keys = ["requestId", "runId", "taskId", "sessionId", "workspace", "model", "frontend", "requestedModel", "terminal", "terminalTitle", "dispatchId", "state"];
  if (Object.keys(row).some(key => !keys.includes(key))) throw new Error("Unknown OpenCode launch fields");
  for (const key of ["requestId", "runId", "taskId", "sessionId"]) {
    if (typeof row[key] !== "string" || !ID.test(row[key] as string)) throw new Error(`Invalid OpenCode launch ${key}`);
  }
  for (const key of ["terminal", "dispatchId"]) {
    if (row[key] !== null && (typeof row[key] !== "string" || !ID.test(row[key] as string))) throw new Error(`Invalid OpenCode launch ${key}`);
  }
  if (typeof row.workspace !== "string" || !row.workspace.startsWith("/") || row.workspace.length > 4096 || row.workspace.includes("\0") ||
      ![openCodeTuiTitle(String(row.requestId)), `orca-dag OpenCode TUI · ${row.requestId}`].includes(String(row.terminalTitle)) ||
      !["prepared", "bound", "closed", "retained"].includes(String(row.state)) ||
      (row.state === "bound" && (!row.terminal || !row.dispatchId))) throw new Error("Invalid OpenCode launch identity/state");
  if (row.frontend !== undefined && row.frontend !== "mini" && row.frontend !== "tui") throw new Error("Invalid OpenCode frontend");
  if (row.model === null && (row.terminal !== null || row.dispatchId !== null)) throw new Error("OpenCode terminal requires a resolved model");
  const model = row.model === null ? null : validateOpenCodeModel(row.model);
  const requestedModel = row.requestedModel === undefined ? model :
    row.requestedModel === null ? null : validateOpenCodeModel(row.requestedModel);
  return { ...row, frontend: row.frontend ?? "tui", requestedModel, model } as unknown as OpenCodeLaunch;
}

/** Bounded, ascending history. Hitting a budget is uncertainty, not absence. */
export async function readOpenCodeExecution(launch: OpenCodeLaunch): Promise<{
  evidence: OpenCodeEvidence; messages: Record<string, unknown>[]; complete: boolean; exited: boolean;
}> {
  const session = await verifyOpenCodeSession(launch);
  const messages: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let complete = false;
  const deadline = Date.now() + 15_000;
  for (let page = 0; page < 10 && Date.now() < deadline; page++) {
    const path = `/api/session/${encodeURIComponent(launch.sessionId)}/message?limit=100` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "&order=asc");
    const response = record(await openCodeApi(launch.workspace, "GET", path));
    if (!Array.isArray(response.data) || !response.cursor || typeof response.cursor !== "object") throw new Error("Invalid OpenCode message page");
    messages.push(...response.data.map(record));
    const next = record(response.cursor).next;
    if (next === null) { complete = true; break; }
    if (typeof next !== "string" || seen.has(next)) throw new Error("Invalid OpenCode message cursor");
    seen.add(next); cursor = next;
  }
  const users = messages.filter(m => m.type === "user");
  const assigned = users.filter(m => typeof m.text === "string" && launch.dispatchId &&
    // The live preamble contains Task + Dispatch, but no Run ID on 1.4.222.
    // Run scope comes from the saved creation identity and exact Orca binding,
    // not from a third marker the runtime never injects.
    [launch.taskId, launch.dispatchId].every(id => marker(m.text as string, id)));
  const user = assigned.length === 1 ? assigned[0] : null;
  const start = user ? messages.indexOf(user) : -1;
  // A new user prompt is new ownership, not a coordinator follow-up. The first
  // release must not interrupt or close that work even if the old Task settled.
  const userOwned = users.length > 1 || (users.length === 1 && !user);
  const scoped = start >= 0 ? messages.slice(start + 1, messages.findIndex((m, i) => i > start && m.type === "user") < 0
    ? undefined : messages.findIndex((m, i) => i > start && m.type === "user")) : [];
  const assistant = scoped.find(m => m.type === "assistant" && typeof m.id === "string");
  const evidence: OpenCodeEvidence = {
    source: "opencode-api", sessionId: launch.sessionId,
    state: assistant ? "turn_started" : user ? "input_accepted" : "input_unproven",
    userMessageId: typeof user?.id === "string" ? user.id : null,
    assistantMessageId: typeof assistant?.id === "string" ? assistant.id : null,
    model: assistant ? validateOpenCodeModel(assistant.model) : null, userOwned,
  };
  const activeData = record(await openCodeApi(launch.workspace, "GET", "/api/session/active")).data;
  if (!activeData || typeof activeData !== "object" || Array.isArray(activeData)) throw new Error("Invalid OpenCode active-session map");
  const active = record(activeData);
  // Require a positive final execution outcome AND absence from a valid active
  // map. A live TUI is not a live server execution; an empty map alone is not exit.
  const exited = complete && !active[launch.sessionId] && ["succeeded", "failed", "interrupted", "cancelled"].includes(String(session.outcome));
  return { evidence, messages: scoped, complete, exited };
}

export async function interruptOpenCodeExecution(launch: OpenCodeLaunch): Promise<void> {
  const before = await readOpenCodeExecution(launch);
  if (!before.complete || before.evidence.userOwned || before.evidence.state === "input_unproven") {
    throw new Error("OpenCode execution ownership is unproven or user-owned; refusing interruption");
  }
  if (before.exited) return;
  const result = record(await openCodeApi(launch.workspace, "POST", `/api/session/${encodeURIComponent(launch.sessionId)}/interrupt?resume=false`));
  if (typeof result.interrupted !== "boolean") throw new Error("OpenCode did not confirm the interrupt request");
  for (let i = 0; i < 8; i++) {
    const after = await readOpenCodeExecution(launch);
    if (after.evidence.userOwned) throw new Error("OpenCode session became user-owned during Stop");
    if (after.exited) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("OpenCode execution exit is not confirmed; Orca stop was not attempted");
}
