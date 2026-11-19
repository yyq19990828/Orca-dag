import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Response } from "express";
import { createApp, listenLoopback } from "./app";
import { createSecurityPolicy } from "./security";
import {
  PluginBridge,
  createPluginToken,
  removePluginEndpointFile,
  writePluginEndpointFile,
} from "./pluginBridge";
import { OutputTailManager } from "./outputTail";
import { WORKSPACE_ENDPOINT_FILE } from "./workspaceState";
import { openOrcaViewerTab, type WorkerOutputReceipt } from "./orca";

function makeFakeSseResponse(): {
  res: Response;
  frames: Array<{ event: string; data: unknown }>;
  close: () => void;
} {
  const frames: Array<{ event: string; data: unknown }> = [];
  let buf = "";
  const state = { writableEnded: false, destroyed: false };
  const res = {
    get writableEnded() { return state.writableEnded; },
    get destroyed() { return state.destroyed; },
    write(chunk: string) {
      buf += chunk;
      let idx = buf.indexOf("\n\n");
      while (idx >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let dataStr = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataStr += line.slice(6);
        }
        if (dataStr) {
          frames.push({ event, data: JSON.parse(dataStr) });
        }
        idx = buf.indexOf("\n\n");
      }
      return true;
    },
    end() {
      state.writableEnded = true;
    },
  } as unknown as Response;
  return {
    res,
    frames,
    close: () => {
      state.writableEnded = true;
      state.destroyed = true;
    },
  };
}

