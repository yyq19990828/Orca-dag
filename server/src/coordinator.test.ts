import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import {
  coordinatorStatus,
  noteManualRelease,
  resetCoordinatorForTests,
  retryWorker,
  startCoordinator,
  stopCoordinator,
  type StartOpts,
  type StopReport,
} from "./coordinator";
import { initOrcaRuntime, type OrcaReadiness } from "./orca";
import { createApp, listenLoopback } from "./app";
import { createSecurityPolicy, type SecurityPolicy } from "./security";

/**
 * Phase 3 acceptance coverage: the closed supervised-worker lifecycle.
 *
 * Everything runs against a stateful fake `orca` executable
 * (`test/fixtures/fake-orca.mjs`) that emulates the 1.4.205 contracts the
 * coordinator drives — FIFO Deliveries that replay until acked, worker-list
 * terminal accounting, release/retain/stop receipts — and records every argv.
 * Tests script the fake's state (tasks, mail, release modes), let the real
 * coordinator loop run against it with a fast tick, and assert on the
 * coordinator's projection plus the recorded CLI call sequence.
 *
 * Race discipline: test-side state writes take the same lock directory the
 * fake uses, and every "the coordinator did nothing wrong" assertion is made
 * only AFTER a waitFor proves the loop processed the relevant input.
 */

// --- fixture plumbing --------------------------------------------------------

let root: string;
let workspace: string;
let fixturePath: string;
let statePath: string;
let logPath: string;

interface FakeCall {
  argv: string[];
  cwd: string;
}

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

// --- scripted helpers --------------------------------------------------------

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

/** The coordinator terminal the loop created (by its well-known title prefix). */
function coordinatorTerminal(state: Record<string, any>): Record<string, any> {
  const mine = (state.terminals ?? []).filter((t: any) =>
    (t.title ?? "").startsWith("orca-dag coordinator"),
  );
  return mine[mine.length - 1];
}

/**
 * Settle `taskId` the way the runtime does when it accepts a worker_done: the
 * task flips terminal, the Dispatch settles, its terminal becomes reclaimable
 * (supervised only — unsupervised tracking dispatches stay `retained`), and
 * the worker_done lands in the coordinator's mailbox. One locked write, so
 * the loop can never observe the task flip without the mail or vice versa.
 */
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
    if (dispatch.workerState === "supervised") dispatch.terminalState = "reclaimable";
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
    if (dispatch.workerState === "supervised") dispatch.terminalState = "reclaimable";
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

