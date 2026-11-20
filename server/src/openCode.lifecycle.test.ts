import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProviderSessionStore } from "./providerSessions";
import { openCodeTuiTitle, parseOpenCodeModel, readOpenCodeBoundSession, readOpenCodeExecution } from "./openCode";
import { createApp, listenLoopback } from "./app";
import { createSecurityPolicy } from "./security";
import { RequestLedger } from "./requestLedger";
import { closeReleasedOpenCodeTui, inspectOpenCodeTui, listWorkers, readWorkerOutput, recoverOpenCodeTuiBindings, releaseWorker, retainOpenCodeTui, showWorkerDetail, startOpenCodeTuiWorker, stopWorkerReceipt } from "./orca";
import { setupOpenCodeHarness } from "./testHelpers/openCodeHarness";

const {
  root,
  orcaFile,
  providerFile,
  orcaLog,
  providerLog,
  store,
  load,
  update,
  calls,
  start,
  interactive,
  settle,
} = setupOpenCodeHarness();

describe("API-preselected OpenCode full TUI (session lifecycle & output)", () => {
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
  it("reads bounded provider output after caller-owned close without reasoning or secret fields", async () => {
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
  it("shows Mini tool progress and structured results, restarting a changed output prefix", async () => {
    const started = await interactive("mini");
    const tool = { type: "tool", name: "shell", state: {
      status: "running", input: { command: "node calculation.mjs", apiKey: "private credential" },
    } };
    update(providerFile, { assistantText: "Computing", toolParts: [tool] });
    const running = await readWorkerOutput(started.dispatchId!, { limit: 2 });
    assert.match(running.lines.join("\n"), /tool shell.*running/);
    assert.equal(running.contentComplete, false);
    update(providerFile, { toolParts: [
      { ...tool, state: { ...tool.state, status: "completed", content: [
        { type: "text", text: "sum=17" }, { type: "text", text: "Exited with code 0" },
      ] } },
      { type: "tool", name: "shell", state: { status: "error", error: {
        message: "command failed", apiKey: "private credential",
      } } },
      { type: "tool", name: "settings", state: { status: "completed", content: [
        { type: "text", text: "private configuration" },
      ] } },
    ] });
    const completed = await readWorkerOutput(started.dispatchId!, { cursor: running.cursor!, limit: 40 });
    const visible = completed.lines.join("\n");
    assert.equal(completed.sourceChanged, true);
    assert.match(visible, /tool shell.*completed/);
    assert.match(visible, /tool result.*sum=17/);
    assert.match(visible, /tool result.*Exited with code 0/);
    assert.match(visible, /tool shell.*error/);
    assert.match(visible, /command failed/);
    assert.equal(visible.includes("private"), false, "reasoning, secret fields and settings results stay hidden");
    const next = await readWorkerOutput(started.dispatchId!, { cursor: completed.cursor!, limit: 40 });
    assert.equal(next.sourceChanged, false);
    assert.deepEqual(next.lines, []);
    assert.equal(next.contentComplete, false, "visible tool completion does not settle an active provider execution");
  });
  it("does not call a clipped assistant text budget a complete transcript", async () => {
    const started = await start(); settle(); update(providerFile, { longOutput: true });
    const output = await readWorkerOutput(started.dispatchId!, { limit: 200 });
    assert.equal(output.clipped, true); assert.equal(output.contentComplete, false);
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
        headers: { "Content-Type": "application/json", "X-Orca-Dag-Token": policy.token },
        body: JSON.stringify({ runId: "run_test" }) });
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
    await recoverOpenCodeTuiBindings("run_test", (await listWorkers("run_test")).workers);
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
});
