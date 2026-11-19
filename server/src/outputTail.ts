import type { Response } from "express";
import {
  readWorkerOutput,
  type WorkerOutputReceipt,
  type WorkerTranscriptMessage,
} from "./orca";
import type { PluginBridge, PluginLiveToolEvent } from "./pluginBridge";

export type OutputTailSource = "auto" | "terminal" | "transcript";

export interface OutputTailSnapshot {
  output: WorkerOutputReceipt;
  trimmedLines: number;
  trimmedMessages: number;
  liveTools: PluginLiveToolEvent[];
  streamingState: "live" | "drained";
}

export interface OutputTailDelta {
  output: WorkerOutputReceipt;
  trimmedLines: number;
  trimmedMessages: number;
  streamingState: "live" | "drained";
}

const PAGE_LIMIT = 120;
const DRAIN_INTERVAL_MS = 250;
const ACTIVE_INTERVAL_MS = 1_500;
const IDLE_INTERVAL_MS = 4_000;
const ERROR_INTERVAL_MS = 10_000;
const WAKE_DEBOUNCE_MS = 150;
const SUBSCRIBER_GRACE_MS = 10_000;
const KEEPALIVE_MS = 25_000;
const MAX_LINES = 5_000;
const MAX_MESSAGES = 1_000;
const MAX_LIVE_TOOLS = 120;

interface TailEntry {
  key: string;
  runId: string;
  dispatchId: string;
  source: OutputTailSource;
  terminalId: string | null;
  subscribers: Set<Response>;
  output: WorkerOutputReceipt | null;
  trimmedLines: number;
  trimmedMessages: number;
  liveTools: PluginLiveToolEvent[];
  seenCallIds: Set<string>;
  streamingState: "live" | "drained";
  inFlight: boolean;
  pendingWake: boolean;
  idlePolls: number;
  pollTimer: NodeJS.Timeout | null;
  graceTimer: NodeJS.Timeout | null;
  keepaliveTimer: NodeJS.Timeout | null;
  lastError: string | null;
}

function writeSse(res: Response, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Closed socket will be cleaned up by its close listener.
  }
}

function collectCallIds(messages: WorkerTranscriptMessage[] | undefined, into: Set<string>): void {
  if (!messages) return;
  for (const msg of messages) {
    for (const block of msg.blocks) {
      if ((block.type === "tool-call" || block.type === "tool-result") && block.callId) {
        into.add(block.callId);
      }
    }
  }
}

/**
 * Centralized server-side `worker-read` tail manager (M2).
 *
 * One cursor poller per `(runId, dispatchId, source)` fans out incremental
 * lines + structured transcript messages over SSE to any number of connected
 * clients (bottom dock Output + right inspector Session + multiple tabs).
 * When the companion Orca plugin is connected, `agent.status.changed` and
 * `agent.tool.after` wake matching tails immediately and stream local tool
 * calls before the next transcript page lands.
 */
export class OutputTailManager {
  private readonly tails = new Map<string, TailEntry>();
  private readonly readFn: typeof readWorkerOutput;
  private readonly unsubscribeWake: (() => void) | null;
  private closed = false;

  constructor(opts: {
    pluginBridge?: PluginBridge;
    readOutput?: typeof readWorkerOutput;
  } = {}) {
    this.readFn = opts.readOutput ?? readWorkerOutput;
    this.unsubscribeWake = opts.pluginBridge
      ? opts.pluginBridge.onWake((evt) => {
          this.handlePluginWake(evt.terminalId, evt.kind === "tool" ? evt.event : null);
        })
      : null;
    this.pluginBridge = opts.pluginBridge ?? null;
  }

  private readonly pluginBridge: PluginBridge | null;

