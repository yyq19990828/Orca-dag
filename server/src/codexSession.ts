import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { open, readdir, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { WorkerOutputReceipt, WorkerTranscriptBlock, WorkerTranscriptMessage } from "./orca";

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const MAX_SEARCH_DEPTH = 5;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_CHARS = 160_000;
const MAX_BLOCK_CHARS = 16_000;
const MAX_LINES = 10_000;
const MAX_MESSAGES = 1_000;
const OTHER_DISPATCH_RE = /\bctx_[A-Za-z0-9_-]{4,64}\b/g;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExactMarker(text: string, id: string): boolean {
  if (!id) return false;
  return new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(id)}(?![A-Za-z0-9_-])`).test(text);
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

function isBootstrapBoilerplateUserMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("# AGENTS.md instructions for ") ||
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<permissions instructions>") ||
    trimmed.startsWith("<skills_instructions>")
  );
}

function isDifferentDispatchPreamble(text: string, expectedDispatchId: string): boolean {
  if (!text.includes("You are working inside Orca")) return false;
  const matches: string[] = text.match(OTHER_DISPATCH_RE) ?? [];
  if (matches.length === 0) return false;
  return !matches.includes(expectedDispatchId);
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
  const sessionsDir = join(resolveCodexHome(codexHomeOverride), "sessions");
  try {
    const info = await lstat(sessionsDir);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
  } catch {
    return null;
  }

  const exactName = `${sessionId}.jsonl`;
  const suffix = `-${sessionId}.jsonl`;
  const matches: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_SEARCH_DEPTH || matches.length > 1) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length > 1) return;
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && (entry.name === exactName || entry.name.endsWith(suffix))) {
        matches.push(fullPath);
      }
    }
  }

  await walk(sessionsDir, 0);
  return matches.length === 1 ? matches[0] : null;
}

interface ParsedRawItem {
  id: string | null;
  role: "user" | "assistant" | "tool";
  timestamp: number | null;
  model: string | null;
  textForMatch?: string;
  blocks: WorkerTranscriptBlock[];
  lines: string[];
}

export interface ParsedCodexSessionResult {
  lines: string[];
  structured: Array<{ startLine: number; message: WorkerTranscriptMessage }>;
  clipped: boolean;
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
    normalizeWorkspace?: (p: string) => string;
  },
): ParsedCodexSessionResult | null {
  const norm = opts.normalizeWorkspace ?? ((p: string) => resolve(p));
  const expectedWorkspace = norm(opts.workspace);
  const rawLines = raw.split(/\r?\n/);

  let metaVerified = false;
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

  for (const line of rawLines) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = asRecord(JSON.parse(line));
    } catch {
      // Ignore a trailing half-written line while Codex is actively flushing.
      continue;
    }

    const type = obj.type;
    const payload = asRecord(obj.payload);
    const ts = parseTimestampMs(obj.timestamp);

    if (type === "session_meta") {
      const sid = typeof payload.session_id === "string"
        ? payload.session_id
        : typeof payload.id === "string"
          ? payload.id
          : null;
      const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
      if (sid === opts.sessionId && cwd && norm(cwd) === expectedWorkspace) {
        metaVerified = true;
      }
      continue;
    }

    if (type === "event_msg" && payload.type === "thread_settings_applied") {
      const settings = asRecord(payload.thread_settings);
      if (typeof settings.model === "string" && settings.model.trim()) {
        currentModel = settings.model.trim();
      }
      continue;
    }

    if (type === "turn_context" && typeof payload.model === "string" && payload.model.trim()) {
      currentModel = payload.model.trim();
      continue;
    }

    if (type !== "response_item") continue;

    const pType = payload.type;
    const id = typeof payload.id === "string" ? payload.id : null;

    if (pType === "message") {
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue;
      const fullText = extractTextParts(payload.content).trim();
      if (!fullText) continue;
      if (role === "user" && isBootstrapBoilerplateUserMessage(fullText)) continue;
      items.push({
        id,
        role,
        timestamp: ts,
        model: role === "assistant" ? currentModel : null,
        textForMatch: role === "user" ? fullText : undefined,
        blocks: [{ type: "text", text: fullText }],
        lines: [`[${role}] ${fullText}`],
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

  if (!metaVerified) return null;

  // Scope turns to the exact Dispatch prompt boundary.
  let startIdx = items.findIndex(
    (item) => item.role === "user" && typeof item.textForMatch === "string" && hasExactMarker(item.textForMatch, opts.dispatchId),
  );
  if (startIdx < 0) {
    // Refuse to guess if another Dispatch owns this session.
    const hasForeignDispatch = items.some(
      (item) => item.role === "user" && typeof item.textForMatch === "string" && isDifferentDispatchPreamble(item.textForMatch, opts.dispatchId),
    );
    if (hasForeignDispatch) return null;
    startIdx = items.findIndex(
      (item) => item.role === "user" && typeof item.textForMatch === "string" && hasExactMarker(item.textForMatch, opts.taskId),
    );
    if (startIdx < 0) return null;
  }

  let endIdx = items.length;
  for (let i = startIdx + 1; i < items.length; i++) {
    const item = items[i];
    if (
      item.role === "user" &&
      typeof item.textForMatch === "string" &&
      isDifferentDispatchPreamble(item.textForMatch, opts.dispatchId)
    ) {
      endIdx = i;
      break;
    }
  }

  const scoped = items.slice(startIdx, endIdx);
  const lines: string[] = [];
  const structured: Array<{ startLine: number; message: WorkerTranscriptMessage }> = [];

  for (const item of scoped) {
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

  return { lines, structured, clipped };
}

async function readFileBounded(filePath: string): Promise<{ text: string; fileClipped: boolean } | null> {
  const info = await lstat(filePath).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) return null;
  const fh = await open(filePath, "r").catch(() => null);
  if (!fh) return null;
  try {
    const toRead = Math.min(info.size, MAX_FILE_BYTES);
    const buf = Buffer.allocUnsafe(toRead);
    let offset = 0;
    while (offset < toRead) {
      const { bytesRead } = await fh.read(buf, offset, toRead - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return { text: buf.subarray(0, offset).toString("utf8"), fileClipped: info.size > MAX_FILE_BYTES };
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
  const filePath = await findCodexSessionFile(opts.sessionId, opts.codexHome);
  if (!filePath) return null;
  const file = await readFileBounded(filePath);
  if (!file) return null;

  let resolvedWorkspace = resolve(opts.workspace);
  try {
    resolvedWorkspace = await realpath(opts.workspace);
  } catch {
    // Keep normalized path if workspace moved.
  }

  const parsed = parseCodexSessionJsonl(file.text, {
    dispatchId: opts.dispatchId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    workspace: resolvedWorkspace,
    normalizeWorkspace: (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return resolve(p);
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
    contentComplete: !clipped && exited,
    clipped,
    sourceChanged,
    warnings: [
      "Local Codex session transcript (Orca worker-read reported session_not_reported).",
      ...(budgetClipped ? ["Codex session output reached the viewer read budget; this page is not a complete transcript."] : []),
    ],
    ...(opts.status ? { status: opts.status } : {}),
  };
}
