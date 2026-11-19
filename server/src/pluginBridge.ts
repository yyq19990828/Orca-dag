import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RequestHandler } from "express";
import {
  prepareWorkspaceRuntimeFile,
  WORKSPACE_DATA_DIR,
  WORKSPACE_ENDPOINT_FILE,
} from "./workspaceState";

/** Companion plugin connection expires if no hello/event/inbox arrives within this window. */
const PLUGIN_CONNECTED_TTL_MS = 25_000;
const MAX_TERMINALS_TRACKED = 64;
const MAX_TOOLS_PER_TERMINAL = 120;
const MAX_PREVIEW_CHARS = 8_192;
const MAX_PENDING_NOTIFICATIONS = 20;
const MAX_PENDING_COMMANDS = 16;

export interface PluginEndpointRecord {
  version: 1;
  port: number;
  pid: number;
  instanceId: string;
  pluginToken: string;
  workspace: string;
  worktree: string;
  startedAt: string;
}

export interface PluginStatusSnapshot {
  connected: boolean;
  pluginId: string | null;
  version: string | null;
  hostApiMinor: number | null;
  grantedCapabilities: string[];
  transport: "loopback-http" | null;
  lastSeenAt: string | null;
  observedAgentCount: number;
}

export interface PluginObservedAgent {
  terminalId: string;
  workspaceId: string | null;
  workspaceListId: string | null;
  paneKey: string | null;
  agent: string | null;
  title: string | null;
  state: string | null;
  sessionId: string | null;
  updatedAt: number;
}

export interface PluginLiveToolEvent {
  id: string;
  observedAt: number;
  agent: string;
  workspaceId: string | null;
  terminalId: string;
  tool: string;
  callId: string | null;
  inputPreview: string;
  inputTruncated: boolean;
  outputPreview: string;
  outputTruncated: boolean;
}

export interface PluginStatusBarSummary {
  text: string;
  tone: "neutral" | "accent" | "success" | "warning" | "danger";
  tooltip: string;
}

export interface PluginNotificationItem {
  id: string;
  title: string;
  body?: string;
}

export interface PluginCommandEnvelope {
  id: string;
  kind: "agent.resume" | "agents.list" | "agent.listSessions" | "workspace.list";
  params: Record<string, unknown>;
  createdAt: number;
}

export type PluginWakeEvent =
  | { kind: "status"; terminalId: string; state: string | null; sessionId: string | null }
  | { kind: "tool"; terminalId: string; event: PluginLiveToolEvent }
  | { kind: "prompt"; terminalId: string };

export function createPluginToken(): string {
  return randomBytes(24).toString("base64url");
}

function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Auth middleware for companion-plugin loopback endpoints. Uses a dedicated
 * per-process token written to `0o600` `.orca-dag/endpoint.json`, separate from
 * the web UI's `/api/session` mutation token.
 */
export function requirePluginToken(expectedToken: string): RequestHandler {
  return (req, res, next) => {
    const provided = req.header("x-orca-plugin-token");
    if (typeof provided !== "string" || !provided || !tokenMatches(expectedToken, provided)) {
      res.status(403).json({
        error: "Invalid or missing Orca plugin token.",
        code: "invalid_plugin_token",
      });
      return;
    }
    next();
  };
}

/**
 * Atomically publish this viewer's loopback endpoint for the companion plugin.
 * Must be called ONLY after `listenLoopback` acquires its port. Never writes
 * through symlinks.
 */