  subscribe(opts: {
    runId: string;
    dispatchId: string;
    source: OutputTailSource;
    terminalId: string | null;
    res: Response;
  }): () => void {
    const key = `${opts.runId}:${opts.dispatchId}:${opts.source}`;
    let entry = this.tails.get(key);
    if (!entry) {
      const seededTools = opts.terminalId && this.pluginBridge
        ? this.pluginBridge.getLiveTools(opts.terminalId).slice(-MAX_LIVE_TOOLS)
        : [];
      entry = {
        key,
        runId: opts.runId,
        dispatchId: opts.dispatchId,
        source: opts.source,
        terminalId: opts.terminalId,
        subscribers: new Set(),
        output: null,
        trimmedLines: 0,
        trimmedMessages: 0,
        liveTools: seededTools,
        seenCallIds: new Set(),
        streamingState: "live",
        inFlight: false,
        pendingWake: false,
        idlePolls: 0,
        pollTimer: null,
        graceTimer: null,
        keepaliveTimer: null,
        lastError: null,
      };
      this.tails.set(key, entry);
    } else {
      if (opts.terminalId && !entry.terminalId) entry.terminalId = opts.terminalId;
      if (entry.graceTimer) {
        clearTimeout(entry.graceTimer);
        entry.graceTimer = null;
      }
    }

    entry.subscribers.add(opts.res);
    if (!entry.keepaliveTimer) {
      entry.keepaliveTimer = setInterval(() => {
        for (const sub of [...entry!.subscribers]) {
          if (!sub.writableEnded && !sub.destroyed) {
            try { sub.write(": keepalive\n\n"); } catch {}
          }
        }
      }, KEEPALIVE_MS);
    }

    if (entry.output) {
      const snapshot: OutputTailSnapshot = {
        output: entry.output,
        trimmedLines: entry.trimmedLines,
        trimmedMessages: entry.trimmedMessages,
        liveTools: entry.liveTools,
        streamingState: entry.streamingState,
      };
      writeSse(opts.res, "init", snapshot);
      if (entry.streamingState === "drained") {
        // Re-check once on new subscriber in case late output arrived after drain.
        this.schedulePoll(entry, 0);
      }
    } else if (!entry.inFlight) {
      this.schedulePoll(entry, 0);
    }

    return () => {
      const current = this.tails.get(key);
      if (!current) return;
      current.subscribers.delete(opts.res);
      if (current.subscribers.size === 0) {
        if (current.pollTimer) {
          clearTimeout(current.pollTimer);
          current.pollTimer = null;
        }
        if (current.keepaliveTimer) {
          clearInterval(current.keepaliveTimer);
          current.keepaliveTimer = null;
        }
        current.graceTimer = setTimeout(() => {
          if (current.subscribers.size === 0) this.disposeEntry(current);
        }, SUBSCRIBER_GRACE_MS);
      }
    };
  }

  private handlePluginWake(terminalId: string, toolEvent: PluginLiveToolEvent | null): void {
    if (this.closed) return;
    for (const entry of this.tails.values()) {
      if (!entry.terminalId || entry.terminalId !== terminalId) continue;
      if (entry.subscribers.size === 0) continue;

      if (toolEvent) {
        if (!toolEvent.callId || !entry.seenCallIds.has(toolEvent.callId)) {
          const dupIdx = toolEvent.callId
            ? entry.liveTools.findIndex((t) => t.callId === toolEvent.callId)
            : entry.liveTools.findIndex((t) => t.id === toolEvent.id);
          if (dupIdx >= 0) entry.liveTools[dupIdx] = toolEvent;
          else {
            entry.liveTools.push(toolEvent);
            if (entry.liveTools.length > MAX_LIVE_TOOLS) {
              entry.liveTools.splice(0, entry.liveTools.length - MAX_LIVE_TOOLS);
            }
          }
          for (const sub of [...entry.subscribers]) {
            writeSse(sub, "liveTool", toolEvent);
          }
        }
      }

      // Wake the authoritative worker-read poller quickly (debounced).
      entry.idlePolls = 0;
      if (entry.streamingState === "drained") entry.streamingState = "live";
      if (entry.inFlight) {
        entry.pendingWake = true;
      } else {
        this.schedulePoll(entry, WAKE_DEBOUNCE_MS);
      }
    }
  }

  private schedulePoll(entry: TailEntry, delayMs: number): void {
    if (this.closed || entry.subscribers.size === 0) return;
    if (entry.pollTimer) clearTimeout(entry.pollTimer);
    entry.pollTimer = setTimeout(() => {
      entry.pollTimer = null;
      void this.pollOnce(entry);
    }, delayMs);
  }