function workerDoneMessage(taskId: string, dispatchId: string, outcome: string, id: string) {
  return {
    id,
    run_id: "run_t",
    delivery_contract: "current_delivery",
    from_handle: "term_worker",
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

/** Non-throwing variant for waitFor predicates (the attempt may not exist yet). */
function findAttempt(taskId: string) {
  return coordinatorStatus().attempts.find((x) => x.taskId === taskId);
}

/**
 * The attempt's dispatch id, once the start receipt has actually been folded
 * into the projection. The worker-start CALL logs before startOne's await
 * resolves, so a capture straight after a start-wait can race a null through.
 */
async function dispatchIdOf(taskId: string): Promise<string> {
  await waitFor(() => (attempt(taskId).dispatchId ?? null), `dispatch id for ${taskId}`);
  return attempt(taskId).dispatchId!;
}

/** Wait until the loop has actually processed a (non-side-effecting) row. */
function processedRow(id: string) {
  return coordinatorStatus().inbox.recent.some((m) => m.id === id);
}

// --- harness -----------------------------------------------------------------

let enabledReadiness: OrcaReadiness;
const httpServers: Server[] = [];

before(() => {
  root = process.env.ORCA_DAG_FAKE_DEBUG_DIR ?? mkdtempSync(join(tmpdir(), "orca-dag-coord-test-"));
  workspace = mkdtempSync(join(tmpdir(), "orca-dag-coord-ws-"));
  fixturePath = join(root, "fake-orca.mjs");
  statePath = join(root, "fake-state.json");
  logPath = join(root, "calls.log");
  // Copy the fixture next to the state/log so the fake needs only env vars.
  const src = readFileSync(new URL("../test/fixtures/fake-orca.mjs", import.meta.url), "utf8");
  writeFileSync(fixturePath, src);
  chmodSync(fixturePath, 0o755);
  writeFileSync(statePath, JSON.stringify({ version: "1.4.205" }));
  process.env.FAKE_ORCA_STATE = statePath;
  process.env.FAKE_ORCA_LOG = logPath;
  initOrcaRuntime({ env: { ORCA_CLI_COMMAND: fixturePath, WORKSPACE_DIR: workspace }, cwd: root });
  enabledReadiness = {
    cli: fixturePath,
    workspace,
    worktree: "path:" + workspace,
    version: "1.4.205",
    executionEnabled: true,
    reason: null,
  };
});

/**
 * Wait until no fake CLI invocation has committed for `quietMs` — i.e. the
 * previous test's loop AND every in-flight fake process has finished writing.
 * Resetting the state file earlier would let a stale snapshot land on top and
 * poison the next test with vanished tasks or lost mode overrides.
 */
async function waitForFakeQuiet(quietMs = 250, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const before = [logPath, statePath].map((p) => (existsSync(p) ? statSync(p).mtimeMs : 0));
    await new Promise((r) => setTimeout(r, quietMs));
    const after = [logPath, statePath].map((p) => (existsSync(p) ? statSync(p).mtimeMs : 0));
    if (before[0] === after[0] && before[1] === after[1]) return;
    if (Date.now() > deadline) return; // best effort — quiescence never came
  }
}

beforeEach(async () => {
  // A prior test may have parked the loop in awaiting_input — take it down
  // deterministically, then wait out every in-flight fake CLI write BEFORE the
  // state file is reset: a stale `terminal close` or `check` writing its
  // (old) snapshot back would otherwise clobber the fresh state below and
  // poison the next test with vanished tasks.
  await stopCoordinator();
  await waitForFakeQuiet();
  if (coordinatorStatus().running) {
    throw new Error("coordinator loop did not stop before the next test");
  }
  resetCoordinatorForTests();
  rmSync(logPath, { force: true });
  writeFileSync(statePath, JSON.stringify({ version: "1.4.205" }));
});

after(async () => {
  await stopCoordinator();
  for (const server of httpServers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (!process.env.ORCA_DAG_FAKE_DEBUG_DIR) {
    // Keep the fake's state around when debugging a failed run.
    rmSync(root, { recursive: true, force: true });
  }
  rmSync(workspace, { recursive: true, force: true });
});

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

// --- tests -------------------------------------------------------------------

describe("two-wave DAG: dependency order, concurrency cap, completion boundary", () => {
  it("runs two parallel roots then the dependent, releases every settled worker (success AND failure), and completes with zero reclaimable workers", async () => {
    const runId = "run_t";
    await mutateState((state) => {
      state.tasks = baseTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });

    await startCoordinator(baseOpts(runId, { maxConcurrency: 2 }));

    // Wave 1: both roots start before either settles; the dependent does not.
    await waitFor(() => (calls("worker-start").length >= 2 ? true : null), "both root tasks to start");
    const startOrder = calls("worker-start").map((c) => c.argv[c.argv.indexOf("--task") + 1]);
    assert.ok(startOrder.includes("task_aaa") && startOrder.includes("task_bbb"), `wave 1 started ${startOrder}`);
    assert.equal(calls("worker-start").filter((c) => c.argv.includes("task_ccc")).length, 0, "dependent must not start before its deps settle");

    // A settles via an accepted worker_done; B via Orca's own task record
    // (worker_done ack lost is not a stuck run — but C still waits for both).
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_a1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "A to release");
    assert.equal(attempt("task_aaa").settledVia, "worker_done");
    assert.ok(attempt("task_aaa").output && attempt("task_aaa").output!.lines.includes("output of task_aaa"), "output archived before release");

    await settleViaTaskStatus("task_bbb", "succeeded");
    // Phase 5: B settles LAST, so C is already ready at B's ownership
    // decision — B's terminal is the immediate compatible follow-up (same
    // harness, no model) and is REUSED for C instead of released. A, which
    // settled while C was still pending, took the default release.
    await waitFor(() => (attempt("task_bbb").terminalDecision === "reused" ? true : null), "B's terminal to be reused for C");
    assert.equal(attempt("task_bbb").settledVia, "task_status");

    // Wave 2: the dependent starts only after BOTH roots settled — C on B's
    // reused terminal (--terminal, never --agent), A genuinely released first.
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_ccc")) ? true : null), "C to start");
    const cStart = calls("worker-start").find((c) => c.argv.includes("task_ccc"))!;
    const cStartIdx = firstIndexOf("worker-start", "--task", "task_ccc");
    const aReleaseIdx = firstIndexOf("worker-release", "--dispatch", attempt("task_aaa").dispatchId!);
    assert.ok(aReleaseIdx >= 0 && aReleaseIdx < cStartIdx, `A released before C started (release at ${aReleaseIdx}, C start at ${cStartIdx})`);
    const bTerminal = (getState().dispatches as Record<string, any>)[attempt("task_bbb").dispatchId!].agentTerminal;
    assert.ok(cStart.argv.includes("--terminal"), "C started via terminal reuse");
    assert.ok(cStart.argv.includes(bTerminal), `C must run on B's terminal ${bTerminal}`);
    assert.ok(!cStart.argv.includes("--agent"), "a reused terminal relaunches nothing");
    assert.equal(findAttempt("task_ccc")!.reuseOf, attempt("task_bbb").dispatchId, "C inherited B's Dispatch lineage");
    assert.equal(
      callsOf("worker-release", "--dispatch", attempt("task_bbb").dispatchId!).length,
      0,
      "B's terminal was never released — ownership transferred, exactly one new Dispatch",
    );

    // C FAILS — a failed worker reaches `released` too (after archiving).
    await settleViaWorkerDone("task_ccc", "failed", "msg_c1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");

    const status = coordinatorStatus();
    assert.equal(status.error, null);
    assert.equal(status.attempts.length, 3);
    for (const a of status.attempts) {
      // B's terminal was REUSED by C; the rest took the default release.
      const expected = a.taskId === "task_bbb" ? "reused" : "released";
      assert.equal(a.terminalDecision, expected, `${a.taskId} must be ${expected}`);
      assert.ok(a.settledVia === "worker_done" || a.settledVia === "task_status", `${a.taskId} settledVia ${a.settledVia}`);
      assert.ok(a.output, `${a.taskId} output archived`);
    }
    assert.equal(attempt("task_ccc").outcome, "failed");
    assert.deepEqual(status.cleanupDebt, [], "no cleanup debt at completion");
    assert.ok(status.completedAt !== null && status.completedAt > 0);

    // Boundary clause 4: the coordinator itself queried the fleet and refused
    // to complete while anything was reclaimable — so a completed phase plus
    // the log proves the query ran and returned empty.
    assert.ok(calls("worker-list").some((c) => c.argv.includes("reclaimable")), "completion queried worker-list --terminal-state reclaimable");
    const remaining = Object.values(getState().dispatches as Record<string, any>).filter((d) => d.terminalState === "reclaimable");
    assert.deepEqual(remaining, [], "no reclaimable worker at completion");

    // Boundary clause 6: the coordinator terminal verifiably closed — poll the
    // runtime's own record rather than a snapshot taken mid-close.
    await waitFor(() => {
      const closed = (getState().terminals as any[]).filter((t) => (t.title ?? "").startsWith("orca-dag coordinator"));
      return closed.length > 0 && closed.every((t) => t.connected === false) ? true : null;
    }, "coordinator terminal to close in Orca");
  });

  it("respects maxConcurrency=1: no second start slips through before settlement", async () => {
    const runId = "run_cap";
    await mutateState((state) => {
      state.tasks = baseTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(baseOpts(runId, { maxConcurrency: 1 }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "first worker to start");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls("worker-start").length, 1, "concurrency cap holds before settlement");
    await stopCoordinator();
  });
});

describe("worker_done validation", () => {
  it("ignores a duplicate/replayed worker_done: no double release, no state change, run still completes", async () => {
    const runId = "run_replay";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_first");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "release");

    // The same settlement replayed as a NEW message (runtime redelivery).
    // Whether the loop processes it before or after completing is immaterial —
    // both orders must leave exactly one release and one settled attempt.
    await injectMail([workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_dup")]);
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
    assert.equal(callsOf("worker-release", "--dispatch", dispatchId).length, 1, "no double release");
    const a = attempt("task_aaa");
    assert.equal(a.settled, true);
    assert.equal(a.terminalDecision, "released");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });

  it("never treats an unknown Dispatch or unverifiable outcome as settlement", async () => {
    const runId = "run_strange";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");

    const dispatchId = await dispatchIdOf("task_aaa");
    await injectMail([
      workerDoneMessage("task_aaa", "ctx_foreign", "succeeded", "msg_foreign"),
      workerDoneMessage("task_aaa", dispatchId, "probably_fine", "msg_unverifiable"),
    ]);
    // Both rows must be *processed* (recorded) before we assert the negative.
    await waitFor(() => (processedRow("msg_foreign") && processedRow("msg_unverifiable") ? true : null), "strange rows to be processed");
    const a = attempt("task_aaa");
    assert.equal(a.settled, false, "unverifiable/foreign worker_done must not settle");
    assert.notEqual(coordinatorStatus().phase, "completed");
    await stopCoordinator();
  });
});

describe("heartbeat handling", () => {
  it("records heartbeats as liveness evidence and never as completion", async () => {
    const runId = "run_beat";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");
    await injectMail([
      {
        id: "msg_beat",
        run_id: runId,
        type: "heartbeat",
        from_handle: "term_worker",
        subject: "alive",
        body: "",
        payload: JSON.stringify({ taskId: "task_aaa", dispatchId, phase: "working" }),
        created_at: "2026-01-01T00:00:05Z",
      },
    ]);
    await waitFor(() => (attempt("task_aaa").lastHeartbeatAt === "2026-01-01T00:00:05Z" ? true : null), "heartbeat recorded");
    assert.equal(attempt("task_aaa").settled, false, "a heartbeat is not completion");
    assert.notEqual(coordinatorStatus().phase, "completed");
    await stopCoordinator();
  });
});

describe("questions hold the Delivery open", () => {
  it("surfaces a question, replies via the API, then acknowledges the Delivery exactly once", async () => {
    const { call } = await startApp();
    const runId = "run_ask";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");

    // One FIFO batch carrying BOTH the settlement and a question. The task and
    // Dispatch flip in the same locked write, exactly like the runtime's own
    // settlement write that accompanies an accepted worker_done.
    const deliveryId = await mutateState((s) => {
      const task = s.tasks.task_aaa;
      const dispatch = s.dispatches[task.dispatch_id];
      task.status = "completed";
      dispatch.status = "completed";
      dispatch.terminalState = "reclaimable";
      s.archives ??= {};
      s.archives[task.dispatch_id] = "output";
      s.seq ??= {};
      s.seq.delivery = (s.seq.delivery ?? 0) + 1;
      const id = `delivery_q${s.seq.delivery}`;
      const handle = coordinatorTerminal(s).handle;
      s.mailboxes ??= {};
      s.mailboxes[handle] = [
        {
          deliveryId: id,
          messages: [
            workerDoneMessage("task_aaa", task.dispatch_id, "succeeded", "msg_done_q"),
            {
              id: "msg_question",
              run_id: runId,
              type: "question",
              from_handle: "term_worker",
              to_handle: null,
              subject: "Which database?",
              body: "postgres or sqlite?",
              priority: "high",
              thread_id: null,
              payload: JSON.stringify({ taskId: "task_aaa", dispatchId: task.dispatch_id }),
              created_at: "2026-01-01T00:00:06Z",
              delivered_at: "2026-01-01T00:00:06Z",
            },
          ],
        },
      ];
      return id;
    });

    // Settlement + release processed; the question is surfaced; no ack yet.
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "settlement in the batch to process");
    await waitFor(() => (coordinatorStatus().inbox.pending.some((i) => i.messageId === "msg_question") ? true : null), "question to surface");
    assert.equal(ackCalls(deliveryId).length, 0, "no ack while the question is open");
    // The phase flips in the reconcile that closes the pass which surfaced the
    // question — wait for it rather than racing the same tick.
    await waitFor(() => (coordinatorStatus().phase === "awaiting_input" ? true : null), "awaiting_input while the question is open");

    // GET /api/inbox exposes it for the panel.
    const inbox = await call("GET", "/api/inbox");
    assert.equal(inbox.status, 200);
    assert.equal((inbox.json.inbox as any).pending.length, 1);

    // Reply over HTTP — routed through the live coordinator, which acks.
    const reply = await call("POST", "/api/messages/msg_question/reply", { runId, body: "sqlite is fine" });
    assert.equal(reply.status, 200);
    await waitFor(() => (coordinatorStatus().inbox.pending.length === 0 ? true : null), "question cleared");

    assert.equal(calls("reply").length, 1);
    assert.deepEqual(calls("reply")[0].argv.slice(2, 7), ["--id", "msg_question", "--body", "sqlite is fine", "--from"]);
    await waitFor(() => (ackCalls(deliveryId).length > 0 ? true : null), "delivery ack after reply");
    assert.equal(ackCalls(deliveryId).length, 1, "acked exactly once");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion after reply");
  });

  it("surfaces escalations the same way and blocks completion until answered", async () => {
    const runId = "run_esc";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");

    await injectMail([
      {
        id: "msg_esc",
        run_id: runId,
        type: "escalation",
        from_handle: "term_worker",
        to_handle: null,
        subject: "Cannot access the registry",
        body: "push denied",
        priority: "urgent",
        thread_id: null,
        payload: JSON.stringify({ taskId: "task_aaa", dispatchId: attempt("task_aaa").dispatchId }),
        created_at: "2026-01-01T00:00:07Z",
        delivered_at: "2026-01-01T00:00:07Z",
      },
    ]);
    await waitFor(() => (coordinatorStatus().inbox.pending[0]?.kind === "escalation" ? true : null), "escalation surfaced");
    // The phase flips in the same iteration's boundary check — poll it rather
    // than assert against a mid-iteration snapshot.
    await waitFor(() => (coordinatorStatus().phase === "awaiting_input" ? true : null), "awaiting_input phase");
    await stopCoordinator();
  });
});

describe("release_pending and release_unknown", () => {
  it("retries a deferred release and completes once Orca settles it", async () => {
    const runId = "run_pending";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");
    await mutateState((s) => {
      s.releaseMode = s.releaseMode ?? {};
      s.releaseMode[dispatchId] = "release_pending";
    });

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_p1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "release_pending" ? true : null), "release to defer");
    const deferredReleases = callsOf("worker-release", "--dispatch", dispatchId).length;
    assert.ok(deferredReleases >= 1);

    // Orca finishes settling the terminal; the next reconciliation retry lands.
    await mutateState((s) => {
      s.releaseMode[dispatchId] = "normal";
    });
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "release to settle");
    assert.ok(callsOf("worker-release", "--dispatch", dispatchId).length > deferredReleases, "release was retried after release_pending");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });

  it("surfaces release_unknown as debt, never auto-retries it; completion waits for the explicit decision", async () => {
    const { call } = await startApp();
    const runId = "run_unknown";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");
    await mutateState((s) => {
      s.releaseMode = s.releaseMode ?? {};
      s.releaseMode[dispatchId] = "release_unknown";
    });

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_u1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "release_unknown" ? true : null), "release_unknown surfaced");
    await waitFor(() => (coordinatorStatus().cleanupDebt.length === 1 ? true : null), "debt recorded");
    assert.equal(coordinatorStatus().cleanupDebt[0].dispatchId, dispatchId);
    assert.equal(coordinatorStatus().phase, "awaiting_input");
    // The ambiguous outcome must NOT be retried behind the user's back.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(callsOf("worker-release", "--dispatch", dispatchId).length, 1, "no automatic retry of release_unknown");
    assert.notEqual(coordinatorStatus().phase, "completed", "completion blocked by debt");

    // The user resolves it explicitly over HTTP. The coordinator folds the
    // receipt into its projection and the boundary passes.
    await mutateState((s) => {
      s.releaseMode[dispatchId] = "normal";
    });
    const rel = await call("POST", `/api/workers/${dispatchId}/release`, {});
    assert.equal(rel.status, 200);
    assert.equal(noteManualRelease(dispatchId, "released"), true, "projection updated");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion after manual release");
    assert.deepEqual(coordinatorStatus().cleanupDebt, []);
  });
});

