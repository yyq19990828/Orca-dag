import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { get as httpGet, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp, listenLoopback } from "./app";
import { createSecurityPolicy } from "./security";
import {
  PluginBridge,
  createPluginToken,
  removePluginEndpointFile,
  writePluginEndpointFile,
} from "./pluginBridge";
import { pluginEndpointPath, pluginRequestToken, readPluginEndpointFile, signPluginReply } from "../../plugin/src/endpoint";
import { openOrcaViewerTab } from "./orca";

describe("PluginBridge & endpoint discovery (M1)", () => {
  it("uses a private registry, rejects symlinks, and removes only its own instance", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "odag-plugin-ep-"));
    const homeVar = process.platform === "win32" ? "USERPROFILE" : "HOME";
    const previousHome = process.env[homeVar];
    process.env[homeVar] = dir;
    t.after(() => {
      if (previousHome === undefined) delete process.env[homeVar];
      else process.env[homeVar] = previousHome;
    });
    try {
      const token = createPluginToken();
      const written = writePluginEndpointFile(dir, {
        version: 2,
        port: 8787,
        pid: process.pid,
        instanceId: "inst-a",
        pluginToken: token,
        workspace: realpathSync(dir),
      });
      assert.equal(written, pluginEndpointPath(dir));
      assert.equal(existsSync(join(dir, ".orca-dag")), false);
      if (process.platform !== "win32") {
        assert.equal(lstatSync(dirname(written)).mode & 0o777, 0o700);
        assert.equal(lstatSync(written).mode & 0o777, 0o600);
      }
      const parsed = JSON.parse(readFileSync(written, "utf8")) as { instanceId: string; pluginToken: string };
      assert.equal(parsed.instanceId, "inst-a");
      assert.equal(parsed.pluginToken, token);

      // Mismatched instanceId must NOT delete another instance's endpoint file.
      assert.equal(removePluginEndpointFile(dir, "inst-other"), false);
      assert.equal(existsSync(written), true);

      assert.equal(removePluginEndpointFile(dir, "inst-a"), true);
      assert.equal(existsSync(written), false);
      const outside = join(dir, "outside.json");
      writeFileSync(outside, "untouched");
      symlinkSync(outside, written);
      assert.equal(readPluginEndpointFile(dir), null);
      assert.throws(() =>
        writePluginEndpointFile(dir, {
          version: 2,
          port: 8787,
          pid: process.pid,
          instanceId: "inst-b",
          pluginToken: token,
          workspace: realpathSync(dir),
        }),
      );
      assert.equal(readFileSync(outside, "utf8"), "untouched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tracks hello, wakes scoped readers, and delivers inbox commands with receipts", async () => {
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
      statusEvents: [{ terminalId: "term_1" }],
      toolEvents: [{ terminalId: "term_1" }],
    });
    assert.equal(ingested.acceptedStatus, 1);
    assert.equal(ingested.acceptedTools, 1);
    assert.deepEqual(wakes, ["status:term_1", "tool:term_1"]);

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

  it("does not deliver an expired command to a reconnecting companion", async () => {
    const bridge = new PluginBridge();
    bridge.hello({});
    try {
      await assert.rejects(bridge.enqueueCommand("agent.resume", { sessionId: "expired" }, 1), /timed out/);
      assert.deepEqual((await bridge.pullInbox(0)).commands, []);
    } finally {
      bridge.close();
    }
  });

  it("restricts HTTP to loopback hosts, signs plugin replies, and uninstalls private discovery", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "odag-plugin-http-"));
    const fakeHome = join(dir, "fake-home");
    mkdirSync(fakeHome);
    const homeVar = process.platform === "win32" ? "USERPROFILE" : "HOME";
    const previousHome = process.env[homeVar];
    process.env[homeVar] = fakeHome;
    t.after(() => {
      if (previousHome === undefined) delete process.env[homeVar];
      else process.env[homeVar] = previousHome;
    });
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
      const [rejectedHost] = await once(
        httpGet(`${base}/api/session`, { headers: { Host: "not-a-viewer.invalid" } }), "response",
      ) as [IncomingMessage];
      rejectedHost.resume();
      assert.equal(rejectedHost.statusCode, 403);
      const session = await fetch(`${base}/api/session`);
      assert.equal(session.status, 200);
      assert.equal(session.headers.get("content-security-policy"), "frame-ancestors 'none'");
      assert.equal(session.headers.get("x-frame-options"), "DENY");
      await session.body?.cancel();

      // Missing/bad token must be refused with 403.
      const unauth = await fetch(`${base}/api/plugin/hello`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pluginId: "orchestration-panel" }),
      });
      assert.equal(unauth.status, 403);

      // Exact plugin token authenticates hello + events + inbox.
      const nonce = "a".repeat(22);
      const headers = { "x-orca-plugin-token": pluginRequestToken(pluginToken), "x-orca-plugin-nonce": nonce };
      const hello = await fetch(`${base}/api/plugin/hello`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          pluginId: "orchestration-panel",
          version: "0.1.0",
          hostApiMinor: 10,
          grantedCapabilities: ["workspace:read", "agent:read"],
        }),
      });
      assert.equal(hello.status, 200);
      const helloBody = await hello.text();
      assert.equal(hello.headers.get("x-orca-plugin-proof"), signPluginReply(pluginToken, "hello", nonce, helloBody));
      const helloJson = JSON.parse(helloBody) as { ok: boolean; status: { connected: boolean } };
      assert.equal(helloJson.ok, true);
      assert.equal(helloJson.status.connected, true);

      const inbox = await fetch(`${base}/api/plugin/inbox?waitMs=0`, {
        headers,
      });
      assert.equal(inbox.status, 200);
      const inboxBody = await inbox.text();
      assert.equal(inbox.headers.get("x-orca-plugin-proof"), signPluginReply(pluginToken, "inbox", nonce, inboxBody));
      const inboxJson = JSON.parse(inboxBody) as { ok: boolean; statusBar: { text: string } | null };
      assert.equal(inboxJson.ok, true);
      assert.equal(inboxJson.statusBar?.text, "Orchestration");

      // Use an isolated HOME so uninstall never touches user files.
      const ep = writePluginEndpointFile(dir, {
        version: 2,
        port,
        pid: process.pid,
        instanceId: "inst-uninstall",
        pluginToken,
        workspace: realpathSync(dir),
      });
      assert.equal(existsSync(ep), true);
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
        [homeVar]: fakeHome,
        WORKSPACE_DIR: dir,
        ORCA_CLI_COMMAND: JSON.stringify(process.execPath),
        NO_OPEN: "1",
      };
      const dry = spawnSync(process.execPath, ["--import", loader, entry, "uninstall", "--dry-run"], {
        cwd: dir, env: childEnv, encoding: "utf8", timeout: 15_000,
      });
      assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
      assert.match(dry.stdout, /would remove.*private plugin discovery endpoint/);
      assert.equal(existsSync(ep), true);

      const real = spawnSync(process.execPath, ["--import", loader, entry, "uninstall"], {
        cwd: dir, env: childEnv, encoding: "utf8", timeout: 15_000,
      });
      assert.equal(real.status, 0, `${real.stdout}\n${real.stderr}`);
      assert.match(real.stdout, /removed.*private plugin discovery endpoint/);
      assert.equal(existsSync(ep), false);
    } finally {
      pluginBridge.close();
      outputTails.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("openOrcaViewerTab and POST /api/open-tab", () => {
  it("reuses an existing worktree tab with deep-link goto, and creates one when absent", async () => {
    const calls: string[][] = [];
    const reused = await openOrcaViewerTab({
      baseUrl: "http://localhost:8787",
      hash: "#section=chat&task=task_1",
      worktree: "path:/tmp/ws",
      isOriginAliveFn: async () => true,
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

    // When a previous tab's port is no longer alive (e.g. closed dev terminal),
    // revive that same tab in-place onto our live embedded viewer URL.
    const reviveCalls: string[][] = [];
    const revived = await openOrcaViewerTab({
      baseUrl: "http://localhost:43210",
      worktree: "path:/tmp/ws",
      isOriginAliveFn: async () => false,
      runOrcaFn: (async (args: string[]) => {
        reviveCalls.push(args);
        if (args[0] === "tab" && args[1] === "list") {
          return {
            tabs: [
              {
                browserPageId: "page_dead_1",
                url: "http://localhost:5173/",
                title: "Orchestration Panel",
              },
            ],
          };
        }
        return {};
      }) as typeof import("./orca").runOrca,
    });
    assert.equal(revived.ok, true);
    assert.equal(revived.reused, true);
    assert.equal(revived.url, "http://localhost:43210/");
    assert.deepEqual(reviveCalls, [
      ["tab", "list", "--worktree", "path:/tmp/ws"],
      ["goto", "--page", "page_dead_1", "--url", "http://localhost:43210/"],
      ["tab", "switch", "--page", "page_dead_1", "--focus"],
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
