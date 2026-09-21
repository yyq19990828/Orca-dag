import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp, listenLoopback } from "./app";
import { createSecurityPolicy, type SecurityPolicy } from "./security";
import { initOrcaRuntime } from "./orca";
import { RequestLedger } from "./requestLedger";
import type { OrcaReadiness } from "./orca";

/**
 * Phase 5 acceptance, over real HTTP: the mutation-request audit surface.
 *
 * A dedicated fake `orca` answers `request-show` (the ONE verb the audit
 * routes may run) and `worker-release`/`worker-retain` (to mint real records
 * through the viewer's own endpoints). Every argv the fake sees is logged,
 * which is how the no-replay guarantee is proven: hitting the read-only
 * audit endpoints must only ever append `request-show` calls.
 *
 * Receipt states covered: completed (Orca recorded an outcome), pending
 * (recorded, outcome not final), absent (Orca holds no record — never
 * "did not happen"), and unknown (the probe itself failed — still resolved
 * to nothing).
 */

const FAKE = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.AUDIT_FAKE_LOG, JSON.stringify(args) + "\\n");
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
let state = {};
try { state = JSON.parse(readFileSync(process.env.AUDIT_FAKE_STATE, "utf8")); } catch {}
const verb = args[1];
const okEnvelope = (result) => { process.stdout.write(JSON.stringify({ ok: true, result })); process.exit(0); };
if (verb === "request-show") {
  const id = flag("--request");
  if ((state.failProbes ?? []).includes(id)) {
    process.stdout.write("<html>502 Bad Gateway</html>"); // garbage → probe fails
    process.exit(1);
  }
  const rec = (state.requests ?? {})[id];
  okEnvelope(rec
    ? { requestId: id, state: rec.state, interpretation: rec.interpretation ?? null, outcome: rec.outcome ?? null }
    : { requestId: id, state: "absent", interpretation: "no recorded request", outcome: null });
}
if (verb === "worker-release" || verb === "worker-retain") {
  const id = flag("--dispatch");
  const requestId = flag("--retry-request");
  const outcome = verb === "worker-release"
    ? { dispatchId: id, requestId, state: "released", reason: null, processAction: "terminated",
        warning: null, archive: { transcript: { rows: 24, path: "/tmp/archive-" + id + ".jsonl" } } }
    : { dispatchId: id, requestId, state: "retained", reason: null, processAction: null,
        warning: null, archive: null };
  state.requests ??= {};
  state.requests[requestId] = { state: "completed", interpretation: verb + " completed", outcome };
  writeFileSync(process.env.AUDIT_FAKE_STATE, JSON.stringify(state));
  okEnvelope(outcome);
}
process.stdout.write(JSON.stringify({ ok: false, error: { code: "unknown_verb", message: String(verb) } }));
process.exit(1);
`;

const policy: SecurityPolicy = createSecurityPolicy({});
let root: string;
let workspace: string;
let statePath: string;
let logPath: string;
let server: Server;
let base: string;
let token: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "orca-dag-audit-"));
  workspace = mkdtempSync(join(tmpdir(), "orca-dag-audit-ws-"));
  statePath = join(root, "fake-state.json");
  logPath = join(root, "calls.log");
  const fixturePath = join(root, "fake-orca.mjs");
  writeFileSync(fixturePath, FAKE);
  chmodSync(fixturePath, 0o755);
  writeFileSync(statePath, JSON.stringify({ version: "1.4.205" }));
  process.env.AUDIT_FAKE_STATE = statePath;
  process.env.AUDIT_FAKE_LOG = logPath;
  initOrcaRuntime({ env: { ORCA_CLI_COMMAND: fixturePath, WORKSPACE_DIR: workspace }, cwd: root });
  const { app } = createApp({
    workspaceDir: workspace,
    worktree: "path:" + workspace,
    policy,
    embeddedAssets: null,
    readiness: async (): Promise<OrcaReadiness> => ({
      cli: fixturePath,
      workspace,
      worktree: "path:" + workspace,
      version: "1.4.205",
      executionEnabled: true,
      reason: null,
    }),
  });
  server = await listenLoopback(app, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  base = `http://127.0.0.1:${addr.port}`;
  token = (await (await fetch(`${base}/api/session`)).json() as { token: string }).token;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method === "POST" ? { "X-Orca-Dag-Token": token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

function fakeState(): Record<string, any> {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function logLines(): string[][] {
  const raw = readFileSync(logPath, "utf8").trim();
  return raw ? raw.split("\n").map((l) => JSON.parse(l) as string[]) : [];
}

describe("mutation-request audit surface", () => {
  it("requires a run id and starts empty", async () => {
    const missing = await call("GET", "/api/requests");
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "run_required");
    const empty = await call("GET", "/api/requests?run=run_a");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.requests, []);
  });

  it("records a manual release endpoint mutation and inspects it live via request-show", async () => {
    const release = await call("POST", "/api/workers/ctx_r1/release");
    assert.equal(release.status, 200);
    const receipt = release.json.receipt as { state: string; requestId: string | null };
    assert.equal(receipt.state, "released");
    assert.ok(receipt.requestId, "the endpoint minted and used a durable request id");

    const list = await call("GET", "/api/requests?run=run_a");
    assert.equal(list.status, 200);
    const requests = list.json.requests as Array<Record<string, unknown>>;
    // The coordinator is NOT running, so scope is positively unknown → the
    // row is stored unscoped and stays inspectable under every Run.
    const row = requests.find((r) => r.requestId === receipt.requestId);
    assert.ok(row, "the minted request id is durably listed");
    assert.equal(row!.operation, "worker-release");
    assert.equal(row!.runId, null, "no coordinator → run scope unknown, never guessed");
    assert.equal(row!.dispatchId, "ctx_r1");
    assert.equal(row!.settledLocally, true);

    // Live inspection: completed, with Orca's interpretation + outcome.
    const detail = await call(
      "GET",
      `/api/requests/${encodeURIComponent(String(receipt.requestId))}?run=run_a`,
    );
    assert.equal(detail.status, 200);
    const r = detail.json.receipt as Record<string, unknown>;
    assert.equal(r.state, "completed");
    assert.equal(r.probe, "orca");
    assert.match(String(r.interpretation), /completed/);
    const outcome = r.outcome as Record<string, unknown>;
    assert.equal(outcome.state, "released");
    assert.ok(outcome.archive, "release archive facts ride in the recorded outcome");

    // Unknown id → 404, and a foreign-Run row never leaks across the boundary.
    const unknown = await call("GET", `/api/requests/${"9".repeat(36)}?run=run_a`);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.code, "request_not_found");
  });

  it("presents absent, pending and failed-probe receipts as DISTINCT states", async () => {
    const ledger = new RequestLedger(workspace);
    // pending: Orca recorded the request without a final outcome.
    await ledger.record({
      requestId: "aaaaaaaa-0000-4000-8000-000000000001",
      operation: "worker-start",
      runId: "run_a",
      taskId: "task_a",
      dispatchId: null,
    });
    // absent: the id is not in Orca's records at all.
    await ledger.record({
      requestId: "aaaaaaaa-0000-4000-8000-000000000002",
      operation: "worker-release",
      runId: "run_a",
      taskId: null,
      dispatchId: "ctx_absent",
    });
    // unknown: the probe itself fails — the outcome stays unresolved.
    await ledger.record({
      requestId: "aaaaaaaa-0000-4000-8000-000000000003",
      operation: "worker-stop",
      runId: "run_a",
      taskId: null,
      dispatchId: "ctx_stop",
    });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: "1.4.205",
        requests: {
          "aaaaaaaa-0000-4000-8000-000000000001": {
            state: "pending",
            interpretation: "worker-start is still running or its outcome was not recorded",
            outcome: null,
          },
        },
        failProbes: ["aaaaaaaa-0000-4000-8000-000000000003"],
      }),
    );

    const probe = async (id: string) =>
      (await call("GET", `/api/requests/${id}?run=run_a`)).json.receipt as Record<string, unknown>;

    const pending = await probe("aaaaaaaa-0000-4000-8000-000000000001");
    assert.equal(pending.state, "pending");
    assert.match(String(pending.interpretation), /still running/);

    const absent = await probe("aaaaaaaa-0000-4000-8000-000000000002");
    assert.equal(absent.state, "absent", "absent is its own readable state");
    assert.match(String(absent.interpretation), /no recorded request/);

    const unknown = await probe("aaaaaaaa-0000-4000-8000-000000000003");
    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.probe, "failed", "a failed probe never masquerades as an Orca answer");

    // A row that positively names ANOTHER Run is out of scope for run_a.
    await ledger.record({
      requestId: "aaaaaaaa-0000-4000-8000-000000000004",
      operation: "worker-retain",
      runId: "run_z",
      taskId: null,
      dispatchId: "ctx_other",
    });
    const mismatch = await call(
      "GET",
      "/api/requests/aaaaaaaa-0000-4000-8000-000000000004?run=run_a",
    );
    assert.equal(mismatch.status, 404);
    assert.equal(mismatch.json.code, "request_run_mismatch");
    const own = await call("GET", "/api/requests/aaaaaaaa-0000-4000-8000-000000000004?run=run_z");
    assert.equal(own.status, 200);
    const list = await call("GET", "/api/requests?run=run_a");
    assert.equal(list.json.otherRunCount, 1, "foreign rows are excluded but counted");
  });

  it("never replays a mutation from a read surface: audit GETs only ever run request-show", async () => {
    const before = logLines();
    // A full pass over the read surface, including the row minted by the
    // release POST in the first test.
    await call("GET", "/api/requests?run=run_a");
    const list = await call("GET", "/api/requests?run=run_b");
    for (const row of (list.json.requests as Array<Record<string, unknown>>).slice(0, 3)) {
      await call("GET", `/api/requests/${encodeURIComponent(String(row.requestId))}?run=run_b`);
    }
    const after = logLines();
    const added = after.slice(before.length);
    assert.ok(added.length > 0, "the audit reads reached the fake CLI");
    for (const argv of added) {
      assert.equal(argv[1], "request-show", `read surface ran ${argv[1]} — replay is forbidden`);
    }
    // The deliberate release above is still the ONLY mutating verb on record.
    const mutators = after.filter((argv) =>
      ["worker-start", "worker-release", "worker-retain", "worker-stop"].includes(argv[1]),
    );
    assert.equal(mutators.length, 1, "no read endpoint ever minted a second mutation");
    assert.equal(fakeState().version, "1.4.205", "fake state untouched by reads");
  });
});
