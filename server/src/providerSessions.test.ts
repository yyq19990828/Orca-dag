import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import {
  discoverProviderSession,
  openCodeSessionTitle,
  probeRecoverySession,
  ProviderSessionStore,
} from "./providerSessions";

const root = await mkdtemp(join(tmpdir(), "orca-dag-provider-sessions-"));
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

describe("provider session identity", () => {
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
