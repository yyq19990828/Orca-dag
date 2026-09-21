import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp, listenLoopback } from "./app";
import { createSecurityPolicy, type SecurityPolicy } from "./security";
import { initOrcaRuntime, ORCHESTRATION_INBOX_LIMIT } from "./orca";
import type { OrcaMessage } from "./orca";

/**
 * Phase 3 acceptance coverage: threaded chat + history integrity, exercised
 * over real loopback HTTP against a scripted Orca CLI double.
 *
 * - Threaded question/reply/ack rows carry thread_id, priority and tri-state
 *   read evidence through /api/activity without losing exact Run scoping.
 * - A saturated GLOBAL inbox window trips the completeness warning even when
 *   the selected Run itself has only a handful of rows.
 * - A failed history read leaves completeness unknown (`inboxWindow: null`),
 *   never asserted complete and never asserted truncated.
 */

const policy: SecurityPolicy = createSecurityPolicy({});
let root: string;
let fixturePath: string;
let scriptPath: string;
let wsDir: string;
let server: Server;
let base: string;

interface FakeConf {
  inboxMessages?: unknown[];
  tasksByRun?: Record<string, unknown[]>;
  workersByRun?: Record<string, unknown[]>;
  fail?: Record<string, boolean>;
}

function writeScript(conf: FakeConf): void {
  writeFileSync(scriptPath, JSON.stringify(conf));
}

function writeFakeOrca(): void {
  const src = `#!/usr/bin/env node
// Minimal Orca CLI double for chatHistory.test.ts — records argv, plays a script.
import { appendFileSync, readFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_ORCA_LOG) {
  appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify({ argv: args }) + "\\n");
}
let conf = {};
const f = process.env.FAKE_ORCA_SCRIPT;
if (f && existsSync(f)) { try { conf = JSON.parse(readFileSync(f, "utf8")); } catch {} }
if (args[0] === "--version") {
  process.stdout.write((conf.version ?? "1.4.205") + "\\n");
  process.exit(0);
}
const fail = (conf.fail ?? {})[args[0] + (args[1] ? "." + args[1] : "")];
if (fail) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: "read_failed", message: "scripted failure" } }));
  process.exit(1);
}
const out = { ok: true, result: {} };
// The real CLI applies --limit to the GLOBAL stream; foreign rows occupy the
// window exactly like this Run's own rows would.
if (args[0] === "orchestration" && args[1] === "inbox") {
  const limitAt = args.indexOf("--limit");
  const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : 100;
  const messages = conf.inboxMessages ?? [];
  out.result = { messages: messages.slice(0, limit), count: Math.min(messages.length, limit) };
}
if (args[0] === "orchestration" && args[1] === "task-list") {
  const runAt = args.indexOf("--run");
  out.result = { tasks: (conf.tasksByRun ?? {})[args[runAt + 1]] ?? [] };
}
if (args[0] === "orchestration" && args[1] === "worker-list") {
  const runAt = args.indexOf("--run");
  out.result = {
    workers: (conf.workersByRun ?? {})[args[runAt + 1]] ?? [],
    page: { hasMore: false, nextCursor: null },
  };
}
process.stdout.write(JSON.stringify(out));
`;
  writeFileSync(fixturePath, src);
  chmodSync(fixturePath, 0o755);
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "orca-dag-chat-test-"));
  fixturePath = join(root, "fake-orca.mjs");
  scriptPath = join(root, "fake-orca.json");
  wsDir = realpathSync(mkdtempSync(join(tmpdir(), "orca-dag-chat-ws-")));
  writeFakeOrca();
  writeScript({});
  process.env.FAKE_ORCA_LOG = join(root, "calls.log");
  process.env.FAKE_ORCA_SCRIPT = scriptPath;
  initOrcaRuntime({ env: { ORCA_CLI_COMMAND: fixturePath, WORKSPACE_DIR: wsDir }, cwd: root });
  const { app } = createApp({ workspaceDir: wsDir, worktree: "active", policy, embeddedAssets: null });
  server = await listenLoopback(app, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  rmSync(wsDir, { recursive: true, force: true });
});

