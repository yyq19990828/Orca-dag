import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp, listenLoopback } from "./app";
import { createSecurityPolicy, type SecurityPolicy } from "./security";
import { buildRunHealth, evaluateRunOwnership } from "./runHealth";
import { initOrcaRuntime, type Gate, type OrcaMessage, type OrcaTask, type OrcaWorkerRow } from "./orca";
import { coordinatorStatus, resetCoordinatorForTests, startCoordinator, stopCoordinator } from "./coordinator";

/**
 * Phase 1 (operations epic) acceptance: Run ownership + health.
 *
 * Two layers, mirroring how the feature is built:
 *  - PURE: `evaluateRunOwnership` / `buildRunHealth` classify every ownership
 *    state and warning from plain evidence objects — no CLI, fully deterministic.
 *  - HTTP: `/api/run-health` is exercised over loopback against a fake `orca`
 *    binary that scripts run-show / task-list / gate-list / inbox / worker-list
 *    receipts, proving the route gathers Run-scoped evidence and never
 *    mislabels a failed read as empty.
 */

// --- fake orca fixture (same pattern as orca.test.ts, read commands only) ----

let root: string;
let fixturePath: string;
let scriptPath: string;
let wsDir: string;

interface FakeConf {
  version?: string;
  statusResult?: Record<string, unknown>;
  runsById?: Record<string, unknown>;
  tasksByRun?: Record<string, unknown[]>;
  gatesByRun?: Record<string, unknown[]>;
  inboxMessages?: unknown[];
  workersByRun?: Record<string, unknown[]>;
  /** Simulate a failed read per command pair, e.g. { "worker-list": true }. */
  fail?: Record<string, boolean>;
}

function writeScript(conf: FakeConf): void {
  writeFileSync(scriptPath, JSON.stringify(conf));
}

function writeFakeOrca(): void {
  const src = `#!/usr/bin/env node
// Minimal Orca CLI double for runHealth.test.ts — records argv, plays a script.
import { appendFileSync, readFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_ORCA_LOG) {
  appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify({ argv: args }) + "\\n");
}
let conf = {};
const f = process.env.FAKE_ORCA_SCRIPT;
if (f && existsSync(f)) { try { conf = JSON.parse(readFileSync(f, "utf8")); } catch {} }
if (args[0] === "--version") {
  process.stdout.write((conf.version ?? "1.4.205") + "\\n");
  process.exit(0);
}
const fail = (conf.fail ?? {})[args[0] + (args[1] ? "." + args[1] : "")];
if (fail) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: "read_failed", message: "scripted failure" } }));
  process.exit(1);
}
const out = { ok: true, result: {} };
if (args[0] === "status") out.result = conf.statusResult ?? { runtime: {} };
if (args[0] === "orchestration" && args[1] === "run-show") {
  const id = args[args.indexOf("--id") + 1];
  const run = (conf.runsById ?? {})[id];
  if (run === undefined) {
    out.ok = false;
    out.error = { code: "run_not_found", message: "Unknown run: " + id };
  } else {
    out.result = { run };
  }
}
if (args[0] === "orchestration" && args[1] === "task-list") {
  const runAt = args.indexOf("--run");
  out.result = { tasks: (conf.tasksByRun ?? {})[args[runAt + 1]] ?? [] };
}
if (args[0] === "orchestration" && args[1] === "gate-list") {
  const runAt = args.indexOf("--run");
  out.result = { gates: (conf.gatesByRun ?? {})[args[runAt + 1]] ?? [] };
}
if (args[0] === "orchestration" && args[1] === "inbox") {
  const limitAt = args.indexOf("--limit");
  const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : 100;
  const messages = conf.inboxMessages ?? [];
  out.result = { messages: messages.slice(0, limit), count: Math.min(messages.length, limit) };
}
if (args[0] === "orchestration" && args[1] === "worker-list") {
  const runAt = args.indexOf("--run");
  out.result = {
    workers: (conf.workersByRun ?? {})[args[runAt + 1]] ?? [],
    page: { hasMore: false, nextCursor: null },
  };
}
// Coordinator-loop receipts (the viewer-owned HTTP case runs the real loop).
if (args[0] === "terminal" && args[1] === "list") out.result = { terminals: conf.terminals ?? [] };
if (args[0] === "terminal" && args[1] === "create") out.result = { terminal: { handle: conf.newHandle ?? "term_health_loop" } };
if (args[0] === "terminal" && args[1] === "close") out.result = {};
if (args[0] === "orchestration" && args[1] === "run-use") {
  const id = args[args.indexOf("--id") + 1];
  out.result = { run: (conf.runsById ?? {})[id] ?? { id, coordinator_handle: null, consumer_generation: 0 } };
}
if (args[0] === "orchestration" && args[1] === "check") {
  const runAt = args.indexOf("--terminal");
  out.result = {
    runId: runAt >= 0 ? args[runAt + 1] : null,
    deliveryId: null,
    messages: [],
    count: 0,
    replayed: false,
    acknowledged: null,
    timedOut: true,
    cancelled: false,
    connectionLost: false,
  };
}
process.stdout.write(JSON.stringify(out));
`;
  writeFileSync(fixturePath, src);
  chmodSync(fixturePath, 0o755);
}

