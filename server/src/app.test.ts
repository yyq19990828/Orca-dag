import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp, listenLoopback } from "./app";
import { createSecurityPolicy, type SecurityPolicy } from "./security";

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
    const { status, json } = await call("POST", "/api/run", {
      runId: "run_ok",
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

  it("rejects a new-top-level placement without repo or name", async () => {
    const cases: Array<[unknown, string]> = [
      [{ kind: "new-top-level", name: "wt" }, "invalid_selector"],
      [{ kind: "new-top-level", repo: "id:repoA" }, "invalid_placement"],
    ];
    for (const [spec, code] of cases) {
      const { status, json } = await call("POST", "/api/run", {
        runId: "run_ok",
        placementByTask: { task_a: spec },
      }, policy.token);
      assert.equal(status, 400);
      assert.equal(json.code, code);
    }
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
