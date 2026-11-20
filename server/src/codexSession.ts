import { createHash } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { open, readdir, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { WorkerOutputReceipt, WorkerTranscriptBlock, WorkerTranscriptMessage } from "./orca";

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const ROLLOUT_NAME_PREFIX = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;
const MAX_SEARCH_DEPTH = 5;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_CHARS = 160_000;
const MAX_BLOCK_CHARS = 16_000;
const MAX_LINES = 10_000;
const MAX_MESSAGES = 1_000;
const DISPATCH_HEADER = "You are working inside Orca, a multi-agent IDE. You are a dispatched worker.";
const DISPATCH_LEAD = "Please carry out this task from my Orca coordinator by following the brief I pasted below.";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolveCodexHome(override?: string): string {
  if (override && isAbsolute(override)) return override;
  if (process.env.CODEX_HOME && isAbsolute(process.env.CODEX_HOME)) return process.env.CODEX_HOME;
  return join(homedir(), ".codex");
}

function prefixHash(lines: string[], end: number): string {
  const hash = createHash("sha256");
  for (let i = 0; i < end; i++) hash.update(lines[i]).update("\n");
  return hash.digest("hex").slice(0, 16);
}

function parseTimestampMs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function extractTextParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const rec = asRecord(item);
    if (typeof rec.text === "string" && rec.text.length > 0) {
      parts.push(rec.text);
    }
  }
  return parts.join("\n");
}

function singleTextPart(content: unknown, type: string): string | null {
  if (!Array.isArray(content) || content.length !== 1) return null;
  const part = asRecord(content[0]);
  return part.type === type && typeof part.text === "string" ? part.text.trim() : null;
}

function isExactDispatchPreamble(text: string, taskId: string, dispatchId: string): boolean {
  if (!text.startsWith(DISPATCH_HEADER) && !text.startsWith(DISPATCH_LEAD)) return false;
  // buildDispatchPreamble writes the Task identity in the header and the
  // Dispatch identity in its lifecycle recipes. The authored task body (or
  // another user's prose mentioning the IDs) must never supply that evidence.
  const taskBoundary = /\r?\n=== TASK ===(?:\r?\n|$)/.exec(text);
  if (!taskBoundary) return false;
  const lines = text.slice(0, taskBoundary.index).split(/\r?\n/);
  const header = lines[0] !== DISPATCH_LEAD ? 0 : lines[1] === "" ? 2 : 1;
  if (!/^(?:Your coordinator's (?:terminal handle|Orca session ID)|You are coordinated from .+\. Your coordinator's address here) is: \S+$/.test(lines[header + 1] ?? "")) return false;
  if (lines[header] !== DISPATCH_HEADER || lines[header + 2] !== `Your task ID is: ${taskId}`) return false;
  const commands = lines.indexOf("=== CLI COMMANDS ===", header + 3);
  if (commands < 0 || lines[commands + 1] !== "" || lines[commands + 2] !== "```sh") return false;
  const end = lines.indexOf("```", commands + 3);
  if (end < 0 || lines[end + 2] !== "=== AFTER YOU SEND worker_done ===") return false;

  let sender: string | undefined;
  let escalation = false;
  let done = false;
  const identity = `--task-id ${taskId} --dispatch-id ${dispatchId}`;
  for (let i = commands + 3; i < end; i++) {
    const recipe = /^  (orca(?:-dev|-ide)? orchestration send --from \S+) --type (escalation|worker_done) (.+)$/.exec(lines[i]);
    if (!recipe) continue;
    if (sender !== undefined && sender !== recipe[1]) return false;
    sender = recipe[1];
    if (recipe[2] === "escalation") {
      if (escalation || recipe[3] !== `--subject "Blocked: <reason>" --body "<details>" ${identity}`) return false;
      escalation = true;
    } else {
      if (done || recipe[3] !== `--subject "<short status>" --body "<3-sentence summary: what you did, what you found, what's left>" ${identity} --outcome succeeded`) return false;
      done = true;
    }
  }
  return escalation && done;
}

/**
 * Locate the exact local Codex rollout JSONL file for `sessionId` under
 * `$CODEX_HOME/sessions`, skipping symlinks and refusing ambiguous matches.
 */
