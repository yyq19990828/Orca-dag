import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openCodeTuiTitle, parseOpenCodeModel, readOpenCodeExecution } from "./openCode";
import { ProviderSessionStore } from "./providerSessions";
import { coordinatorStatus, resetCoordinatorForTests, startCoordinator, stopCoordinator } from "./coordinator";
import { createApp, listenLoopback } from "./app";
import { createSecurityPolicy } from "./security";
import { RequestLedger } from "./requestLedger";
import {
  closeReleasedOpenCodeTui, initOrcaRuntime, inspectOpenCodeTui, listWorkers,
  readWorkerOutput, recoverOpenCodeTuiBindings, releaseWorker, retainOpenCodeTui,
  startOpenCodeTuiWorker, stopWorkerReceipt,
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
    await assert.rejects(() => closeReleasedOpenCodeTui(started.dispatchId!), /identity changed/);
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
      assert.equal(stop.note, "viewer-observed OpenCode provider stop state: abandoned");
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
    await assert.rejects(start, /unresolved OpenCode preparation/);
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
