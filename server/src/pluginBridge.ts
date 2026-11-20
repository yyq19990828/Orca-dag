import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { RequestHandler } from "express";
import { checkPluginEndpointFile, pluginEndpointPath, readPluginEndpointFile, type PluginEndpointRecord } from "../../plugin/src/endpoint";

/** Companion plugin connection expires if no hello/event/inbox arrives within this window. */
const PLUGIN_CONNECTED_TTL_MS = 25_000;
const MAX_PENDING_NOTIFICATIONS = 20;
const MAX_PENDING_COMMANDS = 16;

export interface PluginStatusSnapshot {
  connected: boolean;
  pluginId: string | null;
  version: string | null;
  hostApiMinor: number | null;
  grantedCapabilities: string[];
  transport: "loopback-http" | null;
  lastSeenAt: string | null;
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
  kind: "agent.resume" | "agent.listSessions" | "workspace.list";
  params: Record<string, unknown>;
  createdAt: number;
}

export type PluginWakeEvent = { kind: "status" | "tool" | "prompt"; terminalId: string };

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
 * Auth middleware for companion-plugin loopback endpoints. The request token
 * is derived from the private discovery key, never used to sign viewer replies.
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
 * Atomically publish the viewer in the user's private registry after it binds
 * its port. The workspace is never a source of companion trust.
 */
export function writePluginEndpointFile(
  workspaceDir: string,
  record: PluginEndpointRecord,
): string {
  const target = pluginEndpointPath(workspaceDir, true);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    // Do not replace a linked or non-private record.
    try {
      checkPluginEndpointFile(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  return target;
}

/** Remove only the record for this instance, never another viewer's record. */
export function removePluginEndpointFile(
  workspaceDir: string,
  instanceId: string,
): boolean {
  try {
    if (readPluginEndpointFile(workspaceDir)?.instanceId !== instanceId) return false;
    unlinkSync(pluginEndpointPath(workspaceDir));
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

/**
 * In-memory companion plugin bridge (M1).
 *
 * Agent event batches contain terminal IDs only. They may wake a scoped
 * worker-read; they never prove Task settlement, session identity or custody.
 */
export class PluginBridge {
  private pluginId: string | null = null;
  private version: string | null = null;
  private hostApiMinor: number | null = null;
  private grantedCapabilities: string[] = [];
  private lastSeenMs = 0;

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
    const batches = [
      { kind: "status", rows: rec.statusEvents },
      { kind: "tool", rows: rec.toolEvents },
      { kind: "prompt", rows: rec.promptEvents },
    ] as const;
    for (const { kind, rows } of batches) {
      if (!Array.isArray(rows)) continue;
      for (const raw of rows.slice(0, 100)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const terminalId = (raw as Record<string, unknown>).terminalId;
        if (typeof terminalId !== "string" || !terminalId || terminalId.length > 128) continue;
        if (kind === "status") acceptedStatus++;
        else if (kind === "tool") acceptedTools++;
        else acceptedPrompts++;
        this.emitWake({ kind, terminalId });
      }
    }

    return { acceptedStatus, acceptedTools, acceptedPrompts };
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
    if (this.receiptWaiters.size >= MAX_PENDING_COMMANDS) {
      return Promise.reject(new Error("Companion plugin command queue is full."));
    }
    const id = `pcmd_${randomUUID()}`;
    const envelope: PluginCommandEnvelope = { id, kind, params, createdAt: Date.now() };
    this.pendingCommands.push(envelope);
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.receiptWaiters.delete(id);
        // If not yet delivered, do not let an expired command land later.
        // After delivery the host may already have applied it.
        const pending = this.pendingCommands.indexOf(envelope);
        if (pending !== -1) this.pendingCommands.splice(pending, 1);
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

    if (this.closed || signal?.aborted) return { commands: [], notifications: [], statusBar: null };
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
