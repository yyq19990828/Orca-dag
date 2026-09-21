import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import {
  explainReadiness,
  initOrcaRuntime,
  tasksToDag,
  type Gate,
  type OrcaTask,
  type SchedulerOccupancy,
} from "./orca";
import { createApp, listenLoopback } from "./app";
import { createSecurityPolicy, type SecurityPolicy } from "./security";

/**
 * Phase 4 acceptance coverage (operations epic O5): DAG hierarchy vs
 * dependencies, the ready wave, and evidence-backed readiness reasons.
 *
 * The projection suites are pure — no CLI, no HTTP — so the hierarchy/dependency
 * distinction and every block-reason class is asserted directly on the same
 * functions the /api/dag route composes. One HTTP case then proves the route
 * actually passes hierarchy/readyWave/readiness through, against a minimal
 * fake `orca` that answers task-list and gate-list from an inline script.
 */

/** A full OrcaTask row with test-friendly overrides. */
function task(overrides: Partial<OrcaTask> & { id: string }): OrcaTask {
  return {
    parent_id: null,
    created_by_terminal_handle: null,
    spec: `spec for ${overrides.id}`,
    status: "pending",
    deps: "[]",
    result: null,
    created_at: "2026-09-20T00:00:00Z",
    completed_at: null,
    task_title: overrides.id,
    display_name: null,
    run_id: "run_test",
    ...overrides,
  };
}

function gate(overrides: Partial<Gate> & { id: string }): Gate {
  return {
    taskId: null,
    question: "",
    options: ["approved", "rejected"],
    status: "pending",
    resolution: null,
    raw: {},
    ...overrides,
  };
}

describe("DAG projection: hierarchy is distinct from dependencies", () => {
  it("keeps a parent relation out of the dependency edges (parent ≠ dependency)", () => {
    // A parents both B and C; only B depends on A. C must NOT gain an edge
    // from its parent — ownership is not a scheduling constraint.
    const tasks = [
      task({ id: "task_a", status: "completed" }),
      task({ id: "task_b", parent_id: "task_a", deps: '["task_a"]', status: "ready" }),
      task({ id: "task_c", parent_id: "task_a", status: "pending" }),
    ];
    const { edges, hierarchy } = tasksToDag(tasks);
    assert.deepEqual(
      edges.map((e) => [e.source, e.target]),
      [["task_a", "task_b"]],
      "exactly one dependency edge: A→B",
    );
    assert.deepEqual(
      hierarchy.map((l) => [l.parent, l.child]).sort(),
      [
        ["task_a", "task_b"],
        ["task_a", "task_c"],
      ],
      "both ownership links present, in a separate structure",
    );
  });

  it("keeps a dependency out of the hierarchy links (dependency ≠ parent)", () => {
    const tasks = [
      task({ id: "task_a", status: "completed" }),
      task({ id: "task_b", deps: '["task_a"]', status: "ready" }),
    ];
    const { nodes, edges, hierarchy } = tasksToDag(tasks);
    assert.equal(edges.length, 1, "the dependency edge exists");
    assert.equal(hierarchy.length, 0, "no parent relation was invented");
    assert.equal(nodes.find((n) => n.id === "task_b")?.parentId, null);
  });

  it("preserves parent_id on the node, dropping only unrenderable dangling links", () => {
    const tasks = [
      task({ id: "task_a" }),
      task({ id: "task_orphan", parent_id: "task_gone" }),
    ];
    const { nodes, hierarchy } = tasksToDag(tasks);
    assert.equal(nodes.find((n) => n.id === "task_orphan")?.parentId, "task_gone");
    assert.equal(hierarchy.length, 0, "a parent outside this Run produces no link");
  });

  it("never lets a hierarchy link id collide with a dependency edge id", () => {
    const tasks = [
      task({ id: "task_a", status: "completed" }),
      task({ id: "task_b", parent_id: "task_a", deps: '["task_a"]' }),
    ];
    const { edges, hierarchy } = tasksToDag(tasks);
    const edgeIds = new Set(edges.map((e) => e.id));
    for (const link of hierarchy) assert.equal(edgeIds.has(link.id), false);
    assert.match(hierarchy[0].id, /__hier__/);
  });
});

describe("ready wave", () => {
  it("lists exactly the ready tasks, ordered by id — never a scheduling order", () => {
    const tasks = [
      task({ id: "task_z", status: "ready" }),
      task({ id: "task_a", status: "ready" }),
      task({ id: "task_m", status: "pending", deps: '["task_z"]' }),
      task({ id: "task_done", status: "completed" }),
    ];
    const { readyWave } = explainReadiness(tasks, [], null);
    // Input order deliberately reversed relative to ids: the projection sorts
    // for deterministic rendering only — equally ready tasks are equal.
    assert.deepEqual(readyWave.taskIds, ["task_a", "task_z"]);
    assert.equal(readyWave.freeSlots, null, "no viewer coordinator → capacity unknown, never zero");
  });
});