const policy: SecurityPolicy = createSecurityPolicy({});
let server: Server;
let base: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "orca-dag-runhealth-test-"));
  fixturePath = join(root, "fake-orca.mjs");
  scriptPath = join(root, "fake-orca.json");
  wsDir = realpathSync(mkdtempSync(join(tmpdir(), "orca-dag-runhealth-ws-")));
  writeFakeOrca();
  writeScript({});
  process.env.FAKE_ORCA_LOG = join(root, "calls.log");
  process.env.FAKE_ORCA_SCRIPT = scriptPath;
  initOrcaRuntime({
    env: { ORCA_CLI_COMMAND: fixturePath, WORKSPACE_DIR: wsDir },
    cwd: root,
  });
  const { app } = createApp({ workspaceDir: wsDir, worktree: "active", policy, embeddedAssets: null });
  server = await listenLoopback(app, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  // If the live-loop test failed mid-way, don't leave the loop spinning.
  try {
    if (coordinatorStatus().running) await stopCoordinator();
  } catch {
    /* best effort */
  }
  resetCoordinatorForTests();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  rmSync(wsDir, { recursive: true, force: true });
});

async function getHealth(runId: string): Promise<{ status: number; health: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/run-health?run=${encodeURIComponent(runId)}`);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, health: (json.health ?? {}) as Record<string, unknown> };
}

/** A task row that provably belongs to this test workspace. */
function localTask(over: Partial<OrcaTask> = {}): OrcaTask {
  return {
    id: "task_local1",
    parent_id: null,
    created_by_terminal_handle: null,
    created_by_process_incarnation: `repo::${wsDir}@@incarnation-1`,
    spec: "do the thing",
    status: "pending",
    deps: "[]",
    result: null,
    created_at: new Date().toISOString(),
    completed_at: null,
    task_title: null,
    display_name: null,
    run_id: "run_h",
    ...over,
  };
}

/** A minimal OrcaMessage-shaped row (only fields the health code reads). */
function msg(over: Partial<OrcaMessage> = {}): OrcaMessage {
  return {
    id: "msg_x",
    run_id: "run_h",
    delivery_contract: null,
    from_handle: "term_user",
    to_handle: null,
    subject: "status",
    body: "",
    type: "status",
    priority: "normal",
    thread_id: null,
    payload: null,
    created_at: new Date().toISOString(),
    delivered_at: null,
    ...over,
  };
}

/** A minimal Gate-shaped row (only fields the health code reads). */
function pendingGate(): Gate {
  return { id: "gate_1", taskId: null, question: "Ship it?", options: ["approved", "rejected"], status: "pending", resolution: null, raw: {} };
}

function workerRow(over: Partial<OrcaWorkerRow> = {}): OrcaWorkerRow {
  return {
    dispatchId: "ctx_w1",
    taskId: "task_local1",
    runId: "run_h",
    workerState: "supervised",
    dispatchStatus: "dispatched",
    agentTerminalHandle: "term_w",
    terminalState: "active",
    projection: null,
    ...over,
  };
}

// --- pure ownership classification -------------------------------------------

describe("evaluateRunOwnership (pure)", () => {
  const idle = { running: false, runId: null, coordinatorHandle: null };

  it("viewer_coordinator: the live loop's handle is bound to this Run", () => {
    const view = evaluateRunOwnership(
      { id: "run_a", coordinator_handle: "term_mine", consumer_generation: 2 },
      { running: true, runId: "run_a", coordinatorHandle: "term_mine" },
    );
    assert.equal(view.state, "viewer_coordinator");
  });

  it("viewer_coordinator_other_run: our handle is bound here but the loop serves another Run", () => {
    const view = evaluateRunOwnership(
      { id: "run_a", coordinator_handle: "term_mine", consumer_generation: 2 },
      { running: true, runId: "run_b", coordinatorHandle: "term_mine" },
    );
    assert.equal(view.state, "viewer_coordinator_other_run");
  });

  it("external_coordinator: some other terminal is bound", () => {
    const view = evaluateRunOwnership(
      { id: "run_a", coordinator_handle: "term_user", consumer_generation: 5 },
      idle,
    );
    assert.equal(view.state, "external_coordinator");
    assert.match(view.detail, /term_user/);
    // the plan's hard rule: a handle missing from a local terminal list is NOT
    // evidence of staleness — the wording must not claim the coordinator is dead
    assert.doesNotMatch(view.detail, /stale|dead|exited/i);
  });

  it("names a native chat coordinator as a chat", () => {
    const view = evaluateRunOwnership(
      { id: "run_chat", coordinator_handle: "orca_session_id:chat_123", consumer_generation: 6 },
      idle,
    );
    assert.equal(view.state, "external_coordinator");
    assert.match(view.detail, /Native chat orca_session_id:chat_123/);
    assert.doesNotMatch(view.detail, /Terminal/);
  });

  it("external_coordinator notes when the viewer's coordinator is bound elsewhere", () => {
    const view = evaluateRunOwnership(
      { id: "run_a", coordinator_handle: "term_user", consumer_generation: 5 },
      { running: true, runId: "run_other", coordinatorHandle: "term_mine" },
    );
    assert.equal(view.state, "external_coordinator");
    assert.match(view.detail, /another Run/);
  });

  it("unbound: the Run record names no coordinator", () => {
    const view = evaluateRunOwnership({ id: "run_a", coordinator_handle: null, consumer_generation: 0 }, idle);
    assert.equal(view.state, "unbound");
  });

  it("unbound also wins over whitespace-only handles (never renders a fake handle)", () => {
    const view = evaluateRunOwnership({ id: "run_a", coordinator_handle: "   ", consumer_generation: 0 }, idle);
    assert.equal(view.state, "unbound");
  });

  it("unverifiable: the Run record could not be read", () => {
    const view = evaluateRunOwnership(null, idle);
    assert.equal(view.state, "unverifiable");
    assert.equal(evaluateRunOwnership(null, { running: true, runId: "run_x", coordinatorHandle: "t" }).state, "unverifiable");
  });
});

// --- pure health projection ---------------------------------------------------

describe("buildRunHealth (pure)", () => {
  const idle = { running: false, runId: null, coordinatorHandle: null };
  const ok = { tasks: [], taskError: null, gates: [], gateError: null, messages: [], messageError: null, workers: [], workerError: null };

  it("messages-without-tasks warns and explains the empty graph", () => {
    const view = buildRunHealth({
      runId: "run_h",
      run: { id: "run_h", coordinator_handle: null, consumer_generation: 0 },
      viewer: idle,
      evidence: { ...ok, messages: [msg()] },
      workspaceDir: wsDir,
    });
    const warning = view.warnings.find((w) => w.code === "messages_without_tasks");
    assert.ok(warning, "expected a messages_without_tasks warning");
    assert.match(warning.message, /1 message/);
    assert.equal(warning.severity, "info");
    assert.equal(view.counts.tasks, 0);
    assert.equal(view.counts.messages, 1);
    assert.equal(view.evidenceComplete, true);
  });

  it("dispatched-task-without-worker fires only when the worker read succeeded", () => {
    const base = {
      runId: "run_h",
      run: { id: "run_h", coordinator_handle: null, consumer_generation: 0 },
      viewer: idle,
      workspaceDir: wsDir,
    };
    const withWorkers = buildRunHealth({
      ...base,
      evidence: { ...ok, tasks: [localTask({ id: "task_d1", status: "dispatched", dispatch_id: "ctx_d1" })] },
    });
    assert.ok(withWorkers.warnings.some((w) => w.code === "dispatched_task_without_worker"));

    // same tasks but the worker read failed → unknown, never asserted
    const withoutWorkers = buildRunHealth({
      ...base,
      evidence: {
        ...ok,
        tasks: [localTask({ id: "task_d1", status: "dispatched", dispatch_id: "ctx_d1" })],
        workers: null,
        workerError: "worker-list failed",
      },
    });
    assert.equal(withoutWorkers.warnings.some((w) => w.code === "dispatched_task_without_worker"), false);
    assert.ok(withoutWorkers.warnings.some((w) => w.code === "evidence_incomplete"));
    assert.equal(withoutWorkers.counts.workers, null);
    assert.equal(withoutWorkers.evidenceComplete, false);
  });

  it("reclaimable workers and pending gates each warn with counts", () => {
    const view = buildRunHealth({
      runId: "run_h",
      run: { id: "run_h", coordinator_handle: null, consumer_generation: 0 },
      viewer: idle,
      workspaceDir: wsDir,
      evidence: {
        ...ok,
        workers: [workerRow({ terminalState: "reclaimable" })],
        gates: [pendingGate()],
      },
    });
    assert.ok(view.warnings.some((w) => w.code === "reclaimable_workers" && /1 worker terminal/.test(w.message)));
    assert.ok(view.warnings.some((w) => w.code === "pending_gates" && /1 decision gate/.test(w.message)));
    assert.equal(view.counts.pendingGates, 1);
  });

  it("flags tasks created from a different workspace, and stays quiet for local ones", () => {
    const base = {
      runId: "run_h",
      run: { id: "run_h", coordinator_handle: null, consumer_generation: 0 },
      viewer: idle,
      workspaceDir: wsDir,
      evidence: ok,
    };
    const foreign = buildRunHealth({
      ...base,
      evidence: { ...ok, tasks: [localTask({ created_by_process_incarnation: "repo::/somewhere/else@@inc" })] },
    });
    assert.ok(foreign.warnings.some((w) => w.code === "foreign_workspace"));
    const local = buildRunHealth({
      ...base,
      evidence: { ...ok, tasks: [localTask()] },
    });
    assert.equal(local.warnings.some((w) => w.code === "foreign_workspace"), false);
  });

  it("a verified viewer-owned Run carries no warnings with clean evidence", () => {
    const view = buildRunHealth({
      runId: "run_h",
      run: { id: "run_h", coordinator_handle: "term_mine", consumer_generation: 3 },
      viewer: { running: true, runId: "run_h", coordinatorHandle: "term_mine" },
      evidence: { ...ok, tasks: [localTask()], workers: [workerRow()] },
      workspaceDir: wsDir,
    });
    assert.equal(view.ownership, "viewer_coordinator");
    assert.deepEqual(view.warnings, []);
    assert.deepEqual(view.counts, { tasks: 1, messages: 0, workers: 1, gates: 0, pendingGates: 0 });
    assert.equal(view.consumerGeneration, 3);
  });
});

// --- HTTP surface (fake orca) ---------------------------------------------------

describe("GET /api/run-health", () => {
  it("requires a run scope before touching Orca", async () => {
    const missing = await fetch(`${base}/api/run-health`);
    assert.equal(missing.status, 400);
    const json = (await missing.json()) as Record<string, unknown>;
    assert.equal(json.code, "run_required");
  });

  it("reports an external coordinator from the run-show binding", async () => {
    writeScript({
      runsById: { run_ext: { id: "run_ext", coordinator_handle: "term_user", consumer_generation: 7 } },
      tasksByRun: { run_ext: [localTask()] },
    });
    const { status, health } = await getHealth("run_ext");
    assert.equal(status, 200);
    assert.equal(health.ownership, "external_coordinator");
    assert.equal(health.coordinatorHandle, "term_user");
    assert.equal(health.consumerGeneration, 7);
    assert.equal((health.counts as Record<string, unknown>).tasks, 1);
  });

  it("reports an unbound Run", async () => {
    writeScript({ runsById: { run_free: { id: "run_free", coordinator_handle: null, consumer_generation: 0 } } });
    const { health } = await getHealth("run_free");
    assert.equal(health.ownership, "unbound");
    assert.equal(health.coordinatorHandle, null);
  });

  it("degrades to unverifiable when the Run record cannot be read", async () => {
    writeScript({}); // no runsById → run_not_found
    const { health } = await getHealth("run_missing");
    assert.equal(health.ownership, "unverifiable");
    // evidence still renders: the reads themselves succeeded
    assert.equal((health.counts as Record<string, unknown>).tasks, 0);
  });

  it("explains an empty-with-history Run instead of looking like a rendering bug", async () => {
    writeScript({
      runsById: { run_empty: { id: "run_empty", coordinator_handle: "term_user", consumer_generation: 1 } },
      tasksByRun: { run_empty: [] },
      inboxMessages: [
        { id: "msg_a", run_id: "run_empty", subject: "kicked off", type: "status", from_handle: "term_user" },
        { id: "msg_b", run_id: "run_empty", subject: "later", type: "status", from_handle: "term_user" },
      ],
    });
    const { health } = await getHealth("run_empty");
    assert.equal(health.ownership, "external_coordinator");
    const warnings = health.warnings as Array<{ code: string; message: string }>;
    const empty = warnings.find((w) => w.code === "messages_without_tasks");
    assert.ok(empty, "expected messages_without_tasks");
    assert.match(empty.message, /2 messages? but no tasks/);
    assert.equal((health.counts as Record<string, unknown>).messages, 2);
  });

  it("marks failed reads as unknown evidence, never as empty", async () => {
    writeScript({
      runsById: { run_fail: { id: "run_fail", coordinator_handle: null, consumer_generation: 0 } },
      fail: { "orchestration.worker-list": true },
    });
    const { health } = await getHealth("run_fail");
    assert.equal(health.evidenceComplete, false);
    assert.equal((health.counts as Record<string, unknown>).workers, null);
    const warnings = health.warnings as Array<{ code: string; message: string }>;
    assert.ok(warnings.some((w) => w.code === "evidence_incomplete" && /workers/.test(w.message)));
  });

  it("answers malformed run ids with invalid_input", async () => {
    const res = await fetch(`${base}/api/run-health?run=../escape`);
    assert.equal(res.status, 400);
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(json.code, "invalid_input");
  });
});

// --- viewer-owned Run health: the real coordinator loop against the fake -----

describe("GET /api/run-health with the live viewer coordinator", () => {
  it("reports viewer_coordinator when the loop's handle is the bound one", async () => {
    // No ready tasks: the loop idles (check + reconcile only).
    writeScript({
      tasksByRun: { run_own: [] },
      runsById: {
        // The fake hands the loop the handle "term_health_loop"; the Run record
        // reports that same handle as bound — the ownership match the UI shows
        // as "Viewer-owned".
        run_own: { id: "run_own", coordinator_handle: "term_health_loop", consumer_generation: 4 },
      },
    });
    await startCoordinator({
      runId: "run_own",
      harnessByTask: {},
      modelByTask: {},
      defaultHarness: "claude",
      maxConcurrency: 2,
      worktree: "active",
      tickWaitMs: 10,
    });
    try {
      const status = coordinatorStatus();
      assert.equal(status.running, true, "loop must be up before the health read");
      assert.equal(status.coordinatorHandle, "term_health_loop");
      // The health cache is 1.5s and the first projection may have been built
      // before the loop bound; poll briefly until the fresh one reports owned.
      let owned = false;
      for (let i = 0; i < 40 && !owned; i++) {
        const { health } = await getHealth("run_own");
        owned = health.ownership === "viewer_coordinator";
        if (!owned) await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(owned, true, "expected ownership viewer_coordinator while the loop is live");
      // Stop the loop: the same Run now reads as externally bound by the
      // (already-closed) handle — never as viewer-owned from leftover state.
      await stopCoordinator();
      writeScript({
        tasksByRun: { run_own: [] },
        runsById: {
          run_own: { id: "run_own", coordinator_handle: "term_health_loop", consumer_generation: 5 },
        },
      });
      // The projection cache holds up to 1.5s of the pre-stop verdict; poll
      // past one cache window until the fresh evidence reclassifies the Run.
      let external = false;
      for (let i = 0; i < 40 && !external; i++) {
        const after = await getHealth("run_own");
        external = after.health.ownership === "external_coordinator";
        if (!external) await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(external, true, "expected external_coordinator once the loop is stopped");
    } finally {
      if (coordinatorStatus().running) await stopCoordinator();
    }
  });
});

// --- capability projection endpoint (read-only, Phase 1) -----------------------

describe("GET /api/capabilities", () => {
  it("projects the local status advertisement without treating unrelated capabilities as unknown orchestration ids", async () => {
    const ids = [
      "orchestration.worker-launch-preferences.v1",
      "orchestration.federation-structured-read.v1",
      "orchestration.federation-fleet-snapshot.v1",
      "orchestration.federation-control-mail.v1",
      "orchestration.federation-lifecycle-settlement.v1",
      "orchestration.federation-release-archive.v1",
      "orchestration.worker-stop-verdict.v1",
    ];
    const advertised = [...ids, "orchestration.contract.v1", "orchestration.future.v1", "browser.screencast.v1"];
    writeScript({ version: "1.4.209", statusResult: { runtime: { capabilities: advertised } } });
    const res = await fetch(`${base}/api/capabilities`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      runtime: Record<string, unknown>;
      advertised: string[] | null;
      advertisedSource: string;
      capabilities: Array<{ id: string; supported: boolean; state: string }>;
      unknownAdvertised: string[];
    };
    assert.deepEqual(json.advertised, advertised);
    assert.equal(json.advertisedSource, "local-runtime-status");
    assert.deepEqual(json.capabilities.map((c) => c.id), ids);
    for (const cap of json.capabilities) {
      assert.equal(cap.supported, true, `${cap.id} was advertised by status`);
      assert.equal(cap.state, "supported");
    }
    assert.deepEqual(json.unknownAdvertised, ["orchestration.future.v1"]);
    assert.equal(json.runtime.version, "1.4.209");
    assert.equal(json.runtime.executionEnabled, true);
  });

  it("keeps every row absent when status omits the capability field, regardless of version", async () => {
    writeScript({ version: "1.4.209", statusResult: { runtime: {} } });
    const res = await fetch(`${base}/api/capabilities`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      advertised: string[] | null;
      capabilities: Array<{ supported: boolean; state: string }>;
    };
    assert.equal(json.advertised, null);
    for (const cap of json.capabilities) {
      assert.equal(cap.supported, false);
      assert.equal(cap.state, "absent");
    }
  });

  it("distinguishes an explicit empty advertisement from a missing field", async () => {
    writeScript({ statusResult: { runtime: { capabilities: [] } } });
    const res = await fetch(`${base}/api/capabilities`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      advertised: string[] | null;
      capabilities: Array<{ supported: boolean }>;
    };
    assert.deepEqual(json.advertised, []);
    assert.ok(json.capabilities.every((cap) => !cap.supported));
  });
});
