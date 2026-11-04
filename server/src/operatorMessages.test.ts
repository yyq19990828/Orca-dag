import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ProviderSessionStore } from "./providerSessions";
import { performOperatorGroupSend, performOperatorReply, preflightOperatorMessage } from "./operatorMessages";

const reply = { runId: "run_1", messageId: "msg_1", body: "yes", from: "term_1" };
const group = { runId: "run_1", audience: "@all", body: "pause", subject: "Notice", type: "status", from: "term_1" };

describe("durable operator messaging", () => {
  it("recovers a lost reply after restart without a second native mutation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-operator-"));
    try {
      let sends = 0;
      await assert.rejects(performOperatorReply(reply, { store: new ProviderSessionStore(dir), newRequestId: () => "req_1",
        reply: async () => { sends++; throw new Error("lost"); } }));
      const result = await preflightOperatorMessage({ operation: "reply", ...reply }, { store: new ProviderSessionStore(dir),
        showRequest: async id => ({ requestId: id, state: "completed", interpretation: null, raw: { method: "orchestration.reply" },
          outcome: { message: { id: "answer_1", run_id: "run_1" }, question: { message_id: "msg_1", run_id: "run_1" } } }) });
      assert.equal(result?.requestId, "req_1");
      assert.equal(sends, 1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reconciles a lost group receipt without accepting a changed body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-operator-"));
    try {
      let sends = 0;
      await assert.rejects(performOperatorGroupSend(group, { store: new ProviderSessionStore(dir), newRequestId: () => "req_group",
        sendGroup: async () => { sends++; throw new Error("lost"); } }));
      const outcome = { recipients: 1, messages: [{ run_id: "run_1", to_handle: "dispatch:d1" }], warnings: [{ code: "notice" }] };
      await assert.rejects(preflightOperatorMessage({ operation: "group", ...group, body: "continue" }, { store: new ProviderSessionStore(dir),
        showRequest: async id => ({ requestId: id, state: "completed", interpretation: null,
          raw: { method: "orchestration.send" }, outcome }) }), { code: "operator_message_reconciled", requestId: "req_group" });
      assert.equal(sends, 1);
      const rows = await new ProviderSessionStore(dir).listOperatorMessages("run_1");
      assert.deepEqual(rows[0].outcome, outcome);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("recovers an earlier live answer into its durable mailbox checkpoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-operator-"));
    try {
      const store = new ProviderSessionStore(dir);
      const now = new Date().toISOString();
      const message = { id: "msg_1", run_id: "run_1", delivery_contract: null, from_handle: "dispatch:d1",
        to_handle: "run:run_1", subject: "Question", body: "Choose", type: "question", priority: "normal",
        thread_id: null, payload: null, created_at: now, delivered_at: now };
      await store.recordMailboxCheck({ requestId: "check_1", runId: "run_1", from: "term_old", ack: null,
        state: "pending_input", delivery: { runId: "run_1", deliveryId: "delivery_1", messages: [message], count: 1,
          replayed: false, deliveryAcknowledged: true, acknowledged: null, timedOut: false, cancelled: false, connectionLost: false },
        processedMessageIds: ["msg_1"], pendingQuestionIds: ["msg_1"],
        replyRequests: { msg_1: { requestId: "reply_old", from: "term_old", bodyHash: createHash("sha256").update("yes").digest("hex"), state: "unknown" } },
        createdAt: now, updatedAt: now, error: null });
      await assert.rejects(preflightOperatorMessage({ operation: "reply", ...reply, body: "no" }, { store,
        showRequest: async id => ({ requestId: id, state: "completed", interpretation: null, raw: { method: "orchestration.reply" },
          outcome: { message: { id: "answer_1", run_id: "run_1" }, question: { message_id: "msg_1", run_id: "run_1" } } }) }),
      { code: "operator_message_reconciled" });
      const checkpoint = (await new ProviderSessionStore(dir).listMailboxChecks("run_1"))[0];
      assert.equal(checkpoint.state, "completed");
      assert.deepEqual(checkpoint.pendingQuestionIds, []);
      assert.equal(checkpoint.replyRequests?.msg_1.requestId, "reply_old");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("recovers workspace broadcast recipients in another Run without rebroadcasting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-operator-"));
    try {
      const workspace = { ...group, audience: "@worktree:repo::/workspace" };
      let sends = 0;
      await assert.rejects(performOperatorGroupSend(workspace, {
        store: new ProviderSessionStore(dir), newRequestId: () => "req_workspace",
        sendGroup: async () => { sends++; throw new Error("response lost after enqueue"); },
      }));
      const outcome = { recipients: 1, messages: [
        { id: "msg_other", run_id: "run_other", to_handle: "dispatch:ctx_other" },
      ] };
      const result = await preflightOperatorMessage({ operation: "group", ...workspace }, {
        store: new ProviderSessionStore(dir),
        showRequest: async id => ({ requestId: id, state: "completed", interpretation: null,
          raw: { method: "orchestration.send" }, outcome }),
      });
      assert.equal(result?.requestId, "req_workspace");
      assert.equal(sends, 1);
      assert.equal((await new ProviderSessionStore(dir).listOperatorMessages("run_1"))[0].state, "completed");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("keeps an unrelated cross-Run receipt unknown for a Run-scoped broadcast", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-operator-"));
    try {
      await assert.rejects(performOperatorGroupSend(group, {
        store: new ProviderSessionStore(dir), newRequestId: () => "req_foreign",
        sendGroup: async () => ({ recipients: 1, messages: [
          { id: "msg_other", run_id: "run_other", to_handle: "dispatch:ctx_other" },
        ] }),
      }), { code: "operator_message_unknown" });
      assert.equal((await new ProviderSessionStore(dir).listOperatorMessages("run_1"))[0].state, "unknown");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("recovers a parent broadcast sent to a nested Run mailbox without a redirect warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-operator-"));
    try {
      let sends = 0;
      await assert.rejects(performOperatorGroupSend(group, { store: new ProviderSessionStore(dir), newRequestId: () => "req_nested_group",
        sendGroup: async () => { sends++; throw new Error("lost"); } }));
      const outcome = { recipients: 1, messages: [{ id: "msg_child", run_id: "run_child", to_handle: "run:run_child" }] };
      const result = await preflightOperatorMessage({ operation: "group", ...group }, { store: new ProviderSessionStore(dir),
        showRequest: async id => ({ requestId: id, state: "completed", interpretation: null, raw: { method: "orchestration.send" }, outcome }) });
      assert.deepEqual(result?.outcome, outcome);
      assert.equal(sends, 1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("recovers a nested reply only for the durable original thread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-operator-"));
    try {
      let sends = 0;
      await assert.rejects(performOperatorReply({ ...reply, sourceThreadId: "thread_parent" }, {
        store: new ProviderSessionStore(dir), newRequestId: () => "req_nested_reply",
        reply: async () => { sends++; throw new Error("lost"); },
      }));
      const outcome = { message: { id: "answer_child", run_id: "run_child", to_handle: "run:run_child", thread_id: "thread_other" } };
      const showRequest = async (id: string) => ({ requestId: id, state: "completed", interpretation: null,
        raw: { method: "orchestration.reply" }, outcome });
      await assert.rejects(preflightOperatorMessage({ operation: "reply", ...reply }, { store: new ProviderSessionStore(dir), showRequest }),
        { code: "operator_message_unknown" });
      outcome.message.thread_id = "thread_parent";
      const result = await preflightOperatorMessage({ operation: "reply", ...reply }, { store: new ProviderSessionStore(dir), showRequest });
      assert.deepEqual(result?.outcome, outcome);
      assert.equal(sends, 1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
