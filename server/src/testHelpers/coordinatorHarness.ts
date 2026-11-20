import { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import {
  coordinatorStatus,
  resetCoordinatorForTests,
  stopCoordinator,
  type StartOpts,
} from "../coordinator";
import { initOrcaRuntime, workerSupervision, type OrcaReadiness } from "../orca";
import { createApp, listenLoopback } from "../app";
import { createSecurityPolicy, type SecurityPolicy } from "../security";
import { LaunchHistory } from "../launchHistory";

export interface FakeCall {
  argv: string[];
  cwd: string;
}

export function setupCoordinatorHarness() {
  const root = process.env.ORCA_DAG_FAKE_DEBUG_DIR ?? mkdtempSync(join(tmpdir(), "orca-dag-coord-test-"));
  const workspace = mkdtempSync(join(tmpdir(), "orca-dag-coord-ws-"));
  const fixturePath = join(root, "fake-orca.mjs");
  const src = readFileSync(new URL("../../test/fixtures/fake-orca.mjs", import.meta.url), "utf8");
  writeFileSync(fixturePath, src);
  chmodSync(fixturePath, 0o755);

  let testSeq = 0;
  let statePath = join(root, "fake-state-0.json");
  let logPath = join(root, "calls-0.log");
  writeFileSync(statePath, JSON.stringify({ version: "1.4.205" }));
  process.env.FAKE_ORCA_STATE = statePath;
  process.env.FAKE_ORCA_LOG = logPath;
  initOrcaRuntime({ env: { ORCA_CLI_COMMAND: fixturePath, WORKSPACE_DIR: workspace }, cwd: root });

  const enabledReadiness: OrcaReadiness = {
    cli: fixturePath,
    workspace,
    worktree: "path:" + workspace,
    version: "1.4.205",
    cliVersion: "1.4.205",
    runtimeState: "ready",
    executionEnabled: true,
    reason: null,
  };
  const httpServers: Server[] = [];

  function readLog(): FakeCall[] {
    try {
      const content = readFileSync(logPath, "utf8").trim();
      if (!content) return [];
      return content.split("\n").map((line) => JSON.parse(line) as FakeCall);
    } catch {
      return [];
    }
  }

  /** Calls of one fake subcommand, e.g. calls("worker-release"). */
  function calls(name: string): FakeCall[] {
    return readLog().filter((c) => c.argv[0] === "orchestration" && c.argv[1] === name);
  }

  function callsOf(name: string, flagName: string, flagValue: string): FakeCall[] {
    return calls(name).filter((c) => {
      const i = c.argv.indexOf(flagName);
      return i >= 0 && c.argv[i + 1] === flagValue;
    });
  }

  /** Index of the first matching call in the log, or -1 (value-based, no identity). */
  function firstIndexOf(name: string, flagName: string, flagValue: string): number {
    return readLog().findIndex((c) => {
      if (c.argv[0] !== "orchestration" || c.argv[1] !== name) return false;
      const i = c.argv.indexOf(flagName);
      return i >= 0 && c.argv[i + 1] === flagValue;
    });
  }

  function ackCalls(deliveryId: string): FakeCall[] {
    return calls("check").filter((c) => c.argv.includes("--ack") && c.argv.includes(deliveryId));
  }

  /** Calls of a non-orchestration fake surface, e.g. namespaceCalls("worktree", "list"). */
  function namespaceCalls(ns: string, verb: string): FakeCall[] {
    return readLog().filter((c) => c.argv[0] === ns && c.argv[1] === verb);
  }

  /** Locked read-modify-write of the fake's state (same lock the fake uses). */
  async function mutateState<T>(fn: (state: Record<string, any>) => T): Promise<T> {
    const lockDir = `${statePath}.lock`;
    let locked = false;
    for (let i = 0; i < 400 && !locked; i++) {
      try {
        mkdirSync(lockDir);
        locked = true;
      } catch {
        await new Promise((r) => setTimeout(r, 15));
      }
    }
    try {
      const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
      const out = fn(state);
      writeFileSync(statePath, JSON.stringify(state));
      return out;
    } finally {
      if (locked) rmSync(lockDir, { recursive: true, force: true });
    }
  }

  function getState(): Record<string, any> {
    return JSON.parse(readFileSync(statePath, "utf8"));
  }

  /** Two root tasks + one dependent, like the plan's two-wave acceptance DAG. */
  function baseTasks(runId: string): Record<string, any> {
    return {
      task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]", task_title: "A" },
      task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: "[]", task_title: "B" },
      task_ccc: { id: "task_ccc", run_id: runId, status: "pending", deps: '["task_aaa","task_bbb"]', task_title: "C" },
    };
  }

  function baseOpts(runId: string, extra: Partial<StartOpts> = {}): StartOpts {
    return {
      runId,
      harnessByTask: {},
      modelByTask: {},
      defaultHarness: "claude",
      maxConcurrency: 2,
      worktree: "path:" + workspace,
      tickWaitMs: 25,
      ...extra,
    };
  }

  async function recordViewerLaunch(runId: string, taskId: string, dispatchId: string, harness = "claude"): Promise<void> {
    await new LaunchHistory(workspace).record({ runId, taskId, dispatchId, harness, source: "viewer-launch" });
  }

  /** The coordinator terminal the loop created (by its well-known title prefix). */
  function coordinatorTerminal(state: Record<string, any>): Record<string, any> {
    const mine = (state.terminals ?? []).filter((t: any) =>
      (t.title ?? "").startsWith("orca-dag coordinator"),
    );
    return mine[mine.length - 1];
  }

  function workerDoneMessage(taskId: string, dispatchId: string, outcome: string, id: string) {
    return {
      id,
      run_id: coordinatorStatus().runId ?? "run_t",
      delivery_contract: "current_delivery",
      from_handle: getState().dispatches?.[dispatchId]?.agentTerminal ?? "term_worker",
      to_handle: null,
      subject: `done: ${taskId}`,
      body: "",
      type: "worker_done",
      priority: "normal",
      thread_id: null,
      payload: JSON.stringify({ taskId, dispatchId, outcome }),
      created_at: new Date().toISOString(),
      delivered_at: new Date().toISOString(),
    };
  }

  async function settleViaWorkerDone(
    taskId: string,
    outcome: "succeeded" | "failed",
    msgId: string,
  ): Promise<void> {
    await mutateState((s) => {
      const task = s.tasks[taskId];
      const dispatch = s.dispatches[task.dispatch_id];
      task.status = outcome === "succeeded" ? "completed" : "failed";
      dispatch.status = task.status;
      if (workerSupervision(dispatch) === "supervised") dispatch.terminalState = "reclaimable";
      s.archives ??= {};
      s.archives[task.dispatch_id] ??= `output of ${taskId}`;
      s.seq ??= {};
      s.seq.delivery = (s.seq.delivery ?? 0) + 1;
      const handle = coordinatorTerminal(s).handle;
      s.mailboxes ??= {};
      s.mailboxes[handle] = [
        ...(s.mailboxes[handle] ?? []),
        {
          deliveryId: `delivery_t${s.seq.delivery}`,
          messages: [workerDoneMessage(taskId, task.dispatch_id, outcome, msgId)],
        },
      ];
    });
  }

  /** Settle without any inbox mail — Orca's own task record is the evidence. */
  async function settleViaTaskStatus(taskId: string, outcome: "succeeded" | "failed"): Promise<void> {
    await mutateState((s) => {
      const task = s.tasks[taskId];
      const dispatch = s.dispatches[task.dispatch_id];
      task.status = outcome === "succeeded" ? "completed" : "failed";
      dispatch.status = task.status;
      if (workerSupervision(dispatch) === "supervised") dispatch.terminalState = "reclaimable";
      s.archives ??= {};
      s.archives[task.dispatch_id] ??= `output of ${taskId}`;
    });
  }

  /** Deliver a raw FIFO batch into the coordinator's mailbox. */
  async function injectMail(messages: unknown[]): Promise<string> {
    return mutateState((s) => {
      s.seq ??= {};
      s.seq.delivery = (s.seq.delivery ?? 0) + 1;
      const deliveryId = `delivery_t${s.seq.delivery}`;
      const handle = coordinatorTerminal(s).handle;
      s.mailboxes ??= {};
      s.mailboxes[handle] = [...(s.mailboxes[handle] ?? []), { deliveryId, messages }];
      return deliveryId;
    });
  }

  /** Poll the in-memory coordinator projection until `pred` returns truthy. */
  async function waitFor<T>(pred: () => T | null | false, what: string, timeoutMs = 8000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = pred();
      if (value !== null && value !== false) return value;
      await new Promise((r) => setTimeout(r, 20));
    }
    const s = coordinatorStatus();
    throw new Error(
      `timed out waiting for ${what}; last coordinator status: ${JSON.stringify({
        phase: s.phase,
        error: s.error,
        attempts: s.attempts.map((a) => [a.taskId, a.settled, a.terminalDecision]),
        inbox: s.inbox.pending.length,
        debt: s.cleanupDebt,
      })}`,
    );
  }

  function attempt(taskId: string) {
    const a = coordinatorStatus().attempts.find((x) => x.taskId === taskId);
    assert.ok(a, `attempt for ${taskId} missing`);
    return a;
  }

  function findAttempt(taskId: string) {
    return coordinatorStatus().attempts.find((x) => x.taskId === taskId);
  }

  async function dispatchIdOf(taskId: string): Promise<string> {
    return waitFor(() => findAttempt(taskId)?.dispatchId ?? null, `dispatch id for ${taskId}`);
  }

  function processedRow(id: string) {
    return coordinatorStatus().inbox.recent.some((m) => m.id === id);
  }

  /**
   * Wait until no fake CLI invocation has committed for `quietMs` — used by
   * tests that explicitly assert no further CLI mutations occur.
   */
  async function waitForFakeQuiet(quietMs = 250, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const before = [logPath, statePath].map((p) => (existsSync(p) ? statSync(p).mtimeMs : 0));
      await new Promise((r) => setTimeout(r, quietMs));
      const after = [logPath, statePath].map((p) => (existsSync(p) ? statSync(p).mtimeMs : 0));
      if (before[0] === after[0] && before[1] === after[1]) return;
      if (Date.now() > deadline) return;
    }
  }

  /** Boot the HTTP app against the fake runtime for API-level coverage. */
  async function startApp() {
    const policy: SecurityPolicy = createSecurityPolicy({});
    const { app } = createApp({
      workspaceDir: workspace,
      worktree: "path:" + workspace,
      policy,
      embeddedAssets: null,
      readiness: async () => enabledReadiness,
    });
    const server = await listenLoopback(app, 0);
    httpServers.push(server);
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const base = `http://127.0.0.1:${addr.port}`;
    const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          "X-Orca-Dag-Token": policy.token,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    return { call };
  }

  /** One-run single-task scenario, ready to start. */
  async function singleTaskState(runId: string): Promise<void> {
    await mutateState((state) => {
      state.tasks = { task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" } };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
  }

  beforeEach(async () => {
    // Stop any coordinator loop left running by the previous test, then rotate
    // to a fresh per-test state/log pair so a trailing fake child from a prior
    // test cannot clobber this test's state file (no fixed quiet sleep needed).
    await stopCoordinator();
    if (coordinatorStatus().running) {
      throw new Error("coordinator loop did not stop before the next test");
    }
    resetCoordinatorForTests();
    initOrcaRuntime({ env: { ORCA_CLI_COMMAND: fixturePath, WORKSPACE_DIR: workspace }, cwd: root });
    rmSync(join(workspace, ".orca-dag", "sessions.json"), { force: true });
    rmSync(join(workspace, ".orca-dag", "launches.jsonl"), { force: true });
    rmSync(join(workspace, ".orca-dag", "requests.jsonl"), { force: true });
    testSeq += 1;
    statePath = join(root, `fake-state-${testSeq}.json`);
    logPath = join(root, `calls-${testSeq}.log`);
    process.env.FAKE_ORCA_STATE = statePath;
    process.env.FAKE_ORCA_LOG = logPath;
    writeFileSync(statePath, JSON.stringify({ version: "1.4.205" }));
  });

  after(async () => {
    await stopCoordinator();
    for (const server of httpServers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (!process.env.ORCA_DAG_FAKE_DEBUG_DIR) {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
    rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  return {
    root,
    workspace,
    fixturePath,
    readLog,
    calls,
    callsOf,
    firstIndexOf,
    ackCalls,
    namespaceCalls,
    mutateState,
    getState,
    baseTasks,
    baseOpts,
    recordViewerLaunch,
    coordinatorTerminal,
    settleViaWorkerDone,
    settleViaTaskStatus,
    injectMail,
    workerDoneMessage,
    waitFor,
    attempt,
    findAttempt,
    dispatchIdOf,
    processedRow,
    waitForFakeQuiet,
    startApp,
    singleTaskState,
  };
}
