import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openCodeTuiTitle, parseOpenCodeModel, readOpenCodeBoundSession, readOpenCodeExecution } from "./openCode";
import { ProviderSessionStore } from "./providerSessions";
import { coordinatorStatus, resetCoordinatorForTests, startCoordinator, stopCoordinator } from "./coordinator";
import { createApp, listenLoopback } from "./app";
import { createSecurityPolicy } from "./security";
import { RequestLedger } from "./requestLedger";
import { saveConfig } from "./config";
import {
  closeReleasedOpenCodeTui, initOrcaRuntime, inspectOpenCodeTui, listWorkers,
  readWorkerOutput, recoverOpenCodeTuiBindings, releaseWorker, retainOpenCodeTui,
  showWorkerDetail, startOpenCodeTuiWorker, startOpenCodeInteractiveWorker, stopWorkerReceipt,
} from "./orca";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orca-dag-tui-test-")));
const orcaFile = join(root, "orca.json");
const providerFile = join(root, "provider.json");
const orcaLog = join(root, "orca.log");
const providerLog = join(root, "provider.log");
const oldPath = process.env.PATH;
const envKeys = ["FAKE_ORCA_STATE", "FAKE_ORCA_LOG", "FAKE_OPENCODE_STATE", "FAKE_OPENCODE_LOG", "FAKE_OPENCODE_JOURNAL"];
const previousEnv = envKeys.map(key => process.env[key]);
const bin = join(root, "opencode");
const orcaBin = join(root, "orca");
writeFileSync(bin, readFileSync(new URL("../test/fixtures/fake-opencode.mjs", import.meta.url)));
writeFileSync(orcaBin, readFileSync(new URL("../test/fixtures/fake-orca.mjs", import.meta.url)));
chmodSync(bin, 0o755); chmodSync(orcaBin, 0o755);
process.env.PATH = `${root}:${oldPath}`;
process.env.FAKE_ORCA_STATE = orcaFile; process.env.FAKE_ORCA_LOG = orcaLog;
process.env.FAKE_OPENCODE_STATE = providerFile; process.env.FAKE_OPENCODE_LOG = providerLog;
process.env.FAKE_OPENCODE_JOURNAL = join(root, ".orca-dag/sessions.json");
const store = new ProviderSessionStore(root);
const load = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const update = (file: string, changes: Record<string, unknown>) => writeFileSync(file, JSON.stringify({ ...load(file), ...changes }));
const calls = (file: string, verb: string) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
  .map(line => JSON.parse(line)).filter(row => row.argv[1] === verb);
const start = () => startOpenCodeTuiWorker({ taskId: "task_test", runId: "run_test", from: "term_coordinator",
  worktree: `path:${root}`, model: "provider/model#high", retryRequestId: randomUUID(), onHandle: () => {} });
const interactive = (frontend: "mini" | "tui" = "mini", model: string | null = "provider/model#high") =>
  startOpenCodeInteractiveWorker({ frontend, taskId: "task_test", runId: "run_test", from: "term_coordinator",
    worktree: `path:${root}`, model, retryRequestId: randomUUID(), onHandle: () => {} });
const settle = () => {
  const data = load(orcaFile);
  const dispatch = Object.values(data.dispatches)[0] as Record<string, unknown>;
  dispatch.status = "completed"; dispatch.terminalState = "reclaimable";
  data.tasks.task_test.status = "completed";
  writeFileSync(orcaFile, JSON.stringify(data)); update(providerFile, { active: false });
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) return; await pause(25); }
  throw new Error(`Timed out: ${JSON.stringify(coordinatorStatus())}`);
}
async function settleWithLock(): Promise<void> {
  for (;;) {
    try { mkdirSync(`${orcaFile}.lock`); break; } catch { await pause(5); }
  }
  try { settle(); } finally { rmSync(`${orcaFile}.lock`, { recursive: true }); }
}
const coordinatorOpts = () => ({ runId: "run_test", worktree: `path:${root}`, defaultHarness: "opencode",
  harnessByTask: {}, modelByTask: { task_test: "provider/model#high" }, maxConcurrency: 1, tickWaitMs: 25 });

beforeEach(() => {
  rmSync(join(root, ".orca-dag"), { recursive: true, force: true });
  writeFileSync(orcaFile, JSON.stringify({ openCodeTui: true, version: "1.4.222",
    runs: { run_test: { id: "run_test", objective: "test", legacy: 0 } },
    worktrees: [{ id: "worktree_test", path: root, hostId: "local" }],
    tasks: { task_test: { id: "task_test", run_id: "run_test", status: "ready", deps: "[]" } } }));
  writeFileSync(providerFile, JSON.stringify({ active: true }));
  writeFileSync(orcaLog, ""); writeFileSync(providerLog, "");
  initOrcaRuntime({ env: { ORCA_CLI_COMMAND: orcaBin, WORKSPACE_DIR: root }, cwd: root });
});
after(() => {
  process.env.PATH = oldPath;
  envKeys.forEach((key, i) => { if (previousEnv[i] === undefined) delete process.env[key]; else process.env[key] = previousEnv[i]; });
  rmSync(root, { recursive: true, force: true });
});