export async function findCodexSessionFile(
  sessionId: string,
  codexHomeOverride?: string,
): Promise<string | null> {
  if (!SAFE_SESSION_ID.test(sessionId)) return null;
  const home = await realpath(resolveCodexHome(codexHomeOverride)).catch(() => null);
  if (!home) return null;
  const sessionsDir = join(home, "sessions");
  const info = await lstat(sessionsDir).catch(() => null);
  if (!info?.isDirectory()) return null;

  const exactName = `${sessionId}.jsonl`;
  const suffix = `-${sessionId}.jsonl`;
  const matches: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_SEARCH_DEPTH || matches.length > 1) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length > 1) return;
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && (entry.name === exactName ||
          (entry.name.endsWith(suffix) && ROLLOUT_NAME_PREFIX.test(entry.name.slice(0, -suffix.length))))) {
        matches.push(fullPath);
      }
    }
  }

  try {
    await walk(sessionsDir, 0);
    // An unreadable subtree or a redirected path cannot establish one exact
    // file. The path below the canonical home must not traverse a symlink.
    return matches.length === 1 && await realpath(matches[0]) === matches[0] ? matches[0] : null;
  } catch {
    return null;
  }
}

interface ParsedRawItem {
  id: string | null;
  role: "user" | "assistant" | "tool";
  timestamp: number | null;
  model: string | null;
  blocks: WorkerTranscriptBlock[];
  lines: string[];
}

export interface ParsedCodexSessionResult {
  lines: string[];
  structured: Array<{ startLine: number; message: WorkerTranscriptMessage }>;
  clipped: boolean;
  scopeEnded: boolean;
}

/**
 * Parse and strictly verify a Codex rollout JSONL transcript, scoping output
 * to the exact bound Dispatch (`dispatchId`) inside `sessionId` + `workspace`.
 * Returns `null` if session identity, workspace, or Dispatch scoping cannot be
 * positively verified.
 */
