import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { coordinatorStatus, resetCoordinatorForTests, startCoordinator, stopCoordinator } from "./coordinator";
import { createApp, listenLoopback } from "./app";
import { createSecurityPolicy } from "./security";
import { saveConfig } from "./config";
import { releaseWorker } from "./orca";
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
  settle,
  pause,
  waitFor,
  settleWithLock,
  coordinatorOpts,
} = setupOpenCodeHarness();

describe("API-preselected OpenCode full TUI (coordinator & frontend routing)", () => {
  for (const mode of ["no_owned_resource", "already_released"] as const) {
    it(`retains an exactly verified caller-owned pane when native retain reports ${mode}`, async () => {
      const oldFlag = process.env.ORCA_DAG_OPENCODE_TUI;
      process.env.ORCA_DAG_OPENCODE_TUI = "1";
      resetCoordinatorForTests();
      try {
        await startCoordinator({ ...coordinatorOpts(), defaultOpenCodeUi: "mini", retainByTask: { task_test: true } });
        await waitFor(() => Boolean(coordinatorStatus().attempts.find(a => a.taskId === "task_test")?.dispatchId));
        const dispatchId = coordinatorStatus().attempts.find(a => a.taskId === "task_test")!.dispatchId!;
        for (;;) {
          try { mkdirSync(`${orcaFile}.lock`); break; } catch { await pause(5); }
        }
        try {
          const data = load(orcaFile);
          data.retainMode = { [dispatchId]: mode };
          writeFileSync(orcaFile, JSON.stringify(data));
        } finally { rmSync(`${orcaFile}.lock`, { recursive: true }); }
        await settleWithLock();
        await waitFor(() => coordinatorStatus().attempts.find(a => a.taskId === "task_test")?.terminalDecision === "retained");
        const attempt = coordinatorStatus().attempts.find(a => a.taskId === "task_test")!;
        assert.ok(attempt.terminalDetail?.includes(mode === "no_owned_resource" ? "no_owned_resource" : "already_released"));
        assert.equal((await store.listOpenCodeLaunches()).find(row => row.dispatchId === dispatchId)?.state, "retained");
        assert.equal(calls(orcaLog, "worker-start").length, 1);
        assert.equal(calls(orcaLog, "worker-release").length, 0);
        assert.ok(load(orcaFile).terminals.some((terminal: { handle: string; connected: boolean }) =>
          terminal.handle === attempt.handle && terminal.connected));
      } finally {
        await stopCoordinator(); await pause(150); resetCoordinatorForTests();
        if (oldFlag === undefined) delete process.env.ORCA_DAG_OPENCODE_TUI; else process.env.ORCA_DAG_OPENCODE_TUI = oldFlag;
      }
    });
  }
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