describe("API-preselected OpenCode full TUI", () => {
  it("preserves an explicit successor frontend after a native model-pinned task", async () => {
    const oldFlag = process.env.ORCA_DAG_OPENCODE_TUI;
    delete process.env.ORCA_DAG_OPENCODE_TUI;
    resetCoordinatorForTests();
    update(orcaFile, {
      runtime: { appVersion: "1.4.241", capabilities: ["orchestration.worker-launch-preferences.v1"] },
      tasks: {
        task_test: { id: "task_test", run_id: "run_test", status: "ready", deps: "[]" },
        task_next: { id: "task_next", run_id: "run_test", status: "pending", deps: '["task_test"]' },
      },
    });
    try {
      await startCoordinator({ ...coordinatorOpts(), modelByTask: { task_test: "provider/model" },
        openCodeUiByTask: { task_next: "mini" } });
      await waitFor(() => Boolean(coordinatorStatus().attempts.find(a => a.taskId === "task_test")?.dispatchId));
      assert.equal(coordinatorStatus().attempts.find(a => a.taskId === "task_test")?.openCodeUiLaunched, "native");
      await settleWithLock();
      await waitFor(() => Boolean(coordinatorStatus().attempts.find(a => a.taskId === "task_next")?.dispatchId));
      const next = coordinatorStatus().attempts.find(a => a.taskId === "task_next")!;
      const launch = (await store.listOpenCodeLaunches()).find(row => row.taskId === "task_next");
      assert.equal(next.settled, false);
      assert.equal(next.openCodeUiLaunched, "mini");
      assert.equal(next.reuseOf, null);
      assert.equal(launch?.frontend, "mini");
      assert.equal(launch?.dispatchId, next.dispatchId);
      for (;;) {
        try { mkdirSync(`${orcaFile}.lock`); break; } catch { await pause(5); }
      }
      try {
        const data = load(orcaFile);
        data.dispatches[next.dispatchId!].status = "completed";
        data.dispatches[next.dispatchId!].terminalState = "reclaimable";
        data.tasks.task_next.status = "completed";
        writeFileSync(orcaFile, JSON.stringify(data));
      } finally { rmSync(`${orcaFile}.lock`, { recursive: true }); }
      await waitFor(() => coordinatorStatus().phase === "completed");
      assert.equal((await store.listOpenCodeLaunches()).find(row => row.taskId === "task_next")?.state, "closed");
    } finally {
      await stopCoordinator(); await pause(150); resetCoordinatorForTests();
      if (oldFlag === undefined) delete process.env.ORCA_DAG_OPENCODE_TUI; else process.env.ORCA_DAG_OPENCODE_TUI = oldFlag;
    }
  });
  for (const [defaultUi, override, expected] of [["mini", undefined, "mini"], ["mini", "tui", "tui"], ["tui", "mini", "mini"]] as const) {
    it(`routes workspace ${defaultUi} / node ${override ?? "inherit"} through the selected frontend`, async () => {
      const oldFlag = process.env.ORCA_DAG_OPENCODE_TUI;
      process.env.ORCA_DAG_OPENCODE_TUI = "1"; resetCoordinatorForTests();
      try {
        await startCoordinator({ ...coordinatorOpts(), defaultOpenCodeUi: defaultUi,
          openCodeUiByTask: override ? { task_test: override } : {} });
        await waitFor(() => Boolean(coordinatorStatus().attempts[0]?.dispatchId));
        assert.equal((await store.listOpenCodeLaunches())[0].frontend, expected);
        assert.equal(coordinatorStatus().attempts[0].openCodeUiRequested, override ?? defaultUi);
        assert.equal(coordinatorStatus().attempts[0].openCodeUiLaunched, expected);
        await settleWithLock(); await waitFor(() => !coordinatorStatus().running);
      } finally {
        await stopCoordinator(); await pause(150); resetCoordinatorForTests();
        if (oldFlag === undefined) delete process.env.ORCA_DAG_OPENCODE_TUI; else process.env.ORCA_DAG_OPENCODE_TUI = oldFlag;
      }
    });
  }
  it("loads persisted frontend preferences when a Run request omits the new fields", async () => {
    resetCoordinatorForTests();
    const orca = load(orcaFile);
    orca.tasks.task_done = { id: "task_done", run_id: "run_test", status: "completed", deps: "[]" };
    writeFileSync(orcaFile, JSON.stringify(orca));
    const policy = createSecurityPolicy({});
    await saveConfig(root, { defaultOpenCodeUi: "mini" });
    const { app } = createApp({ workspaceDir: root, worktree: `path:${root}`, policy, embeddedAssets: null });
    const server = await listenLoopback(app, 0);
    try {
      const address = server.address(); assert.ok(address && typeof address === "object");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/run`, { method: "POST",
        headers: { "Content-Type": "application/json", "X-Orca-Dag-Token": policy.token },
        body: JSON.stringify({ runId: "run_test", defaultHarness: "opencode", maxConcurrency: 1,
          environmentByTask: { task_done: "env_remote" },
          placementByTask: { task_done: { kind: "existing", selector: "path:/remote/already-settled" } } }) });
      assert.equal(response.status, 200, await response.text());
      await waitFor(() => Boolean(coordinatorStatus().attempts[0]?.dispatchId));
      assert.equal((await store.listOpenCodeLaunches())[0].frontend, "mini");
      assert.equal((await store.listOpenCodeLaunches())[0].requestedModel, null);
      await settleWithLock(); await waitFor(() => !coordinatorStatus().running);
    } finally {
      await stopCoordinator(); await pause(150); resetCoordinatorForTests(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it("freezes per-node frontend choices for later Run dispatches", async () => {
    resetCoordinatorForTests();
    const overrides: Record<string, "mini" | "tui"> = { task_test: "mini" };
    try {
      await startCoordinator({ ...coordinatorOpts(), defaultOpenCodeUi: "tui", openCodeUiByTask: overrides });
      overrides.task_test = "tui";
      await waitFor(() => Boolean(coordinatorStatus().attempts[0]?.dispatchId));
      assert.equal((await store.listOpenCodeLaunches())[0].frontend, "mini");
      await settleWithLock(); await waitFor(() => !coordinatorStatus().running);
    } finally { await stopCoordinator(); await pause(150); resetCoordinatorForTests(); }
  });
  it("rejects an explicit new-worktree placement without creating a provider session or worker", async () => {
    resetCoordinatorForTests();
    try {
      await startCoordinator({ ...coordinatorOpts(), defaultOpenCodeUi: "mini",
        placementByTask: { task_test: { kind: "new-child", setup: "run" } } });
      await waitFor(() => Boolean(coordinatorStatus().attempts[0]?.settled));
      assert.equal(coordinatorStatus().attempts[0].outcome, "failed");
      assert.equal(calls(providerLog, "POST").length, 0);
      assert.equal(calls(orcaLog, "worker-start").length, 0);
    } finally { await stopCoordinator(); await pause(150); resetCoordinatorForTests(); }
  });
  for (const frontend of ["mini", "tui"] as const) {
    it(`starts explicit ${frontend} with one session and no model flags in worker-start`, async () => {
      await interactive(frontend);
      const launch = (await store.listOpenCodeLaunches())[0];
      assert.equal(launch.frontend, frontend);
      const wire = calls(orcaLog, "worker-start")[0].argv;
      assert.ok(wire.includes("--terminal"));
      for (const flag of ["--model", "--effort", "--agent"]) assert.equal(wire.includes(flag), false);
      assert.equal(calls(providerLog, "POST").filter(row => row.argv[2] === "/api/session").length, 1);
    });
    it(`resolves the configured default model before creating ${frontend}'s pane`, async () => {
      await interactive(frontend, null);
      const launch = (await store.listOpenCodeLaunches())[0];
      assert.equal(launch.requestedModel, null);
      assert.deepEqual(launch.model, { providerID: "provider", id: "model", variant: "high" });
      const post = calls(providerLog, "POST")[0].argv;
      assert.deepEqual(JSON.parse(post[post.indexOf("--data") + 1]).model,
        { providerID: "provider", id: "model", variant: "high" });
      assert.equal(calls(providerLog, "GET").filter(row => row.argv[2].startsWith("/api/model/default?")).length, 1);
    });
  }
  for (const version of ["opencode v2.1.1", "opencode v2.1.2-beta.1", "unknown"]) {
    it(`refuses unqualified CLI ${version} before any preparation effect`, async () => {
      update(providerFile, { version });
      await assert.rejects(() => interactive(), /OpenCode >= 2.1.2/);
      assert.deepEqual(await store.listOpenCodeLaunches(), []);
      assert.equal(calls(providerLog, "POST").length, 0);
      assert.equal(calls(orcaLog, "create").length, 0);
    });
  }
  it("refuses an old running Orca before creating a session", async () => {
    update(orcaFile, { version: "1.4.221" });
    await assert.rejects(() => interactive(), /running Orca/);
    assert.equal(calls(providerLog, "POST").length, 0);
  });
  it("never relaxes an explicit model/variant mismatch or launches a pane for it", async () => {
    update(providerFile, { modelOverride: { providerID: "provider", id: "model", variant: "low" } });
    await assert.rejects(() => interactive(), /preserve the requested/);
    assert.equal(calls(orcaLog, "create").length, 0);
    assert.equal(calls(orcaLog, "worker-start").length, 0);
  });
  it("refuses a default session without a resolved model rather than picking the first available model", async () => {
    update(providerFile, { missingModel: true });
    await assert.rejects(() => interactive("mini", null), /Invalid OpenCode Model/);
    assert.equal(calls(orcaLog, "create").length, 0);
    assert.equal(calls(providerLog, "POST").length, 1);
    assert.equal((await store.listOpenCodeLaunches())[0].model, null);
  });
  it("refuses a session that replaces the officially resolved default model/variant", async () => {
    update(providerFile, { modelOverride: { providerID: "provider", id: "model", variant: "low" } });
    await assert.rejects(() => interactive("mini", null), /preserve the requested/);
    assert.equal(calls(orcaLog, "create").length, 0);
    assert.equal(calls(orcaLog, "worker-start").length, 0);
    assert.equal((await store.listOpenCodeLaunches())[0].model, null);
  });
  it("does not create a session when the official default resolver reports an unavailable model", async () => {
    update(providerFile, { defaultEnabled: false });
    await assert.rejects(() => interactive("mini", null), /default model is unavailable/);
    assert.equal(calls(providerLog, "POST").length, 0);
    assert.equal(calls(orcaLog, "create").length, 0);
    assert.deepEqual(await store.listOpenCodeLaunches(), []);
  });
  it("retains a prepared pane whose model changed before input without injecting or replacing it", async () => {
    update(providerFile, { changeModelBeforeBind: true });
    await assert.rejects(() => interactive(), /model changed before binding/);
    assert.equal(calls(orcaLog, "worker-start").length, 0);
    assert.equal(calls(orcaLog, "close").length, 0);
    assert.equal((await store.listOpenCodeLaunches())[0].state, "retained");
  });
  it("keeps a lost default-model creation journaled and blocks replacement even without a model", async () => {
    update(providerFile, { createResponseLost: true });
    await assert.rejects(() => interactive("mini", null));
    const launch = (await store.listOpenCodeLaunches())[0];
    assert.equal(launch.model, null); assert.equal(launch.state, "prepared");
    assert.equal(launch.frontend, "mini"); assert.equal(launch.requestedModel, null);
    await assert.rejects(() => interactive("tui", null), /unresolved/);
    assert.equal(calls(providerLog, "POST").length, 1);
    assert.equal(calls(orcaLog, "create").length, 0);
  });
  it("requires a resolved model before attaching a pane and prevents journal identity replacement", async () => {
    update(providerFile, { createResponseLost: true });
    await assert.rejects(() => interactive("mini", null));
    const launch = (await store.listOpenCodeLaunches())[0];
    await assert.rejects(() => store.recordOpenCodeLaunch({ ...launch, terminal: "term_other" }), /resolved model/);
    await assert.rejects(() => store.recordOpenCodeLaunch({ ...launch, frontend: "tui" }), /identity/);
    await store.recordOpenCodeLaunch({ ...launch, model: { providerID: "provider", id: "model", variant: "high" } });
    await assert.rejects(() => store.recordOpenCodeLaunch({ ...launch, model: { providerID: "provider", id: "model", variant: "low" } }), /identity/);
    await assert.rejects(() => store.recordOpenCodeLaunch(launch), /identity/);
  });
  it("normalizes historical full-TUI journal rows without consulting current preferences", async () => {
    await start();
    const file = join(root, ".orca-dag/sessions.json"); const data = load(file);
    delete data.openCodeLaunches[0].frontend; delete data.openCodeLaunches[0].requestedModel;
    writeFileSync(file, JSON.stringify(data));
    const legacy = (await store.listOpenCodeLaunches())[0];
    assert.equal(legacy.frontend, "tui"); assert.deepEqual(legacy.requestedModel, legacy.model);
    await assert.rejects(() => store.recordOpenCodeLaunch({ ...legacy, frontend: "mini" }), /identity/);
  });
  it("interrupts mini's exact provider session before external Orca accounting", async () => {
    const started = await interactive();
    await stopWorkerReceipt(started.dispatchId!);
    assert.equal(load(providerFile).outcome, "interrupted");
    const ops = readFileSync(orcaLog, "utf8").trim().split("\n").map(line => JSON.parse(line).argv[1]);
    assert.ok(ops.indexOf("interrupt") < ops.indexOf("worker-abandon"));
    assert.equal(calls(orcaLog, "worker-stop").length, 0);
  });
  it("does not inject into a mini pane that never clears its readiness prompt", async () => {
    update(orcaFile, { tuiWaitSatisfied: false });
    await assert.rejects(() => interactive(), /did not become ready/);
    assert.equal(calls(orcaLog, "worker-start").length, 0);
    assert.equal((await store.listOpenCodeLaunches())[0].state, "closed");
  });
  it("accepts a provider-resolved default variant without weakening explicit model selection", async () => {
    update(providerFile, { defaultVariant: "default" });
    await startOpenCodeTuiWorker({ taskId: "task_test", runId: "run_test", from: "term_coordinator",
      worktree: `path:${root}`, model: "provider/model", retryRequestId: randomUUID(), onHandle: () => {} });
    assert.deepEqual((await store.listOpenCodeLaunches())[0].model,
      { providerID: "provider", id: "model", variant: "default" });
    assert.equal(calls(orcaLog, "worker-start").length, 1);
  });
  it("parses variant/effort without silently overriding conflicting preferences", () => {
    assert.equal(openCodeTuiTitle("6a7e0c99-7db5-42ed-80af-d398feb3b656"), "odag:6a7e0c997db542ed80afd398feb3b656");
    assert.deepEqual(parseOpenCodeModel("provider/model#high"), { providerID: "provider", id: "model", variant: "high" });
    assert.deepEqual(parseOpenCodeModel("provider/model", "high"), parseOpenCodeModel("provider/model#high"));
    assert.deepEqual(parseOpenCodeModel("openrouter/anthropic/claude-model#high"),
      { providerID: "openrouter", id: "anthropic/claude-model", variant: "high" });
    assert.throws(() => parseOpenCodeModel("provider/model#high", "low"));
    assert.throws(() => parseOpenCodeModel("provider/model; touch bad"));
  });
  it("pins an independent session before effects and binds only by terminal under one durable request", async () => {
    const started = await start();
    assert.equal(started.mode, "supervised");
    const launch = (await store.listOpenCodeLaunches())[0];
    assert.equal(launch.state, "bound");
    assert.deepEqual(launch.model, { providerID: "provider", id: "model", variant: "high" });
    const argv = calls(orcaLog, "worker-start")[0].argv;
    for (const flag of ["--agent", "--model", "--effort"]) assert.equal(argv.includes(flag), false);
    assert.equal(argv[argv.indexOf("--retry-request") + 1], launch.requestId);
    assert.equal((await new ProviderSessionStore(root).list("run_test"))[0].sessionId, launch.sessionId);
    assert.equal((await inspectOpenCodeTui(started.dispatchId!))?.state, "turn_started");
  });
  it("waits for the exact session to mount instead of admitting an idle startup shell", async () => {
    update(orcaFile, { openCodeTitleDelayLists: 2 });
    const started = await start();
    assert.equal((await inspectOpenCodeTui(started.dispatchId!))?.state, "turn_started");
  });
  it("accepts the API's canonical default variant without changing the requested model", async () => {
    update(providerFile, { sessionModel: { providerID: "provider", id: "model", variant: "default" } });
    const started = await startOpenCodeTuiWorker({ taskId: "task_test", runId: "run_test", from: "term_coordinator",
      worktree: `path:${root}`, model: "provider/model", retryRequestId: randomUUID(), onHandle: () => {} });
    assert.equal((await inspectOpenCodeTui(started.dispatchId!))?.state, "turn_started");
    settle();
    await releaseWorker(started.dispatchId!);
    assert.equal(await closeReleasedOpenCodeTui(started.dispatchId!), "closed");
  });
  for (const changed of [
    { field: "provider", model: { providerID: "other", id: "model", variant: "high" } },
    { field: "model", model: { providerID: "provider", id: "other", variant: "high" } },
    { field: "explicit variant", model: { providerID: "provider", id: "model", variant: "default" } },
  ]) {
    it(`refuses an API-changed ${changed.field} before creating a terminal or binding a Dispatch`, async () => {
      update(providerFile, { sessionModel: changed.model });
      await assert.rejects(start);
      assert.equal(calls(orcaLog, "create").length, 0);
      assert.equal(calls(orcaLog, "worker-start").length, 0);
      assert.equal((await store.listOpenCodeLaunches())[0].state, "closed");
    });
  }
  for (const frontend of ["mini", "tui"] as const) {
    it(`holds ${frontend}'s exact preparation when its API backend loses the session after pane creation`, async () => {
      update(providerFile, { sessionUnavailableAfterPane: true });
      await assert.rejects(() => interactive(frontend), /ownership is unproven/);
      const launch = (await store.listOpenCodeLaunches())[0];
      assert.equal(launch.state, "prepared");
      assert.equal(launch.dispatchId, null);
      assert.ok(launch.terminal, "the exact created pane remains available for inspection");
      assert.equal(load(providerFile).sessions[launch.sessionId].id, launch.sessionId,
        "loss of API visibility must not erase the original provider session");
      assert.equal(calls(orcaLog, "worker-start").length, 0, "no Task input reaches an unproven backend");
      assert.equal(calls(orcaLog, "close").length, 0, "missing API evidence cannot authorize closing the pane");
      await assert.rejects(() => interactive(frontend), /unresolved OpenCode preparation/);
      assert.equal(calls(providerLog, "POST").length, 1, "no replacement session");
      assert.equal(calls(orcaLog, "create").length, 1, "no replacement pane");
    });
  }
  it("does not mistake input acceptance or silence for an assistant turn or resend", async () => {
    update(providerFile, { noAssistant: true });
    const started = await start();
    assert.equal((await inspectOpenCodeTui(started.dispatchId!))?.state, "input_accepted");
    update(providerFile, { noInput: true });
    assert.equal((await inspectOpenCodeTui(started.dispatchId!))?.state, "input_unproven");
    assert.equal(calls(orcaLog, "worker-start").length, 1);
  });
  it("reads labeled, bounded provider text after caller-owned close without exposing tool inputs/reasoning", async () => {
    const started = await start(); settle();
    const release = await releaseWorker(started.dispatchId!);
    assert.equal(release.reason, "external_terminal");
    assert.equal(await closeReleasedOpenCodeTui(started.dispatchId!), "closed");
    const output = await readWorkerOutput(started.dispatchId!, { limit: 2 });
    assert.equal(output.source, "opencode-api"); assert.equal(output.clipped, true);
    assert.match(output.lines.join("\n"), /provider\/model#high/);
    const rest = await readWorkerOutput(started.dispatchId!, { cursor: output.cursor!, limit: 40 });
    assert.equal(rest.contentComplete, true);
    assert.equal(rest.lines.join("\n").includes("private"), false);
    assert.equal(calls(orcaLog, "worker-read").length, 0);
  });
  it("does not call a clipped assistant text budget a complete transcript", async () => {
    const started = await start(); settle(); update(providerFile, { longOutput: true });
    const output = await readWorkerOutput(started.dispatchId!, { limit: 200 });
    assert.equal(output.clipped, true); assert.equal(output.contentComplete, false);
    assert.ok(output.warnings.some(line => line.includes("output budget")));
  });
  it("reads a cold exact-bound one-shot session without upgrading fleet liveness", async () => {
    const started = await start();
    const binding = await store.get({ runId: "run_test", taskId: "task_test", dispatchId: started.dispatchId! });
    assert.ok(binding);
    const state = load(providerFile);
    state.sessions[binding.sessionId].model = { providerID: "live", id: "actual", variant: "xhigh" };
    state.sessions[binding.sessionId].title = `orca-dag:run_test:task_test:${started.dispatchId}`;
    state.active = true;
    state.userOwned = true;
    writeFileSync(providerFile, JSON.stringify(state));
    const journalPath = join(root, ".orca-dag/sessions.json");
    update(journalPath, { openCodeLaunches: [] });
    update(orcaFile, {
      livenessOverride: { [started.dispatchId!]: "unverifiable" },
      livenessReason: { [started.dispatchId!]: "missing_status" },
    });
    const detail = await showWorkerDetail(started.dispatchId!, { includeProviderSession: true });
    assert.equal(detail?.providerSession?.status, "active");
    assert.equal(detail?.providerSession?.model?.providerID, "live");
    assert.equal(detail?.providerSession?.model?.id, "actual");
    assert.equal(detail?.providerSession?.model?.variant, "xhigh");
    assert.equal(detail?.providerSession?.modelSource, "assistant-message");
    assert.equal(detail?.liveness.verdict, "unverifiable");
    const output = await readWorkerOutput(started.dispatchId!, { limit: 100 });
    assert.equal(output.source, "opencode-api");
    assert.equal(output.contentComplete, false);
    assert.match(output.lines.join("\n"), /verified worker output/);
    assert.equal(output.lines.some(line => line.includes("task_test")), false, "startup instructions are identity evidence, not worker output");
    assert.ok(output.warnings.some(line => line.includes("user-owned")));
    assert.match(output.lines.join("\n"), /tool read_file/);
    assert.match(output.lines.join("\n"), /tool result content/);
    assert.equal(output.lines.join("\n").includes("do not store"), false);
    assert.equal(output.lines.join("\n").includes("new user work"), false);
    const firstPage = await readWorkerOutput(started.dispatchId!, { limit: 2 });
    update(providerFile, { assistantText: "verified worker output\nsecond line\nappended progress" });
    const appendedPage = await readWorkerOutput(started.dispatchId!, { cursor: firstPage.cursor!, limit: 40 });
    assert.equal(appendedPage.sourceChanged, false);
    assert.equal(appendedPage.lines[0], "appended progress");
    update(providerFile, { assistantText: "changed original output\nsecond line" });
    const changedPage = await readWorkerOutput(started.dispatchId!, { cursor: firstPage.cursor!, limit: 2 });
    assert.equal(changedPage.sourceChanged, true);
    assert.match(changedPage.lines[0], /changed original output/);
    assert.equal(calls(orcaLog, "worker-read").length, 0);
    await assert.rejects(() => readOpenCodeBoundSession({ ...binding, host: "remote:host" }));
    await assert.rejects(() => readOpenCodeBoundSession({ ...binding, workspace: `${binding.workspace}/..` }));
    update(providerFile, { unavailable: true });
    assert.equal((await showWorkerDetail(started.dispatchId!, { includeProviderSession: true }))?.providerSession?.status, "unavailable");
    await assert.rejects(() => readWorkerOutput(started.dispatchId!, { limit: 40 }), /OpenCode API.*unavailable/);
    assert.equal(calls(orcaLog, "worker-read").length, 0);
    await assert.rejects(() => readOpenCodeBoundSession({ ...binding, dispatchId: "ctx_other" }));
    await assert.rejects(() => readOpenCodeBoundSession({ ...binding, runId: "run_other" }));
  });
  it("never closes on unknown release, live execution, changed pane identity, or later user-owned work", async () => {
    const started = await start(); settle();
    update(orcaFile, { releaseMode: { [started.dispatchId!]: "release_unknown" } });
    await releaseWorker(started.dispatchId!);
    await assert.rejects(() => closeReleasedOpenCodeTui(started.dispatchId!));
    update(orcaFile, { releaseMode: {} }); await releaseWorker(started.dispatchId!);
    update(providerFile, { active: true });
    await assert.rejects(() => closeReleasedOpenCodeTui(started.dispatchId!));
    update(providerFile, { active: false, userOwned: true });
    assert.equal(await closeReleasedOpenCodeTui(started.dispatchId!), "retained");
    assert.equal(calls(orcaLog, "close").length, 0);
  });
  it("honors explicit retention durably", async () => {
    const started = await start(); settle(); await releaseWorker(started.dispatchId!);
    await retainOpenCodeTui(started.dispatchId!);
    assert.equal(await closeReleasedOpenCodeTui(started.dispatchId!), "retained");
    assert.equal(calls(orcaLog, "close").length, 0);
  });
  it("refuses cleanup after pane rename instead of matching a title prefix", async () => {
    const started = await start(); settle(); await releaseWorker(started.dispatchId!);
    const data = load(orcaFile); data.terminals[0].title += " user takeover";
    writeFileSync(orcaFile, JSON.stringify(data));
    await assert.rejects(() => closeReleasedOpenCodeTui(started.dispatchId!));
    assert.equal(calls(orcaLog, "close").length, 0);
  });
  it("interrupts the exact shared-service execution before Orca accounting, without an external worker-stop fallback", async () => {
    const started = await start();
    await stopWorkerReceipt(started.dispatchId!);
    const order = readFileSync(orcaLog, "utf8").trim().split("\n").map(line => JSON.parse(line).argv[1]);
    assert.ok(order.indexOf("interrupt") >= 0 && order.indexOf("interrupt") < order.indexOf("worker-abandon"));
    assert.equal(calls(orcaLog, "worker-stop").length, 0);
    assert.equal(load(providerFile).outcome, "interrupted");
  });
  it("journals the HTTP Stop's real worker-abandon operation and confirmed provider exit, then retains fenced identity", async () => {
    const started = await start();
    const policy = createSecurityPolicy({});
    const { app } = createApp({ workspaceDir: root, worktree: `path:${root}`, policy, embeddedAssets: null });
    const server = await listenLoopback(app, 0);
    try {
      const address = server.address(); assert.ok(address && typeof address === "object");
      const base = `http://127.0.0.1:${address.port}`;
      const response = await fetch(`${base}/api/workers/${started.dispatchId}/stop`, { method: "POST",
        headers: { "Content-Type": "application/json", "X-Orca-Dag-Token": policy.token },
        body: JSON.stringify({ runId: "run_test" }) });
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.receipt.providerExecutionExited, true);
      const entries = await new RequestLedger(root).list();
      const stop = entries.find(row => row.requestId === body.requestId)!;
      assert.equal(stop.operation, "worker-abandon");
      assert.equal(stop.settledLocally, true);
      const release = await fetch(`${base}/api/workers/${started.dispatchId}/release`, { method: "POST",
        headers: { "X-Orca-Dag-Token": policy.token } });
      assert.equal(release.status, 200);
      assert.equal((await store.listOpenCodeLaunches())[0].state, "retained");
      assert.equal(calls(orcaLog, "close").length, 0); assert.equal(calls(orcaLog, "worker-stop").length, 0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("refuses Stop when provider ownership/exit cannot be proven", async () => {
    const started = await start(); update(providerFile, { userOwned: true });
    await assert.rejects(() => stopWorkerReceipt(started.dispatchId!));
    update(providerFile, { userOwned: false, unavailable: true });
    await assert.rejects(() => stopWorkerReceipt(started.dispatchId!), error => !String(error).includes("private credential"));
    assert.equal(calls(orcaLog, "worker-stop").length, 0); assert.equal(calls(orcaLog, "worker-abandon").length, 0);
    assert.equal(calls(orcaLog, "close").length, 0);
  });
  it("parks lost starts and blocks a replacement session/terminal", async () => {
    update(orcaFile, { workerStartAmbiguous: "lost_noreceipt" });
    await assert.rejects(start);
    assert.equal((await store.listOpenCodeLaunches())[0].state, "prepared");
    await assert.rejects(start);
    assert.equal(calls(orcaLog, "create").length, 1); assert.equal(calls(orcaLog, "close").length, 0);
  });
  it("keeps an unknown terminal-create result unresolved without a guessed close or replacement", async () => {
    update(orcaFile, { terminalCreateLost: true }); await assert.rejects(start);
    const launch = (await store.listOpenCodeLaunches())[0];
    assert.equal(launch.state, "prepared"); assert.equal(launch.terminal, null);
    await assert.rejects(start, /unresolved OpenCode preparation/);
    assert.equal(calls(orcaLog, "create").length, 1); assert.equal(calls(orcaLog, "close").length, 0);
  });
  it("journals a lost API session-create response and blocks replacement without a second POST", async () => {
    update(providerFile, { createResponseLost: true }); await assert.rejects(start);
    const launch = (await store.listOpenCodeLaunches())[0];
    assert.equal(launch.state, "prepared"); assert.equal(launch.terminal, null);
    assert.ok(load(providerFile).sessions[launch.sessionId]);
    await assert.rejects(start, /unresolved OpenCode preparation/);
    assert.equal(calls(providerLog, "POST").length, 1); assert.equal(calls(orcaLog, "create").length, 0);
  });
  it("recovers a lost start by replaying the same wire request, not a second resource", async () => {
    update(orcaFile, { workerStartAmbiguous: "lost" });
    const started = await start();
    assert.equal(started.replayed, true); assert.equal(calls(orcaLog, "create").length, 1);
    const starts = calls(orcaLog, "worker-start");
    assert.deepEqual(starts[0].argv, starts[1].argv);
    assert.equal(Object.keys(load(orcaFile).dispatches).length, 1);
  });
  it("repairs the post-start crash window using exact fleet/terminal identity", async () => {
    const started = await start();
    const journal = load(process.env.FAKE_OPENCODE_JOURNAL!);
    journal.bindings = []; journal.openCodeLaunches[0].dispatchId = null; journal.openCodeLaunches[0].state = "prepared";
    writeFileSync(process.env.FAKE_OPENCODE_JOURNAL!, JSON.stringify(journal));
    await recoverOpenCodeTuiBindings("run_test", await listWorkers("run_test"));
    assert.equal((await store.list())[0].dispatchId, started.dispatchId);
    assert.equal(calls(orcaLog, "worker-start").length, 1);
  });
  it("fails before injection on bad model, unsupported placement, or readiness timeout", async () => {
    await assert.rejects(() => startOpenCodeTuiWorker({ taskId: "task_test", runId: "run_test", from: "term_c",
      worktree: "new-child", model: "provider/model", retryRequestId: randomUUID(), onHandle: () => {} }));
    update(orcaFile, { tuiWaitSatisfied: false }); await assert.rejects(start);
    assert.equal(calls(orcaLog, "worker-start").length, 0); assert.equal(calls(orcaLog, "close").length, 1);
    assert.equal((await store.listOpenCodeLaunches())[0].state, "closed");
  });
  it("treats malformed active maps, wrong locations and repeated pagination cursors as unknown", async () => {
    await start(); const launch = (await store.listOpenCodeLaunches())[0];
    update(providerFile, { invalidActive: true }); await assert.rejects(() => readOpenCodeExecution(launch));
    update(providerFile, { invalidActive: false, wrongWorkspace: true }); await assert.rejects(() => readOpenCodeExecution(launch));
    update(providerFile, { wrongWorkspace: false, loopCursor: true }); await assert.rejects(() => readOpenCodeExecution(launch));
  });
  it("preserves old session bindings alongside preparation records and refuses identity replacement", async () => {
    await store.bind({ runId: "run_old", taskId: "task_old", dispatchId: "ctx_old", harness: "codex",
      sessionId: "thread_old", workspace: root, host: "local:local", source: "manual" });
    await start();
    assert.equal((await store.list("run_old"))[0].sessionId, "thread_old");
    const launch = (await store.listOpenCodeLaunches())[0];
    await assert.rejects(() => store.recordOpenCodeLaunch({ ...launch, sessionId: "ses_other" }));
    await assert.rejects(() => store.recordOpenCodeLaunch({ ...launch, terminal: "term_other" }));
  });
  it("runs the opt-in coordinator path through authoritative settlement and external-terminal cleanup", async () => {
    const oldFlag = process.env.ORCA_DAG_OPENCODE_TUI; process.env.ORCA_DAG_OPENCODE_TUI = "1";
    resetCoordinatorForTests();
    try {
      await startCoordinator(coordinatorOpts());
      await waitFor(() => Boolean(coordinatorStatus().attempts[0]?.dispatchId));
      assert.equal(coordinatorStatus().attempts[0].mode, "supervised");
      assert.equal(coordinatorStatus().attempts[0].effective?.model, null);
      await settleWithLock();
      await waitFor(() => coordinatorStatus().phase === "completed");
      assert.equal(coordinatorStatus().attempts[0].terminalDecision, "closed");
      assert.equal((await store.listOpenCodeLaunches())[0].state, "closed");
      assert.equal(calls(orcaLog, "worker-start").length, 1);
      assert.equal(calls(orcaLog, "dispatch").length, 0);
    } finally {
      await stopCoordinator(); await pause(150); resetCoordinatorForTests();
      if (oldFlag === undefined) delete process.env.ORCA_DAG_OPENCODE_TUI; else process.env.ORCA_DAG_OPENCODE_TUI = oldFlag;
    }
  });
  it("recovers caller-owned cleanup after Orca cleared Task dispatch identity and changed workerState to the outcome", async () => {
    const started = await start(); settle(); await releaseWorker(started.dispatchId!);
    const data = load(orcaFile);
    delete data.tasks.task_test.dispatch_id;
    Object.values(data.dispatches).forEach(row => { (row as Record<string, unknown>).workerState = "succeeded"; });
    writeFileSync(orcaFile, JSON.stringify(data));
    resetCoordinatorForTests();
    try {
      await startCoordinator(coordinatorOpts());
      await waitFor(() => coordinatorStatus().phase === "completed");
      assert.equal(coordinatorStatus().attempts[0].dispatchId, started.dispatchId);
      assert.equal(coordinatorStatus().attempts[0].terminalDecision, "closed");
      assert.equal((await store.listOpenCodeLaunches())[0].state, "closed");
      assert.equal(calls(orcaLog, "worker-start").length, 1, "recovery starts no second worker even with opt-in unset");
    } finally { await stopCoordinator(); await pause(150); resetCoordinatorForTests(); }
  });
  it("holds an exact live TUI even when external Stop parked the Task without settling its Dispatch", async () => {
    const started = await start();
    const data = load(orcaFile);
    delete data.tasks.task_test.dispatch_id;
    data.tasks.task_test.status = "blocked";
    Object.values(data.dispatches).forEach(row => { (row as Record<string, unknown>).workerState = "stop_unknown"; });
    writeFileSync(orcaFile, JSON.stringify(data)); resetCoordinatorForTests();
    try {
      await startCoordinator(coordinatorOpts());
      assert.equal(coordinatorStatus().attempts[0].dispatchId, started.dispatchId);
      assert.equal(coordinatorStatus().attempts[0].mode, "supervised");
      assert.equal(coordinatorStatus().busy, 1);
      assert.equal(calls(orcaLog, "worker-start").length, 1);
      assert.equal((await stopCoordinator()).clean, true);
      assert.equal((await store.listOpenCodeLaunches())[0].state, "retained", "fencing invalidates Orca release identity; keep the pane for inspection");
      assert.equal(calls(orcaLog, "close").some(row => row.argv.includes(started.handle)), false);
    } finally { await stopCoordinator(); await pause(150); resetCoordinatorForTests(); }
  });
  it("keeps the TUI on uncertain coordinator cleanup instead of starting or closing again", async () => {
    const oldFlag = process.env.ORCA_DAG_OPENCODE_TUI; process.env.ORCA_DAG_OPENCODE_TUI = "1";
    resetCoordinatorForTests();
    try {
      update(providerFile, { active: true });
      await startCoordinator(coordinatorOpts());
      await waitFor(() => Boolean(coordinatorStatus().attempts[0]?.dispatchId));
      const data = load(orcaFile);
      data.releaseMode = { [coordinatorStatus().attempts[0].dispatchId!]: "release_unknown" };
      // Hold the loop's file lock while authoritatively settling this fake.
      for (;;) { try { mkdirSync(`${orcaFile}.lock`); break; } catch { await pause(5); } }
      try {
        const current = load(orcaFile); current.releaseMode = data.releaseMode;
        writeFileSync(orcaFile, JSON.stringify(current)); settle();
      } finally { rmSync(`${orcaFile}.lock`, { recursive: true }); }
      await waitFor(() => coordinatorStatus().cleanupDebt.length > 0);
      const launch = (await store.listOpenCodeLaunches())[0];
      assert.equal(calls(orcaLog, "close").some(row => row.argv.includes(launch.terminal)), false);
      assert.equal(calls(orcaLog, "worker-start").length, 1);
    } finally {
      await stopCoordinator(); await pause(150); resetCoordinatorForTests();
      if (oldFlag === undefined) delete process.env.ORCA_DAG_OPENCODE_TUI; else process.env.ORCA_DAG_OPENCODE_TUI = oldFlag;
    }
  });
});
