import type { Response } from "express";
import { readWorkerOutput, type WorkerOutputReceipt } from "./orca";
import type { PluginBridge } from "./pluginBridge";

export type OutputTailSource = "auto" | "terminal" | "transcript";

interface TailFrame {
  output: WorkerOutputReceipt;
  trimmedLines: number;
  trimmedMessages: number;
  streamingState: "live" | "drained";
}

type TailEvent = "init" | "reset" | "append" | "streamError";

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

interface TailSubscriber {
  res: Response;
  onDrain: (() => void) | null;
  missedOutput: boolean;
  unsubscribe: () => void;
}

interface TailEntry {
  key: string;
  dispatchId: string;
  source: OutputTailSource;
  terminalId: string | null;
  subscribers: Set<TailSubscriber>;
  output: WorkerOutputReceipt | null;
  trimmedLines: number;
  trimmedMessages: number;
  streamingState: "live" | "drained";
  inFlight: boolean;
  pendingWake: boolean;
  idlePolls: number;
  poll: { timer: NodeJS.Timeout; dueAt: number } | null;
  graceTimer: NodeJS.Timeout | null;
  keepaliveTimer: NodeJS.Timeout | null;
}

function sseFrame(event: TailEvent, data: TailFrame | { error: string }): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function tailFrame(entry: TailEntry, output: WorkerOutputReceipt): TailFrame {
  return {
    output,
    trimmedLines: entry.trimmedLines,
    trimmedMessages: entry.trimmedMessages,
    streamingState: entry.streamingState,
  };
}

/** Append an already bounded page without allocating rows past the tail limit. */
function appendTail<T>(previous: T[], page: T[], limit: number): T[] {
  if (page.length === 0) return previous;
  if (previous.length === 0 || page.length === limit) return page;
  const merged = previous.slice(Math.max(0, previous.length + page.length - limit));
  merged.push(...page);
  return merged;
}

