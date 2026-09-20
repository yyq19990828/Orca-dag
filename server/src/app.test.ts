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
