import { after, before, describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import {
  discoverProviderSession,
  openCodeSessionTitle,
  probeRecoverySession,
  ProviderSessionStore,
  SESSIONS_FILE,
  type MailboxCheckCheckpoint,
  type GuidanceSendCheckpoint,
} from "./providerSessions";

// Darwin's sockaddr_un is shorter than the default per-user temp path plus
// Codex's fixed socket suffix. Keep the actual socket and workspace canonical.
const root = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "od-provider-")));
const workspace = join(root, "worktree");
const socketDir = join(root, "app-server-control");
const socket = join(socketDir, "app-server-control.sock");
const oldCodexHome = process.env.CODEX_HOME;
let server: Server;
let wsServer: WebSocketServer;
let listRows: Record<string, unknown>[] = [];
let readStatus = "active";

const identity = {
  runId: "run_test",
  taskId: "task_test",
  dispatchId: "ctx_test",
  harness: "codex" as const,
  workspace,
  host: "local:local",
};

before(async () => {
  await mkdir(workspace);
  await mkdir(socketDir);
  process.env.CODEX_HOME = root;
  server = createServer();
  wsServer = new WebSocketServer({ server });
  wsServer.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const request = JSON.parse(String(raw)) as { id?: number; method?: string };
      if (request.method === "initialize") ws.send(JSON.stringify({ id: request.id, result: {} }));
      if (request.method === "thread/list") ws.send(JSON.stringify({
        id: request.id, result: { data: listRows, nextCursor: null },
      }));
      if (request.method === "thread/read") ws.send(JSON.stringify({
        id: request.id,
        result: { thread: { id: "thread_test", cwd: workspace, status: { type: readStatus } } },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
});

after(async () => {
  for (const client of wsServer.clients) client.terminate();
  await new Promise<void>((resolve) => wsServer.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = oldCodexHome;
  await rm(root, { recursive: true, force: true });
});

// Separate Node processes model the external and embedded viewers. Pause
// just before one rename, after its stale snapshot would have been exposed
// to the other writer without a lock covering the complete transaction.
const journalWriter = `
  import { once } from "node:events";
  import fs from "node:fs/promises";
  import { syncBuiltinESMExports } from "node:module";
  import { join } from "node:path";
  const [moduleUrl, workspace, mode, holderPid] = process.argv.slice(1);
  // A subprocess started with --eval has no module-relative source path.
  const { ProviderSessionStore, SESSIONS_FILE } = await import(moduleUrl);
  const store = new ProviderSessionStore(workspace);
  const timestamp = new Date().toISOString();
  const shared = { runId: "run_shared", from: "term_coordinator", state: "prepared",
    createdAt: timestamp, updatedAt: timestamp, error: null };
  if (mode === "mailbox") {
    const rename = fs.rename;
    fs.rename = async (source, target) => {
      if (target === join(workspace, SESSIONS_FILE)) {
        const commit = once(process, "message");
        process.send("staged");
        await commit;
      }
      return rename(source, target);
    };
    syncBuiltinESMExports();
    await store.recordMailboxCheck({ ...shared, requestId: "request_mail",
      ack: null, delivery: null, processedMessageIds: [], pendingQuestionIds: [] });
  } else {
    const kill = process.kill;
    let reported = false;
    process.kill = (pid, signal) => {
      const result = kill.call(process, pid, signal);
      if (!reported && signal === 0 && pid === Number(holderPid)) {
        reported = true;
        process.send("contended");
      }
      return result;
    };
    await store.recordGuidanceSend({ ...shared, requestId: "request_send",
      requestedTaskId: "task_shared", requestedDispatchId: "ctx_shared", receipt: null, creationProven: false });
  }
  process.disconnect();
`;

function startJournalWriter(t: TestContext, dir: string, mode: "mailbox" | "guidance", holder?: ChildProcess) {
  const child = spawn(process.execPath, [
    "--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", journalWriter,
    new URL("./providerSessions.ts", import.meta.url).href, dir, mode, String(holder?.pid ?? ""),
  ], { stdio: ["ignore", "ignore", "inherit", "ipc"], timeout: 15_000 });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  return { child, closed };
}

async function expectWriterMessage(child: ChildProcess, expected: string) {
  const abort = new AbortController();
  try {
    const actual = await Promise.race([
      once(child, "message", { signal: abort.signal }).then(([message]) => message),
      once(child, "close", { signal: abort.signal }).then(([code, signal]) => `exited (${code ?? signal})`),
    ]);
    assert.equal(actual, expected);
  } finally {
    abort.abort();
  }
}

describe("workspace session journal ownership", () => {
  it("preserves both checkpoints from independently contending viewer processes", async (t) => {
    const dir = await mkdtemp(join(root, "concurrent-"));
    const holder = startJournalWriter(t, dir, "mailbox");
    await expectWriterMessage(holder.child, "staged");
    const stateDir = dirname(join(dir, SESSIONS_FILE));
    const staged = (await readdir(stateDir)).find(name => name.endsWith(".tmp"));
    assert.ok(staged);
    // A suspended writer must never lose its lock to an expired timestamp.
    await utimes(join(stateDir, staged.slice(0, -4)), 1, 1);
    const contender = startJournalWriter(t, dir, "guidance", holder.child);
    await expectWriterMessage(contender.child, "contended");
    holder.child.send("commit");
    assert.deepEqual(await Promise.all([holder.closed, contender.closed]), [[0, null], [0, null]]);

    const store = new ProviderSessionStore(dir);
    assert.deepEqual((await store.listMailboxChecks()).map(row => row.requestId), ["request_mail"]);
    assert.deepEqual((await store.listGuidanceSends()).map(row => row.requestId), ["request_send"]);
    assert.deepEqual(await readdir(stateDir), [basename(SESSIONS_FILE)]);
  });

  it("reaps a killed writer's claim and staged data without committing the interrupted update", async (t) => {
    const dir = await mkdtemp(join(root, "crash-"));
    const store = new ProviderSessionStore(dir);
    const input = { ...identity, workspace: dir, sessionId: "thread_before", source: "manual" as const };
    const original = await store.bind(input);
    const holder = startJournalWriter(t, dir, "mailbox");
    await expectWriterMessage(holder.child, "staged");
    const stateDir = dirname(join(dir, SESSIONS_FILE));
    assert.equal((await readdir(stateDir)).filter(name => name.endsWith(".tmp")).length, 1);
    assert.equal(holder.child.kill("SIGKILL"), true);
    await holder.closed;
    assert.deepEqual(await store.list(), [original]);
    assert.deepEqual(await store.listMailboxChecks(), []);
    const later = await store.bind({ ...input, dispatchId: "ctx_after", sessionId: "thread_after" });
    assert.deepEqual(await store.list(), [original, later]);
    assert.deepEqual(await readdir(stateDir), [basename(SESSIONS_FILE)]);
  });

  it("refuses symlinked state and lock directories without touching their target", async () => {
    const dir = await mkdtemp(join(root, "symlink-"));
    const outside = await mkdtemp(join(root, "outside-"));
    const sentinel = join(outside, "keep");
    await writeFile(sentinel, "outside");
    const stateDir = dirname(join(dir, SESSIONS_FILE));
    const linkType = process.platform === "win32" ? "junction" : "dir";
    const bind = () => new ProviderSessionStore(dir).bind({ ...identity, workspace: dir, sessionId: "thread", source: "manual" });
    await symlink(outside, stateDir, linkType);
    await assert.rejects(bind(), /must be a real directory/);
    await rm(stateDir);
    await mkdir(stateDir);
    const claim = `${basename(SESSIONS_FILE)}.lock.${process.pid}.${randomUUID()}`;
    await symlink(outside, join(stateDir, claim), linkType);
    await assert.rejects(bind(), /must be a real directory/);
    assert.equal((await lstat(join(stateDir, claim))).isSymbolicLink(), true);
    assert.deepEqual(await readdir(stateDir), [claim]);
    assert.deepEqual(await readdir(outside), ["keep"]);
    assert.equal(await readFile(sentinel, "utf8"), "outside");
  });
});

describe("provider session identity", () => {
  it("persists critical mailbox and guidance identities alongside bindings across reloads", async () => {
    const store = new ProviderSessionStore(workspace);
    const timestamp = new Date().toISOString();
    const check: MailboxCheckCheckpoint = { requestId: "request_mail", runId: "run_mail", from: "term_mail", ack: null,
      state: "prepared", delivery: null, processedMessageIds: [], pendingQuestionIds: [], createdAt: timestamp, updatedAt: timestamp, error: null };
    const send: GuidanceSendCheckpoint = { requestId: "request_send", runId: "run_mail", from: "term_mail",
      requestedTaskId: "task_mail", requestedDispatchId: "ctx_mail", state: "prepared", receipt: null,
      creationProven: false, createdAt: timestamp, updatedAt: timestamp, error: null };
    await Promise.all([store.recordMailboxCheck(check), store.recordGuidanceSend(send)]);
    const reloaded = new ProviderSessionStore(workspace);
    assert.deepEqual(await reloaded.listMailboxChecks("run_mail"), [check]);
    assert.deepEqual(await reloaded.listGuidanceSends("run_mail"), [send]);
    await assert.rejects(() => reloaded.recordMailboxCheck({ ...check, from: "term_other" }), /identity/);
    await assert.rejects(() => reloaded.recordGuidanceSend({ ...send, requestedDispatchId: "ctx_other" }), /identity/);
    assert.ok((await reloaded.list(identity.runId)).every(binding => binding.runId === identity.runId));
  });

  it("keeps accepted follow-up identities and the first unknown readiness across reloads", async () => {
    const store = new ProviderSessionStore(workspace);
    const now = new Date().toISOString();
    const row: GuidanceSendCheckpoint = {
      requestId: "request_followup", runId: "run_followup", from: "term_coordinator",
      requestedTaskId: "task_original", requestedDispatchId: "ctx_original",
      state: "unknown", creationProven: true, createdAt: now, updatedAt: now, error: "start_unconfirmed",
      receipt: { kind: "follow_up", runId: "run_followup", taskId: "task_followup", dispatchId: "ctx_followup",
        requestedTaskId: "task_original", requestedDispatchId: "ctx_original", followUpOf: "ctx_original", requestId: "request_followup", destinationRunId: null },
      startEvidence: { status: "outcome_unknown", launchMode: { mode: "terminal", preferred: null, reason: null, detail: null } },
    };
    await store.recordGuidanceSend(row);
    const reloaded = new ProviderSessionStore(workspace);
    assert.deepEqual((await reloaded.listGuidanceSends(row.runId))[0], row);
    await assert.rejects(() => reloaded.recordGuidanceSend({ ...row, startEvidence: { status: "ready" } }), /identity/);
    await assert.rejects(() => reloaded.recordGuidanceSend({ ...row, receipt: { ...row.receipt!, dispatchId: "ctx_other" } }), /identity/);
  });

  it("retains mixed V3 delivery and question progress across a store reload", async () => {
    const timestamp = new Date().toISOString();
    const message = { id: "msg_question", run_id: "run_mixed", from_handle: "term_worker", to_handle: null,
      subject: "Need input", body: "full untruncated question", type: "question", priority: "normal",
      delivery_contract: "current_delivery", thread_id: null, payload: null, created_at: timestamp, delivered_at: timestamp };
    const check: MailboxCheckCheckpoint = { requestId: "request_mixed", runId: "run_mixed", from: "term_coordinator", ack: null,
      state: "pending_input", delivery: { runId: "run_mixed", deliveryId: "delivery_mixed", messages: [message], count: 1,
        replayed: false, deliveryAcknowledged: true, acknowledged: null, timedOut: false, cancelled: false, connectionLost: false },
      processedMessageIds: [message.id], pendingQuestionIds: [message.id], createdAt: timestamp, updatedAt: timestamp, error: null };
    await new ProviderSessionStore(workspace).recordMailboxCheck(check);
    const restored = (await new ProviderSessionStore(workspace).listMailboxChecks("run_mixed"))[0];
    assert.equal(restored.delivery?.messages[0].body, message.body);
    assert.equal(restored.delivery?.deliveryAcknowledged, true);
    assert.deepEqual(restored.pendingQuestionIds, [message.id]);
    await assert.rejects(() => new ProviderSessionStore(workspace).recordMailboxCheck({ ...check, processedMessageIds: [] }));
    await assert.rejects(() => new ProviderSessionStore(workspace).recordMailboxCheck({
      ...check, pendingQuestionIds: [], state: "completed",
    }));
    assert.deepEqual((await new ProviderSessionStore(workspace).listMailboxChecks("run_mixed"))[0], check);
  });

  it("clears a pending permission message only with its immutable, durable decision", async () => {
    const store = new ProviderSessionStore(workspace);
    const timestamp = new Date().toISOString();
    const message = { id: "msg_permission", run_id: "run_permission", from_handle: "term_worker", to_handle: null,
      subject: "Need permission", body: "Permission is required", type: "escalation", priority: "normal",
      delivery_contract: "current_delivery", thread_id: null, payload: null, created_at: timestamp, delivered_at: timestamp };
    const check: MailboxCheckCheckpoint = { requestId: "request_check_permission", runId: message.run_id, from: "term_coordinator",
      ack: null, state: "pending_input", delivery: { runId: message.run_id, deliveryId: "delivery_permission", messages: [message],
        count: 1, replayed: false, deliveryAcknowledged: true, acknowledged: null, timedOut: false, cancelled: false, connectionLost: false },
      processedMessageIds: [message.id], pendingQuestionIds: [message.id], createdAt: timestamp, updatedAt: timestamp, error: null };
    await store.recordMailboxCheck(check);

    const decision = { dispatchId: "ctx_permission", promptId: "perm_prompt", decision: "deny" as const, requestId: "request_deny" };
    const completed: MailboxCheckCheckpoint = { ...check, state: "completed", pendingQuestionIds: [] };
    await assert.rejects(store.recordMailboxCheck({ ...completed, resolvedPermissionPrompts: { [decision.promptId]: decision } }),
      /Pending input cannot be cleared/);
    await assert.rejects(store.recordMailboxCheck({ ...completed,
      resolvedPermissionPrompts: { [message.id]: { ...decision, promptId: "invalid/prompt" } } }), /permission prompt promptId/);
    await assert.rejects(store.recordMailboxCheck({ ...completed,
      resolvedPermissionPrompts: { [message.id]: { ...decision, decision: "always" as unknown as typeof decision.decision } } }), /Invalid permission prompt decision/);

    const resolved = { ...completed, resolvedPermissionPrompts: { [message.id]: decision } };
    await store.recordMailboxCheck(resolved);
    const reloaded = new ProviderSessionStore(workspace);
    assert.deepEqual(await reloaded.listMailboxChecks(check.runId), [resolved]);
    await assert.rejects(reloaded.recordMailboxCheck(completed), /Permission prompt resolution cannot change/);
    await assert.rejects(reloaded.recordMailboxCheck({ ...completed,
      resolvedPermissionPrompts: { [message.id]: { ...decision, decision: "approve" } } }), /Permission prompt resolution cannot change/);
  });

  it("does not truncate or replace a prepared request when its delivery exceeds the store budget", async () => {
    const store = new ProviderSessionStore(workspace);
    const timestamp = new Date().toISOString();
    const check: MailboxCheckCheckpoint = { requestId: "request_oversized", runId: "run_oversized", from: "term_oversized", ack: null,
      state: "prepared", delivery: null, processedMessageIds: [], pendingQuestionIds: [], createdAt: timestamp, updatedAt: timestamp, error: null };
    await store.recordMailboxCheck(check);
    const message = { id: "msg_oversized", run_id: check.runId, from_handle: "term_worker", to_handle: null,
      subject: "question", body: "x".repeat(2 * 1024 * 1024), type: "question", priority: "normal",
      delivery_contract: "current_delivery", thread_id: null, payload: null, created_at: timestamp, delivered_at: timestamp };
    await assert.rejects(() => store.recordMailboxCheck({ ...check, state: "received", delivery: {
      runId: check.runId, deliveryId: "delivery_oversized", messages: [message], count: 1, replayed: false,
      deliveryAcknowledged: true, acknowledged: null, timedOut: false, cancelled: false, connectionLost: false,
    } }), /full/);
    assert.equal((await new ProviderSessionStore(workspace).listMailboxChecks(check.runId))[0].state, "prepared");
  });
  it("creates only a shell-safe Dispatch-specific OpenCode title", () => {
    assert.equal(openCodeSessionTitle("run_a", "task_b", "ctx_c"), "orca-dag:run_a:task_b:ctx_c");
    assert.throws(() => openCodeSessionTitle("run_a", "task_$(touch bad)", "ctx_c"));
  });

  it("binds one exact identity durably and refuses a different session", async () => {
    const store = new ProviderSessionStore(workspace);
    const input = { ...identity, sessionId: "thread_test", source: "provider-evidence" as const };
    const first = await store.bind(input);
    assert.equal((await store.bind(input)).createdAt, first.createdAt);
    assert.equal((await store.list(identity.runId))[0]?.sessionId, "thread_test");
    await assert.rejects(() => store.bind({ ...input, sessionId: "other_thread" }));
  });

  it("discovers Codex only from unique exact Task and Dispatch markers", async () => {
    listRows = [{ id: "thread_test", cwd: workspace, preview: "Task task_test; Dispatch ctx_test." }];
    assert.equal(await discoverProviderSession(identity), "thread_test");
    listRows = [{ id: "thread_test", cwd: workspace, preview: "Task task_test; Dispatch ctx_test_extra." }];
    assert.equal(await discoverProviderSession(identity), null);
    listRows = [
      { id: "thread_test", cwd: workspace, preview: "task_test ctx_test" },
      { id: "thread_other", cwd: workspace, preview: "task_test ctx_test" },
    ];
    assert.equal(await discoverProviderSession(identity), null);
  });

  it("keeps notLoaded unknown and reports loaded exact Codex status", async () => {
    const input = { ...identity, sessionId: "thread_test" };
    readStatus = "notLoaded";
    assert.equal((await probeRecoverySession(input)).status, "unknown");
    readStatus = "active";
    assert.equal((await probeRecoverySession(input)).status, "active");
    readStatus = "idle";
    assert.equal((await probeRecoverySession(input)).status, "idle");
  });
});
