import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";

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
  model: OpenCodeModel;
  terminal: string | null;
  terminalTitle: string;
  dispatchId: string | null;
  /** Unknown effects stay prepared, never silently classified as closed. */
  state: "prepared" | "bound" | "closed" | "retained";
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

export async function verifyOpenCodeModel(workspace: string, model: OpenCodeModel): Promise<void> {
  const response = record(await openCodeApi(workspace, "GET", `/api/model?location[directory]=${encodeURIComponent(workspace)}`));
  const rows = Array.isArray(response.data) ? response.data.map(record) : [];
  const matches = rows.filter(row => row.providerID === model.providerID && row.id === model.id && row.enabled === true);
  if (matches.length !== 1 || (model.variant &&
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

export function validateOpenCodeLaunch(value: unknown): OpenCodeLaunch {
  const row = record(value);
  const keys = ["requestId", "runId", "taskId", "sessionId", "workspace", "model", "terminal", "terminalTitle", "dispatchId", "state"];
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
  return { ...row, model: validateOpenCodeModel(row.model) } as unknown as OpenCodeLaunch;
}

function marker(text: string, id: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`).test(text);
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