export function writePluginEndpointFile(
  workspaceDir: string,
  record: PluginEndpointRecord,
): { path: string; createdDir: boolean } {
  const dirExisted = existsSync(join(workspaceDir, WORKSPACE_DATA_DIR));
  const target = prepareWorkspaceRuntimeFile(workspaceDir, WORKSPACE_ENDPOINT_FILE, true);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    // Re-verify target is not a symlink before replacing.
    try {
      const st = lstatSync(target);
      if (!st.isFile() || st.isSymbolicLink()) {
        throw new Error(`${target} must be a regular file; left untouched`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  return { path: target, createdDir: !dirExisted };
}

/**
 * Remove `.orca-dag/endpoint.json` on clean exit, ONLY if it still belongs to
 * this viewer `instanceId` (so a stopping instance never deletes a newer one).
 * When `removeEmptyDir` is true (this process created `.orca-dag/` solely for
 * the ephemeral endpoint file), also removes the directory via non-recursive
 * `rmdirSync` if and only if it is completely empty.
 */
export function removePluginEndpointFile(
  workspaceDir: string,
  instanceId: string,
  opts: { removeEmptyDir?: boolean } = {},
): boolean {
  try {
    const target = prepareWorkspaceRuntimeFile(workspaceDir, WORKSPACE_ENDPOINT_FILE, false);
    const st = lstatSync(target);
    if (!st.isFile() || st.isSymbolicLink()) return false;
    const raw = JSON.parse(readFileSync(target, "utf8")) as { instanceId?: unknown };
    if (raw?.instanceId !== instanceId) return false;
    unlinkSync(target);
    if (opts.removeEmptyDir) {
      try {
        const dir = join(workspaceDir, WORKSPACE_DATA_DIR);
        const dirStat = lstatSync(dir);
        if (dirStat.isDirectory() && !dirStat.isSymbolicLink()) rmdirSync(dir);
      } catch {
        // Non-empty (user wrote config/plans) or gone — leave untouched.
      }
    }
    return true;
  } catch {
    return false;
  }
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * In-memory companion plugin bridge (M1).
 *
 * Security & authority boundaries:
 * - Tool inputs/outputs are kept strictly in bounded RAM rings and NEVER
 *   persisted to `.orca-dag/activity.jsonl` or any other durable store.
 * - Plugin status/tool events are presentation & wakeup hints ONLY — never
 *   Orca Task settlement or terminal custody authority.
 */
export class PluginBridge {
  private pluginId: string | null = null;
  private version: string | null = null;
  private hostApiMinor: number | null = null;
  private grantedCapabilities: string[] = [];
  private lastSeenMs = 0;

  private readonly agentsByTerminal = new Map<string, PluginObservedAgent>();
  private readonly toolsByTerminal = new Map<string, PluginLiveToolEvent[]>();
  private readonly wakeListeners = new Set<(event: PluginWakeEvent) => void>();

  private readonly pendingNotifications: PluginNotificationItem[] = [];
  private readonly pendingCommands: PluginCommandEnvelope[] = [];
  private readonly receiptWaiters = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly inboxWaiters = new Set<() => void>();
  private statusSummaryProvider: (() => PluginStatusBarSummary | null) | null = null;
  private lastDeliveredStatusSig = "";
  private closed = false;

  setStatusSummaryProvider(provider: () => PluginStatusBarSummary | null): void {
    this.statusSummaryProvider = provider;
  }

  private touch(): void {
    this.lastSeenMs = Date.now();
  }

  private notifyInboxWaiters(): void {
    for (const wake of [...this.inboxWaiters]) {
      this.inboxWaiters.delete(wake);
      wake();
    }
  }

  private emitWake(event: PluginWakeEvent): void {
    for (const listener of [...this.wakeListeners]) {
      try {
        listener(event);
      } catch {
        // Never let one listener break ingestion.
      }
    }
  }

  onWake(listener: (event: PluginWakeEvent) => void): () => void {
    this.wakeListeners.add(listener);
    return () => {
      this.wakeListeners.delete(listener);
    };
  }

  hello(input: unknown): PluginStatusSnapshot {
    const rec = input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
    this.pluginId = boundedString(rec.pluginId, 64) ?? "orchestration-panel";
    this.version = boundedString(rec.version, 32) ?? "0.0.0";
    this.hostApiMinor =
      typeof rec.hostApiMinor === "number" && Number.isFinite(rec.hostApiMinor)
        ? Math.max(0, Math.min(999, Math.round(rec.hostApiMinor)))
        : null;
    this.grantedCapabilities = Array.isArray(rec.grantedCapabilities)
      ? rec.grantedCapabilities
          .filter((c): c is string => typeof c === "string")
          .map((c) => c.slice(0, 64))
          .slice(0, 32)
      : [];
    this.touch();
    return this.status();
  }

  status(now = Date.now()): PluginStatusSnapshot {
    const connected = !this.closed && this.lastSeenMs > 0 && now - this.lastSeenMs <= PLUGIN_CONNECTED_TTL_MS;
    return {
      connected,
      pluginId: this.pluginId,
      version: this.version,
      hostApiMinor: this.hostApiMinor,
      grantedCapabilities: [...this.grantedCapabilities],
      transport: this.lastSeenMs > 0 ? "loopback-http" : null,
      lastSeenAt: this.lastSeenMs > 0 ? new Date(this.lastSeenMs).toISOString() : null,
      observedAgentCount: this.agentsByTerminal.size,
    };
  }

  ingestEvents(payload: unknown): { acceptedStatus: number; acceptedTools: number; acceptedPrompts: number } {
    this.touch();
    const rec = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
    let acceptedStatus = 0;
    let acceptedTools = 0;
    let acceptedPrompts = 0;
    const now = Date.now();

    if (Array.isArray(rec.statusEvents)) {
      for (const raw of rec.statusEvents.slice(0, 100)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>;
        const terminalId = boundedString(item.terminalId, 128);
        if (!terminalId) continue;
        const prev = this.agentsByTerminal.get(terminalId);
        const updated: PluginObservedAgent = {
          terminalId,
          workspaceId: boundedString(item.workspaceId, 512) ?? prev?.workspaceId ?? null,
          workspaceListId: boundedString(item.workspaceListId, 256) ?? prev?.workspaceListId ?? null,
          paneKey: boundedString(item.paneKey, 256) ?? prev?.paneKey ?? null,
          agent: boundedString(item.agent, 64) ?? prev?.agent ?? null,
          title: boundedString(item.title, 256) ?? prev?.title ?? null,
          state: boundedString(item.state, 32) ?? prev?.state ?? null,
          sessionId: boundedString(item.sessionId, 256) ?? prev?.sessionId ?? null,
          updatedAt: typeof item.observedAt === "number" && Number.isFinite(item.observedAt) ? item.observedAt : now,
        };
        this.recordAgent(updated);
        acceptedStatus += 1;
        this.emitWake({
          kind: "status",
          terminalId,
          state: updated.state,
          sessionId: updated.sessionId,
        });
      }
    }

    if (Array.isArray(rec.agents)) {
      for (const raw of rec.agents.slice(0, 100)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>;
        const terminalId = boundedString(item.terminalId, 128);
        if (!terminalId) continue;
        const prev = this.agentsByTerminal.get(terminalId);
        this.recordAgent({
          terminalId,
          workspaceId: boundedString(item.workspaceId, 512) ?? prev?.workspaceId ?? null,
          workspaceListId: boundedString(item.workspaceListId, 256) ?? prev?.workspaceListId ?? null,
          paneKey: boundedString(item.paneKey, 256) ?? prev?.paneKey ?? null,
          agent: boundedString(item.agent, 64) ?? prev?.agent ?? null,
          title: boundedString(item.title, 256) ?? prev?.title ?? null,
          state: boundedString(item.state, 32) ?? prev?.state ?? null,
          sessionId: boundedString(item.sessionId, 256) ?? prev?.sessionId ?? null,
          updatedAt: now,
        });
      }
    }

    if (Array.isArray(rec.toolEvents)) {
      for (const raw of rec.toolEvents.slice(0, 100)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>;
        const terminalId = boundedString(item.terminalId, 128);
        const tool = boundedString(item.tool, 128);
        if (!terminalId || !tool) continue;
        const event: PluginLiveToolEvent = {
          id: boundedString(item.id, 128) ?? `ptool_${randomUUID()}`,
          observedAt:
            typeof item.observedAt === "number" && Number.isFinite(item.observedAt) ? item.observedAt : now,
          agent: boundedString(item.agent, 64) ?? "unknown",
          workspaceId: boundedString(item.workspaceId, 512),
          terminalId,
          tool,
          callId: boundedString(item.callId, 128),
          inputPreview: boundedText(item.inputPreview, MAX_PREVIEW_CHARS),
          inputTruncated: Boolean(item.inputTruncated),
          outputPreview: boundedText(item.outputPreview, MAX_PREVIEW_CHARS),
          outputTruncated: Boolean(item.outputTruncated),
        };
        this.recordTool(event);
        acceptedTools += 1;
        this.emitWake({ kind: "tool", terminalId, event });
      }
    }

    if (Array.isArray(rec.promptEvents)) {
      for (const raw of rec.promptEvents.slice(0, 50)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>;
        const terminalId = boundedString(item.terminalId, 128);
        if (!terminalId) continue;
        acceptedPrompts += 1;
        this.emitWake({ kind: "prompt", terminalId });
      }
    }

    return { acceptedStatus, acceptedTools, acceptedPrompts };
  }

  private recordAgent(agent: PluginObservedAgent): void {
    this.agentsByTerminal.delete(agent.terminalId);
    this.agentsByTerminal.set(agent.terminalId, agent);
    while (this.agentsByTerminal.size > MAX_TERMINALS_TRACKED) {
      const oldest = this.agentsByTerminal.keys().next().value;
      if (oldest === undefined) break;
      this.agentsByTerminal.delete(oldest);
    }
  }

  private recordTool(event: PluginLiveToolEvent): void {
    let list = this.toolsByTerminal.get(event.terminalId);
    if (!list) {
      list = [];
      this.toolsByTerminal.set(event.terminalId, list);
      while (this.toolsByTerminal.size > MAX_TERMINALS_TRACKED) {
        const oldest = this.toolsByTerminal.keys().next().value;
        if (oldest === undefined) break;
        this.toolsByTerminal.delete(oldest);
      }
    }
    // Deduplicate retries of the same live tool event id / callId.
    const dupIdx = event.callId
      ? list.findIndex((existing) => existing.callId === event.callId)
      : list.findIndex((existing) => existing.id === event.id);
    if (dupIdx >= 0) list[dupIdx] = event;
    else {
      list.push(event);
      if (list.length > MAX_TOOLS_PER_TERMINAL) {
        list.splice(0, list.length - MAX_TOOLS_PER_TERMINAL);
      }
    }
  }

  getObservedAgent(terminalId: string): PluginObservedAgent | null {
    return this.agentsByTerminal.get(terminalId) ?? null;
  }

  getLiveTools(terminalId: string): PluginLiveToolEvent[] {
    return (this.toolsByTerminal.get(terminalId) ?? []).slice();
  }

  enqueueNotification(title: string, body?: string): void {
    if (this.closed) return;
    this.pendingNotifications.push({
      id: `pnote_${randomUUID()}`,
      title: title.slice(0, 120),
      ...(body ? { body: body.slice(0, 400) } : {}),
    });
    if (this.pendingNotifications.length > MAX_PENDING_NOTIFICATIONS) {
      this.pendingNotifications.splice(0, this.pendingNotifications.length - MAX_PENDING_NOTIFICATIONS);
    }
    this.notifyInboxWaiters();
  }

  notifyStatusChanged(): void {
    this.notifyInboxWaiters();
  }

  /** Queue a command for the companion plugin and await its receipt (used in M3 resume). */
  enqueueCommand(
    kind: PluginCommandEnvelope["kind"],
    params: Record<string, unknown>,
    timeoutMs = 20_000,
  ): Promise<Record<string, unknown>> {
    if (this.closed || !this.status().connected) {
      return Promise.reject(new Error("Companion Orca plugin is not connected."));
    }
    if (this.pendingCommands.length >= MAX_PENDING_COMMANDS) {
      return Promise.reject(new Error("Companion plugin command queue is full."));
    }
    const id = `pcmd_${randomUUID()}`;
    const envelope: PluginCommandEnvelope = { id, kind, params, createdAt: Date.now() };
    this.pendingCommands.push(envelope);
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.receiptWaiters.delete(id);
        reject(new Error(`Companion plugin command ${kind} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.receiptWaiters.set(id, { resolve, reject, timer });
    });
    this.notifyInboxWaiters();
    return promise;
  }

  submitReceipt(commandId: string, receipt: Record<string, unknown>): boolean {
    this.touch();
    const waiter = this.receiptWaiters.get(commandId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.receiptWaiters.delete(commandId);
    waiter.resolve(receipt);
    return true;
  }

  /**
   * Long-poll inbox for the companion plugin worker. Resolves immediately when
   * commands, notifications, or a new status bar summary are ready.
   */
  async pullInbox(
    waitMs = 10_000,
    signal?: AbortSignal,
  ): Promise<{
    commands: PluginCommandEnvelope[];
    notifications: PluginNotificationItem[];
    statusBar: PluginStatusBarSummary | null;
  }> {
    this.touch();
    const clampWait = Math.max(0, Math.min(15_000, Math.round(waitMs)));
    const readStatus = (): { summary: PluginStatusBarSummary | null; changed: boolean } => {
      const summary = this.statusSummaryProvider ? this.statusSummaryProvider() : null;
      const sig = summary ? JSON.stringify(summary) : "";
      const changed = sig !== this.lastDeliveredStatusSig;
      return { summary, changed };
    };

    const hasImmediate = (): boolean =>
      this.closed ||
      this.pendingCommands.length > 0 ||
      this.pendingNotifications.length > 0 ||
      readStatus().changed;

    if (!hasImmediate() && clampWait > 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.inboxWaiters.delete(finish);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, clampWait);
        this.inboxWaiters.add(finish);
        signal?.addEventListener("abort", finish, { once: true });
      });
    }

    const commands = this.pendingCommands.splice(0, this.pendingCommands.length);
    const notifications = this.pendingNotifications.splice(0, this.pendingNotifications.length);
    const { summary, changed } = readStatus();
    if (changed) this.lastDeliveredStatusSig = summary ? JSON.stringify(summary) : "";
    return {
      commands,
      notifications,
      statusBar: changed ? summary : null,
    };
  }

  close(): void {
    this.closed = true;
    this.notifyInboxWaiters();
    for (const [id, waiter] of this.receiptWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Viewer server shutting down."));
      this.receiptWaiters.delete(id);
    }
    this.wakeListeners.clear();
  }
}