/**
 * Centralized server-side `worker-read` tail manager (M2).
 *
 * One cursor poller per `(runId, dispatchId, source)` fans out incremental
 * lines + structured transcript messages over SSE to any number of connected
 * clients (bottom dock Output + right inspector Session + multiple tabs).
 * Companion-plugin hooks identify a terminal, not its Run and Dispatch at
 * event time. They only wake the Dispatch-scoped worker-read poller; on
 * terminal reuse, no hook content can move between streams.
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
    this.unsubscribeWake = opts.pluginBridge?.onWake(({ terminalId }) => {
      this.handlePluginWake(terminalId);
    }) ?? null;
  }

  subscribe(opts: {
    runId: string;
    dispatchId: string;
    source: OutputTailSource;
    terminalId: string | null;
    res: Response;
  }): () => void {
    const { res } = opts;
    if (res.destroyed || res.writableEnded) return () => {};
    if (this.closed) {
      res.end();
      return () => {};
    }
    // IDs may contain colons, so serialize the tuple without delimiter aliases.
    const key = JSON.stringify([opts.runId, opts.dispatchId, opts.source]);
    let entry = this.tails.get(key);
    if (!entry) {
      entry = {
        key,
        dispatchId: opts.dispatchId,
        source: opts.source,
        terminalId: opts.terminalId,
        subscribers: new Set(),
        output: null,
        trimmedLines: 0,
        trimmedMessages: 0,
        streamingState: "live",
        inFlight: false,
        pendingWake: false,
        idlePolls: 0,
        poll: null,
        graceTimer: null,
        keepaliveTimer: null,
      };
      this.tails.set(key, entry);
    } else {
      if (opts.terminalId && !entry.terminalId) entry.terminalId = opts.terminalId;
      if (entry.graceTimer) {
        clearTimeout(entry.graceTimer);
        entry.graceTimer = null;
      }
    }

    const tail = entry;
    const sub: TailSubscriber = {
      res,
      onDrain: null,
      missedOutput: false,
      unsubscribe: () => this.removeSubscriber(tail, sub),
    };
    tail.subscribers.add(sub);
    res.once("close", sub.unsubscribe);
    if (!tail.keepaliveTimer) {
      tail.keepaliveTimer = setInterval(() => {
        for (const subscriber of tail.subscribers) this.writeFrame(tail, subscriber, ": keepalive\n\n");
      }, KEEPALIVE_MS);
    }

    if (tail.output) this.writeFrame(tail, sub, sseFrame("init", tailFrame(tail, tail.output)));
    // Resume a cached tail after its subscribers left, including a check for
    // late output after drain.
    if (!tail.inFlight && !tail.poll) this.schedulePoll(tail, 0);
    return sub.unsubscribe;
  }

  private removeSubscriber(entry: TailEntry, sub: TailSubscriber): void {
    if (!entry.subscribers.delete(sub)) return;
    sub.res.off("close", sub.unsubscribe);
    if (sub.onDrain) sub.res.off("drain", sub.onDrain);
    if (this.closed || entry.subscribers.size > 0) return;
    if (entry.poll) {
      clearTimeout(entry.poll.timer);
      entry.poll = null;
    }
    if (entry.keepaliveTimer) {
      clearInterval(entry.keepaliveTimer);
      entry.keepaliveTimer = null;
    }
    entry.graceTimer = setTimeout(() => this.disposeEntry(entry), SUBSCRIBER_GRACE_MS);
  }

  private writeFrame(entry: TailEntry, sub: TailSubscriber, frame: string): void {
    if (sub.onDrain || sub.res.writableEnded || sub.res.destroyed) return;
    try {
      if (sub.res.write(frame)) return;
    } catch {
      sub.unsubscribe();
      sub.res.destroy();
      return;
    }
    if (!entry.subscribers.has(sub)) return;

    // The frame was accepted, but the response buffer is full. Keep at most
    // one in-flight frame and no per-subscriber queue. Catch up from the shared
    // bounded snapshot once this client can write again.
    sub.onDrain = () => {
      sub.onDrain = null;
      if (!sub.missedOutput || !entry.output || !entry.subscribers.has(sub)) return;
      sub.missedOutput = false;
      this.writeFrame(entry, sub, sseFrame("reset", tailFrame(entry, entry.output)));
    };
    sub.res.once("drain", sub.onDrain);
  }

  private publish(entry: TailEntry, event: TailEvent, data: TailFrame | { error: string }): void {
    let frame: string | undefined;
    for (const sub of entry.subscribers) {
      if (sub.onDrain) {
        if (event !== "streamError") sub.missedOutput = true;
        continue;
      }
      this.writeFrame(entry, sub, frame ??= sseFrame(event, data));
    }
  }

  private handlePluginWake(terminalId: string): void {
    if (this.closed) return;
    for (const entry of this.tails.values()) {
      if (!entry.terminalId || entry.terminalId !== terminalId) continue;
      if (entry.subscribers.size === 0) continue;

      // Terminal events can only change when we poll, never what we send.
      entry.idlePolls = 0;
      if (entry.inFlight) {
        entry.pendingWake = true;
      } else {
        this.schedulePoll(entry, WAKE_DEBOUNCE_MS);
      }
    }
  }

  private schedulePoll(entry: TailEntry, delayMs: number): void {
    if (this.closed || entry.subscribers.size === 0) return;
    const dueAt = performance.now() + delayMs;
    if (entry.poll) {
      // Coalesce wake bursts without postponing an already scheduled read.
      if (entry.poll.dueAt <= dueAt) return;
      clearTimeout(entry.poll.timer);
    }
    const timer = setTimeout(() => {
      entry.poll = null;
      void this.pollOnce(entry);
    }, delayMs);
    entry.poll = { timer, dueAt };
  }

  private async pollOnce(entry: TailEntry): Promise<void> {
    if (this.closed || entry.subscribers.size === 0 || entry.inFlight) return;
    entry.inFlight = true;
    entry.pendingWake = false;
    const beforePoll = entry.output;
    const cursor = beforePoll?.cursor ?? undefined;

    try {
      const receipt = await this.readFn(entry.dispatchId, {
        source: entry.source === "auto" ? undefined : entry.source,
        cursor,
        limit: PAGE_LIMIT,
      });
      if (this.closed || this.tails.get(entry.key) !== entry) return;
      // The route already proved this Dispatch's Run. Never cache or forward a
      // page that names a different Dispatch, even following a plugin wake.
      if (receipt.dispatchId !== entry.dispatchId) {
        throw new Error("worker-read returned output for a different Dispatch");
      }

      const previous = cursor && !receipt.sourceChanged ? beforePoll : null;
      const newLinesCount = receipt.lines.length;
      const newMessagesCount = receipt.messages?.length ?? 0;
      const page = newLinesCount > MAX_LINES || newMessagesCount > MAX_MESSAGES
        ? {
            ...receipt,
            lines: newLinesCount > MAX_LINES ? receipt.lines.slice(-MAX_LINES) : receipt.lines,
            ...(receipt.messages && newMessagesCount > MAX_MESSAGES
              ? { messages: receipt.messages.slice(-MAX_MESSAGES) }
              : {}),
          }
        : receipt;
      entry.trimmedLines = (previous ? entry.trimmedLines : 0) +
        Math.max(0, (previous?.lines.length ?? 0) + newLinesCount - MAX_LINES);
      entry.trimmedMessages = (previous ? entry.trimmedMessages : 0) +
        Math.max(0, (previous?.messages?.length ?? 0) + newMessagesCount - MAX_MESSAGES);

      const wasDrained = entry.streamingState === "drained";
      const drained = page.status?.liveness === "exited" && newLinesCount === 0 && newMessagesCount === 0;
      entry.streamingState = drained ? "drained" : "live";

      if (!previous) {
        entry.output = page;
        this.publish(entry, beforePoll ? "reset" : "init", tailFrame(entry, page));
      } else {
        const messages = page.messages?.length
          ? appendTail(previous.messages ?? [], page.messages, MAX_MESSAGES)
          : previous.messages ?? page.messages;
        entry.output = {
          ...page,
          lines: appendTail(previous.lines, page.lines, MAX_LINES),
          ...(messages !== undefined ? { messages } : {}),
        };
        if (newLinesCount > 0 || newMessagesCount > 0 || drained || wasDrained ||
            page.warnings.join("|") !== previous.warnings.join("|")) {
          this.publish(entry, "append", tailFrame(entry, page));
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
      if (this.closed || this.tails.get(entry.key) !== entry) return;
      const message = String((err as Error)?.message ?? err);
      this.publish(entry, "streamError", { error: message });
      if (entry.subscribers.size > 0) {
        this.schedulePoll(entry, ERROR_INTERVAL_MS);
      }
    } finally {
      entry.inFlight = false;
      if (entry.pendingWake && !this.closed && entry.subscribers.size > 0 && !entry.poll) {
        this.schedulePoll(entry, WAKE_DEBOUNCE_MS);
      }
    }
  }

  private disposeEntry(entry: TailEntry): void {
    if (entry.poll) clearTimeout(entry.poll.timer);
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    if (entry.keepaliveTimer) clearInterval(entry.keepaliveTimer);
    this.tails.delete(entry.key);
  }

  closeAll(): void {
    this.closed = true;
    this.unsubscribeWake?.();
    for (const entry of this.tails.values()) {
      for (const sub of entry.subscribers) {
        sub.unsubscribe();
        try { sub.res.end(); } catch {}
      }
      this.disposeEntry(entry);
    }
  }
}