export function parseCodexSessionJsonl(
  raw: string,
  opts: {
    dispatchId: string;
    taskId: string;
    sessionId: string;
    workspace: string;
    normalizeWorkspace?: (p: string) => string | null;
  },
): ParsedCodexSessionResult | null {
  if (!SAFE_SESSION_ID.test(opts.sessionId) || !opts.taskId || !opts.dispatchId || !isAbsolute(opts.workspace)) return null;
  const norm = opts.normalizeWorkspace ?? ((p: string) => resolve(p));
  const expectedWorkspace = norm(opts.workspace);
  if (!expectedWorkspace) return null;
  const rawLines = raw.split(/\r?\n/);

  let metaVerified = false;
  let currentWorkspace: string | null = expectedWorkspace;
  let launchText: string | null = null;
  let launchTurnId: unknown;
  let launchEchoPending = false;
  let scopeEnded = false;
  let currentModel: string | null = null;
  const items: ParsedRawItem[] = [];
  let clipped = false;
  let budget = MAX_TOTAL_CHARS;

  const clipText = (value: string): string => {
    const allowed = Math.min(MAX_BLOCK_CHARS, Math.max(0, budget));
    if (value.length > allowed) clipped = true;
    const out = value.slice(0, allowed);
    budget -= out.length;
    return out;
  };

  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
    const line = rawLines[lineIndex];
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = asRecord(JSON.parse(line));
    } catch {
      // Only a trailing, unterminated record can be a write in progress. A
      // hole in the middle could hide a user prompt or conflicting identity.
      if (lineIndex !== rawLines.length - 1) return null;
      clipped = true;
      break;
    }

    const type = obj.type;
    const payload = asRecord(obj.payload);
    const ts = parseTimestampMs(obj.timestamp);

    if (type === "session_meta") {
      const { id, session_id: sessionId, cwd } = payload;
      if (metaVerified || (id === undefined && sessionId === undefined) ||
          (id !== undefined && id !== opts.sessionId) || (sessionId !== undefined && sessionId !== opts.sessionId) ||
          typeof cwd !== "string" || !isAbsolute(cwd) || norm(cwd) !== expectedWorkspace) return null;
      metaVerified = true;
      continue;
    }

    if (!metaVerified || typeof type !== "string") return null;

    if (type === "event_msg") {
      if (payload.type === "thread_settings_applied") {
        const settings = asRecord(payload.thread_settings);
        if (typeof settings.model === "string" && settings.model.trim()) currentModel = settings.model.trim();
      }
      if (launchText !== null && !scopeEnded) {
        const item = asRecord(payload.item);
        if (payload.type === "task_started" || payload.type === "turn_started") {
          // A new provider turn does not inherit Dispatch ownership.
          scopeEnded = true;
        } else if (payload.type === "user_message" || (payload.type === "item_completed" && item.type === "UserMessage")) {
          // Codex mirrors the submitted response_item as an event before
          // assistant output. No other user event is a proven continuation.
          const echo = payload.type === "user_message"
            ? typeof payload.message === "string" ? payload.message.trim() : null
            : singleTextPart(item.content, "text");
          if (!launchEchoPending || echo !== launchText ||
              (typeof launchTurnId === "string" && typeof payload.turn_id === "string" && payload.turn_id !== launchTurnId)) {
            scopeEnded = true;
          }
          launchEchoPending = false;
        }
      }
      continue;
    }

    if (type === "turn_context") {
      if (typeof payload.model === "string" && payload.model.trim()) currentModel = payload.model.trim();
      if (payload.cwd !== undefined) {
        currentWorkspace = typeof payload.cwd === "string" && isAbsolute(payload.cwd) ? norm(payload.cwd) : null;
        if (launchText !== null && currentWorkspace !== expectedWorkspace) scopeEnded = true;
      }
      continue;
    }

    if (type !== "response_item") continue;

    const pType = payload.type;
    const id = typeof payload.id === "string" ? payload.id : null;

    if (pType === "message" && payload.role === "user") {
      const text = singleTextPart(payload.content, "input_text");
      if (text !== null && isExactDispatchPreamble(text, opts.taskId, opts.dispatchId)) {
        // Even an exact preamble is ambiguous if it was submitted twice.
        if (launchText !== null || currentWorkspace !== expectedWorkspace) return null;
        launchText = text;
        launchTurnId = asRecord(payload.internal_chat_message_metadata_passthrough).turn_id;
        launchEchoPending = true;
        items.push({
          id,
          role: "user",
          timestamp: ts,
          model: null,
          blocks: [{ type: "text", text }],
          lines: [`[user] ${text}`],
        });
      } else if (launchText !== null) {
        // Empty, image-only, and context-looking messages are boundaries too.
        scopeEnded = true;
      }
      continue;
    }
    if (launchText === null || scopeEnded) continue;
    launchEchoPending = false;

    if (pType === "message") {
      if (payload.role !== "assistant") continue;
      const fullText = extractTextParts(payload.content).trim();
      if (!fullText) continue;
      items.push({
        id,
        role: "assistant",
        timestamp: ts,
        model: currentModel,
        blocks: [{ type: "text", text: fullText }],
        lines: [`[assistant] ${fullText}`],
      });
      continue;
    }

    if (pType === "custom_tool_call" || pType === "function_call") {
      const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : "tool";
      const callId = typeof payload.call_id === "string" ? payload.call_id : null;
      const status = typeof payload.status === "string" ? payload.status : null;
      const rawInput = typeof payload.input === "string"
        ? payload.input
        : typeof payload.arguments === "string"
          ? payload.arguments
          : payload.input !== undefined
            ? JSON.stringify(payload.input)
            : "";
      items.push({
        id,
        role: "assistant",
        timestamp: ts,
        model: currentModel,
        blocks: [{ type: "tool-call", name, input: rawInput, callId, status }],
        lines: [`[tool ${name}]${status ? ` ${status}` : ""}${rawInput ? ` ${rawInput}` : ""}`],
      });
      continue;
    }

    if (pType === "custom_tool_call_output" || pType === "function_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : null;
      const output = extractTextParts(payload.output).trim();
      const isError = payload.is_error === true;
      items.push({
        id,
        role: "tool",
        timestamp: ts,
        model: null,
        blocks: [{ type: "tool-result", output, callId, isError }],
        lines: [`[tool result] ${output}`],
      });
    }
  }

  if (launchText === null) return null;
  const lines: string[] = [];
  const structured: Array<{ startLine: number; message: WorkerTranscriptMessage }> = [];

  for (const item of items) {
    if (budget <= 0 || lines.length >= MAX_LINES) {
      clipped = true;
      break;
    }
    const startLine = lines.length;
    const boundedBlocks: WorkerTranscriptBlock[] = [];
    for (const block of item.blocks) {
      if (block.type === "text") {
        const text = clipText(block.text);
        if (text) boundedBlocks.push({ type: "text", text });
      } else if (block.type === "tool-call") {
        boundedBlocks.push({ ...block, input: clipText(block.input) });
      } else if (block.type === "tool-result") {
        boundedBlocks.push({ ...block, output: clipText(block.output) });
      }
    }
    for (const rawLine of item.lines) {
      const sliced = rawLine.slice(0, MAX_BLOCK_CHARS);
      if (rawLine.length > MAX_BLOCK_CHARS) clipped = true;
      const chunks = sliced.split("\n");
      const remaining = MAX_LINES - lines.length;
      lines.push(...chunks.slice(0, remaining));
      if (chunks.length > remaining) clipped = true;
    }
    if (boundedBlocks.length > 0 && structured.length < MAX_MESSAGES) {
      structured.push({
        startLine,
        message: {
          id: item.id,
          role: item.role,
          timestamp: item.timestamp,
          ...(item.model ? { model: item.model } : {}),
          source: "codex-session",
          blocks: boundedBlocks,
        },
      });
    }
  }

  return { lines, structured, clipped, scopeEnded };
}

