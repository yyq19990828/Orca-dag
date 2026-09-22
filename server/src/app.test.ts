import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp, listenLoopback, validateWorkspacePath, type CoordinatorStatusSnapshot } from "./app";
import { createSecurityPolicy, type SecurityPolicy } from "./security";
import { coordinatorStatus as liveCoordinatorStatus } from "./coordinator";
import { initOrcaRuntime, type OrcaReadiness } from "./orca";

/**
 * Security/API coverage for the control plane (Phase 1 acceptance).
 *
 * The app is exercised over real HTTP on an ephemeral loopback port — no fixed
 * port, no `orca` CLI: every case below either expects success without Orca
 * (health, session, token round-trip on run-stop, config file writes into a
 * throwaway workspace) or a 400/403 that fires BEFORE any Orca command runs.
 */

const policy: SecurityPolicy = createSecurityPolicy({});
const workspace = await mkdtemp(join(tmpdir(), "orca-dag-api-test-"));
let server: Server;
let base: string;

before(async () => {
  const { app } = createApp({
    workspaceDir: workspace,
    worktree: "active",
    policy,
    embeddedAssets: null,
  });
  server = await listenLoopback(app, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object", "server must expose its address");
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  // undici keeps keep-alive sockets open, which would make close() wait forever
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(workspace, { recursive: true, force: true });
});

async function call(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown>; contentType: string }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token !== undefined) headers["X-Orca-Dag-Token"] = token;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = res.headers.get("content-type") ?? "";
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json, contentType };
}

describe("loopback binding", () => {
  it("listens on 127.0.0.1, never a wildcard interface", () => {
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    assert.equal(addr.address, "127.0.0.1");
  });
});

describe("unauthenticated surface", () => {
  it("serves /api/health without a token", async () => {
    const { status, json } = await call("GET", "/api/health");
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.workspace, workspace);
  });

  it("answers unknown API routes with JSON, not the SPA fallback", async () => {
    const { status, json, contentType } = await call("GET", "/api/nope");
    assert.equal(status, 404);
    assert.equal(json.code, "not_found");
    assert.match(contentType, /application\/json/);
  });
});

describe("mutation token", () => {
  it("hands out the token once per process with no-store", async () => {
    const res = await fetch(`${base}/api/session`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const json = (await res.json()) as { token: string; allowCustomCommands: boolean };
    assert.equal(json.token, policy.token);
    assert.equal(json.allowCustomCommands, policy.allowCustomCommands);
  });

  it("rejects missing and wrong tokens with 403 and performs no Orca work", async () => {
    for (const token of [undefined, "not-the-token", ""]) {
      const { status, json } = await call("POST", "/api/run-stop", {}, token);
      assert.equal(status, 403, `expected 403 for token ${JSON.stringify(token)}`);
      assert.equal(json.code, "invalid_token");
      // proof no Orca command ran: the coordinator is untouched
      const { json: status1 } = await call("GET", "/api/run-status");
      assert.equal(status1.running, false);
    }
  });

  it("accepts a valid token on a mutation (run-stop with nothing running)", async () => {
    const { status, json } = await call("POST", "/api/run-stop", {}, policy.token);
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });

  it("protects proactive coordinator messages with the same mutation token", async () => {
    const { status, json } = await call(
      "POST",
      "/api/tasks/task_a/messages",
      { runId: "run_a", body: "Please verify the focused test." },
    );
    assert.equal(status, 403);
    assert.equal(json.code, "invalid_token");
  });
});

describe("strict request validation", () => {
  it("requires a well-formed run id before touching Orca", async () => {
    // missing → run_required; malformed → invalid_input. Both 400, both before
    // any Orca terminal is created.
    const missing = await call("POST", "/api/run", {}, policy.token);
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "run_required");
    const malformed = await call("POST", "/api/run", { runId: "../escape" }, policy.token);
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.code, "invalid_input");
  });

  it("rejects custom harness commands by default with a dedicated code", async () => {
    const { status, json } = await call(
      "POST",
      "/api/run",
      { runId: "run_test123", defaultHarness: "aider --yolo" },
      policy.token,
    );
    assert.equal(status, 400);
    assert.equal(json.code, "custom_commands_disabled");
  });

  it("rejects malformed opencode models against the provider/model grammar", async () => {
    const { status, json } = await call(
      "POST",
      "/api/run",
      {
        runId: "run_test123",
        harnessByTask: { task_1: "opencode" },
        modelByTask: { task_1: "glm-5.3-flash" }, // no provider/ segment
      },
      policy.token,
    );
    assert.equal(status, 400);
    assert.equal(json.code, "invalid_model");
  });

  it("rejects out-of-range concurrency and hostile map keys", async () => {
    const tooBig = await call("POST", "/api/run", { runId: "run_t", maxConcurrency: 99 }, policy.token);
    assert.equal(tooBig.status, 400);
    const badKey = await call(
      "POST",
      "/api/run",
      { runId: "run_t", harnessByTask: { "a;b": "claude" } },
      policy.token,
    );
    assert.equal(badKey.status, 400);
  });

  it("rejects a DAG request without a run scope", async () => {
    const { status, json } = await call("GET", "/api/dag");
    assert.equal(status, 400);
    assert.equal(json.code, "run_required");
  });

  it("validates /api/workers Run scope before invoking Orca", async () => {
    const missing = await call("GET", "/api/workers");
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "run_required");

    const malformed = await call("GET", "/api/workers?run=../escape");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.code, "invalid_input");
  });

  it("validates worker-detail scope and ids before invoking Orca (Phase 2)", async () => {
    // missing run → run_required; malformed dispatch/run → invalid_input.
    // All three refuse at the boundary, before any Orca command can run.
    const noRun = await call("GET", "/api/workers/ctx_valid");
    assert.equal(noRun.status, 400);
    assert.equal(noRun.json.code, "run_required");

    const badDispatch = await call("GET", "/api/workers/bad%20id?run=run_a");
    assert.equal(badDispatch.status, 400);
    assert.equal(badDispatch.json.code, "invalid_input");

    const badRun = await call("GET", "/api/workers/ctx_valid?run=../escape");
    assert.equal(badRun.status, 400);
    assert.equal(badRun.json.code, "invalid_input");
  });

  it("requires explicit Run scope for Inbox and Activity reads", async () => {
    for (const path of ["/api/inbox", "/api/activity", "/api/activity/stream"]) {
      const missing = await call("GET", path);
      assert.equal(missing.status, 400, path);
      assert.equal(missing.json.code, "run_required", path);
    }

    const malformed = await call("GET", "/api/activity?run=../escape");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.code, "invalid_input");
  });
});