describe("explicit retain", () => {
  it("keeps a settled worker's terminal when retainByTask asks for it", async () => {
    const runId = "run_retain";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId, { retainByTask: { task_aaa: true } }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_r1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "retained" ? true : null), "retained");
    assert.equal(calls("worker-retain").length, 1);
    assert.equal(calls("worker-release").length, 0, "no release on explicit retain");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });
});

describe("explicit stop", () => {
  it("stops supervised workers, fences the opencode tracking dispatch, closes only its own terminal, and reports mixed outcomes distinctly", async () => {
    const { call } = await startApp();
    const runId = "run_stop";
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: "[]" },
        task_ccc: { id: "task_ccc", run_id: runId, status: "pending", deps: "[]" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(
      baseOpts(runId, {
        maxConcurrency: 3,
        harnessByTask: { task_bbb: "opencode", task_ccc: "claude" },
      }),
    );
    await waitFor(() => (calls("worker-start").length === 2 ? true : null), "two supervised workers to start");
    await waitFor(() => (calls("dispatch").length === 1 ? true : null), "opencode tracking dispatch");
    // The tracking dispatch id is adopted from Orca's task record on the next
    // reconciliation — Stop must report it, so wait for the adoption first.
    await waitFor(() => (attempt("task_bbb").dispatchId !== null ? true : null), "tracking dispatch adopted");
    await waitFor(() => (attempt("task_bbb").handle !== null ? true : null), "legacy terminal recorded");

    // Capture identities BEFORE the stop: stopCoordinator clears the attempts.
    const aDispatch = attempt("task_aaa").dispatchId!;
    const cDispatch = attempt("task_ccc").dispatchId!;
    const legacyTerm = attempt("task_bbb").handle!;
    const trackingId = attempt("task_bbb").dispatchId!;
    await mutateState((s) => {
      // Make C's stop unverifiable — the report must carry the uncertainty.
      s.stopMode = s.stopMode ?? {};
      s.stopMode[cDispatch] = "fail";
    });

    const stop = await call("POST", "/api/run-stop", {});
    assert.equal(stop.status, 200);
    const report = stop.json as unknown as StopReport & { ok: boolean };
    assert.equal(report.ok, true);
    assert.equal(report.clean, false, "an unverifiable stop must mark the report unclean");

    const aResult = report.results.find((r) => r.target === aDispatch);
    const cResult = report.results.find((r) => r.target === cDispatch);
    const trackResult = report.results.find((r) => r.target === trackingId);
    const termResult = report.results.find((r) => r.target === legacyTerm);
    assert.equal(aResult?.result, "stopped", `A: ${JSON.stringify(aResult)}`);
    assert.equal(aResult?.kind, "supervised");
    assert.equal(cResult?.result, "unknown", `C: ${JSON.stringify(cResult)}`);
    assert.ok(trackResult, `tracking dispatch reported: ${JSON.stringify(report.results)}`);
    assert.equal(trackResult.result, "fenced");
    assert.equal(trackResult.kind, "tracking_dispatch");
    assert.equal(termResult?.result, "closed", `legacy terminal: ${JSON.stringify(termResult)}`);
    assert.equal(termResult?.kind, "legacy_terminal");

    // Only the viewer-created bare shell was closed — no worker-stop stood in
    // for it, and the supervised terminals were never "closed" to fake a stop.
    const state = getState();
    assert.equal((state.terminals as any[]).find((t) => t.handle === legacyTerm)?.connected, false);
    // Coordinator terminal closed → the user's agent can rebind the Run.
    const coordHandle = coordinatorTerminal(state)?.handle;
    await waitFor(
      () => ((getState().terminals as any[]).find((t) => t.handle === coordHandle)?.connected === false ? true : null),
      "coordinator terminal closed",
    );
    // Stop uncertainty stays visible after the phase resets.
    assert.ok(coordinatorStatus().cleanupDebt.length >= 1, "stop uncertainty surfaces as cleanup debt");
    assert.equal(coordinatorStatus().running, false);
    assert.notEqual(coordinatorStatus().lastStopReport, null);
  });
});