/** A realistic OrcaMessage row (only the fields the projection reads). */
function msg(over: Partial<OrcaMessage> & { id: string; run_id: string }): OrcaMessage {
  return {
    delivery_contract: null,
    from_handle: "term_worker",
    to_handle: "run:" + over.run_id,
    subject: "Progress",
    body: "Working.",
    type: "status",
    priority: "normal",
    thread_id: null,
    payload: null,
    created_at: "2026-09-21T00:00:00Z",
    delivered_at: null,
    ...over,
  };
}

async function getActivity(runId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/activity?run=${encodeURIComponent(runId)}`);
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

describe("threaded chat history over HTTP", () => {
  it("threads question/reply/ack through the API with priority and tri-state read", async () => {
    writeScript({
      inboxMessages: [
        msg({
          id: "q1",
          run_id: "run_t",
          type: "question",
          subject: "Question",
          body: "Ship now or after review?",
          priority: "urgent",
          read: 0,
          created_at: "2026-09-21T00:00:01Z",
        }),
        msg({
          id: "r1",
          run_id: "run_t",
          from_handle: "run:run_t",
          to_handle: "dispatch:ctx_t",
          type: "status",
          subject: "Re: Question",
          body: "After review.",
          thread_id: "q1",
          // no read marker: older runtime, absence must stay unknown
          created_at: "2026-09-21T00:00:02Z",
        }),
        msg({
          id: "ack1",
          run_id: "run_t",
          type: "status",
          subject: "Round acknowledged",
          body: "Understood.",
          thread_id: "q1",
          read: 1,
          created_at: "2026-09-21T00:00:03Z",
        }),
      ],
    });

    const json = await getActivity("run_t");
    const events = json.events as Array<Record<string, unknown>>;
    assert.deepEqual(events.map((event) => event.id), ["ack1", "r1", "q1"], "newest first, interleaved with checks");

    const question = events.find((event) => event.id === "q1")!;
    assert.equal(question.priority, "urgent");
    assert.equal(question.read, false, "explicit unread marker survives the wire");
    assert.equal(question.threadId, null);

    const reply = events.find((event) => event.id === "r1")!;
    assert.equal(reply.threadId, "q1", "the reply keeps Orca's own thread id");
    assert.equal(reply.read, null, "absent marker is unknown, never unread");
    assert.equal(reply.direction, "coordinator_to_agent");

    const ack = events.find((event) => event.id === "ack1")!;
    assert.equal(ack.threadId, "q1");
    assert.equal(ack.read, true);

    const window = json.inboxWindow as Record<string, unknown>;
    assert.deepEqual(window, { limit: ORCHESTRATION_INBOX_LIMIT, observed: 3, saturated: false });
  });

  it("flags a saturated global window even when the selected Run has few rows", async () => {
    // The selected Run has exactly 3 rows; 4997 OTHER-Run rows fill the rest
    // of the global window. Older rows of ANY Run — including this one — may
    // exist past the window, and foreign rows must still never leak.
    const foreign = Array.from({ length: ORCHESTRATION_INBOX_LIMIT - 3 }, (_, index) =>
      msg({ id: `foreign_${index}`, run_id: "run_other", created_at: "2026-09-20T00:00:00Z" }),
    );
    writeScript({
      inboxMessages: [
        msg({ id: "s1", run_id: "run_sat", body: "one" }),
        msg({ id: "s2", run_id: "run_sat", body: "two" }),
        msg({ id: "s3", run_id: "run_sat", body: "three" }),
        ...foreign,
      ],
    });

    const json = await getActivity("run_sat");
    const window = json.inboxWindow as Record<string, unknown>;
    assert.deepEqual(window, {
      limit: ORCHESTRATION_INBOX_LIMIT,
      observed: ORCHESTRATION_INBOX_LIMIT,
      saturated: true,
    });
    const events = json.events as Array<Record<string, unknown>>;
    assert.equal(events.length, 3, "few visible rows do not suppress the completeness warning");
    assert.ok(events.every((event) => event.runId === "run_sat"), "foreign rows never leak into the Run");
  });

  it("leaves completeness unknown when the history read fails", async () => {
    writeScript({ fail: { "orchestration.inbox": true } });

    // A fresh Run id: the short activity cache must not serve the previous
    // test's window evidence for this one.
    const json = await getActivity("run_fail");
    assert.equal(json.inboxWindow, null, "no window evidence — no completeness claim either way");
    assert.deepEqual(json.events, []);
    assert.equal(json.truncated, false);
  });
});