describe("readiness reasons", () => {
  it("explains a pending task held back by an unmet dependency", () => {
    const tasks = [
      task({ id: "task_a", status: "dispatched", dispatch_id: "ctx_a" }),
      task({ id: "task_b", deps: '["task_a"]', status: "pending" }),
    ];
    const { readiness } = explainReadiness(tasks, [], null);
    const b = readiness.task_b;
    assert.equal(b.runnable, false);
    assert.deepEqual(b.codes, ["unmet_dependencies"]);
    assert.deepEqual(b.unmetDependencyIds, ["task_a"]);
    assert.match(b.reasons[0], /task_a \(dispatched\)/);
  });

  it("treats a completed dependency as met and counts a failed one as unmet", () => {
    const tasks = [
      task({ id: "task_done", status: "completed" }),
      task({ id: "task_bad", status: "failed" }),
      task({ id: "task_b", deps: '["task_done"]', status: "ready" }),
      task({ id: "task_c", deps: '["task_bad"]', status: "pending" }),
    ];
    const { readyWave, readiness } = explainReadiness(tasks, [], null);
    assert.deepEqual(readyWave.taskIds, ["task_b"]);
    assert.deepEqual(readiness.task_c.unmetDependencyIds, ["task_bad"]);
    assert.match(readiness.task_c.reasons[0], /failed/);
  });

  it("explains a blocked task through its pending gate, with the gate as evidence", () => {
    const tasks = [task({ id: "task_b", status: "blocked" })];
    const gates = [gate({ id: "gate_1", taskId: "task_b", question: "Ship it?" })];
    const { readiness } = explainReadiness(tasks, gates, null);
    const b = readiness.task_b;
    assert.equal(b.runnable, false);
    assert.deepEqual(b.codes, ["pending_gate"]);
    assert.deepEqual(b.pendingGateIds, ["gate_1"]);
    assert.match(b.reasons[0], /Ship it\?/);
    assert.match(b.reasons[0], /gate_1/);
  });

  it("ignores resolved gates and run-level gates with no task binding", () => {
    const tasks = [task({ id: "task_b", status: "ready" })];
    const gates = [
      gate({ id: "gate_resolved", taskId: "task_b", status: "resolved", resolution: "approved" }),
      gate({ id: "gate_runlevel", taskId: null }),
    ];
    const { readyWave, readiness } = explainReadiness(tasks, gates, null);
    assert.deepEqual(readyWave.taskIds, ["task_b"]);
    assert.deepEqual(readiness.task_b.codes, [], "no blocker may be invented");
    assert.deepEqual(readiness.task_b.pendingGateIds, []);
  });

  it("flags waiting_for_capacity only when the viewer coordinator has no free slot", () => {
    const tasks = [task({ id: "task_r", status: "ready" })];
    const full: SchedulerOccupancy = { busy: 2, maxConcurrency: 2 };
    const free: SchedulerOccupancy = { busy: 1, maxConcurrency: 2 };

    const fullWave = explainReadiness(tasks, [], full);
    assert.equal(fullWave.readyWave.freeSlots, 0);
    assert.deepEqual(fullWave.readiness.task_r.codes, ["waiting_for_capacity"]);
    assert.equal(fullWave.readiness.task_r.runnable, true, "capacity never un-readies a ready task");

    const freeWave = explainReadiness(tasks, [], free);
    assert.equal(freeWave.readyWave.freeSlots, 1);
    assert.deepEqual(freeWave.readiness.task_r.codes, []);

    const unknown = explainReadiness(tasks, [], null);
    assert.equal(unknown.readyWave.freeSlots, null, "no coordinator of ours → unknown, not zero");
    assert.deepEqual(unknown.readiness.task_r.codes, []);
  });

  it("explains in-flight and finished tasks without calling them blocked", () => {
    const tasks = [
      task({ id: "task_run", status: "dispatched", dispatch_id: "ctx_run" }),
      task({ id: "task_ok", status: "completed" }),
      task({ id: "task_bad", status: "failed" }),
    ];
    const { readiness } = explainReadiness(tasks, [], null);
    assert.deepEqual(readiness.task_run.codes, ["in_flight"]);
    assert.match(readiness.task_run.reasons[0], /ctx_run/);
    assert.deepEqual(readiness.task_ok.codes, ["already_finished"]);
    assert.deepEqual(readiness.task_bad.codes, ["already_finished"]);
    for (const id of ["task_run", "task_ok", "task_bad"]) {
      assert.equal(readiness[id].runnable, false);
    }
  });

  it("reports unknown state when nothing visible explains a non-ready status", () => {
    const tasks = [
      task({ id: "task_stuck", status: "pending" }),
      task({ id: "task_blocked?", status: "blocked" }),
    ];
    const { readiness } = explainReadiness(tasks, [], null);
    assert.deepEqual(readiness.task_stuck.codes, ["unknown"]);
    assert.match(readiness.task_stuck.reasons[0], /nudges/);
    assert.deepEqual(readiness["task_blocked?"].codes, ["unknown"]);
    assert.match(readiness["task_blocked?"].reasons[0], /no open gate/);
  });

  it("explains an unrecognized runtime status as unknown instead of guessing", () => {
    const tasks = [task({ id: "task_x", status: "warp" as OrcaTask["status"] })];
    const { readiness } = explainReadiness(tasks, [], null);
    assert.deepEqual(readiness.task_x.codes, ["unknown"]);
    assert.match(readiness.task_x.reasons[0], /warp/);
  });

  it("reports both unmet dependencies and a pending gate when a task waits on both", () => {
    const tasks = [
      task({ id: "task_a", status: "dispatched", dispatch_id: "ctx_a" }),
      task({ id: "task_b", deps: '["task_a"]', status: "pending" }),
    ];
    const gates = [gate({ id: "gate_9", taskId: "task_b", question: "Also approve this" })];
    const { readiness } = explainReadiness(tasks, gates, null);
    assert.deepEqual(readiness.task_b.codes, ["unmet_dependencies", "pending_gate"]);
  });
});

