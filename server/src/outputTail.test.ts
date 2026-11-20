import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it, type TestContext } from "node:test";
import type { Response } from "express";
import type { readWorkerOutput, WorkerOutputReceipt, WorkerTranscriptMessage } from "./orca";
import { OutputTailManager } from "./outputTail";
import { PluginBridge } from "./pluginBridge";

const terminalId = "term_reused";
const exited = { worker: "succeeded", terminal: "exited", liveness: "exited" };

interface OutputFrame {
  output: WorkerOutputReceipt;
  trimmedLines: number;
  trimmedMessages: number;
  streamingState: "live" | "drained";
}

class StreamSink extends EventEmitter {
  readonly frames: Array<{ event: string; data: unknown }> = [];
  keepalives = 0;
  writableEnded = false;
  destroyed = false;
  blocked = false;

  get res(): Response { return this as unknown as Response; }

  write(chunk: string): boolean {
    if (chunk === ": keepalive\n\n") {
      this.keepalives += 1;
    } else {
      const [, event, data] = /^event: (.+)\ndata: (.+)\n\n$/.exec(chunk)!;
      this.frames.push({ event, data: JSON.parse(data) });
    }
    return !this.blocked;
  }

  end(): void {
    this.writableEnded = true;
    this.emit("close");
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }

  outputAt(index: number, event: string): OutputFrame {
    const frame = this.frames[index];
    assert.equal(frame?.event, event);
    return frame.data as OutputFrame;
  }
}

function page(dispatchId: string, fields: Partial<WorkerOutputReceipt> = {}): WorkerOutputReceipt {
  return {
    dispatchId,
    source: "transcript",
    cursor: null,
    lines: [],
    contentComplete: false,
    clipped: false,
    warnings: [],
    sourceChanged: false,
    ...fields,
  };
}

function toolMessage(id: string): WorkerTranscriptMessage {
  return {
    id,
    role: "assistant",
    timestamp: null,
    source: "transcript",
    blocks: [{ type: "tool-result", output: `Scoped result ${id}`, callId: id }],
  };
}

function setup(t: TestContext, readOutput: typeof readWorkerOutput, pluginBridge?: PluginBridge) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const tails = new OutputTailManager({ pluginBridge, readOutput });
  t.after(() => {
    tails.closeAll();
    pluginBridge?.close();
  });
  return tails;
}

function subscribe(tails: OutputTailManager, sink: StreamSink, runId: string, dispatchId: string): void {
  tails.subscribe({ runId, dispatchId, source: "transcript", terminalId, res: sink.res });
}

function wake(bridge: PluginBridge, toolEvent: Record<string, unknown> = { terminalId }): void {
  assert.equal(bridge.ingestEvents({ toolEvents: [toolEvent] }).acceptedTools, 1);
}

async function advance(t: TestContext, ms: number): Promise<void> {
  t.mock.timers.tick(ms);
  await Promise.resolve(); // let the resolved worker-read continuation publish
}

it("only wakes scoped reads on tool hooks, including after a terminal is reused", async (t) => {
  const bridge = new PluginBridge();
  const calls: Array<[string, string | undefined]> = [];
  const turn = toolMessage("new-tool");
  const tails = setup(t, async (dispatchId, opts) => {
    const cursor = opts?.cursor;
    calls.push([dispatchId, cursor]);
    if (dispatchId === "ctx_old") return page(dispatchId, { cursor: "old-exit", status: exited });
    if (!cursor) return page(dispatchId, { cursor: "new-start", lines: ["new Dispatch"] });
    return cursor === "new-start"
      ? page(dispatchId, { cursor: "new-tool", messages: [turn] })
      : page(dispatchId, { cursor: "new-tool", status: exited });
  }, bridge);

  const legacyHook = { terminalId, tool: "fixture", callId: "old-tool", outputPreview: "Unscoped old tool" };
  wake(bridge, legacyHook);
  const old = new StreamSink();
  subscribe(tails, old, "run_old", "ctx_old");
  await advance(t, 1);
  assert.equal(old.outputAt(0, "init").streamingState, "drained");

  const first = new StreamSink();
  const second = new StreamSink();
  subscribe(tails, first, "run_new", "ctx_new");
  subscribe(tails, second, "run_new", "ctx_new");
  await advance(t, 1);
  assert.deepEqual(calls, [["ctx_old", undefined], ["ctx_new", undefined]]);
  for (const sink of [first, second]) assert.deepEqual(sink.outputAt(0, "init").output.lines, ["new Dispatch"]);

  wake(bridge, { terminalId: "term_unrelated" });
  await advance(t, 150);
  assert.equal(calls.length, 2);

  // A delayed legacy hook from the prior ownership can reach both pollers,
  // but its payload must never be sent or cached under either Dispatch.
  wake(bridge, legacyHook);
  const lateOld = new StreamSink();
  subscribe(tails, lateOld, "run_old", "ctx_old");
  assert.equal(lateOld.outputAt(0, "init").streamingState, "drained");
  assert.equal(first.frames.length, 1);
  assert.equal(second.frames.length, 1);
  await advance(t, 150);
  assert.deepEqual(calls.slice(2), [["ctx_old", "old-exit"], ["ctx_new", "new-start"]]);
  for (const sink of [first, second]) assert.deepEqual(sink.outputAt(1, "append").output.messages, [turn]);

  const lateNew = new StreamSink();
  subscribe(tails, lateNew, "run_new", "ctx_new");
  assert.deepEqual(lateNew.outputAt(0, "init").output.messages, [turn]);
  wake(bridge);
  await advance(t, 150);
  assert.equal(first.outputAt(2, "append").streamingState, "drained");
  assert.doesNotMatch(JSON.stringify([old.frames, first.frames, second.frames, lateOld.frames, lateNew.frames]),
    /liveTools?|Unscoped old tool/);
});