describe("legacy (opencode) lane settlement", () => {
  it("closes its proven viewer-created terminal and settles the unsupervised tracking dispatch without worker-stop, then completes", async () => {
    const runId = "run_legacy";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId, { harnessByTask: { task_aaa: "opencode" } }));

    // Legacy start: bare shell + tracking dispatch + preamble typed in.
    await waitFor(() => (calls("dispatch").length === 1 ? true : null), "tracking dispatch");
    await waitFor(() => (calls("dispatch-show").length === 1 ? true : null), "preamble fetch");
    await waitFor(
      () => (readLog().some((c) => c.argv[0] === "terminal" && c.argv[1] === "send" && c.argv.some((a) => String(a).includes("opencode run --auto"))) ? true : null),
      "opencode launched",
    );
    // The mode folds into the projection only after startOpencodeWorker's
    // await resolves — the launch log line lands first, so poll, don't assert.
    await waitFor(() => (attempt("task_aaa").mode === "legacy" ? true : null), "legacy attempt recorded");
    await waitFor(() => (attempt("task_aaa").handle !== null ? true : null), "viewer-created terminal recorded");
    await waitFor(() => (attempt("task_aaa").dispatchId !== null ? true : null), "tracking dispatch adopted");
    const legacyHandle = attempt("task_aaa").handle!;

    // The worker settles itself (its preamble sends worker_done from its own
    // pane; the runtime accepts it and completes the task).
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_leg1");

    await waitFor(() => (attempt("task_aaa").terminalDecision === "closed" ? true : null), "legacy terminal closed");
    assert.equal(calls("worker-stop").length, 0, "no worker-stop on the happy path");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
    const state = getState();
    assert.equal((state.terminals as any[]).find((t) => t.handle === legacyHandle)?.connected, false, "only the proven viewer-created terminal closed");
    const reclaimable = Object.values(state.dispatches as Record<string, any>).filter((d) => d.terminalState === "reclaimable");
    assert.deepEqual(reclaimable, [], "no reclaimable workers after the legacy lane settles");
  });
});

describe("unowned dispatched tasks", () => {
  it("adopts a pre-existing active Dispatch (Phase 4), counts it against the budget, and never double-places over it", async () => {
    const runId = "run_unowned";
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_zzz: {
          id: "task_zzz",
          run_id: runId,
          status: "dispatched",
          deps: "[]",
          dispatch_id: "ctx_preexisting",
          assignee_handle: "term_elsewhere",
        },
      };
      state.dispatches = {
        ctx_preexisting: {
          id: "ctx_preexisting",
          task_id: "task_zzz",
          run_id: runId,
          status: "dispatched",
          workerState: "supervised",
          terminalState: "active",
          agentTerminal: "term_elsewhere",
        },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(baseOpts(runId, { maxConcurrency: 1 }));
    // Recovery adopts the active Dispatch into the projection…
    await waitFor(
      () =>
        (attempt("task_zzz").adopted === true && attempt("task_zzz").dispatchId === "ctx_preexisting"
          ? true
          : null),
      "pre-existing Dispatch to be adopted",
    );
    assert.deepEqual(coordinatorStatus().recovery?.activeAdopted, ["task_zzz"]);
    // …it occupies the only concurrency slot…
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(calls("worker-start").length, 0, "no placement over an adopted Dispatch at cap 1");
    // …and the projection no longer reports it as unowned (it is OURS now).
    assert.deepEqual(coordinatorStatus().unownedDispatches, []);
    // Stopping the coordinator must account for the adopted Dispatch too.
    const stop = await stopCoordinator();
    const zzz = stop.results.find((r) => r.target === "ctx_preexisting");
    assert.ok(zzz, "adopted Dispatch appears in the stop report");
    assert.equal(zzz.result, "stopped");
  });

  it("surfaces an unverifiable Dispatch (no supervised row) without adopting or placing over it", async () => {
    const runId = "run_unverifiable";
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_zzz: {
          id: "task_zzz",
          run_id: runId,
          status: "dispatched",
          deps: "[]",
          dispatch_id: "ctx_nowhere",
          assignee_handle: "term_elsewhere",
        },
      };
      // NO dispatch row for ctx_nowhere — worker-list has nothing verifiable.
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(baseOpts(runId, { maxConcurrency: 1 }));
    await waitFor(
      () => (coordinatorStatus().unownedDispatches.length === 1 ? true : null),
      "unverifiable dispatch surfaced",
    );
    assert.deepEqual(coordinatorStatus().unownedDispatches, ["task_zzz (ctx_nowhere)"]);
    assert.deepEqual(coordinatorStatus().recovery?.unverifiable, ["task_zzz"]);
    // Nothing was adopted, nothing placed: the unverifiable slot holds the budget.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(calls("worker-start").length, 0, "no placement while an unverifiable Dispatch holds the cap");
    // And nothing destructive ever ran against it.
    assert.equal(calls("worker-stop").length, 0);
    assert.equal(calls("worker-release").length, 0);
    await stopCoordinator();
  });
});

// --- Phase 4: restart recovery, idempotent mutations, safe retry -------------

describe("Phase 4: ambiguous worker-start recovery", () => {
  it("resolves a lost worker-start response via request-show + same-id replay: exactly ONE Dispatch, concurrency held", async () => {
    const runId = "run_ambiguous";
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: '["task_aaa"]' },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      // The fake performs the FULL mutation, records the request as completed,
      // then dies with garbage output — the response is lost after the fact.
      state.workerStartAmbiguous = "lost";
    });
    await startCoordinator(baseOpts(runId, { maxConcurrency: 1 }));

    await waitFor(() => (findAttempt("task_aaa")?.dispatchId ?? null), "dispatch to be recovered");
    const a = attempt("task_aaa");
    assert.equal(a.dispatchId, "ctx_s1");
    assert.equal(a.settled, false, "the recovered start is a live worker, not a settlement");
    assert.equal(a.startRequestId, null, "the durable id retires once the outcome is known");
    const starts = calls("worker-start");
    assert.equal(starts.length, 2, "original + idempotent replay, nothing else");
    const ids = starts.map((c) => c.argv[c.argv.indexOf("--retry-request") + 1]);
    assert.ok(ids[0], "original call carried a durable retry-request id");
    assert.equal(ids[0], ids[1], "the replay reuses the SAME durable id");
    assert.equal(ids[0], a.startReceipt?.requestId, "the receipt echoes the id the start ran under");
    assert.ok(calls("request-show").length >= 1, "request-show ran before any replay");
    assert.equal(Object.keys(getState().dispatches ?? {}).length, 1, "no second Dispatch was minted");

    // Concurrency: the dependent holds until the recovered worker settles.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(calls("worker-start").length, 2, "no placement behind the unresolved-but-live worker");

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_amb1");
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_bbb")) ? true : null), "dependent to start");
    await settleViaWorkerDone("task_bbb", "succeeded", "msg_amb2");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
    assert.deepEqual(coordinatorStatus().cleanupDebt, [], "a recovered run completes clean");
  });

  it("parks a lost start Orca holds no receipt for: receipt retained, NO auto-retry, explicit retry succeeds", async () => {
    const runId = "run_lostnr";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.workerStartAmbiguous = "lost_noreceipt";
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (findAttempt("task_aaa")?.settledVia === "start_failed" ? true : null), "failed start recorded");
    const a = attempt("task_aaa");
    assert.equal(a.settled, true);
    assert.equal(a.outcome, "failed");
    assert.equal(a.startReceipt?.failedStage, "response_lost", "the unresolved ambiguity is IN the receipt");
    assert.ok(calls("request-show").length >= 1, "Orca was asked whether the start landed");
    assert.equal(Object.keys(getState().dispatches ?? {}).length, 0, "no Dispatch exists");
    await waitFor(
      () => (findAttempt("task_aaa")?.terminalDecision === "not_needed" ? true : null),
      "ownership decided: nothing was created",
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls("worker-start").length, 1, "the parked start is never retried blindly");
    assert.equal(getState().tasks.task_aaa.status, "ready", "the task stays ready, not re-placed");
    assert.equal(coordinatorStatus().error, null, "a receipt-bearing failure stays on the attempt, not the global error");

    // Explicit retry is the ONLY way this task runs again.
    await mutateState((state) => {
      delete state.workerStartAmbiguous;
    });
    const retried = await retryWorker("task_aaa");
    assert.equal(retried.taskId, "task_aaa");
    assert.equal(retried.retriedFrom, null, "no old Dispatch existed for --retry-of lineage");
    await waitFor(() => (findAttempt("task_aaa")?.dispatchId === "ctx_s1" ? true : null), "the explicit retry to place");
    assert.equal(attempt("task_aaa").settled, false);
    assert.equal(attempt("task_aaa").startReceipt?.dispatchId, "ctx_s1", "the success receipt replaced the failure receipt");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_lnr1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });

  it("refuses to retry an active attempt, and refuses while cleanup debt is open", async () => {
    const runId = "run_refuse";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    const dispatchId = (await waitFor(
      () => (findAttempt("task_aaa")?.dispatchId ?? null),
      "first worker to start",
    ))!;

    // Active: positively NOT failed.
    await assert.rejects(retryWorker("task_aaa"), /not positively failed/, "active attempt refuses");
    await assert.rejects(retryWorker(dispatchId), /not positively failed/, "by-dispatch-id refusal works too");

    // Settle as FAILED, then make the release ambiguous so debt opens.
    await mutateState((state) => {
      state.releaseMode ??= {};
      state.releaseMode[dispatchId] = "release_unknown";
    });
    await settleViaWorkerDone("task_aaa", "failed", "msg_ref1");
    await waitFor(() => (coordinatorStatus().cleanupDebt.length === 1 ? true : null), "release_unknown debt to surface");
    await assert.rejects(retryWorker("task_aaa"), /cleanup debt/, "open debt refuses the retry");
    await stopCoordinator();
  });
});