  private async pollOnce(entry: TailEntry): Promise<void> {
    if (this.closed || entry.subscribers.size === 0 || entry.inFlight) return;
    entry.inFlight = true;
    entry.pendingWake = false;
    const isInitial = entry.output === null;
    const cursor = entry.output?.cursor ?? undefined;

    try {
      const page = await this.readFn(entry.dispatchId, {
        source: entry.source === "auto" ? undefined : entry.source,
        cursor,
        limit: PAGE_LIMIT,
      });
      if (this.closed || !this.tails.has(entry.key)) return;
      entry.lastError = null;

      const continues = !isInitial && Boolean(cursor) && !page.sourceChanged;
      const newLinesCount = page.lines.length;
      const newMessagesCount = page.messages?.length ?? 0;
      const exited = page.status?.liveness === "exited";
      const drained = exited && newLinesCount === 0 && newMessagesCount === 0;
      entry.streamingState = drained ? "drained" : "live";

      if (!continues) {
        entry.seenCallIds.clear();
        collectCallIds(page.messages, entry.seenCallIds);
        entry.liveTools = entry.liveTools.filter((t) => !t.callId || !entry.seenCallIds.has(t.callId));
        entry.trimmedLines = 0;
        entry.trimmedMessages = 0;
        entry.output = page;
        const snapshot: OutputTailSnapshot = {
          output: entry.output,
          trimmedLines: entry.trimmedLines,
          trimmedMessages: entry.trimmedMessages,
          liveTools: entry.liveTools,
          streamingState: entry.streamingState,
        };
        const eventName = isInitial ? "init" : "reset";
        for (const sub of [...entry.subscribers]) {
          writeSse(sub, eventName, snapshot);
        }
      } else {
        const prev = entry.output!;
        const mergedLines = [...prev.lines, ...page.lines];
        const lineOverflow = Math.max(0, mergedLines.length - MAX_LINES);
        if (lineOverflow > 0) entry.trimmedLines += lineOverflow;

        let mergedMessages = prev.messages;
        if (page.messages) {
          collectCallIds(page.messages, entry.seenCallIds);
          entry.liveTools = entry.liveTools.filter((t) => !t.callId || !entry.seenCallIds.has(t.callId));
          const combined = [...(prev.messages ?? []), ...page.messages];
          const msgOverflow = Math.max(0, combined.length - MAX_MESSAGES);
          if (msgOverflow > 0) entry.trimmedMessages += msgOverflow;
          mergedMessages = msgOverflow > 0 ? combined.slice(msgOverflow) : combined;
        }

        entry.output = {
          ...page,
          lines: lineOverflow > 0 ? mergedLines.slice(lineOverflow) : mergedLines,
          ...(mergedMessages !== undefined ? { messages: mergedMessages } : {}),
        };

        if (newLinesCount > 0 || newMessagesCount > 0 || drained || page.warnings.join("|") !== prev.warnings.join("|")) {
          const delta: OutputTailDelta = {
            output: page,
            trimmedLines: entry.trimmedLines,
            trimmedMessages: entry.trimmedMessages,
            streamingState: entry.streamingState,
          };
          for (const sub of [...entry.subscribers]) {
            writeSse(sub, "append", delta);
          }
        }
      }

      if (newLinesCount === 0 && newMessagesCount === 0) entry.idlePolls += 1;
      else entry.idlePolls = 0;

      if (!drained && entry.subscribers.size > 0) {
        const nextDelay = entry.pendingWake
          ? WAKE_DEBOUNCE_MS
          : newLinesCount >= PAGE_LIMIT || newMessagesCount >= PAGE_LIMIT
            ? DRAIN_INTERVAL_MS
            : entry.idlePolls >= 3
              ? IDLE_INTERVAL_MS
              : ACTIVE_INTERVAL_MS;
        this.schedulePoll(entry, nextDelay);
      }
    } catch (err) {
      if (this.closed || !this.tails.has(entry.key)) return;
      const message = String((err as Error)?.message ?? err);
      entry.lastError = message;
      for (const sub of [...entry.subscribers]) {
        writeSse(sub, "streamError", { error: message });
      }
      if (entry.subscribers.size > 0) {
        this.schedulePoll(entry, ERROR_INTERVAL_MS);
      }
    } finally {
      entry.inFlight = false;
      if (entry.pendingWake && !this.closed && entry.subscribers.size > 0 && !entry.pollTimer) {
        this.schedulePoll(entry, WAKE_DEBOUNCE_MS);
      }
    }
  }

  private disposeEntry(entry: TailEntry): void {
    if (entry.pollTimer) clearTimeout(entry.pollTimer);
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    if (entry.keepaliveTimer) clearInterval(entry.keepaliveTimer);
    this.tails.delete(entry.key);
  }

  closeAll(): void {
    this.closed = true;
    this.unsubscribeWake?.();
    for (const entry of [...this.tails.values()]) {
      for (const sub of [...entry.subscribers]) {
        try { sub.end(); } catch {}
      }
      entry.subscribers.clear();
      this.disposeEntry(entry);
    }
  }
}