describe("config API", () => {
  it("requires the token on PUT", async () => {
    const { status } = await call("PUT", "/api/config", { maxConcurrency: 3 });
    assert.equal(status, 403);
  });

  it("rejects a non-object body instead of storing it", async () => {
    const { status } = await call("PUT", "/api/config", [1, 2, 3], policy.token);
    assert.equal(status, 400);
  });

  it("persists known fields through the sanitizer and drops unknown ones", async () => {
    const { status, json } = await call(
      "PUT",
      "/api/config",
      { maxConcurrency: 3, runId: "run_keep", harnessByTask: { task_1: "claude" }, evilField: { a: 1 } },
      policy.token,
    );
    assert.equal(status, 200);
    assert.equal(json.maxConcurrency, 3);
    assert.equal(json.runId, "run_keep");
    // the sanitizer must have kept `evilField` out of the file on disk too
    const stored = JSON.parse(await readFile(join(workspace, ".orca-dag.config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(stored.evilField, undefined);
    assert.equal(stored.maxConcurrency, 3);
  });

  it("persists a well-formed effortByTask map (Phase 5)", async () => {
    const { status, json } = await call("PUT", "/api/config", { effortByTask: { task_1: "high" } }, policy.token);
    assert.equal(status, 200);
    assert.deepEqual(json.effortByTask, { task_1: "high" });
  });

  it("persists one explicit lead Task per Run and validates both ids", async () => {
    const good = await call(
      "PUT",
      "/api/config",
      { leadTaskByRun: { run_a: "task_lead_a", run_b: "task_lead_b" } },
      policy.token,
    );
    assert.equal(good.status, 200);
    assert.deepEqual(good.json.leadTaskByRun, {
      run_a: "task_lead_a",
      run_b: "task_lead_b",
    });

    const badRun = await call(
      "PUT",
      "/api/config",
      { leadTaskByRun: { "../run": "task_1" } },
      policy.token,
    );
    assert.equal(badRun.status, 400);

    const badTask = await call(
      "PUT",
      "/api/config",
      { leadTaskByRun: { run_a: "../task" } },
      policy.token,
    );
    assert.equal(badTask.status, 400);

    const nonStringTask = await call(
      "PUT",
      "/api/config",
      { leadTaskByRun: { run_a: 42 } },
      policy.token,
    );
    assert.equal(nonStringTask.status, 400);
    assert.equal(nonStringTask.json.code, "invalid_input");
  });
});

describe("Phase 5: per-task effort validation", () => {
  it("rejects an effort entry without a model for the same task (effort_requires_model)", async () => {
    const { status, json } = await call(
      "POST",
      "/api/run",
      { runId: "run_e1", effortByTask: { task_1: "high" } },
      policy.token,
    );
    assert.equal(status, 400);
    assert.equal(json.code, "effort_requires_model");
  });

  it("rejects effort values with unsupported characters before any Orca work", async () => {
    const { status, json } = await call(
      "POST",
      "/api/run",
      {
        runId: "run_e2",
        modelByTask: { task_1: "opus" },
        effortByTask: { task_1: "high; rm -rf /" },
      },
      policy.token,
    );
    assert.equal(status, 400);
    assert.equal(json.code, "invalid_effort");
  });
});

// --- Phase 6: environment/placement request validation -----------------------
//
// These fire BEFORE the execution gate, so they need no Orca runtime — the
// point is precisely that malformed placement input is refused at the HTTP
// boundary and can never become argv.

describe("Phase 6: environment/placement validation", () => {
  it("rejects a remote-ambiguous new-child placement with invalid_placement", async () => {
    // Local new-child is a legal placement; the ambiguity only exists when
    // the same task is placed on a SAVED ENVIRONMENT (another server), and
    // the compatibility gate refuses that combination before any Orca call.
    const { status, json } = await call("POST", "/api/run", {
      runId: "run_ok",
      environmentByTask: { task_a: "env_remote" },
      placementByTask: { task_a: { kind: "new-child", name: "kid" } },
    }, policy.token);
    assert.equal(status, 400);
    assert.equal(json.code, "invalid_placement");
    assert.match(String(json.error), /new-child/);
  });

  it("rejects an existing-placement missing its selector", async () => {
    const { status, json } = await call("POST", "/api/run", {
      runId: "run_ok",
      placementByTask: { task_a: { kind: "existing" } },
    }, policy.token);
    assert.equal(status, 400);
    // Selector sub-field failures carry the precise invalid_selector code;
    // kind-level failures are invalid_placement (asserted in the next case).
    assert.equal(json.code, "invalid_selector");
    assert.match(String(json.error), /selector/);
  });

  it("rejects a new-top-level placement without repo or an explicit remote name", async () => {
    // Local new-top-level may derive its name; the explicit-name requirement
    // bites on a saved environment (the remote host cannot derive one).
    const noRepo = await call("POST", "/api/run", {
      runId: "run_ok",
      placementByTask: { task_a: { kind: "new-top-level", name: "wt" } },
    }, policy.token);
    assert.equal(noRepo.status, 400);
    assert.equal(noRepo.json.code, "invalid_selector");

    const remoteNoName = await call("POST", "/api/run", {
      runId: "run_ok",
      environmentByTask: { task_a: "env_remote" },
      placementByTask: { task_a: { kind: "new-top-level", repo: "id:repoA" } },
    }, policy.token);
    assert.equal(remoteNoName.status, 400);
    assert.equal(remoteNoName.json.code, "invalid_placement");
    assert.match(String(remoteNoName.json.error), /name/);
  });

  it("rejects a malformed environment selector and a non-object placement map", async () => {
    const badEnv = await call("POST", "/api/run", {
      runId: "run_ok",
      environmentByTask: { task_a: "not a selector!" },
    }, policy.token);
    assert.equal(badEnv.status, 400);
    assert.equal(badEnv.json.code, "invalid_environment");

    const badMap = await call("POST", "/api/run", {
      runId: "run_ok",
      placementByTask: ["current"],
    }, policy.token);
    assert.equal(badMap.status, 400);
  });

  it("validates the same shapes on PUT /api/config", async () => {
    const bad = await call("PUT", "/api/config", {
      placementByTask: { task_a: { kind: "wat" } },
    }, policy.token);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, "invalid_placement");

    const good = await call("PUT", "/api/config", {
      placementByTask: { task_a: { kind: "new-top-level", repo: "id:repoA", name: "phase6-wt" } },
      environmentByTask: { task_a: "env_remote" },
    }, policy.token);
    assert.equal(good.status, 200);
  });
});

// --- Phase 6: safe group messaging boundaries --------------------------------
//
// A dedicated app instance with an injected (passing) readiness probe: group
// sends must fail on audience/type/priority validation BEFORE any Orca call,
// and on coordinator authority (409 not_running) once validation passes.
// This environment has no `orca` executable, so any attempt to reach the CLI
// would surface as a 500 — which is itself the assertion that the gates
// fired in the right order.

describe("Phase 6: safe group messaging boundaries", () => {
  let groupBase: string;
  let groupServer: Server;
  let groupWorkspace: string;

  before(async () => {
    groupWorkspace = await mkdtemp(join(tmpdir(), "orca-dag-group-test-"));
    const { app } = createApp({
      workspaceDir: groupWorkspace,
      worktree: "active",
      policy,
      embeddedAssets: null,
      readiness: async () => ({
        cli: "fake-orca",
        workspace: groupWorkspace,
        worktree: "active",
        version: "1.4.206",
        executionEnabled: true,
        reason: null,
      }),
    });
    groupServer = await listenLoopback(app, 0);
    const addr = groupServer.address();
    assert.ok(addr && typeof addr === "object");
    groupBase = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    groupServer.closeAllConnections();
    await new Promise<void>((resolve) => groupServer.close(() => resolve()));
    await rm(groupWorkspace, { recursive: true, force: true });
  });

  async function callGroup(
    body: unknown,
    token: string | null = policy.token,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${groupBase}/api/messages/group`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token !== null ? { "X-Orca-Dag-Token": token } : {}),
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  it("protects group sends with the same mutation token", async () => {
    const { status, json } = await callGroup({ runId: "run_a", audience: "@all", body: "hello" }, null);
    assert.equal(status, 403);
    assert.equal(json.code, "invalid_token");
  });

  it("rejects arbitrary and cross-Run recipient shapes with invalid_audience", async () => {
    for (const audience of ["dispatch:ctx_a", "run:run_b", "term_worker", "@kernel", "all", ""]) {
      const { status, json } = await callGroup({ runId: "run_a", audience, body: "hello" });
      assert.equal(status, 400, `expected 400 for audience ${JSON.stringify(audience)}`);
      assert.equal(json.code, "invalid_audience");
    }
  });

  it("rejects a well-formed but undiscovered worktree audience with unknown_audience", async () => {
    // No `orca` CLI exists here, so discovery cannot return ANY identity —
    // the send must be refused as unknown, never passed through.
    const { status, json } = await callGroup({
      runId: "run_a",
      audience: "@worktree:not-discovered::/repo/x",
      body: "hello",
    });
    assert.equal(status, 400);
    assert.equal(json.code, "unknown_audience");
  });

  it("forbids lifecycle group signals before touching Orca", async () => {
    for (const type of ["worker_done", "heartbeat"]) {
      const { status, json } = await callGroup({ runId: "run_a", audience: "@all", body: "hello", type });
      assert.equal(status, 400, `expected 400 for type ${type}`);
      assert.equal(json.code, "forbidden_group_type");
    }
    const other = await callGroup({ runId: "run_a", audience: "@all", body: "hello", type: "escalation" });
    assert.equal(other.status, 400);
    assert.equal(other.json.code, "invalid_message_type");
  });

  it("rejects unsupported priorities and a missing body", async () => {
    const badPriority = await callGroup({ runId: "run_a", audience: "@all", body: "hello", priority: "asap" });
    assert.equal(badPriority.status, 400);
    assert.equal(badPriority.json.code, "invalid_priority");

    const noBody = await callGroup({ runId: "run_a", audience: "@all", body: "" });
    assert.equal(noBody.status, 400);
    const noRun = await callGroup({ audience: "@all", body: "hello" });
    assert.equal(noRun.status, 400);
  });

  it("answers a valid request with 409 not_running when this viewer is not the Run's live coordinator", async () => {
    const { status, json } = await callGroup({ runId: "run_a", audience: "@all", body: "hello" });
    assert.equal(status, 409);
    assert.equal(json.code, "not_running");
    assert.match(String(json.error), /live coordinator/);
  });
});

// --- Integration: remaining HTTP boundaries ----------------------------------
//
// Phase 7 review found four routes whose boundary behavior had no direct
// test: the group-audience discovery read, the retain/retry worker mutations,
// and the model-list endpoint. As everywhere above, the assertions fire on
// token/validation ordering — BEFORE any Orca call — so they hold with or
// without an `orca`/`opencode` executable on PATH.

describe("integration: remaining HTTP boundaries", () => {
  it("validates Run scope on the group-audience discovery read", async () => {
    const missing = await call("GET", "/api/audiences");
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "run_required");

    const malformed = await call("GET", "/api/audiences?run=../escape");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.code, "invalid_input");
  });

  it("degrades audience discovery to an empty list, never a 500, and labels the degraded provenance", async () => {
    // Whether or not an `orca` CLI exists, the response must keep its shape:
    // audiences is an array (empty when discovery fails) and any discovery
    // failure is reported as a field, not an error status — the picker stays
    // renderable and the user sees WHY it is empty.
    const res = await call("GET", "/api/audiences?run=run_boundary_check");
    assert.equal(res.status, 200);
    assert.equal(res.json.runId, "run_boundary_check");
    assert.equal(res.json.coordinatorActive, false, "nothing coordinates a Run in this test app");
    assert.ok(Array.isArray(res.json.audiences));
  });

  it("protects worker retention with the token and validates the dispatch id before any Orca work", async () => {
    const noToken = await call("POST", "/api/workers/ctx_boundary/retain", {});
    assert.equal(noToken.status, 403);
    assert.equal(noToken.json.code, "invalid_token");

    const malformed = await call("POST", "/api/workers/bad%20id/retain", {}, policy.token);
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.code, "invalid_input");
  });

  it("protects worker retry with the token and validates the id before any Orca work", async () => {
    const noToken = await call("POST", "/api/workers/task_boundary/retry", {});
    assert.equal(noToken.status, 403);
    assert.equal(noToken.json.code, "invalid_token");

    const malformed = await call("POST", "/api/workers/bad%20id/retry", {}, policy.token);
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.code, "invalid_input");
  });

  it("returns the non-enumerable harness model list without a CLI and normalizes the harness name", async () => {
    // claude/codex/cursor have no programmatic model list (the UI falls back
    // to free text), so this needs no `orca` and no `opencode` on PATH.
    const res = await call("GET", "/api/models/CLAUDE");
    assert.equal(res.status, 200);
    assert.equal(res.json.harness, "claude");
    assert.deepEqual(res.json.models, []);
  });
});

// --- Operations routes against a scripted Orca -------------------------------
//
// Acceptance coverage for the worktree-lanes / one-Dispatch lifecycle / file
// review / worktree removal surface. The app is exercised over real HTTP on
// an ephemeral loopback port while `ORCA_CLI_COMMAND` points at a tiny fake
// `orca` executable that records every argv and answers from a per-test JSON
// script — so success, refusal, and response-loss branches are all
// deterministic with no real runtime.

/** One recorded invocation of the fake CLI. */
interface FakeCall {
  argv: string[];
  cwd: string;
}

describe("operations routes against a scripted Orca", () => {
  const opsPolicy: SecurityPolicy = createSecurityPolicy({});
  // Durable ids shared across the scenario: the archive-hook-blocked removal
  // attempt (waiver evidence) and a real worker-stop row (negative evidence
  // for the waiver refusal). Tests within this suite run in order.
  let hookEvidenceId: string | null = null;
  let stopEvidenceId: string | null = null;
  // Mutable coordinator-status snapshot injected into the app: tests aim the
  // lane view/actions at lanes this suite fabricates (lane identity is
  // coordinator state — Orca has no lane table), the same way readiness is
  // injected. Null = "nothing running", the default.
  let coordinatorSnapshot: CoordinatorStatusSnapshot | null = null;
  let root: string;
  let fixturePath: string;
  let scriptPath: string;
  let logPath: string;
  let ws: string;
  let wsReal: string;
  let opsServer: Server;
  let opsBase: string;

  // Built inside before() once the fake CLI path exists — readiness is only
  // ever read through the app's injected probe, which cannot fire earlier.
  let enabledReadiness: OrcaReadiness;

  function writeScript(conf: Record<string, unknown>): void {
    writeFileSync(scriptPath, JSON.stringify(conf));
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

  function clearLog(): void {
    rmSync(logPath, { force: true });
  }

  /** Read one JSONL sidecar file (activity journal / request ledger). */
  async function readJsonl(name: string): Promise<Record<string, unknown>[]> {
    try {
      const text = await readFile(join(ws, name), "utf8");
      return text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  async function rpc(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token !== undefined) headers["X-Orca-Dag-Token"] = token;
    const res = await fetch(opsBase + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /**
   * A `worker-show` result payload shaped like the verified 1.4.206 receipt.
   * Tests override the layers they care about; everything else is a healthy
   * live local worker.
   */
  function workerShowReceipt(
    overrides: {
      dispatchId?: string;
      runId?: string;
      taskId?: string;
      liveness?: { verdict: string; reason: string | null };
      dispatchStatus?: string;
      terminal?: Record<string, unknown> | null;
      observation?: Record<string, unknown> | null;
    } = {},
  ): Record<string, unknown> {
    const dispatchId = overrides.dispatchId ?? "ctx_s1";
    const runId = overrides.runId ?? "run_a";
    const taskId = overrides.taskId ?? "task_s1";
    return {
      dispatch: {
        id: dispatchId,
        runId,
        task_id: taskId,
        status: overrides.dispatchStatus ?? "dispatched",
        failureCount: 0,
        lastFailure: null,
        terminationReason: null,
        dispatchedAt: "2026-09-22 10:00:00",
        completedAt: null,
        lastHeartbeatAt: "2026-09-22T10:00:30Z",
        retryOfDispatchId: null,
        depth: 1,
      },
      worker: {
        dispatchId,
        state: "supervised",
        stage: "running",
        setupState: "complete",
        agentTerminalHandle: "term_agent",
        lastError: null,
      },
      projection: {
        id: dispatchId,
        dispatchId,
        taskId,
        runId,
        role: "worker",
        host: { kind: "local", id: "local" },
        stage: { worker: "supervised", dispatch: "dispatched", detail: null, activity: "working" },
        outcome: "in_progress",
        liveness: overrides.liveness ?? { verdict: "live", reason: null },
        nextAction: { kind: "none", argv: [] },
        attention: { categories: [], requiresAction: false },
      },
      terminal:
        overrides.terminal === null
          ? null
          : {
              handle: "term_agent",
              title: "claude",
              connected: true,
              orphaned: false,
              worktreePath: "/ws/lane",
              branch: "refs/heads/orca/lane",
              executionHostId: "local",
              agentIdentity: "claude",
              lastOutputAt: 1789986567208,
              preview: "…",
              agentWait: null,
              ...(overrides.terminal ?? {}),
            },
      observation:
        overrides.observation === null
          ? null
          : (overrides.observation ?? { status: "live", exactWorker: true, agentWait: null }),
    };
  }

  const worktreeRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "id:repoL::/ws/lane",
    repoId: "repoL",
    path: "/ws/lane",
    displayName: "lane",
    branch: "orca/lane",
    hostId: null,
    parentWorktreeId: "id:repoL::/ws/main",
    isMainWorktree: false,
    ...overrides,
  });

  /** One coordinator-tracked lane for the injected status snapshot. */
  const laneRow = (overrides: Record<string, unknown> = {}): CoordinatorStatusSnapshot["worktreeLanes"][number] =>
    ({
      laneId: "lane_a",
      taskIds: ["task_l1"],
      state: "settled",
      selector: "id:repoL::/ws/lane",
      worktreeId: "wt_lane",
      path: "/ws/lane",
      branch: "refs/heads/orca/lane",
      head: "abc123def456",
      creationDispatchId: "ctx_lane",
      activeDispatchIds: [],
      source: "worktree_show",
      warnings: [],
      ...overrides,
    }) as CoordinatorStatusSnapshot["worktreeLanes"][number];

  /** Aim the injected coordinator at a live Run carrying these lanes. */
  const runLanes = (lanes: CoordinatorStatusSnapshot["worktreeLanes"], runId = "run_a"): void => {
    // Build on the real singleton's projection so every unrelated field keeps
    // its live idle shape — only the Run identity and lanes are fabricated.
    coordinatorSnapshot = {
      ...liveCoordinatorStatus(),
      running: true,
      phase: "running",
      runId,
      coordinatorHandle: "term_coord",
      worktreeLanes: lanes,
    };
  };

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "orca-dag-ops-test-"));
    fixturePath = join(root, "fake-orca.mjs");
    scriptPath = join(root, "fake-orca.json");
    logPath = join(root, "calls.log");
    enabledReadiness = {
      cli: fixturePath,
      workspace: "/ws",
      worktree: "path:/ws",
      version: "1.4.205",
      executionEnabled: true,
      reason: null,
    };
    ws = mkdtempSync(join(tmpdir(), "orca-dag-ops-ws-"));
    wsReal = realpathSync(ws);
    writeFileSync(
      fixturePath,
      `#!/usr/bin/env node
// Minimal Orca CLI double for app.test.ts — records argv, plays a JSON script.
import { appendFileSync, readFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_ORCA_LOG) {
  appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify({ argv: args, cwd: process.cwd() }) + "\\n");
}
let conf = {};
const f = process.env.FAKE_ORCA_SCRIPT;
if (f && existsSync(f)) { try { conf = JSON.parse(readFileSync(f, "utf8")); } catch {} }
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args[0] === "--version") { process.stdout.write((conf.version ?? "1.4.205") + "\\n"); process.exit(0); }
const out = { ok: true, result: {} };
const rawFail = (script) => {
  if (script && script.rawError !== undefined) {
    process.stdout.write(String(script.rawError));
    process.exit(script.exitCode ?? 1);
  }
};
if (args[0] === "terminal" && args[1] === "list") out.result = { terminals: conf.terminals ?? [] };
if (args[0] === "terminal" && args[1] === "create") out.result = { terminal: { handle: conf.newHandle ?? "term_fake_new" } };
if (args[0] === "terminal" && args[1] === "switch") {
  rawFail(conf.terminalSwitch);
  out.result = (conf.terminalSwitch && conf.terminalSwitch.result) ?? { switched: true };
}
if (args[0] === "worktree" && args[1] === "list") {
  rawFail(conf.worktreeList);
  out.result = { worktrees: conf.worktrees ?? [] };
}
if (args[0] === "worktree" && args[1] === "show") {
  const sel = flag("--worktree");
  const row = (conf.worktrees ?? []).find((w) => w && (w.id === sel || w.path === sel));
  if (!row) {
    out.ok = false;
    out.error = { code: "selector_not_found", message: "no such worktree: " + sel };
  } else {
    out.result = { worktree: row };
  }
}
if (args[0] === "repo" && args[1] === "list") out.result = { repos: conf.repos ?? [] };
if (args[0] === "worktree" && args[1] === "rm") {
  const wr = conf.worktreeRm;
  if (wr && wr.fail) {
    out.ok = false;
    out.error = wr.error ?? { code: "worktree_archive_hook_failed", message: "archive hook failed" };
    process.stdout.write(JSON.stringify(out));
    process.exit(1);
  }
  out.result = (wr && wr.result) ?? {};
}
if (args[0] === "file") {
  rawFail(conf.fileCall);
  out.result = conf.fileResult ?? {};
}
if (args[0] === "orchestration" && args[1] === "run-list") {
  const cursor = flag("--cursor") ?? "__first__";
  const page = conf.runPages && conf.runPages[cursor];
  out.result = page ?? { runs: conf.runs ?? [], nextCursor: null };
}
if (args[0] === "orchestration" && args[1] === "run-show") {
  const rs = conf.runShow;
  if (rs && rs.rawError) { process.stdout.write(rs.rawError); process.exit(rs.exitCode ?? 1); }
  const id = flag("--id");
  const run = conf.runsById && conf.runsById[id];
  if (run) { out.result = { run }; }
  else {
    out.ok = false;
    out.error = { code: "run_not_found", message: "Run " + id + " was not found." };
  }
}
if (args[0] === "orchestration" && args[1] === "task-list") {
  out.result = { tasks: (conf.tasksByRun ?? {})[flag("--run")] ?? [] };
}
if (args[0] === "orchestration" && args[1] === "inbox") {
  const limit = Number(flag("--limit") ?? 100);
  const messages = conf.inboxMessages ?? [];
  out.result = { messages: messages.slice(0, limit), count: Math.min(messages.length, limit) };
}
if (args[0] === "orchestration" && args[1] === "worker-list") {
  out.result = { workers: conf.workers ?? [], page: { hasMore: false, nextCursor: null } };
}
if (args[0] === "orchestration" && args[1] === "worker-show") {
  const id = flag("--dispatch");
  const receipt = conf.workerShow && conf.workerShow[id];
  if (receipt) { out.result = receipt; }
  else {
    out.ok = false;
    out.error = { code: "dispatch_not_found", message: "Worker Dispatch " + id + " was not found." };
  }
}
if (args[0] === "orchestration" && args[1] === "worker-stop") {
  rawFail(conf.workerStop);
  out.result = (conf.workerStop && conf.workerStop.result) ?? {
    dispatchId: flag("--dispatch"),
    state: "stopped",
    alreadySettled: false,
    processAction: "terminated",
    warning: null,
  };
}
if (args[0] === "orchestration" && args[1] === "worker-abandon") {
  rawFail(conf.workerAbandon);
  out.result = (conf.workerAbandon && conf.workerAbandon.result) ?? {
    dispatchId: flag("--dispatch"),
    state: "abandoned",
    alreadySettled: false,
    processAction: null,
    warning: null,
  };
}
if (args[0] === "orchestration" && args[1] === "request-show") {
  const id = flag("--request");
  if (conf.requestShowAll) {
    out.result = { requestId: id, state: "completed", interpretation: "landed", outcome: { state: "stopped" } };
  } else {
    out.result = { requestId: id, state: "absent", interpretation: null, outcome: null };
  }
}
process.stdout.write(JSON.stringify(out));
`,
    );
    chmodSync(fixturePath, 0o755);
    process.env.FAKE_ORCA_LOG = logPath;
    process.env.FAKE_ORCA_SCRIPT = scriptPath;
    writeScript({});
    clearLog();
    // The runtime resolves ONCE against the fake CLI; readiness is injected
    // so the execution gate never probes the ambient (real) runtime.
    initOrcaRuntime({ env: { ORCA_CLI_COMMAND: fixturePath, WORKSPACE_DIR: ws }, cwd: root });
    const { app } = createApp({
      workspaceDir: ws,
      worktree: `path:${wsReal}`,
      policy: opsPolicy,
      embeddedAssets: null,
      readiness: async () => ({ ...enabledReadiness, cli: fixturePath, workspace: wsReal, worktree: `path:${wsReal}` }),
      // Null snapshot = the real singleton's idle projection ("nothing running").
      coordinatorStatus: () => coordinatorSnapshot ?? liveCoordinatorStatus(),
    });
    opsServer = await listenLoopback(app, 0);
    const addr = opsServer.address();
    assert.ok(addr && typeof addr === "object");
    opsBase = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    opsServer.closeAllConnections();
    await new Promise<void>((resolve) => opsServer.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  });

  it("lists local worktrees and repos verbatim from Orca's own discovery", async () => {
    writeScript({
      worktrees: [worktreeRow(), worktreeRow({ id: "id:repoL::/ws/main", path: "/ws/main", isMainWorktree: true, displayName: "main", parentWorktreeId: null })],
      repos: [{ id: "repoL", path: "/repo", displayName: "Local Repo", kind: "git", hostId: null }],
    });
    clearLog();
    const wt = await rpc("GET", "/api/worktrees");
    assert.equal(wt.status, 200);
    assert.equal((wt.json.worktrees as unknown[]).length, 2);
    const repos = await rpc("GET", "/api/repos");
    assert.equal(repos.status, 200);
    assert.equal((repos.json.repos as Record<string, unknown>[])[0].id, "repoL");
    // Discovery is a pass-through of what Orca discovered — no invention.
    const calls = readLog().filter((c) => c.argv[0] === "worktree" || c.argv[0] === "repo");
    assert.deepEqual(
      calls.map((c) => `${c.argv[0]} ${c.argv[1]}`).sort(),
      ["repo list", "worktree list"],
    );
  });

  it("surfaces a failed discovery read instead of a fake-empty list", async () => {
    writeScript({ worktreeList: { rawError: "transport down", exitCode: 1 } });
    const wt = await rpc("GET", "/api/worktrees");
    assert.equal(wt.status, 500);
    assert.match(String(wt.json.error), /transport down|response_lost/);
  });

  it("serves the exact worktree identity, 404 only on Orca's definite absence", async () => {
    writeScript({ worktrees: [worktreeRow()] });
    const found = await rpc("GET", `/api/worktrees/${encodeURIComponent("id:repoL::/ws/lane")}`);
    assert.equal(found.status, 200);
    assert.equal((found.json.worktree as Record<string, unknown>).id, "id:repoL::/ws/lane");

    const missing = await rpc("GET", `/api/worktrees/${encodeURIComponent("id:repoL::/ws/ghost")}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, "worktree_not_found");
  });

  it("pages the Run registry cursor-first and passes nextCursor through verbatim", async () => {
    writeScript({
      runPages: {
        __first__: { runs: [{ id: "run_a", objective: "a", coordinator_handle: null, consumer_generation: 1, legacy: 0, created_at: "2026-09-22T00:00:00Z", updated_at: "2026-09-22T00:00:00Z" }], nextCursor: "c2" },
        c2: { runs: [{ id: "run_b", objective: "b", coordinator_handle: null, consumer_generation: 1, legacy: 0, created_at: "2026-09-21T00:00:00Z", updated_at: "2026-09-21T00:00:00Z" }], nextCursor: null },
      },
    });
    clearLog();
    const page1 = await rpc("GET", "/api/runs/page");
    assert.equal(page1.status, 200);
    assert.deepEqual((page1.json.runs as Record<string, unknown>[]).map((r) => r.id), ["run_a"]);
    assert.equal(page1.json.nextCursor, "c2");

    const page2 = await rpc("GET", "/api/runs/page?cursor=c2");
    assert.equal(page2.status, 200);
    assert.deepEqual((page2.json.runs as Record<string, unknown>[]).map((r) => r.id), ["run_b"]);
    assert.equal(page2.json.nextCursor, null);
    // The opaque cursor reached the CLI byte-for-byte.
    const paged = readLog().filter((c) => c.argv[1] === "run-list" && c.argv.includes("--cursor"));
    assert.ok(paged.length >= 1 && paged[0].argv.includes("c2"));
  });

  it("resolves one exact Run with positive workspace-ownership evidence", async () => {
    writeScript({
      runsById: {
        run_a: { id: "run_a", objective: "o", coordinator_handle: "term_c", consumer_generation: 3, legacy: 0, created_at: "t", updated_at: "t" },
      },
      tasksByRun: {
        run_a: [{ id: "task_a", run_id: "run_a", created_by_process_incarnation: `repoX::${wsReal}@@pty:incarnation` }],
        run_foreign: [{ id: "task_f", run_id: "run_foreign", created_by_process_incarnation: "repoY::/other/ws@@pty:inc" }],
      },
    });
    const own = await rpc("GET", "/api/runs/run_a");
    assert.equal(own.status, 200);
    assert.equal((own.json.run as Record<string, unknown>).id, "run_a");
    assert.deepEqual(own.json.workspace, { owned: true, evidence: "task creator marker" });

    // A foreign-workspace Run is visible but flagged — never relabeled ours.
    writeScript({
      runsById: {
        run_foreign: { id: "run_foreign", objective: "f", coordinator_handle: null, consumer_generation: 1, legacy: 0, created_at: "t", updated_at: "t" },
      },
      tasksByRun: { run_foreign: [{ id: "task_f", run_id: "run_foreign", created_by_process_incarnation: "repoY::/other/ws@@pty:inc" }] },
    });
    const foreign = await rpc("GET", "/api/runs/run_foreign");
    assert.equal(foreign.status, 200);
    assert.deepEqual(foreign.json.workspace, { owned: false, evidence: "no task in this Run was created from this workspace" });
  });

  it("answers 404 run_not_found for an unknown id and keeps a failed read at 500", async () => {
    writeScript({});
    const missing = await rpc("GET", "/api/runs/run_ghost");
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, "run_not_found");

    writeScript({ runShow: { rawError: "contact lost", exitCode: 1 } });
    const broken = await rpc("GET", "/api/runs/run_a");
    assert.equal(broken.status, 500, "contact loss must never masquerade as absence");
  });

  it("answers the lane view only for the coordinator's own Run", async () => {
    // Nothing is running: every Run gets the honest empty answer, never
    // another Run's lanes.
    const empty = await rpc("GET", "/api/worktree-lanes?run=run_a");
    assert.equal(empty.status, 200);
    assert.equal(empty.json.running, false);
    assert.deepEqual(empty.json.lanes, []);
    const malformed = await rpc("GET", "/api/worktree-lanes?run=../escape");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.code, "invalid_input");
  });

  it("scopes the lane view to the live Run and never leaks another Run's lanes", async () => {
    runLanes([laneRow()]);
    const mine = await rpc("GET", "/api/worktree-lanes?run=run_a");
    assert.equal(mine.status, 200);
    assert.equal(mine.json.running, true);
    assert.equal((mine.json.lanes as unknown[]).length, 1);
    const other = await rpc("GET", "/api/worktree-lanes?run=run_other");
    assert.equal(other.status, 200);
    assert.equal(other.json.running, false, "a foreign Run never sees the live lanes");
    assert.deepEqual(other.json.lanes, []);
    coordinatorSnapshot = null;
  });

  it("opens a lane's changed files in the proven workspace only", async () => {
    writeScript({ fileResult: { worktree: "id:repoL::/ws/lane" } });
    clearLog();
    // No live coordinator: the lane (and its identity) does not exist.
    const dormant = await rpc(
      "POST",
      "/api/worktree-lanes/lane_a/open-changed",
      { mode: "files" },
      opsPolicy.token,
    );
    assert.equal(dormant.status, 409);
    assert.equal(dormant.json.code, "not_running");
    assert.equal(readLog().filter((c) => c.argv[0] === "file").length, 0);

    runLanes([laneRow()]);
    const res = await rpc("POST", "/api/worktree-lanes/lane_a/open-changed", { mode: "files" }, opsPolicy.token);
    assert.equal(res.status, 200);
    const receipt = res.json.receipt as Record<string, unknown>;
    assert.equal(receipt.laneId, "lane_a");
    assert.equal(receipt.workspace, "id:repoL::/ws/lane");
    const calls = readLog().filter((c) => c.argv[0] === "file");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv.slice(1, 6), [
      "open-changed",
      "--mode",
      "edit", // the UI verb "files" maps to the adapter's closed union HERE
      "--worktree",
      "id:repoL::/ws/lane",
    ]);

    // A lane with no positive identity authorizes nothing.
    runLanes([laneRow({ laneId: "lane_ghost", selector: null, path: null, source: null })]);
    const ghost = await rpc(
      "POST",
      "/api/worktree-lanes/lane_ghost/open-changed",
      { mode: "diff" },
      opsPolicy.token,
    );
    assert.equal(ghost.status, 409);
    assert.equal(ghost.json.code, "lane_unverifiable");
    assert.equal(readLog().filter((c) => c.argv[0] === "file").length, 1, "no CLI call for an unverifiable lane");
    coordinatorSnapshot = null;
  });

  it("removes a settled lane's worktree only on the server-recomputed token", async () => {
    writeScript({
      worktrees: [worktreeRow()],
      worktreeRm: { result: { worktree: "wt_lane", state: "removed" } },
    });
    clearLog();
    runLanes([laneRow()]);
    // Wrong token: refused before any CLI call, even though the lane is settled.
    const wrong = await rpc("POST", "/api/worktree-lanes/lane_a/remove", { confirm: "wt_lane " }, opsPolicy.token);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.code, "confirm_mismatch");
    assert.equal(readLog().filter((c) => c.argv[1] === "rm").length, 0);

    const res = await rpc("POST", "/api/worktree-lanes/lane_a/remove", { confirm: "wt_lane" }, opsPolicy.token);
    assert.equal(res.status, 200);
    const receipt = res.json.receipt as Record<string, unknown>;
    assert.equal(receipt.laneId, "lane_a");
    assert.equal(receipt.state, "removed");
    const rms = readLog().filter((c) => c.argv[1] === "rm");
    assert.equal(rms.length, 1);
    assert.ok(rms[0].argv.includes("--worktree") && rms[0].argv.includes("id:repoL::/ws/lane"));
    // The removal ran through the shared core: durable ledger + Run-scoped activity.
    const rows = (await readJsonl(".orca-dag.requests.jsonl")).filter(
      (r) => r.requestId === res.json.requestId,
    );
    assert.equal(rows.length, 2, "one mint line + one outcome line");
    assert.equal(rows[1].note, "removed");
    const activity = await readJsonl(".orca-dag.activity.jsonl");
    assert.ok(activity.some((e) => e.kind === "worktree" && String(e.summary).includes("id:repoL::/ws/lane")));
    coordinatorSnapshot = null;
  });

  it("refuses to remove a lane that is not settled or is unknown", async () => {
    writeScript({ worktrees: [worktreeRow()] });
    clearLog();
    runLanes([laneRow({ state: "active", activeDispatchIds: ["ctx_live"] })]);
    const busy = await rpc("POST", "/api/worktree-lanes/lane_a/remove", { confirm: "wt_lane" }, opsPolicy.token);
    assert.equal(busy.status, 409);
    assert.equal(busy.json.code, "lane_not_settled");
    assert.equal(readLog().filter((c) => c.argv[1] === "rm").length, 0);

    const unknown = await rpc("POST", "/api/worktree-lanes/lane_ghost/remove", { confirm: "x" }, opsPolicy.token);
    assert.equal(unknown.status, 409);
    assert.equal(unknown.json.code, "lane_not_found");
    coordinatorSnapshot = null;
  });

  it("stops one Dispatch under a durable request id and journals it", async () => {
    writeScript({
      workerShow: { ctx_s1: workerShowReceipt() },
      workerStop: { result: { dispatchId: "ctx_s1", state: "stopped", alreadySettled: false, processAction: "terminated", warning: null } },
    });
    clearLog();
    const res = await rpc("POST", "/api/workers/ctx_s1/stop", { runId: "run_a" }, opsPolicy.token);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    const requestId = res.json.requestId as string;
    assert.ok(requestId, "the response carries the durable request id");
    const receipt = res.json.receipt as Record<string, unknown>;
    assert.equal(receipt.state, "stopped");
    // The pre-action evidence re-read rides back to the UI.
    const evidence = res.json.evidence as Record<string, unknown>;
    assert.equal((evidence.liveness as Record<string, unknown>).verdict, "live");
    assert.deepEqual(evidence.workspace, { worktreePath: "/ws/lane", branch: "refs/heads/orca/lane" });

    // Exactly one CLI mutation, carrying the durable id.
    const stops = readLog().filter((c) => c.argv[1] === "worker-stop");
    assert.equal(stops.length, 1);
    assert.ok(stops[0].argv.includes("--dispatch") && stops[0].argv.includes("ctx_s1"));
    assert.ok(stops[0].argv.includes("--retry-request") && stops[0].argv.includes(requestId));

    // The ledger row: minted with positive Run scope, closed with the state.
    const rows = await readJsonl(".orca-dag.requests.jsonl");
    const mine = rows.filter((r) => r.requestId === requestId);
    assert.equal(mine.length, 2, "one mint line + one outcome line");
    assert.ok(mine.every((r) => r.operation === "worker-stop" && r.runId === "run_a"));
    assert.equal(mine[1].note, "viewer-observed stop state: stopped");
    assert.equal(mine[1].settledLocally, true);

    // The Activity row carries the same durable request identity.
    const activity = await readJsonl(".orca-dag.activity.jsonl");
    const row = activity.find((e) => e.kind === "stop" && e.dispatchId === "ctx_s1");
    assert.ok(row, "a stop row is journaled");
    assert.equal((row!.technical as Record<string, unknown>).requestId, requestId);
    stopEvidenceId = requestId;
  });

  it("refuses to stop a Dispatch whose durable Run scope is foreign", async () => {
    writeScript({ workerShow: { ctx_s1: workerShowReceipt() } });
    clearLog();
    const res = await rpc("POST", "/api/workers/ctx_s1/stop", { runId: "run_other" }, opsPolicy.token);
    assert.equal(res.status, 404);
    assert.equal(res.json.code, "worker_run_mismatch");
    assert.equal(readLog().filter((c) => c.argv[1] === "worker-stop").length, 0, "no mutation on foreign scope");
  });

  it("answers 404 for an unknown Dispatch before minting anything", async () => {
    writeScript({});
    clearLog();
    const res = await rpc("POST", "/api/workers/ctx_ghost/stop", { runId: "run_a" }, opsPolicy.token);
    assert.equal(res.status, 404);
    assert.equal(res.json.code, "worker_not_found");
    assert.equal(readLog().filter((c) => c.argv[1] === "worker-stop").length, 0);
  });

  it("reports a lost stop response with the probe id and keeps the ledger unresolved", async () => {
    writeScript({
      workerShow: { ctx_s1: workerShowReceipt() },
      workerStop: { rawError: "killed before the receipt was written", exitCode: 1 },
      requestShowAll: true,
    });
    clearLog();
    const res = await rpc("POST", "/api/workers/ctx_s1/stop", { runId: "run_a" }, opsPolicy.token);
    assert.equal(res.status, 502);
    assert.equal(res.json.code, "response_lost");
    const requestId = res.json.requestId as string;
    assert.ok(requestId, "the lost attempt's id is handed back for the request-show probe");

    const rows = (await readJsonl(".orca-dag.requests.jsonl")).filter((r) => r.requestId === requestId);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].settledLocally, false);
    assert.match(String(rows[1].note), /response lost/);

    // The audit probe resolves the id against Orca's recorded outcome.
    const audit = await rpc("GET", `/api/requests/${requestId}?run=run_a`);
    assert.equal(audit.status, 200);
    const receipt = audit.json.receipt as Record<string, unknown>;
    assert.equal(receipt.state, "completed");
    assert.equal(receipt.probe, "orca");
  });

  it("stops exactly one Dispatch and leaves unrelated Dispatches untouched", async () => {
    writeScript({
      workerShow: {
        ctx_s1: workerShowReceipt(),
        ctx_s2: workerShowReceipt({ dispatchId: "ctx_s2", taskId: "task_s2" }),
      },
    });
    clearLog();
    const res = await rpc("POST", "/api/workers/ctx_s1/stop", { runId: "run_a" }, opsPolicy.token);
    assert.equal(res.status, 200);
    const lifecycleCalls = readLog().filter((c) =>
      ["worker-stop", "worker-abandon", "worker-release", "worker-retain"].includes(c.argv[1] ?? ""),
    );
    assert.equal(lifecycleCalls.length, 1, "one lifecycle call total");
    assert.ok(lifecycleCalls[0].argv.includes("ctx_s1"));
    assert.ok(!lifecycleCalls[0].argv.includes("ctx_s2"), "the sibling Dispatch is never named");
  });

  it("stops an already-settled Dispatch and reports the receipt honestly", async () => {
    writeScript({
      workerShow: { ctx_s1: workerShowReceipt({ dispatchStatus: "completed" }) },
      workerStop: { result: { dispatchId: "ctx_s1", state: "already_settled", alreadySettled: true, processAction: null, warning: null } },
    });
    clearLog();
    const res = await rpc("POST", "/api/workers/ctx_s1/stop", { runId: "run_a" }, opsPolicy.token);
    assert.equal(res.status, 200);
    const receipt = res.json.receipt as Record<string, unknown>;
    assert.equal(receipt.alreadySettled, true);
    assert.equal(receipt.state, "already_settled");
  });

  it("refuses to abandon a Dispatch Orca proves live", async () => {
    writeScript({ workerShow: { ctx_s1: workerShowReceipt() } });
    clearLog();
    const res = await rpc("POST", "/api/workers/ctx_s1/abandon", { runId: "run_a" }, opsPolicy.token);
    assert.equal(res.status, 409);
    assert.equal(res.json.code, "abandon_refused");
    assert.match(String(res.json.error), /Stop it instead/);
    assert.equal(readLog().filter((c) => c.argv[1] === "worker-abandon").length, 0);
  });

  it("abandons an unverifiable Dispatch — abandon is the outcome-unknown tool", async () => {
    writeScript({
      workerShow: {
        ctx_s1: workerShowReceipt({ liveness: { verdict: "unverifiable", reason: "missing_status" } }),
      },
    });
    clearLog();
    const res = await rpc("POST", "/api/workers/ctx_s1/abandon", { runId: "run_a" }, opsPolicy.token);
    assert.equal(res.status, 200);
    const requestId = res.json.requestId as string;
    const receipt = res.json.receipt as Record<string, unknown>;
    assert.equal(receipt.state, "abandoned");
    assert.equal(receipt.requestId, requestId, "the receipt echoes the durable id");
    const rows = (await readJsonl(".orca-dag.requests.jsonl")).filter((r) => r.requestId === requestId);
    assert.ok(rows.every((r) => r.operation === "worker-abandon"));
    assert.equal(rows[1].settledLocally, true);
  });

  it("keeps an abandoned-in-doubt Dispatch unresolved on response loss", async () => {
    writeScript({
      workerShow: { ctx_s1: workerShowReceipt({ liveness: { verdict: "exited", reason: null } }) },
      workerAbandon: { rawError: "truncated output", exitCode: 1 },
    });
    clearLog();
    const res = await rpc("POST", "/api/workers/ctx_s1/abandon", { runId: "run_a" }, opsPolicy.token);
    assert.equal(res.status, 502);
    assert.equal(res.json.code, "response_lost");
    const rows = (await readJsonl(".orca-dag.requests.jsonl")).filter(
      (r) => r.requestId === res.json.requestId,
    );
    assert.equal(rows[1].settledLocally, false);
  });

  it("focuses the worker's own terminal from the fresh receipt", async () => {
    writeScript({ workerShow: { ctx_s1: workerShowReceipt() } });
    clearLog();
    const res = await rpc("POST", "/api/workers/ctx_s1/focus", { runId: "run_a" }, opsPolicy.token);
    assert.equal(res.status, 200);
    const receipt = res.json.receipt as Record<string, unknown>;
    assert.equal(receipt.handle, "term_agent");
    const switches = readLog().filter((c) => c.argv[1] === "switch");
    assert.equal(switches.length, 1);
    // runOrca appends `--json` to every argv (its parse envelope), so the
    // recorded spawn carries the trailing flag — the contract is "exact
    // handle, nothing else", which the slice before it proves.
    assert.deepEqual(switches[0].argv.slice(2), ["--terminal", "term_agent", "--json"]);
    const rows = await readJsonl(".orca-dag.requests.jsonl");
    const focus = rows.find((r) => r.operation === "terminal-focus");
    assert.equal(focus?.target, "term_agent");
  });

  it("refuses focus without positive terminal facts and never guesses a handle", async () => {
    writeScript({
      workerShow: { ctx_s1: workerShowReceipt({ terminal: null }) },
    });
    clearLog();
    const res = await rpc("POST", "/api/workers/ctx_s1/focus", { runId: "run_a" }, opsPolicy.token);
    assert.equal(res.status, 409);
    assert.equal(res.json.code, "focus_unavailable");
    assert.equal(readLog().filter((c) => c.argv[1] === "switch").length, 0);
  });

  it("requires the mutation token on the new lifecycle routes", async () => {
    for (const path of [
      "/api/workers/ctx_s1/stop",
      "/api/workers/ctx_s1/abandon",
      "/api/workers/ctx_s1/focus",
      "/api/files/open",
      "/api/worktrees/remove",
    ]) {
      const res = await rpc("POST", path, {});
      assert.equal(res.status, 403, path);
      assert.equal(res.json.code, "invalid_token", path);
    }
  });

  it("opens a file and a staged diff against the selected worktree", async () => {
    writeScript({ fileResult: { path: "src/x.ts", worktree: "id:repoL::/ws/main" } });
    clearLog();
    const open = await rpc(
      "POST",
      "/api/files/open",
      { path: "src/x.ts", worktree: "id:repoL::/ws/main", runId: "run_a" },
      opsPolicy.token,
    );
    assert.equal(open.status, 200);
    const openReceipt = open.json.receipt as Record<string, unknown>;
    assert.equal(openReceipt.path, "src/x.ts");
    const openCall = readLog().find((c) => c.argv[0] === "file")!;
    // Trailing `--json` is runOrca's parse envelope, not part of the command.
    assert.deepEqual(openCall.argv.slice(1), ["open", "src/x.ts", "--worktree", "id:repoL::/ws/main", "--json"]);

    clearLog();
    const diff = await rpc(
      "POST",
      "/api/files/diff",
      { path: "src/x.ts", staged: true, worktree: "id:repoL::/ws/main" },
      opsPolicy.token,
    );
    assert.equal(diff.status, 200);
    const diffCall = readLog().find((c) => c.argv[0] === "file")!;
    assert.deepEqual(diffCall.argv.slice(1, 4), ["diff", "src/x.ts", "--staged"]);

    // The durable ledger records the review with the path as target.
    const rows = await readJsonl(".orca-dag.requests.jsonl");
    assert.ok(rows.some((r) => r.operation === "file-open" && r.target === "src/x.ts"));
    assert.ok(rows.some((r) => r.operation === "file-diff" && r.target === "src/x.ts"));
    const activity = await readJsonl(".orca-dag.activity.jsonl");
    assert.ok(activity.some((e) => e.kind === "file_review" && e.runId === "run_a"));
  });

  it("contains review paths: traversal, separators, and expansion are refused pre-CLI", async () => {
    writeScript({ fileResult: {} });
    clearLog();
    for (const path of ["../escape", "a/../b", "src/../../x", "back\\slash", "C:/Windows", "~/secrets", ""]) {
      const res = await rpc("POST", "/api/files/open", { path }, opsPolicy.token);
      assert.equal(res.status, 400, `path ${JSON.stringify(path)} must be refused`);
      assert.equal(res.json.code, "invalid_path", path);
    }
    assert.equal(readLog().filter((c) => c.argv[0] === "file").length, 0, "no CLI call on a refused path");
  });

  it("validates the open-changed mode union before any CLI call", async () => {
    writeScript({ fileResult: {} });
    clearLog();
    const bad = await rpc("POST", "/api/files/open-changed", { mode: "nope" }, opsPolicy.token);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, "invalid_mode");
    const good = await rpc("POST", "/api/files/open-changed", { mode: "edit", worktree: "id:repoL::/ws/main" }, opsPolicy.token);
    assert.equal(good.status, 200);
    const call = readLog().find((c) => c.argv[0] === "file")!;
    assert.deepEqual(call.argv.slice(1), [
      "open-changed",
      "--mode",
      "edit",
      "--worktree",
      "id:repoL::/ws/main",
      "--json", // runOrca's parse envelope, appended to every spawn
    ]);
  });

  it("removes a discovered non-main worktree and keeps the receipt semantics", async () => {
    writeScript({
      worktrees: [worktreeRow()],
      worktreeRm: { result: { worktree: "id:repoL::/ws/lane", archiveHookOverride: null } },
    });
    clearLog();
    const res = await rpc("POST", "/api/worktrees/remove", { worktree: "id:repoL::/ws/lane" }, opsPolicy.token);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    const receipt = res.json.receipt as Record<string, unknown>;
    assert.equal(receipt.worktree, "id:repoL::/ws/lane");
    const rms = readLog().filter((c) => c.argv[1] === "rm");
    assert.equal(rms.length, 1);
    assert.ok(!rms[0].argv.includes("--run-hooks"), "no hook flags without an explicit request");
    assert.ok(!rms[0].argv.includes("--allow-failed-archive-hook"));
    const rows = (await readJsonl(".orca-dag.requests.jsonl")).filter(
      (r) => r.requestId === res.json.requestId,
    );
    assert.equal(rows[1].note, "removed");
    assert.equal(rows[1].settledLocally, true);
  });

  it("refuses to remove a workspace Orca does not discover", async () => {
    writeScript({});
    clearLog();
    const res = await rpc("POST", "/api/worktrees/remove", { worktree: "id:repoL::/ws/ghost" }, opsPolicy.token);
    assert.equal(res.status, 404);
    assert.equal(res.json.code, "worktree_not_found");
    assert.equal(readLog().filter((c) => c.argv[1] === "rm").length, 0);
  });

  it("protects the main worktree and this viewer's own workspace", async () => {
    writeScript({
      worktrees: [
        worktreeRow({ id: "id:repoL::/ws/main", path: "/ws/main", displayName: "main", isMainWorktree: true, parentWorktreeId: null }),
        worktreeRow(),
      ],
    });
    clearLog();
    const main = await rpc("POST", "/api/worktrees/remove", { worktree: "id:repoL::/ws/main" }, opsPolicy.token);
    assert.equal(main.status, 409);
    assert.equal(main.json.code, "main_worktree_protected");

    const own = await rpc("POST", "/api/worktrees/remove", { worktree: `path:${wsReal}` }, opsPolicy.token);
    assert.equal(own.status, 409);
    assert.equal(own.json.code, "current_workspace_protected");
    assert.equal(readLog().filter((c) => c.argv[1] === "rm").length, 0);
  });

  it("answers the archive-hook failure without waiving anything", async () => {
    writeScript({
      worktrees: [worktreeRow()],
      worktreeRm: { fail: true, error: { code: "worktree_archive_hook_failed", message: "hook exited 3" } },
    });
    clearLog();
    const res = await rpc("POST", "/api/worktrees/remove", { worktree: "id:repoL::/ws/lane" }, opsPolicy.token);
    assert.equal(res.status, 409);
    assert.equal(res.json.code, "worktree_archive_hook_failed");
    hookEvidenceId = res.json.requestId as string;
    assert.ok(hookEvidenceId, "the blocked attempt's id comes back as waiver evidence");
    // Exactly ONE rm: nothing was removed, nothing was auto-waived.
    assert.equal(readLog().filter((c) => c.argv[1] === "rm").length, 1);
    const rows = (await readJsonl(".orca-dag.requests.jsonl")).filter((r) => r.requestId === hookEvidenceId);
    assert.equal(rows[1].settledLocally, false);
    assert.match(String(rows[1].note), /archive hook failed/);
  });

  it("waives the hook only with the durable evidence of the blocked attempt", async () => {
    writeScript({
      worktrees: [worktreeRow()],
      worktreeRm: { result: { worktree: "id:repoL::/ws/lane", archiveHookOverride: { hook: "archive", exitCode: 3 } } },
    });
    clearLog();
    const res = await rpc(
      "POST",
      "/api/worktrees/remove",
      {
        worktree: "id:repoL::/ws/lane",
        runHooks: true,
        allowFailedArchiveHook: true,
        evidenceRequestId: hookEvidenceId,
      },
      opsPolicy.token,
    );
    assert.equal(res.status, 200);
    const rms = readLog().filter((c) => c.argv[1] === "rm");
    assert.equal(rms.length, 1);
    assert.ok(rms[0].argv.includes("--run-hooks"));
    assert.ok(rms[0].argv.includes("--allow-failed-archive-hook"));
    const receipt = res.json.receipt as Record<string, unknown>;
    assert.ok(receipt.archiveHookOverride, "the waived failure rides through verbatim");
  });

  it("refuses a waiver whose evidence is missing, foreign, or unrelated", async () => {
    writeScript({ worktrees: [worktreeRow()] });
    clearLog();
    // A random id names no ledger row at all.
    const none = await rpc(
      "POST",
      "/api/worktrees/remove",
      { worktree: "id:repoL::/ws/lane", runHooks: true, allowFailedArchiveHook: true, evidenceRequestId: "00000000-0000-4000-8000-000000000000" },
      opsPolicy.token,
    );
    assert.equal(none.status, 403);
    assert.equal(none.json.code, "removal_evidence_required");
    // The stop request id from earlier is real but names a different
    // operation and target — it authorizes nothing here.
    const wrong = await rpc(
      "POST",
      "/api/worktrees/remove",
      { worktree: "id:repoL::/ws/lane", runHooks: true, allowFailedArchiveHook: true, evidenceRequestId: stopEvidenceId },
      opsPolicy.token,
    );
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json.code, "removal_evidence_required");
    assert.equal(readLog().filter((c) => c.argv[1] === "rm").length, 0, "no removal runs on unverifiable evidence");
  });

  it("keeps the new mutations in the Run-scoped request audit", async () => {
    const audit = await rpc("GET", "/api/requests?run=run_a");
    assert.equal(audit.status, 200);
    const requests = audit.json.requests as Record<string, unknown>[];
    const operations = new Set(requests.map((r) => r.operation));
    for (const op of ["worker-stop", "worker-abandon", "terminal-focus", "file-open", "file-diff", "worktree-remove"]) {
      assert.ok(operations.has(op), `audit covers ${op}`);
    }
    // Viewer-receipted ops without a Run in scope stay inspectable as
    // unscoped rows; nothing was mis-attributed to run_a.
    const unscoped = requests.filter((r) => r.runId === null);
    assert.ok(unscoped.some((r) => r.operation === "worktree-remove"));
  });
});