describe("Phase 4: failed-before-ready starts", () => {
  it("keeps the attempt with its receipt, owes no cleanup, never auto-retries, and retries only on request", async () => {
    const runId = "run_fbready";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.workerStartFail = {
        code: "terminal_start_failed",
        message: "agent terminal failed to become ready",
        receipt: {
          stage: "terminal_start",
          failedStage: "terminal_start",
          setup: "skipped",
          residualResources: null,
          recoveryCommands: [],
        },
      };
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (findAttempt("task_aaa")?.settledVia === "start_failed" ? true : null), "failed-before-ready recorded");
    const a = attempt("task_aaa");
    assert.equal(a.settled, true);
    assert.equal(a.outcome, "failed");
    assert.equal(a.startReceipt?.failedStage, "terminal_start", "the runtime's receipt is preserved verbatim");
    await waitFor(
      () => (findAttempt("task_aaa")?.terminalDecision === "not_needed" ? true : null),
      "ownership decided: nothing to release",
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls("worker-start").length, 1, "no automatic re-placement of a failed start");
    assert.equal(getState().tasks.task_aaa.status, "ready");

    // The explicit retry re-places with the same harness and fresh id.
    await mutateState((state) => {
      delete state.workerStartFail;
    });
    await retryWorker("task_aaa");
    await waitFor(() => (findAttempt("task_aaa")?.dispatchId === "ctx_s1" ? true : null), "retry to place");
    assert.equal(attempt("task_aaa").settled, false);
    assert.equal(attempt("task_aaa").startReceipt?.ok, true, "the new start's success receipt is on file");

    // While that retry is ACTIVE, another retry must refuse.
    await assert.rejects(retryWorker("task_aaa"), /not positively failed/, "an in-flight retry target refuses");

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_fbr1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
    assert.deepEqual(coordinatorStatus().cleanupDebt, []);
  });
});

