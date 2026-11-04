import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTaskMessageReceipt, performTaskGuidance, recoverTaskGuidance } from "./taskGuidance";
import type { GuidanceSendCheckpoint, ProviderSessionStore } from "./providerSessions";
import type { WorkerDetailView } from "./orca";

const input = { runId: "run_1", taskId: "task_1", dispatchId: "dispatch_1", from: "terminal_1", subject: "Guidance", body: "Do the work" };

function memoryStore() {
  const rows: GuidanceSendCheckpoint[] = [];
  const store = {
    async listGuidanceSends(runId?: string) { return rows.filter(row => !runId || row.runId === runId); },
    async recordGuidanceSend(row: GuidanceSendCheckpoint) {
      const index = rows.findIndex(old => old.requestId === row.requestId);
      if (index < 0) rows.push(row); else rows[index] = row;
    },
  } satisfies Pick<ProviderSessionStore, "listGuidanceSends" | "recordGuidanceSend">;
  return { store, rows };
}

describe("durable task guidance", () => {
  it("journals before the send and records an ordinary destination", async () => {
    const { store, rows } = memoryStore();
    const result = await performTaskGuidance(input, { store, newRequestId: () => "req_1", send: async opts => {
      assert.equal(rows[0].state, "prepared");
      assert.equal(opts.requestId, "req_1");
      return { message: { run_id: "run_1", to_handle: "dispatch:dispatch_1" } };
    } });
    assert.equal(result.receipt.kind, "enqueued");
    assert.equal(rows[0].state, "enqueued");
    assert.equal(result.creationProven, false);
  });

  it("uses the routed address and does not claim a steered follow-up was created", async () => {
    const result = await normalizeTaskMessageReceipt({ message: { run_id: "run_1", to_handle: "dispatch:dispatch_2", task_id: "task_1" } }, input, "req_1",
      async () => ({ dispatchId: "dispatch_2", runId: "run_1", taskId: "task_2" }) as WorkerDetailView);
    assert.equal(result.receipt.taskId, "task_2");
    assert.equal(result.receipt.kind, "follow_up");
    assert.equal(result.creationProven, false);
  });

  it("recovers a lost start via its exact native request, without sending again", async () => {
    const { store, rows } = memoryStore();
    await assert.rejects(performTaskGuidance(input, { store, newRequestId: () => "req_1", send: async () => { throw new Error("lost"); } }));
    assert.equal(rows[0].state, "unknown");
    const result = await recoverTaskGuidance(rows[0], { store, send: async () => { throw new Error("must not send"); },
      showRequest: async id => ({ requestId: id, state: "completed", interpretation: null,
        raw: { method: "orchestration.send" }, outcome: { runId: "run_1", taskId: "task_2", dispatchId: "dispatch_2", state: "ready", delivery: "follow_up", followUpOf: "dispatch_1" } }) });
    assert.equal(result.creationProven, true);
    assert.equal(rows[0].receipt?.dispatchId, "dispatch_2");
  });

  it("holds an unknown follow-up even if native returned its identity", async () => {
    const { store, rows } = memoryStore();
    await assert.rejects(performTaskGuidance(input, { store, newRequestId: () => "req_1", send: async () => ({
      runId: "run_1", taskId: "task_2", dispatchId: "dispatch_2", state: "outcome_unknown", delivery: "follow_up", followUpOf: "dispatch_1",
    }) }), /unconfirmed/);
    assert.equal(rows[0].state, "unknown");
    assert.equal(rows[0].creationProven, true);
    assert.equal(rows[0].receipt?.dispatchId, "dispatch_2");
    assert.equal(rows[0].startEvidence?.status, "outcome_unknown");
  });

  it("never retries a mutation when request-show is absent or fails", async () => {
    const { store, rows } = memoryStore();
    let sends = 0;
    await assert.rejects(performTaskGuidance(input, { store, newRequestId: () => "req_lost",
      send: async () => { sends++; throw new Error("response lost"); } }));
    for (const showRequest of [async () => null, async () => { throw new Error("offline"); }]) {
      await assert.rejects(recoverTaskGuidance(rows[0], { store, showRequest }), { code: "guidance_unknown" });
      await assert.rejects(performTaskGuidance(input, { store, showRequest,
        send: async () => { sends++; return {}; } }), { code: "guidance_unknown" });
    }
    assert.equal(sends, 1);
    assert.equal(rows[0].state, "unknown");
  });

  it("does not turn a static unknown start into ready on recovery", async () => {
    const { store, rows } = memoryStore();
    const outcome = { runId: "run_1", taskId: "task_2", dispatchId: "dispatch_2",
      state: "outcome_unknown", delivery: "reopened", followUpOf: "dispatch_1" };
    await assert.rejects(performTaskGuidance(input, { store, newRequestId: () => "req_unknown", send: async () => outcome }));
    await assert.rejects(recoverTaskGuidance(rows[0], { store, showRequest: async id => ({
      requestId: id, state: "completed", interpretation: null, raw: { method: "orchestration.send" }, outcome,
    }) }), { code: "guidance_unknown" });
    assert.equal(rows[0].receipt?.dispatchId, "dispatch_2");
    assert.equal(rows[0].creationProven, true);
    assert.equal(rows[0].state, "unknown");
  });

  it("rejects cross-Run routes and unrecognized purported starts without claiming custody", async () => {
    const routed = { message: { run_id: "run_1", to_handle: "dispatch:dispatch_foreign" } };
    await assert.rejects(normalizeTaskMessageReceipt(routed, input, "req_1",
      async () => ({ dispatchId: "dispatch_foreign", runId: "run_other", taskId: "task_foreign" }) as WorkerDetailView));
    await assert.rejects(normalizeTaskMessageReceipt({ runId: "run_other", taskId: "task_2",
      dispatchId: "dispatch_2", state: "ready", delivery: "follow_up", followUpOf: "dispatch_1" }, input, "req_1"));
    await assert.rejects(normalizeTaskMessageReceipt({ runId: "run_1", taskId: "task_2",
      dispatchId: "dispatch_2", state: "ready", delivery: "invented", followUpOf: "dispatch_1" }, input, "req_1"));
  });

  it("never replaces an accepted unknown Dispatch with a different replay identity", async () => {
    const { store, rows } = memoryStore();
    await assert.rejects(performTaskGuidance(input, { store, newRequestId: () => "req_identity",
      send: async () => ({ runId: "run_1", taskId: "task_2", dispatchId: "dispatch_2",
        state: "outcome_unknown", delivery: "follow_up", followUpOf: "dispatch_1" }) }));
    await assert.rejects(recoverTaskGuidance(rows[0], { store, showRequest: async id => ({
      requestId: id, state: "completed", interpretation: null, raw: { method: "orchestration.send" },
      outcome: { runId: "run_1", taskId: "task_3", dispatchId: "dispatch_3",
        state: "ready", delivery: "follow_up", followUpOf: "dispatch_1" },
    }) }), /conflicts/);
    assert.equal(rows[0].receipt?.dispatchId, "dispatch_2");
    assert.equal(rows[0].state, "unknown");
  });
  it("recovers a positively evidenced nested coordinator redirect without adopting its Run", async () => {
    const { store, rows } = memoryStore();
    const outcome = { message: { run_id: "run_child", to_handle: "run:run_child" },
      warnings: [{ code: "recipient_run_bound_redirect", recipient: "dispatch:dispatch_1" }] };
    await assert.rejects(performTaskGuidance(input, { store, newRequestId: () => "req_redirect", send: async () => { throw new Error("lost"); } }));
    const result = await recoverTaskGuidance(rows[0], { store, showRequest: async id => ({
      requestId: id, state: "completed", interpretation: null, raw: { method: "orchestration.send" }, outcome,
    }), showWorker: async () => { throw new Error("must not adopt or inspect child"); } });
    assert.equal(result.receipt.kind, "recipient_run_bound_redirect");
    assert.equal(result.receipt.runId, "run_1");
    assert.equal(result.receipt.destinationRunId, "run_child");
    assert.equal(result.receipt.dispatchId, "dispatch_1");
    assert.equal(result.creationProven, false);
    await assert.rejects(normalizeTaskMessageReceipt({ ...outcome, warnings: [{ code: "recipient_run_bound_redirect", recipient: "dispatch:other" }] }, input, "req_redirect"));
    await assert.rejects(normalizeTaskMessageReceipt({ message: outcome.message }, input, "req_redirect"));
  });
});
