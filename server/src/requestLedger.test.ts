import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestLedger, REQUESTS_FILE } from "./requestLedger";

/**
 * Phase 5 acceptance: bounded, atomic, restart-durable metadata for
 * viewer-originated mutation requests. The ledger must behave exactly like
 * the activity journal (append-only JSONL, rotation, torn-line tolerance)
 * while never storing more than ids, scope, and bounded notes — the recorded
 * state of a mutation always comes from a live `request-show`, never from
 * this file.
 */

async function tempWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "orca-dag-ledger-test-"));
  await mkdir(join(workspace, ".orca-dag"));
  return workspace;
}

describe("request ledger", () => {
  it("returns an empty list when no ledger file exists", async () => {
    const ws = await tempWorkspace();
    try {
      assert.deepEqual(await new RequestLedger(ws).list(), []);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("persists records across instances (restart durability) and lists newest first", async () => {
    const ws = await tempWorkspace();
    try {
      const first = new RequestLedger(ws);
      await first.record({
        requestId: "11111111-1111-4111-8111-111111111111",
        operation: "worker-start",
        runId: "run_a",
        taskId: "task_a",
        dispatchId: null,
      });
      await first.record({
        requestId: "22222222-2222-4222-8222-222222222222",
        operation: "worker-release",
        runId: "run_a",
        taskId: "task_a",
        dispatchId: "ctx_1",
        settledLocally: true,
        note: "viewer-observed terminal state: released",
      });
      // A SECOND instance over the same workspace = a restarted viewer.
      const rows = await new RequestLedger(ws).list();
      assert.equal(rows.length, 2);
      assert.equal(rows[0].requestId, "22222222-2222-4222-8222-222222222222", "newest first");
      assert.equal(rows[1].operation, "worker-start");
      assert.equal(rows[1].dispatchId, null, "start rows are minted before a dispatch exists");
      assert.equal(rows[0].settledLocally, true);
      assert.equal(rows[0].recordType, "mutation_request");
      assert.ok(rows[0].createdAt, "createdAt is set");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("upserts by request id: last observation wins, createdAt stays from the mint line", async () => {
    const ws = await tempWorkspace();
    try {
      const ledger = new RequestLedger(ws);
      await ledger.record({
        requestId: "33333333-3333-4333-8333-333333333333",
        operation: "worker-start",
        runId: "run_a",
        taskId: "task_b",
        dispatchId: null,
        note: null,
      });
      await ledger.record({
        requestId: "33333333-3333-4333-8333-333333333333",
        operation: "worker-start",
        runId: "run_a",
        taskId: "task_b",
        dispatchId: "ctx_s9",
        settledLocally: true,
        note: "landed as dispatch ctx_s9",
      });
      const rows = await ledger.list();
      assert.equal(rows.length, 1, "one row per request id");
      const row = rows[0];
      assert.equal(row.dispatchId, "ctx_s9", "the later line wins");
      assert.equal(row.note, "landed as dispatch ctx_s9");
      assert.equal(row.settledLocally, true);
      assert.ok(row.updatedAt >= row.createdAt, "updatedAt never precedes createdAt");
      // createdAt is STABLE across reads: the first line fixes it forever.
      const reread = await new RequestLedger(ws).list();
      assert.equal(reread[0].createdAt, row.createdAt);
      // The file itself keeps BOTH lines (append-only audit trail).
      const raw = await readFile(join(ws, REQUESTS_FILE), "utf8");
      assert.equal(raw.trim().split("\n").length, 2);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("keeps records bounded: ids and notes are clamped, garbage metadata is skipped", async () => {
    const ws = await tempWorkspace();
    try {
      const ledger = new RequestLedger(ws);
      await ledger.record({
        requestId: "44444444-4444-4444-8444-444444444444",
        operation: "worker-retain",
        runId: "run_" + "x".repeat(500),
        taskId: "task_c",
        dispatchId: "ctx_2",
        note: "y".repeat(2000),
      });
      await ledger.record({
        requestId: "",
        operation: "worker-stop",
        runId: null,
        taskId: null,
        dispatchId: null,
      }); // no inspectable id → nothing persisted
      const rows = await ledger.list();
      assert.equal(rows.length, 1);
      assert.ok(rows[0].runId!.length <= 128, "ids are clamped to the HTTP boundary budget");
      assert.ok(rows[0].note!.length <= 300, "notes are clamped to 300 chars");
      assert.match(rows[0].note!, /\.\.\.$/, "clamped notes are visibly truncated");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("survives a torn final append and never loads foreign record types", async () => {
    const ws = await tempWorkspace();
    try {
      const path = join(ws, REQUESTS_FILE);
      const good =
        JSON.stringify({
          recordType: "mutation_request",
          requestId: "55555555-5555-4555-8555-555555555555",
          operation: "worker-start",
          runId: "run_a",
          taskId: "task_d",
          dispatchId: null,
          note: null,
          settledLocally: null,
          createdAt: "2026-09-21T10:00:00.000Z",
          updatedAt: "2026-09-21T10:00:00.000Z",
        }) + "\n";
      await writeFile(path, good + `{"recordType":"mutation_request","requestId":"torn`, "utf8");
      const rows = await new RequestLedger(ws).list();
      assert.equal(rows.length, 1, "the torn line is skipped, the good line survives");
      assert.equal(rows[0].requestId, "55555555-5555-4555-8555-555555555555");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("rotates like the activity journal so the ledger cannot grow without bound", async () => {
    const ws = await tempWorkspace();
    try {
      const path = join(ws, REQUESTS_FILE);
      // A filler line ~2.5MB: over the 5MB rotation threshold, under the
      // 2MB keep window, so rotation must drop it and keep the tail.
      const filler = "0".repeat(2_500_000);
      await writeFile(path, `{"filler":"${filler}"}\n`, "utf8");
      const ledger = new RequestLedger(ws);
      await ledger.record({
        requestId: "66666666-6666-4666-8666-666666666666",
        operation: "worker-stop",
        runId: "run_a",
        taskId: "task_e",
        dispatchId: "ctx_3",
      });
      const size = (await readFile(path, "utf8")).length;
      assert.ok(size < 2_600_000, `rotated file stays small (got ${size} bytes)`);
      const rows = await ledger.list();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].operation, "worker-stop");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