describe("PluginBridge & endpoint discovery (M1)", () => {
  it("writes 0o600 endpoint.json, rejects symlinks, and removes only matching instanceId", () => {
    const dir = mkdtempSync(join(tmpdir(), "odag-plugin-ep-"));
    try {
      const token = createPluginToken();
      const { path: written, createdDir } = writePluginEndpointFile(dir, {
        version: 1,
        port: 8787,
        pid: process.pid,
        instanceId: "inst-a",
        pluginToken: token,
        workspace: dir,
        worktree: `path:${dir}`,
        startedAt: new Date().toISOString(),
      });
      assert.equal(written, join(dir, WORKSPACE_ENDPOINT_FILE));
      assert.equal(createdDir, true);
      const mode = lstatSync(written).mode & 0o777;
      assert.equal(mode, 0o600);
      const parsed = JSON.parse(readFileSync(written, "utf8")) as { instanceId: string; pluginToken: string };
      assert.equal(parsed.instanceId, "inst-a");
      assert.equal(parsed.pluginToken, token);

      // Mismatched instanceId must NOT delete another instance's endpoint file.
      assert.equal(removePluginEndpointFile(dir, "inst-other"), false);
      assert.equal(existsSync(written), true);

      // Matching instanceId removes cleanly (and prunes empty created dir when requested).
      assert.equal(removePluginEndpointFile(dir, "inst-a", { removeEmptyDir: createdDir }), true);
      assert.equal(existsSync(written), false);
      assert.equal(existsSync(join(dir, ".orca-dag")), false);

      // Re-create .orca-dag for symlink refusal test.
      mkdirSync(join(dir, ".orca-dag"));
      const outside = join(dir, "outside.json");
      writeFileSync(outside, "untouched");
      symlinkSync(outside, written);
      assert.throws(() =>
        writePluginEndpointFile(dir, {
          version: 1,
          port: 8787,
          pid: process.pid,
          instanceId: "inst-b",
          pluginToken: token,
          workspace: dir,
          worktree: `path:${dir}`,
          startedAt: new Date().toISOString(),
        }),
      );
      assert.equal(readFileSync(outside, "utf8"), "untouched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tracks hello, bounded tool/status ingestion, wake events, inbox delivery, and receipts", async () => {
    const bridge = new PluginBridge();
    bridge.setStatusSummaryProvider(() => ({
      text: "DAG · 1 active",
      tone: "accent",
      tooltip: "Run active",
    }));

    assert.equal(bridge.status().connected, false);
    const st = bridge.hello({
      pluginId: "orchestration-panel",
      version: "0.1.0",
      hostApiMinor: 10,
      grantedCapabilities: ["workspace:read", "agent:read", "agent:launch"],
    });
    assert.equal(st.connected, true);
    assert.equal(st.pluginId, "orchestration-panel");
    assert.equal(st.hostApiMinor, 10);

    const wakes: string[] = [];
    const off = bridge.onWake((evt) => wakes.push(`${evt.kind}:${evt.terminalId}`));

    const ingested = bridge.ingestEvents({
      statusEvents: [
        { terminalId: "term_1", state: "working", sessionId: "sess_1", workspaceListId: "identity:wt2:local:1" },
      ],
      toolEvents: [
        {
          terminalId: "term_1",
          agent: "codex",
          tool: "exec",
          callId: "call_1",
          inputPreview: "x".repeat(20_000),
          inputTruncated: true,
          outputPreview: "ok",
          outputTruncated: false,
        },
      ],
    });
    assert.equal(ingested.acceptedStatus, 1);
    assert.equal(ingested.acceptedTools, 1);
    assert.deepEqual(wakes, ["status:term_1", "tool:term_1"]);

    const agent = bridge.getObservedAgent("term_1");
    assert.equal(agent?.sessionId, "sess_1");
    assert.equal(agent?.workspaceListId, "identity:wt2:local:1");

    const tools = bridge.getLiveTools("term_1");
    assert.equal(tools.length, 1);
    assert.ok(tools[0].inputPreview.length <= 8_192);

    // Command + inbox + receipt round-trip
    bridge.enqueueNotification("Gate pending", "Approve deploy?");
    const cmdPromise = bridge.enqueueCommand("agent.resume", {
      workspaceId: "identity:wt2:local:1",
      agent: "codex",
      sessionId: "sess_1",
    });
    const inbox = await bridge.pullInbox(0);
    assert.equal(inbox.notifications.length, 1);
    assert.equal(inbox.statusBar?.text, "DAG · 1 active");
    assert.equal(inbox.commands.length, 1);
    const cmd = inbox.commands[0];
    assert.equal(bridge.submitReceipt(cmd.id, { ok: true, terminalId: "term_2", started: true }), true);
    const receipt = await cmdPromise;
    assert.equal(receipt.terminalId, "term_2");

    off();
    bridge.close();
    assert.equal(bridge.status().connected, false);
  });

  it("enforces pluginToken on /api/plugin/* routes and removes stale endpoint.json on uninstall", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odag-plugin-http-"));
    const pluginToken = createPluginToken();
    const { app, pluginBridge, outputTails } = createApp({
      workspaceDir: dir,
      worktree: `path:${dir}`,
      policy: createSecurityPolicy(),
      pluginToken,
    });
    const server = await listenLoopback(app, 0);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      // Missing/bad token must be refused with 403.
      const unauth = await fetch(`${base}/api/plugin/hello`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pluginId: "orchestration-panel" }),
      });
      assert.equal(unauth.status, 403);

      // Exact plugin token authenticates hello + events + inbox.
      const hello = await fetch(`${base}/api/plugin/hello`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-orca-plugin-token": pluginToken },
        body: JSON.stringify({
          pluginId: "orchestration-panel",
          version: "0.1.0",
          hostApiMinor: 10,
          grantedCapabilities: ["workspace:read", "agent:read"],
        }),
      });
      assert.equal(hello.status, 200);
      const helloJson = (await hello.json()) as { ok: boolean; status: { connected: boolean } };
      assert.equal(helloJson.ok, true);
      assert.equal(helloJson.status.connected, true);

      const inbox = await fetch(`${base}/api/plugin/inbox?waitMs=0`, {
        headers: { "x-orca-plugin-token": pluginToken },
      });
      assert.equal(inbox.status, 200);
      const inboxJson = (await inbox.json()) as { ok: boolean; statusBar: { text: string } | null };
      assert.equal(inboxJson.ok, true);
      assert.equal(inboxJson.statusBar?.text, "Orchestration");

      // Uninstall removes stale endpoint.json even without --purge (respecting
      // --dry-run), tested in a child process with isolated HOME & CLI so tests
      // never touch the developer's HOME or live Orca terminals.
      const { path: ep } = writePluginEndpointFile(dir, {
        version: 1,
        port,
        pid: process.pid,
        instanceId: "inst-uninstall",
        pluginToken,
        workspace: dir,
        worktree: `path:${dir}`,
        startedAt: new Date().toISOString(),
      });
      assert.equal(existsSync(ep), true);
      const fakeHome = join(dir, "fake-home");
      mkdirSync(fakeHome);
      const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
      const loader = import.meta.resolve("tsx");
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith("ORCA_") || ["CLAUDE_CONFIG_DIR", "GROK_HOME", "KIRO_HOME", "CODEX_HOME"].includes(key)) {
          delete env[key];
        }
      }
      const childEnv: NodeJS.ProcessEnv = {
        ...env,
        HOME: fakeHome,
        WORKSPACE_DIR: dir,
        ORCA_CLI_COMMAND: JSON.stringify(process.execPath),
        NO_OPEN: "1",
      };
      const dry = spawnSync(process.execPath, ["--import", loader, entry, "uninstall", "--dry-run"], {
        cwd: dir, env: childEnv, encoding: "utf8", timeout: 15_000,
      });
      assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
      assert.match(dry.stdout, /would remove.*endpoint\.json/);
      assert.equal(existsSync(ep), true);

      const real = spawnSync(process.execPath, ["--import", loader, entry, "uninstall"], {
        cwd: dir, env: childEnv, encoding: "utf8", timeout: 15_000,
      });
      assert.equal(real.status, 0, `${real.stdout}\n${real.stderr}`);
      assert.match(real.stdout, /removed.*endpoint\.json/);
      assert.equal(existsSync(ep), false);
    } finally {
      pluginBridge.close();
      outputTails.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("OutputTailManager (M2)", () => {
  it("shares one upstream poller across subscribers, streams plugin liveTool, deduplicates by callId, and drains on exit", async () => {
    const bridge = new PluginBridge();
    bridge.hello({ pluginId: "orchestration-panel", version: "0.1.0", hostApiMinor: 10, grantedCapabilities: [] });

    let readCalls = 0;
    const pages: WorkerOutputReceipt[] = [
      {
        dispatchId: "ctx_1",
        source: "transcript",
        cursor: "c1",
        lines: ["[assistant] Starting"],
        messages: [
          {
            id: "m1",
            role: "assistant",
            timestamp: 1000,
            source: "transcript",
            blocks: [{ type: "text", text: "Starting" }],
          },
        ],
        contentComplete: false,
        clipped: false,
        warnings: [],
        sourceChanged: false,
        status: { worker: "running", terminal: "running", liveness: "live" },
      },
      {
        dispatchId: "ctx_1",
        source: "transcript",
        cursor: "c2",
        lines: ["[assistant] [tool exec] {\"cmd\":\"ls\"}"],
        messages: [
          {
            id: "m2",
            role: "assistant",
            timestamp: 2000,
            source: "transcript",
            blocks: [
              { type: "tool-call", name: "exec", input: "{\"cmd\":\"ls\"}", callId: "call_live_1" },
              { type: "tool-result", output: "README.md", isError: false, callId: "call_live_1" },
            ],
          },
        ],
        contentComplete: false,
        clipped: false,
        warnings: [],
        sourceChanged: false,
        status: { worker: "succeeded", terminal: "exited", liveness: "exited" },
      },
      {
        dispatchId: "ctx_1",
        source: "transcript",
        cursor: "c2",
        lines: [],
        messages: [],
        contentComplete: true,
        clipped: false,
        warnings: [],
        sourceChanged: false,
        status: { worker: "succeeded", terminal: "exited", liveness: "exited" },
      },
    ];

    const tails = new OutputTailManager({
      pluginBridge: bridge,
      readOutput: async () => {
        const idx = Math.min(readCalls, pages.length - 1);
        readCalls += 1;
        return pages[idx];
      },
    });

    const sub1 = makeFakeSseResponse();
    const sub2 = makeFakeSseResponse();
    const unsub1 = tails.subscribe({
      runId: "run_1",
      dispatchId: "ctx_1",
      source: "auto",
      terminalId: "term_live_1",
      res: sub1.res,
    });
    const unsub2 = tails.subscribe({
      runId: "run_1",
      dispatchId: "ctx_1",
      source: "auto",
      terminalId: "term_live_1",
      res: sub2.res,
    });

    // Wait for initial poll — BOTH subscribers share the exact 1 read call.
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(readCalls, 1);
    assert.equal(sub1.frames[0]?.event, "init");
    assert.equal(sub2.frames[0]?.event, "init");

    // Companion plugin fires agent.tool.after → immediate liveTool frame + wakeup poll!
    bridge.ingestEvents({
      toolEvents: [
        {
          terminalId: "term_live_1",
          agent: "codex",
          tool: "exec",
          callId: "call_live_1",
          inputPreview: "{\"cmd\":\"ls\"}",
          outputPreview: "README.md",
        },
      ],
    });
    assert.equal(sub1.frames.some((f) => f.event === "liveTool"), true);
    assert.equal(sub2.frames.some((f) => f.event === "liveTool"), true);

    // Debounced wakeup poll fetches page 2 (containing call_live_1), and next poll drains!
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(readCalls >= 2);
    assert.equal(sub1.frames.some((f) => f.event === "append"), true);

    // A late subscriber gets an init snapshot with call_live_1 already deduplicated out of liveTools.
    const sub3 = makeFakeSseResponse();
    const unsub3 = tails.subscribe({
      runId: "run_1",
      dispatchId: "ctx_1",
      source: "auto",
      terminalId: "term_live_1",
      res: sub3.res,
    });
    const init3 = sub3.frames.find((f) => f.event === "init")?.data as { liveTools: unknown[]; output: WorkerOutputReceipt };
    assert.ok(init3);
    assert.equal(init3.liveTools.length, 0);
    assert.equal(init3.output.messages?.length, 2);

    unsub1();
    unsub2();
    unsub3();
    tails.closeAll();
    bridge.close();
  });
});

describe("openOrcaViewerTab and POST /api/open-tab", () => {
  it("reuses an existing worktree tab with deep-link goto, and creates one when absent", async () => {
    const calls: string[][] = [];
    const reused = await openOrcaViewerTab({
      baseUrl: "http://localhost:8787",
      hash: "#section=chat&task=task_1",
      worktree: "path:/tmp/ws",
      runOrcaFn: (async (args: string[]) => {
        calls.push(args);
        if (args[0] === "tab" && args[1] === "list") {
          return {
            tabs: [
              {
                browserPageId: "page_existing_1",
                url: "http://localhost:5173/#view=board",
                title: "Orchestration Panel",
              },
            ],
          };
        }
        return {};
      }) as typeof import("./orca").runOrca,
    });
    assert.equal(reused.ok, true);
    assert.equal(reused.reused, true);
    assert.equal(reused.pageId, "page_existing_1");
    assert.equal(reused.url, "http://localhost:5173/#section=chat&task=task_1");
    assert.deepEqual(calls, [
      ["tab", "list", "--worktree", "path:/tmp/ws"],
      ["goto", "--page", "page_existing_1", "--url", "http://localhost:5173/#section=chat&task=task_1"],
      ["tab", "switch", "--page", "page_existing_1", "--focus"],
    ]);

    const createCalls: string[][] = [];
    const created = await openOrcaViewerTab({
      baseUrl: "http://localhost:8787",
      hash: "#section=settings",
      worktree: "path:/tmp/ws",
      runOrcaFn: (async (args: string[]) => {
        createCalls.push(args);
        if (args[0] === "tab" && args[1] === "list") return { tabs: [] };
        if (args[0] === "tab" && args[1] === "create") return { browserPageId: "page_new_2" };
        return {};
      }) as typeof import("./orca").runOrca,
    });
    assert.equal(created.ok, true);
    assert.equal(created.reused, false);
    assert.equal(created.pageId, "page_new_2");
    assert.equal(created.url, "http://localhost:8787/#section=settings");
    assert.deepEqual(createCalls, [
      ["tab", "list", "--worktree", "path:/tmp/ws"],
      ["tab", "create", "--worktree", "path:/tmp/ws", "--url", "http://localhost:8787/#section=settings"],
      ["tab", "switch", "--page", "page_new_2", "--focus"],
    ]);
  });

  it("enforces mutation token and validates hash on POST /api/open-tab", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odag-open-tab-"));
    const policy = createSecurityPolicy();
    const seen: Array<{ baseUrl: string; hash?: string; worktree?: string }> = [];
    const { app, pluginBridge, outputTails } = createApp({
      workspaceDir: dir,
      worktree: `path:${dir}`,
      policy,
      getViewerUrl: () => "http://localhost:8787",
      openViewerTabFn: async (opts) => {
        seen.push(opts);
        return { ok: true, reused: false, pageId: "page_1", url: `${opts.baseUrl}/${opts.hash ?? ""}` };
      },
    });
    const server = await listenLoopback(app, 0);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const noTok = await fetch(`${base}/api/open-tab`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(noTok.status, 403);

      const badHash = await fetch(`${base}/api/open-tab`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-orca-dag-token": policy.token },
        body: JSON.stringify({ hash: "https://evil.example" }),
      });
      assert.equal(badHash.status, 400);

      const okRes = await fetch(`${base}/api/open-tab`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-orca-dag-token": policy.token },
        body: JSON.stringify({ hash: "#section=chat&task=task_42" }),
      });
      assert.equal(okRes.status, 200);
      const body = (await okRes.json()) as { ok: boolean; pageId: string; url: string };
      assert.equal(body.ok, true);
      assert.equal(body.pageId, "page_1");
      assert.equal(seen[0]?.hash, "#section=chat&task=task_42");
    } finally {
      pluginBridge.close();
      outputTails.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