describe("Phase 4: restart projection classes", () => {
  /** One dispatched task with a pre-existing Dispatch row (a crashed viewer's). */
  async function crashedState(runId: string, dispatch: Record<string, any>, taskStatus: string): Promise<void> {
    await mutateState((state) => {
      state.tasks = {
        task_zzz: {
          id: "task_zzz",
          run_id: runId,
          status: taskStatus,
          deps: "[]",
          dispatch_id: dispatch.id,
        },
      };
      state.dispatches = { [dispatch.id]: { id: dispatch.id, task_id: "task_zzz", run_id: runId, workerState: "supervised", ...dispatch } };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
  }

  it("stale projection: task row says dispatched, worker-list says completed → adopted settled and auto-released", async () => {
    const runId = "run_stale";
    // The task row is the STALE side: it still says dispatched even though the
    // Dispatch settled — worker-list is authoritative (plan §6.3).
    await crashedState(runId, { id: "ctx_stale", status: "completed", terminalState: "reclaimable" }, "dispatched");
    await startCoordinator(baseOpts(runId));
    assert.deepEqual(coordinatorStatus().recovery?.settledAdopted, ["task_zzz"], "the stale case is settled from worker-list");
    await waitFor(() => (attempt("task_zzz").terminalDecision === "released" ? true : null), "positively reclaimable worker auto-released");
    assert.equal(attempt("task_zzz").settledVia, "task_status");
    assert.equal(attempt("task_zzz").outcome, "succeeded");
    assert.equal(callsOf("worker-release", "--dispatch", "ctx_stale").length, 1, "released exactly once");
    assert.equal(calls("worker-start").length, 0, "never re-placed over a settled Dispatch");
    await stopCoordinator();
  });

  it("retained projection: an already-decided row is left exactly as Orca holds it", async () => {
    const runId = "run_retained";
    await crashedState(runId, { id: "ctx_ret", status: "completed", terminalState: "retained" }, "completed");
    await startCoordinator(baseOpts(runId));
    assert.equal(coordinatorStatus().recovery?.leftDecided, 1, "the retained row is counted as decided");
    assert.equal(coordinatorStatus().attempts.length, 0, "no attempt is invented for it");
    assert.equal(calls("worker-release").length, 0, "no release behind the user's retain");
    assert.equal(calls("worker-retain").length, 0);
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });

  it("release_unknown projection on restart: adopted, surfaced as debt, never auto-retried", async () => {
    const runId = "run_unk";
    await crashedState(runId, { id: "ctx_unk", status: "failed", terminalState: "release_unknown" }, "failed");
    await mutateState((state) => {
      state.releaseMode = { ctx_unk: "release_unknown" };
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(
      () => (coordinatorStatus().cleanupDebt.some((d) => d.dispatchId === "ctx_unk") ? true : null),
      "the ambiguous release to surface as debt",
    );
    assert.equal(attempt("task_zzz").terminalDecision, "release_unknown");
    const releases = callsOf("worker-release", "--dispatch", "ctx_unk").length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(callsOf("worker-release", "--dispatch", "ctx_unk").length, releases, "release_unknown is never auto-retried");
    await stopCoordinator();
  });

  it("release_pending projection on restart: retried under the SAME durable id until Orca settles it", async () => {
    const runId = "run_pend";
    await crashedState(runId, { id: "ctx_pend", status: "completed", terminalState: "release_pending" }, "completed");
    await mutateState((state) => {
      state.releaseMode = { ctx_pend: "release_pending" };
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (attempt("task_zzz").terminalDecision === "release_pending" ? true : null), "deferred release recorded");
    await mutateState((state) => {
      delete state.releaseMode.ctx_pend;
    });
    await waitFor(() => (attempt("task_zzz").terminalDecision === "released" ? true : null), "the deferred release to settle");
    const ids = new Set(
      callsOf("worker-release", "--dispatch", "ctx_pend").map((c) => c.argv[c.argv.indexOf("--retry-request") + 1]),
    );
    assert.equal(ids.size, 1, "every release_pending retry runs under ONE durable id");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });
});

describe("Phase 4: literal nextAction (item 6)", () => {
  it("follows a prescribed worker-release argv verbatim — no extra id is added", async () => {
    const runId = "run_nextact";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.nextAction = {
        ctx_s1: { kind: "release", argv: ["orchestration", "worker-release", "--dispatch", "ctx_s1"] },
      };
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "start");
    const dispatchId = await dispatchIdOf("task_aaa");
    assert.equal(dispatchId, "ctx_s1");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_na1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "released");
    const rel = callsOf("worker-release", "--dispatch", "ctx_s1");
    assert.equal(rel.length, 1);
    assert.equal(rel[0].argv.includes("--retry-request"), false, "the prescribed argv ran VERBATIM");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });

  it("uses the idempotent direct release when no nextAction is prescribed (never invents one)", async () => {
    const runId = "run_nonextact";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "start");
    const dispatchId = await dispatchIdOf("task_aaa");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_nn1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "released");
    const rel = callsOf("worker-release", "--dispatch", dispatchId);
    assert.equal(rel.length, 1);
    assert.equal(rel[0].argv.includes("--retry-request"), true, "the direct release carries a durable id");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });
});

// --- Phase 5: terminal reuse, forced-fresh launch choices, explicit retain ---

describe("Phase 5: terminal reuse and retain", () => {
  /** A → B dependency chain: B is the immediate ready follow-up. */
  async function chainState(runId: string): Promise<void> {
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: '["task_aaa"]' },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
  }

  it("reuses the settled terminal for an immediate compatible follow-up BEFORE acknowledging the old Delivery", async () => {
    const runId = "run_reuse";
    await chainState(runId);
    await startCoordinator(baseOpts(runId, { maxConcurrency: 2 }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "A to start");
    const aDispatch = await dispatchIdOf("task_aaa");

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_ru1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "reused" ? true : null), "A's terminal reused");
    await waitFor(() => (findAttempt("task_bbb")?.dispatchId ?? null), "B started on the reused terminal");

    const bStart = calls("worker-start").find((c) => c.argv.includes("task_bbb"))!;
    assert.ok(bStart.argv.includes("--terminal"), "B started via --terminal reuse");
    assert.equal(bStart.argv.indexOf("--agent"), -1, "a reused terminal relaunches nothing");
    assert.equal(attempt("task_bbb").reuseOf, aDispatch, "B's lineage names A's Dispatch");
    assert.equal(
      callsOf("worker-release", "--dispatch", aDispatch).length,
      0,
      "A's terminal was NOT released — it changed hands",
    );
    // Ownership transferred to EXACTLY one new Dispatch, same terminal handle.
    const dispatches = getState().dispatches as Record<string, any>;
    const bDispatches = Object.values(dispatches).filter((d) => d.task_id === "task_bbb");
    assert.equal(bDispatches.length, 1, "exactly one new Dispatch");
    assert.equal(bDispatches[0].agentTerminal, dispatches[aDispatch].agentTerminal, "the SAME terminal handle moved to B");
    assert.equal(dispatches[aDispatch].terminalState, "released", "the old Dispatch no longer holds a reclaimable resource");

    // The old Delivery settles only AFTER the reuse start actually ran.
    await waitFor(() => (ackCalls("delivery_t1").length > 0 ? true : null), "A's delivery acked");
    const bStartIdx = firstIndexOf("worker-start", "--task", "task_bbb");
    const ackIdx = firstIndexOf("check", "--ack", "delivery_t1");
    assert.ok(ackIdx > bStartIdx, `reuse start (log ${bStartIdx}) must land before the ack (log ${ackIdx})`);

    await settleViaWorkerDone("task_bbb", "succeeded", "msg_ru2");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
    assert.equal(attempt("task_bbb").terminalDecision, "released", "the last worker takes the default release");
    assert.deepEqual(coordinatorStatus().cleanupDebt, []);
  });

  it("forces a fresh worker when the follow-up requests a model (--terminal cannot carry one)", async () => {
    const runId = "run_fresh_model";
    await chainState(runId);
    await startCoordinator(baseOpts(runId, { maxConcurrency: 2, modelByTask: { task_bbb: "opus" } }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "A to start");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_fm1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "A released");
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_bbb")) ? true : null), "B to start fresh");
    const bStart = calls("worker-start").find((c) => c.argv.includes("task_bbb"))!;
    assert.ok(bStart.argv.includes("--agent"), "B got its own terminal");
    assert.ok(bStart.argv.includes("--model") && bStart.argv.includes("opus"), "the requested model reached the CLI");
    assert.equal(bStart.argv.indexOf("--terminal"), -1, "no reuse when a model is requested");
    assert.equal(callsOf("worker-release", "--dispatch", attempt("task_aaa").dispatchId!).length, 1, "the settled terminal was released");
    const b = attempt("task_bbb");
    assert.equal(b.requested.model, "opus", "requested model recorded");
    assert.equal(b.requested.terminal, null, "the fresh start claims no reused terminal");
    await stopCoordinator();
  });

  it("forces a fresh worker when the follow-up uses a different harness", async () => {
    const runId = "run_fresh_harness";
    await chainState(runId);
    await startCoordinator(baseOpts(runId, { maxConcurrency: 2, harnessByTask: { task_bbb: "codex" } }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "A to start");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_fh1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "A released");
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_bbb")) ? true : null), "B to start fresh");
    const bStart = calls("worker-start").find((c) => c.argv.includes("task_bbb"))!;
    assert.ok(bStart.argv.includes("--agent") && bStart.argv.includes("codex"), "B started on its own agent");
    assert.equal(bStart.argv.indexOf("--terminal"), -1, "a terminal runs ONE agent — never handed across harnesses");
    assert.equal(callsOf("worker-release", "--dispatch", attempt("task_aaa").dispatchId!).length, 1);
    await stopCoordinator();
  });

  it("explicit retain-for-debugging prevents automatic release AND reuse; the follow-up starts fresh", async () => {
    const runId = "run_retain_debug";
    await chainState(runId);
    await startCoordinator(baseOpts(runId, { maxConcurrency: 2, retainByTask: { task_aaa: true } }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "A to start");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_rd1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "retained" ? true : null), "A retained");
    assert.equal(calls("worker-retain").length, 1);
    assert.equal(calls("worker-release").length, 0, "retain prevents release");
    // B still runs — but on a FRESH terminal; the retained one is the user's
    // debugging session and is never handed off.
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_bbb")) ? true : null), "B to start");
    const bStart = calls("worker-start").find((c) => c.argv.includes("task_bbb"))!;
    assert.ok(bStart.argv.includes("--agent"), "B started fresh");
    assert.equal(bStart.argv.indexOf("--terminal"), -1, "the retained terminal is never reused");
    await stopCoordinator();
  });

  it("releases the settled terminal when its reuse start definitely fails (no orphan, no lost worker)", async () => {
    const runId = "run_reuse_fail";
    await chainState(runId);
    await startCoordinator(baseOpts(runId, { maxConcurrency: 2 }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "A to start");
    // The NEXT start (the reuse) fails definitely, with a receipt.
    await mutateState((state) => {
      state.workerStartFail = {
        code: "terminal_start_failed",
        message: "agent terminal failed to become ready",
        receipt: {
          stage: "terminal_start",
          failedStage: "terminal_start",
          setup: "skipped",
          residualResources: null,
          recoveryCommands: [],
        },
      };
    });
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_rf1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "A released after the failed reuse");
    assert.equal(
      callsOf("worker-release", "--dispatch", attempt("task_aaa").dispatchId!).length,
      1,
      "the unconsumed terminal takes the default release",
    );
    await waitFor(() => (findAttempt("task_bbb")?.settledVia === "start_failed" ? true : null), "B parked with its receipt");
    await waitFor(() => (findAttempt("task_bbb")?.terminalDecision === "not_needed" ? true : null), "B's ownership decided");
    assert.equal(attempt("task_bbb").terminalDecision, "not_needed", "the failed start created nothing");
    await stopCoordinator();
  });
});

// --- Phase 5: worker output API + launch-preference API ----------------------

describe("Phase 5: worker output API and launch-preference API", () => {
  it("serves a bounded output page: clamped limit, cursor restart on source_changed, invalid source refused", async () => {
    const { call } = await startApp();
    const runId = "run_out";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    // Wait for the START first — dispatchIdOf's predicate asserts the attempt
    // exists, and the loop needs a tick to reserve it.
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");
    await mutateState((s) => {
      s.archives ??= {};
      s.archives[dispatchId] = "hello output";
    });

    const page = await call("GET", `/api/workers/${dispatchId}/output`);
    assert.equal(page.status, 200);
    const out = page.json.output as {
      source: string;
      lines: string[];
      clipped: boolean;
      sourceChanged: boolean;
      cursor: string | null;
    };
    assert.equal(out.source, "terminal");
    assert.deepEqual(out.lines, ["hello output"]);
    assert.equal(out.clipped, true, "the runtime reported the page as limited → clipped");
    assert.equal(out.sourceChanged, false);
    const read1 = calls("worker-read").at(-1)!;
    assert.equal(read1.argv[read1.argv.indexOf("--limit") + 1], "40", "default limit is 40");

    // limit clamps at both bounds before reaching the CLI
    await call("GET", `/api/workers/${dispatchId}/output?limit=99999`);
    await call("GET", `/api/workers/${dispatchId}/output?limit=0`);
    const limits = calls("worker-read").map((c) => c.argv[c.argv.indexOf("--limit") + 1]);
    assert.ok(limits.includes("200"), "upper clamp is 200");
    assert.ok(limits.includes("1"), "lower clamp is 1");

    // source_changed: the stale-cursor read is refused once, the endpoint
    // restarts fresh and labels the discontinuity.
    await mutateState((s) => {
      s.readCursorFail = { [dispatchId]: true };
    });
    const restarted = await call("GET", `/api/workers/${dispatchId}/output?cursor=cur_stale`);
    assert.equal(restarted.status, 200);
    const out2 = restarted.json.output as typeof out & { warnings: string[] };
    assert.equal(out2.sourceChanged, true, "the discontinuity is labeled");
    assert.ok(out2.warnings.some((w) => w.toLowerCase().includes("changed")), "a warning explains the restart");
    assert.deepEqual(out2.lines, ["hello output"], "the restart read fresh rows");
    const reads = calls("worker-read");
    assert.ok(reads.at(-2)!.argv.includes("--cursor"), "the refused call carried the cursor");
    assert.ok(!reads.at(-1)!.argv.includes("--cursor"), "the restart dropped it");

    const bad = await call("GET", `/api/workers/${dispatchId}/output?source=everywhere`);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, "invalid_source");
    await stopCoordinator();
  });

  it("threads per-task effort through /api/run: --model and --effort reach worker-start, requested prefs recorded", async () => {
    const { call } = await startApp();
    const runId = "run_effort";
    await mutateState((state) => {
      state.tasks = { task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" } };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    const res = await call("POST", "/api/run", {
      runId,
      defaultHarness: "claude",
      modelByTask: { task_aaa: "opus" },
      effortByTask: { task_aaa: "high" },
    });
    assert.equal(res.status, 200);
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const start = calls("worker-start")[0];
    assert.ok(start.argv.includes("--model") && start.argv.includes("opus"));
    assert.ok(start.argv.includes("--effort") && start.argv.includes("high"), "effort rides with the model");
    const a = await waitFor(() => {
      const x = findAttempt("task_aaa");
      return x?.requested.effort === "high" ? x : null;
    }, "requested preferences recorded");
    assert.equal(a.requested.model, "opus");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_eff1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });
});