it("keeps the last scoped snapshot and cursor when a read returns a different Dispatch", async (t) => {
  const bridge = new PluginBridge();
  const cursors: Array<string | undefined> = [];
  const tails = setup(t, async (dispatchId, opts) => {
    cursors.push(opts?.cursor);
    if (cursors.length === 1) return page(dispatchId, { cursor: "scoped", lines: ["initial"] });
    if (cursors.length === 2) return page("ctx_other", { cursor: "foreign", lines: ["Not this Dispatch"] });
    return page(dispatchId, { cursor: "scoped-next", lines: ["continuation"] });
  }, bridge);

  const sink = new StreamSink();
  subscribe(tails, sink, "run_1", "ctx_1");
  await advance(t, 1);
  wake(bridge);
  await advance(t, 150);
  assert.deepEqual(sink.frames.map((frame) => frame.event), ["init", "streamError"]);

  const late = new StreamSink();
  subscribe(tails, late, "run_1", "ctx_1");
  assert.deepEqual(late.outputAt(0, "init").output.lines, ["initial"]);
  wake(bridge);
  await advance(t, 150);
  assert.deepEqual(cursors, [undefined, "scoped", "scoped"]);
  assert.deepEqual(late.outputAt(1, "append").output.lines, ["continuation"]);
  assert.doesNotMatch(JSON.stringify(sink.frames), /Not this Dispatch/);
});

it("isolates exact Run and Dispatch tuples, including colon-containing IDs", async (t) => {
  const tails = setup(t, async (dispatchId) => page(dispatchId, { lines: [dispatchId] }));
  const first = new StreamSink();
  const second = new StreamSink();
  subscribe(tails, first, "run_fleet:local", "ctx_1");
  subscribe(tails, second, "run_fleet", "local:ctx_1");
  await advance(t, 1);
  assert.deepEqual(first.outputAt(0, "init").output.lines, ["ctx_1"]);
  assert.deepEqual(second.outputAt(0, "init").output.lines, ["local:ctx_1"]);
});

it("does not queue frames for slow subscribers and resets them from the bounded tail on drain", async (t) => {
  const bridge = new PluginBridge();
  let reads = 0;
  const tails = setup(t, async (dispatchId) => {
    reads += 1;
    if (reads === 1) return page(dispatchId, {
      cursor: "c1",
      lines: Array.from({ length: 5_001 }, (_, i) => `line-${i}`),
      messages: Array.from({ length: 1_001 }, (_, i) => toolMessage(`message-${i}`)),
    });
    if (reads === 4) return page(dispatchId, { cursor: "c3", status: exited });
    assert.ok(reads <= 4);
    return page(dispatchId, { cursor: `c${reads}`, lines: [`append-${reads}`], messages: [toolMessage(`turn-${reads}`)] });
  }, bridge);

  const slow = new StreamSink();
  const disconnecting = new StreamSink();
  const healthy = new StreamSink();
  slow.blocked = true;
  disconnecting.blocked = true;
  for (const sink of [slow, healthy, disconnecting]) subscribe(tails, sink, "run_1", "ctx_1");
  await advance(t, 1);
  const init = slow.outputAt(0, "init");
  assert.equal(init.output.lines.length, 5_000);
  assert.equal(init.output.messages?.length, 1_000);
  assert.equal(init.trimmedLines, 1);
  assert.equal(init.trimmedMessages, 1);
  assert.equal(disconnecting.listenerCount("drain"), 1);
  disconnecting.destroy();
  assert.equal(disconnecting.listenerCount("drain"), 0);

  for (let i = 0; i < 3; i += 1) {
    wake(bridge);
    await advance(t, 150);
  }
  await advance(t, 25_000);
  assert.equal(reads, 4);
  assert.deepEqual(healthy.frames.map((frame) => frame.event), ["init", "append", "append", "append"]);
  assert.equal(healthy.outputAt(3, "append").streamingState, "drained");
  assert.equal(healthy.keepalives, 1);
  assert.equal(slow.frames.length, 1);
  assert.equal(slow.keepalives, 0);
  assert.equal(slow.listenerCount("drain"), 1);
  assert.equal(disconnecting.frames.length, 1);

  slow.emit("drain"); // The reset can also fill the buffer, without accumulating another frame.
  const reset = slow.outputAt(1, "reset");
  assert.equal(reset.streamingState, "drained");
  assert.equal(reset.output.cursor, "c3");
  assert.equal(reset.output.lines.length, 5_000);
  assert.equal(reset.output.lines[0], "line-3");
  assert.deepEqual(reset.output.lines.slice(-2), ["append-2", "append-3"]);
  assert.equal(reset.output.messages?.length, 1_000);
  assert.equal(reset.output.messages?.[0]?.id, "message-3");
  assert.deepEqual(reset.output.messages?.slice(-2).map((message) => message.id), ["turn-2", "turn-3"]);
  assert.equal(reset.trimmedLines, 3);
  assert.equal(reset.trimmedMessages, 3);
  assert.equal(slow.listenerCount("drain"), 1);

  slow.blocked = false;
  slow.emit("drain");
  assert.equal(slow.listenerCount("drain"), 0);
  assert.equal(slow.frames.length, 2);
});