async function readFileBounded(filePath: string): Promise<{ text: string; fileClipped: boolean } | null> {
  const before = await lstat(filePath, { bigint: true }).catch(() => null);
  if (!before?.isFile()) return null;
  const fh = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK).catch(() => null);
  if (!fh) return null;
  try {
    const info = await fh.stat({ bigint: true });
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) return null;
    const fileClipped = info.size > BigInt(MAX_FILE_BYTES);
    const toRead = fileClipped ? MAX_FILE_BYTES : Number(info.size);
    const buf = Buffer.allocUnsafe(toRead);
    let offset = 0;
    while (offset < toRead) {
      const { bytesRead } = await fh.read(buf, offset, toRead - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    const after = await lstat(filePath, { bigint: true });
    if (offset !== toRead || !after.isFile() || after.dev !== info.dev || after.ino !== info.ino ||
        after.size < info.size || (after.size === info.size && after.mtimeNs !== info.mtimeNs) ||
        await realpath(filePath) !== filePath) return null;
    return { text: buf.toString("utf8"), fileClipped };
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Read a bounded page from an exact local Codex session JSONL file when Orca's
 * `worker-read` could not report a native transcript (e.g., L1 resumed or
 * `--terminal`-attached Codex Dispatches).
 */
export async function readBoundCodexSessionOutput(opts: {
  dispatchId: string;
  taskId: string;
  sessionId: string;
  workspace: string;
  cursor?: string;
  limit?: number;
  status?: WorkerOutputReceipt["status"];
  codexHome?: string;
}): Promise<WorkerOutputReceipt | null> {
  if (!isAbsolute(opts.workspace)) return null;
  const resolvedWorkspace = await realpath(opts.workspace).catch(() => null);
  if (!resolvedWorkspace) return null;
  const filePath = await findCodexSessionFile(opts.sessionId, opts.codexHome);
  if (!filePath) return null;
  const file = await readFileBounded(filePath);
  if (!file) return null;

  const parsed = parseCodexSessionJsonl(file.text, {
    dispatchId: opts.dispatchId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    workspace: resolvedWorkspace,
    normalizeWorkspace: (p: string) => {
      if (p === resolvedWorkspace) return p;
      try {
        return realpathSync(p);
      } catch {
        return null;
      }
    },
  });
  if (!parsed || parsed.structured.length === 0) return null;

  const { lines, structured } = parsed;
  const budgetClipped = parsed.clipped || file.fileClipped;
  const prefix = `codex1:${opts.dispatchId}:${opts.sessionId}:`;
  let sourceChanged = Boolean(opts.cursor && !opts.cursor.startsWith(prefix));
  let offset = 0;
  if (opts.cursor && !sourceChanged) {
    const match = /^(\d+):([a-f0-9]{16})$/.exec(opts.cursor.slice(prefix.length));
    if (!match || !Number.isSafeInteger(Number(match[1]))) {
      sourceChanged = true;
      offset = 0;
    } else {
      offset = Number(match[1]);
      if (offset > lines.length || prefixHash(lines, offset) !== match[2]) {
        sourceChanged = true;
        offset = 0;
      }
    }
  }

  const limit = Math.max(1, Math.min(200, opts.limit ?? 40));
  const page = lines.slice(offset, offset + limit);
  const pageMessages = structured
    .filter((entry) => entry.startLine >= offset && entry.startLine < offset + page.length)
    .map((entry) => entry.message);
  const endOffset = offset + page.length;
  const clipped = budgetClipped || endOffset < lines.length;
  const exited = opts.status?.liveness === "exited";

  return {
    dispatchId: opts.dispatchId,
    source: "codex-session",
    provider: "codex",
    sourceExact: true,
    sourceIdentity: opts.sessionId,
    cursor: `${prefix}${endOffset}:${prefixHash(lines, endOffset)}`,
    lines: page,
    messages: pageMessages,
    contentComplete: !clipped && !parsed.scopeEnded && exited,
    clipped,
    sourceChanged,
    warnings: [
      "Local Codex session transcript (Orca worker-read reported session_not_reported).",
      ...(budgetClipped ? ["Codex session output reached the viewer read budget; this page is not a complete transcript."] : []),
      ...(parsed.scopeEnded ? ["Later session output is not proven to belong to this Dispatch; only the initial Dispatch turn is shown."] : []),
    ],
    ...(opts.status ? { status: opts.status } : {}),
  };
}