// --- Phase 6: connected-server placement, remote authority, capabilities -----

/** Two root tasks: one placed locally, one on a saved remote environment. */
function mixedTasks(runId: string): Record<string, any> {
  return {
    task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]", task_title: "Local" },
    task_remote: { id: "task_remote", run_id: runId, status: "pending", deps: "[]", task_title: "Remote" },
  };
}

const REMOTE_ENV_OPTS: Partial<StartOpts> = {
  environmentByTask: { task_remote: "env_remote" },
  placementByTask: { task_remote: { kind: "existing", selector: "id:repoA::/srv/remote-ws" } },
};

describe("Phase 6: mixed local/remote DAG", () => {
  it("starts local and remote workers in one run, routes everything by Dispatch ID, and completes", async () => {
    const runId = "run_mixed";
    await mutateState((state) => {
      state.tasks = mixedTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.environments = [
        {
          id: "env_remote",
          name: "work-laptop",
          connected: true,
          capabilities: ["model.effort", "fleet.snapshot"],
        },
      ];
    });

    await startCoordinator(baseOpts(runId, REMOTE_ENV_OPTS));

    await waitFor(() => (calls("worker-start").length >= 2 ? true : null), "both workers to start");
    const remoteStart = calls("worker-start").find((c) => c.argv.includes("task_remote"))!;
    const localStart = calls("worker-start").find((c) => c.argv.includes("task_aaa"))!;
    // Remote: exact-existing placement + --on, no creation flags.
    assert.ok(remoteStart.argv.includes("--on") && remoteStart.argv.includes("env_remote"));
    assert.ok(
      remoteStart.argv.includes("--worktree") && remoteStart.argv.includes("id:repoA::/srv/remote-ws"),
    );
    assert.ok(
      !remoteStart.argv.includes("--repo") && !remoteStart.argv.includes("--name"),
      "an exact existing workspace carries no creation flags",
    );
    // Local: byte-identical zero-config default, never a --on.
    assert.ok(!localStart.argv.includes("--on"), "the local worker stays on the home server");
    assert.ok(localStart.argv.includes("current"));
    // The peer was inspected before the remote start (capability evidence).
    assert.ok(
      readLog().some((c) => c.argv[0] === "environment" && c.argv[1] === "show"),
      "environment show ran before the remote start",
    );
    // Reconciliation sees remote rows at all.
    assert.ok(calls("worker-list").some((c) => c.argv.includes("--include-remote")));

    await waitFor(() => {
      const r = findAttempt("task_remote");
      return r && r.host?.kind === "environment" ? true : null;
    }, "the remote attempt to adopt its execution host");
    assert.equal(attempt("task_remote").requested.on, "env_remote");
    assert.equal(attempt("task_remote").effective?.on, "env_remote", "the receipt echo names the server");
    assert.equal(attempt("task_aaa").host?.id, "local", "the local attempt reports the local host");

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_a1");
    await settleViaWorkerDone("task_remote", "succeeded", "msg_r1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");
    assert.equal(attempt("task_remote").terminalDecision, "released");
    // Cleanup is addressed by Dispatch ID only — no --on, no terminal handles.
    const release = callsOf("worker-release", "--dispatch", attempt("task_remote").dispatchId!)[0];
    assert.ok(release, "the remote dispatch was released");
    assert.ok(!release.argv.includes("--on"));
    assert.deepEqual(coordinatorStatus().cleanupDebt, []);
  });

  it("places a remote worker with new-top-level: exact repo selector plus explicit name", async () => {
    const runId = "run_newtl";
    await mutateState((state) => {
      state.tasks = {
        task_remote: { id: "task_remote", run_id: runId, status: "pending", deps: "[]" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.environments = [{ id: "env_remote", name: "work-laptop" }];
    });
    await startCoordinator(
      baseOpts(runId, {
        environmentByTask: { task_remote: "env_remote" },
        placementByTask: { task_remote: { kind: "new-top-level", repo: "id:repoA", name: "phase6-wt" } },
      }),
    );
    await waitFor(() => (calls("worker-start").length >= 1 ? true : null), "remote worker to start");
    const start = calls("worker-start").find((c) => c.argv.includes("task_remote"))!;
    assert.ok(start.argv.includes("new-top-level"));
    assert.ok(start.argv.includes("--repo") && start.argv.includes("id:repoA"));
    assert.ok(start.argv.includes("--name") && start.argv.includes("phase6-wt"));
    assert.ok(start.argv.includes("--on") && start.argv.includes("env_remote"));
    await stopCoordinator();
  });
});

describe("Phase 6: refusal gates before Orca", () => {
  it("refuses a remote 'current' placement before any mutation and parks the attempt — no local fallback", async () => {
    const runId = "run_refuse";
    await mutateState((state) => {
      state.tasks = { task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" } };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.environments = [{ id: "env_remote", name: "work-laptop" }];
    });
    await startCoordinator(
      baseOpts(runId, {
        environmentByTask: { task_aaa: "env_remote" }, // no placement → current → refused
      }),
    );
    await waitFor(
      () => (findAttempt("task_aaa")?.settledVia === "start_failed" ? true : null),
      "the attempt to fail closed",
    );
    assert.equal(calls("worker-start").length, 0, "no worker-start was ever attempted");
    assert.equal(calls("dispatch").length, 0, "no tracking dispatch — never a synthetic local fallback");
    const created = readLog().filter((c) => c.argv[0] === "terminal" && c.argv[1] === "create" && !(c.argv.includes("--title") && c.argv.join(" ").includes("orca-dag coordinator")));
    assert.equal(created.length, 0, "no worker terminal was created locally either");
    assert.match(attempt("task_aaa").terminalDetail ?? "", /ambiguous across servers/);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(coordinatorStatus().phase, "awaiting_input", "the failed start parks the run");
    await stopCoordinator();
  });

  it("forwards model/effort remotely only when the peer advertises the capability", async () => {
    const runId = "run_caps";
    await mutateState((state) => {
      state.tasks = {
        task_old: { id: "task_old", run_id: runId, status: "pending", deps: "[]" },
        task_new: { id: "task_new", run_id: runId, status: "pending", deps: "[]" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.environments = [
        // Old peer: no capability field at all — nothing is advertised.
        { id: "env_plain", name: "old peer" },
        // New peer: advertises model/effort forwarding.
        { id: "env_caps", name: "new peer", capabilities: ["model.effort", "fleet.snapshot"] },
      ];
    });
    // BOTH nodes carry valid remote placements (exact-existing selectors) —
    // a remote node with no placement would be `current`, which the adapter
    // refuses BEFORE the capability question even arises.
    await startCoordinator(
      baseOpts(runId, {
        environmentByTask: { task_old: "env_plain", task_new: "env_caps" },
        placementByTask: {
          task_old: { kind: "existing", selector: "id:repoA::/srv/old-ws" },
          task_new: { kind: "existing", selector: "id:repoA::/srv/new-ws" },
        },
        modelByTask: { task_old: "opus", task_new: "opus" },
      }),
    );
    await waitFor(
      () => (findAttempt("task_old")?.settledVia === "start_failed" ? true : null),
      "the unproven-capability start to fail closed",
    );
    assert.match(attempt("task_old").terminalDetail ?? "", /model\/effort capability/);
    assert.equal(
      calls("worker-start").filter((c) => c.argv.includes("task_old")).length,
      0,
      "no start was attempted against the peer that does not advertise",
    );
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_new")) ? true : null), "the advertising peer's worker to start");
    const newStart = calls("worker-start").find((c) => c.argv.includes("task_new"))!;
    assert.ok(newStart.argv.includes("--model") && newStart.argv.includes("opus"));
    assert.ok(newStart.argv.includes("--on") && newStart.argv.includes("env_caps"));
    assert.equal(attempt("task_new").requested.model, "opus");
    assert.equal(attempt("task_new").requested.on, "env_caps");
    await stopCoordinator();
  });
});

describe("Phase 6: remote authority across disconnect/reconnect", () => {
  it("keeps a disconnected remote Dispatch unverifiable with zero destructive calls, then the same Dispatch settles on reconnect", async () => {
    const runId = "run_drop";
    await mutateState((state) => {
      state.tasks = mixedTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.environments = [
        { id: "env_remote", name: "work-laptop", capabilities: ["fleet.snapshot"] },
      ];
    });

    await startCoordinator(baseOpts(runId, REMOTE_ENV_OPTS));
    await waitFor(() => (calls("worker-start").length >= 2 ? true : null), "both workers to start");
    await waitFor(
      () => (attempt("task_remote").liveness === "live" && attempt("task_remote").host?.kind === "environment" ? true : null),
      "the remote worker to report live",
    );
    const rDispatch = await dispatchIdOf("task_remote");

    // The execution host stops reporting: its row vanishes from worker-list.
    await mutateState((s) => {
      s.offlineDispatch = s.dispatches[rDispatch];
      delete s.dispatches[rDispatch];
    });
    await waitFor(() => (attempt("task_remote").liveness === "unverifiable" ? true : null), "remote liveness to read unverifiable");
    assert.match(attempt("task_remote").livenessReason ?? "", /not reported/);
    assert.equal(attempt("task_remote").nextAction, null, "absence earns no prescribed action");
    assert.equal(attempt("task_remote").settled, false);
    assert.equal(attempt("task_remote").terminalDecision, "pending");
    assert.equal(callsOf("worker-stop", "--dispatch", rDispatch).length, 0);
    assert.equal(callsOf("worker-release", "--dispatch", rDispatch).length, 0);
    assert.equal(calls("worker-abandon").length, 0);
    await new Promise((r) => setTimeout(r, 150));
    assert.notEqual(coordinatorStatus().phase, "completed");

    // Reconnect: the host reports the SAME dispatch again — liveness is
    // restored from the fleet, and the original Dispatch settles.
    await mutateState((s) => {
      s.dispatches[rDispatch] = s.offlineDispatch;
    });
    await waitFor(() => (attempt("task_remote").liveness === "live" ? true : null), "reconnect to restore liveness");
    await settleViaWorkerDone("task_remote", "succeeded", "msg_r1");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_a1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");
    assert.equal(attempt("task_remote").dispatchId, rDispatch, "the ORIGINAL Dispatch settled");
    assert.equal(attempt("task_remote").terminalDecision, "released");
    assert.equal(callsOf("worker-release", "--dispatch", rDispatch).length, 1);
  });
});

describe("Phase 6: reuse never crosses placement", () => {
  it("does not hand a settled local terminal to a remote follow-up — fresh worker with its own placement", async () => {
    const runId = "run_noreuse_r";
    await mutateState((state) => {
      state.tasks = mixedTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.environments = [{ id: "env_remote", name: "work-laptop" }];
    });
    // Concurrency 1: the local worker settles while the remote task is the
    // only ready candidate — exactly the case old reuse logic would consume.
    await startCoordinator(baseOpts(runId, { ...REMOTE_ENV_OPTS, maxConcurrency: 1 }));
    await waitFor(() => (calls("worker-start").length >= 1 ? true : null), "local worker to start");
    await settleViaTaskStatus("task_aaa", "succeeded");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "local worker to release");
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_remote")) ? true : null), "remote follow-up to start");
    const remoteStart = calls("worker-start").find((c) => c.argv.includes("task_remote"))!;
    assert.ok(remoteStart.argv.includes("--agent"), "a fresh agent terminal is launched");
    assert.ok(!remoteStart.argv.includes("--terminal"), "the settled terminal is never inherited across placement");
    assert.ok(remoteStart.argv.includes("--on") && remoteStart.argv.includes("env_remote"));
    await settleViaWorkerDone("task_remote", "succeeded", "msg_r1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");
  });

  it("does not hand a settled REMOTE terminal to a local follow-up — the remote worker takes the default release", async () => {
    const runId = "run_noreuse_l";
    await mutateState((state) => {
      // task_remote is inserted FIRST so it is the one that starts under
      // concurrency 1 (listTasks preserves insertion order) — task_aaa stays
      // `ready` as the follow-up candidate at the ownership decision.
      state.tasks = {
        task_remote: { id: "task_remote", run_id: runId, status: "pending", deps: "[]" },
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.environments = [{ id: "env_remote", name: "work-laptop" }];
    });
    await startCoordinator(baseOpts(runId, { ...REMOTE_ENV_OPTS, maxConcurrency: 1 }));
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_remote")) ? true : null), "remote worker to start first");
    await settleViaTaskStatus("task_remote", "succeeded");
    await waitFor(() => (attempt("task_remote").terminalDecision === "released" ? true : null), "remote worker released (never reused)");
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_aaa")) ? true : null), "local follow-up to start fresh");
    const localStart = calls("worker-start").find((c) => c.argv.includes("task_aaa"))!;
    assert.ok(localStart.argv.includes("--agent") && !localStart.argv.includes("--terminal"));
    assert.ok(!localStart.argv.includes("--on"));
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_a1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");
  });
});

// --- Phase 6: environment/placement discovery + config API -------------------

describe("Phase 6: environment discovery API", () => {
  it("lists saved environments with parsed peer capabilities, and scopes discovery with --environment", async () => {
    await mutateState((state) => {
      state.environments = [
        { id: "env_a", name: "work-laptop", connected: true, capabilities: ["model.effort", "fleet.snapshot"] },
        { id: "env_b", name: "old box" },
      ];
      state.repos = [
        { id: "repoA", path: "/srv/repo", displayName: "repo-a", kind: "git", executionHostId: "ssh:h1" },
      ];
      state.worktrees = [
        {
          id: "repoA::/srv/remote-ws",
          repoId: "repoA",
          path: "/srv/remote-ws",
          displayName: "remote-ws",
          branch: "refs/heads/main",
          hostId: "ssh:h1",
          parentWorktreeId: null,
          isMainWorktree: true,
        },
      ];
      state.projects = [{ id: "proj1", displayName: "Project", kind: "git", sourceRepoIds: ["repoA"] }];
    });
    const { call } = await startApp();
    const { status, json } = await call("GET", "/api/environments");
    assert.equal(status, 200);
    const envs = json.environments as Array<Record<string, unknown>>;
    assert.equal(envs.length, 2);
    assert.equal(envs[0].id, "env_a");
    assert.deepEqual((envs[0].peer as Record<string, unknown>), {
      modelEffort: true,
      transcriptRead: false,
      fleetSnapshot: true,
      raw: ["model.effort", "fleet.snapshot"],
    });
    assert.equal((envs[1].peer as Record<string, unknown>).modelEffort, false, "nothing advertised → gates off");

    const wt = await call("GET", "/api/environments/env_a/worktrees");
    assert.equal(wt.status, 200);
    assert.equal((wt.json.worktrees as unknown[]).length, 1);
    assert.equal(
      readLog().some((c) => c.argv[0] === "worktree" && c.argv.includes("--environment") && c.argv.includes("env_a")),
      true,
      "worktree discovery names the environment",
    );
    const repos = await call("GET", "/api/environments/env_a/repos");
    assert.equal((repos.json.repos as unknown[]).length, 1);
    const projects = await call("GET", "/api/environments/env_a/projects");
    assert.equal((projects.json.projects as unknown[]).length, 1);
    // A malformed selector never reaches the CLI.
    const bad = await call("GET", "/api/environments/bad%20env/worktrees");
    assert.equal(bad.status, 400);
  });
});