// --- /api/dag pass-through ---------------------------------------------------

describe("GET /api/dag serves hierarchy, ready wave and readiness", () => {
  const policy: SecurityPolicy = createSecurityPolicy({});
  let root: string;
  let workspace: string;
  let server: Server;
  let base: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "orca-dag-dag-test-"));
    workspace = join(root, "ws");
    mkdirSync(workspace, { recursive: true });
    const fixture = join(root, "fake-orca.mjs");
    // Minimal Orca double: enough surface for the /api/dag composition —
    // version probe, one Run's task rows (hierarchy + deps + mixed statuses),
    // and one pending gate. Payloads are baked in; nothing else is served.
    writeFileSync(
      fixture,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("1.4.205\\n"); process.exit(0); }
const out = { ok: true, result: {} };
if (args[0] === "orchestration" && args[1] === "task-list") {
  out.result = { tasks: [
    { id: "task_a", parent_id: null, deps: "[]", status: "completed", spec: "A", result: null,
      created_at: "2026-09-20T00:00:00Z", completed_at: null, task_title: "A", display_name: null,
      run_id: "run_dag", created_by_terminal_handle: null },
    { id: "task_b", parent_id: "task_a", deps: "[]", status: "ready", spec: "B", result: null,
      created_at: "2026-09-20T00:00:00Z", completed_at: null, task_title: "B", display_name: null,
      run_id: "run_dag", created_by_terminal_handle: null },
    { id: "task_c", parent_id: "task_a", deps: '["task_b"]', status: "pending", spec: "C", result: null,
      created_at: "2026-09-20T00:00:00Z", completed_at: null, task_title: "C", display_name: null,
      run_id: "run_dag", created_by_terminal_handle: null },
  ] };
} else if (args[0] === "orchestration" && args[1] === "gate-list") {
  out.result = { gates: [ { id: "gate_1", task_id: "task_c", question: "Proceed?", status: "pending" } ] };
}
process.stdout.write(JSON.stringify(out));
`,
    );
    chmodSync(fixture, 0o755);
    initOrcaRuntime({ env: { ORCA_CLI_COMMAND: fixture, WORKSPACE_DIR: workspace } });
    const { app } = createApp({
      workspaceDir: workspace,
      worktree: "path:" + workspace,
      policy,
      embeddedAssets: null,
    });
    server = await listenLoopback(app, 0);
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  it("composes the new Phase 4 fields from Run-scoped facts", async () => {
    const res = await fetch(`${base}/api/dag?run=run_dag`);
    assert.equal(res.status, 200);
    const dag = (await res.json()) as {
      hierarchy: { parent: string; child: string }[];
      nodes: { id: string; parentId: string | null }[];
      edges: { source: string; target: string }[];
      readyWave: { taskIds: string[]; freeSlots: number | null };
      readiness: Record<string, { runnable: boolean; codes: string[]; pendingGateIds: string[] }>;
    };
    // Hierarchy travels apart from dependencies: B and C are A's children, but
    // only C depends on B — and the parent links never appear as edges.
    assert.deepEqual(
      dag.edges.map((e) => [e.source, e.target]),
      [["task_b", "task_c"]],
    );
    assert.deepEqual(
      dag.hierarchy.map((l) => [l.parent, l.child]).sort(),
      [
        ["task_a", "task_b"],
        ["task_a", "task_c"],
      ],
    );
    assert.equal(dag.nodes.find((n) => n.id === "task_b")?.parentId, "task_a");
    // Ready wave + evidence-backed reasons, with capacity unknown (no viewer
    // coordinator is running this Run in this test).
    assert.deepEqual(dag.readyWave.taskIds, ["task_b"]);
    assert.equal(dag.readyWave.freeSlots, null);
    assert.deepEqual(dag.readiness.task_b.codes, []);
    assert.equal(dag.readiness.task_b.runnable, true);
    assert.deepEqual(dag.readiness.task_c.codes, ["unmet_dependencies", "pending_gate"]);
    assert.deepEqual(dag.readiness.task_c.pendingGateIds, ["gate_1"]);
  });
});
