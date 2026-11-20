import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coordinatorStatus, retryWorker, startCoordinator, stopCoordinator } from "./coordinator";
import { setupCoordinatorHarness } from "./testHelpers/coordinatorHarness";

const {
  root,
  calls,
  callsOf,
  firstIndexOf,
  ackCalls,
  mutateState,
  getState,
  baseOpts,
  recordViewerLaunch,
  settleViaWorkerDone,
  settleViaTaskStatus,
  workerDoneMessage,
  waitFor,
  attempt,
  findAttempt,
  dispatchIdOf,
  waitForFakeQuiet,
  singleTaskState,
} = setupCoordinatorHarness();

describe("same-Run helper custody", () => {
  async function seedHelpers(runId: string, helperStatus = "completed") {
    await mutateState((s) => {
      s.runs = { [runId]: { id: runId, objective: "helper custody", legacy: 0 } };
      s.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "dispatched", deps: "[]", dispatch_id: "ctx_parent" },
        task_helper: { id: "task_helper", run_id: runId, parent_id: "task_aaa", status: helperStatus,
          deps: "[]", ...(helperStatus === "dispatched" ? { dispatch_id: "ctx_helper" } : {}) },
      };
      s.dispatches = {
        ctx_parent: { id: "ctx_parent", task_id: "task_aaa", run_id: runId, status: "dispatched",
          workerState: "ready", terminalState: "active", agentTerminal: "term_parent", creatorDispatchId: null, depth: 1 },
        ctx_helper: { id: "ctx_helper", task_id: "task_helper", run_id: runId, status: helperStatus,
          workerState: helperStatus === "completed" ? "succeeded" : "ready",
          terminalState: helperStatus === "completed" ? "reclaimable" : "active",
          agentTerminal: "term_helper", creatorDispatchId: "ctx_parent", depth: 2 },
      };
    });
    await recordViewerLaunch(runId, "task_aaa", "ctx_parent");
  }
  for (const terminalState of ["released", "retained"] as const) {
    it(`recovers a running descendant through a ${terminalState} historical helper`, async () => {
      const runId = `run_helper_history_recovery_${terminalState}`;
      await seedHelpers(runId, "dispatched");
      await mutateState(s => {
        s.tasks.task_helper.status = "completed";
        delete s.tasks.task_helper.dispatch_id;
        Object.assign(s.dispatches.ctx_helper, { status: "completed", workerState: "succeeded", terminalState });
        s.tasks.task_nested = { id: "task_nested", run_id: runId, parent_id: "task_helper", status: "dispatched", deps: "[]", dispatch_id: "ctx_nested" };
        s.dispatches.ctx_nested = { id: "ctx_nested", task_id: "task_nested", run_id: runId, status: "dispatched",
          workerState: "ready", terminalState: "active", agentTerminal: "term_nested", creatorDispatchId: "ctx_helper", depth: 3 };
      });
      await startCoordinator(baseOpts(runId));
      assert.equal(findAttempt("task_nested")?.dispatchId, "ctx_nested");
      assert.equal(findAttempt("task_helper"), undefined, "disposed history does not become an attempt");
      assert.equal(calls("worker-start").length, 0);
      await stopCoordinator();
    });

    it(`stops a running descendant through a ${terminalState} historical helper`, async () => {
      const runId = `run_helper_history_stop_${terminalState}`;
      await seedHelpers(runId, "dispatched");
      await mutateState(s => {
        s.tasks.task_helper.status = "completed";
        delete s.tasks.task_helper.dispatch_id;
        Object.assign(s.dispatches.ctx_helper, { status: "completed", workerState: "succeeded", terminalState });
        s.tasks.task_nested = { id: "task_nested", run_id: runId, parent_id: "task_helper", status: "dispatched", deps: "[]", dispatch_id: "ctx_nested" };
        s.dispatches.ctx_nested = { id: "ctx_nested", task_id: "task_nested", run_id: runId, status: "dispatched",
          workerState: "ready", terminalState: "active", agentTerminal: "term_nested", creatorDispatchId: "ctx_helper", depth: 3 };
      });
      await startCoordinator(baseOpts(runId));
      const report = await stopCoordinator();
      assert.equal(callsOf("worker-stop", "--dispatch", "ctx_nested").length, 1);
      assert.equal(report.results.find(row => row.target === "ctx_nested")?.result, "stopped");
      assert.equal(getState().dispatches.ctx_nested.status, "stopped");
      assert.equal(callsOf("worker-stop", "--dispatch", "ctx_helper").length, 0);
    });
  }
  it("recovers across multiple disposed exact creators without Task parent hints", async () => {
    const runId = "run_helper_multi_history";
    await seedHelpers(runId, "dispatched");
    await mutateState(s => {
      s.tasks.task_helper.status = "completed";
      delete s.tasks.task_helper.dispatch_id;
      Object.assign(s.dispatches.ctx_helper, { status: "completed", workerState: "succeeded", terminalState: "released" });
      s.tasks.task_middle = { id: "task_middle", run_id: runId, status: "completed", deps: "[]" };
      s.dispatches.ctx_middle = { id: "ctx_middle", task_id: "task_middle", run_id: runId, status: "completed",
        workerState: "succeeded", terminalState: "retained", creatorDispatchId: "ctx_helper", depth: 3 };
      s.tasks.task_nested = { id: "task_nested", run_id: runId, status: "dispatched", deps: "[]", dispatch_id: "ctx_nested" };
      s.dispatches.ctx_nested = { id: "ctx_nested", task_id: "task_nested", run_id: runId, status: "dispatched",
        workerState: "ready", terminalState: "active", creatorDispatchId: "ctx_middle", depth: 4 };
    });
    await startCoordinator(baseOpts(runId));
    assert.equal(findAttempt("task_nested")?.dispatchId, "ctx_nested");
    assert.equal(findAttempt("task_helper"), undefined);
    assert.equal(findAttempt("task_middle"), undefined);
    const report = await stopCoordinator();
    assert.equal(report.results.find(row => row.target === "ctx_nested")?.result, "stopped");
  });

  it("reports unknown Stop when a handed-back descendant has an unproven historical chain", async () => {
    const runId = "run_helper_unknown_history";
    await seedHelpers(runId, "dispatched");
    await mutateState(s => {
      s.tasks.task_helper.status = "completed";
      delete s.tasks.task_helper.dispatch_id;
      Object.assign(s.dispatches.ctx_helper, { status: "completed", workerState: "succeeded",
        terminalState: "released", creatorDispatchId: "ctx_missing" });
      s.tasks.task_nested = { id: "task_nested", run_id: runId, parent_id: "task_helper",
        status: "dispatched", deps: "[]", dispatch_id: "ctx_nested" };
      s.dispatches.ctx_nested = { id: "ctx_nested", task_id: "task_nested", run_id: runId, status: "dispatched",
        workerState: "ready", terminalState: "active", creatorDispatchId: "ctx_helper", depth: 3 };
    });
    await startCoordinator(baseOpts(runId));
    assert.equal(findAttempt("task_nested"), undefined);
    const report = await stopCoordinator();
    assert.equal(callsOf("worker-stop", "--dispatch", "ctx_nested").length, 0);
    assert.equal(report.results.find(row => row.target === "ctx_nested")?.result, "unknown");
  });


  it("leaves a settled helper with its active creator, then adopts and releases it after handback", async () => {
    const runId = "run_helpers";
    await seedHelpers(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => coordinatorStatus().checks.length > 0 ? true : null, "helper custody pass");
    assert.equal(findAttempt("task_helper"), undefined);
    assert.equal(callsOf("worker-release", "--dispatch", "ctx_helper").length, 0);
    await settleViaTaskStatus("task_aaa", "succeeded");
    await waitFor(() => coordinatorStatus().phase === "completed" ? true : null, "creator handback completion");
    assert.equal(attempt("task_helper").dispatchId, "ctx_helper");
    assert.equal(attempt("task_helper").terminalDecision, "released");
    assert.equal(calls("worker-start").length, 0, "handback adopts the existing Dispatch, never launches another");
    assert.equal(getState().dispatches.ctx_helper.terminalState, "released");
  });

  it("stops an active helper only after its viewer-owned creator settles during Stop", async () => {
    const runId = "run_helper_stop";
    await seedHelpers(runId, "dispatched");
    await startCoordinator(baseOpts(runId));
    await waitFor(() => coordinatorStatus().checks.length > 0 ? true : null, "active helper custody pass");
    const report = await stopCoordinator();
    assert.equal(callsOf("worker-stop", "--dispatch", "ctx_helper").length, 1);
    assert.equal(getState().dispatches.ctx_helper.status, "stopped");
    assert.equal(report.results.find(row => row.target === "ctx_helper")?.result, "stopped");
    assert.ok(firstIndexOf("worker-stop", "--dispatch", "ctx_parent") < firstIndexOf("worker-stop", "--dispatch", "ctx_helper"));
  });

  it("does not transfer helper custody from a missing creator", async () => {
    const runId = "run_helper_missing";
    await seedHelpers(runId);
    await mutateState(s => {
      delete s.dispatches.ctx_parent;
      s.tasks.task_aaa.status = "completed";
      delete s.tasks.task_aaa.dispatch_id;
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => coordinatorStatus().phase === "awaiting_input" ? true : null, "unverifiable helper owner");
    assert.equal(findAttempt("task_helper"), undefined);
    assert.equal(callsOf("worker-release", "--dispatch", "ctx_helper").length, 0);
    assert.equal(getState().dispatches.ctx_helper.terminalState, "reclaimable");
  });

  it("keeps an active retained helper under its creator's custody", async () => {
    const runId = "run_helper_retained";
    await seedHelpers(runId, "dispatched");
    await mutateState(s => { s.dispatches.ctx_helper.terminalState = "retained"; s.stopMode = { ctx_parent: "fail" }; });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => coordinatorStatus().checks.length > 0 ? true : null, "retained helper inspection");
    assert.equal(findAttempt("task_helper"), undefined);
    const report = await stopCoordinator();
    assert.equal(callsOf("worker-stop", "--dispatch", "ctx_helper").length, 0);
    assert.equal(report.results.find(row => row.target === "ctx_helper")?.result, "unknown");
    assert.equal(getState().dispatches.ctx_helper.status, "dispatched");
  });

  it("adopts an exact pending helper after creator settlement even when its Task is blocked", async () => {
    const runId = "run_helper_pending";
    await seedHelpers(runId, "dispatched");
    await mutateState(s => {
      s.tasks.task_helper.status = "blocked";
      delete s.tasks.task_helper.dispatch_id;
      s.dispatches.ctx_helper.status = "pending";
      s.dispatches.ctx_helper.workerState = "start_unknown";
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => coordinatorStatus().checks.length > 0 ? true : null, "pending delegated helper");
    assert.equal(findAttempt("task_helper"), undefined);
    await settleViaTaskStatus("task_aaa", "succeeded");
    await waitFor(() => findAttempt("task_helper")?.dispatchId === "ctx_helper" ? true : null, "pending helper handback");
    assert.equal(attempt("task_helper").settled, false);
    assert.equal(callsOf("worker-release", "--dispatch", "ctx_helper").length, 0);
    await stopCoordinator();
    assert.equal(callsOf("worker-stop", "--dispatch", "ctx_helper").length, 1);
  });

  it("discards an old helper inspection that returns after Stop and another Run starts", async () => {
    const runId = "run_helper_old";
    const replacement = "run_helper_new";
    const startedFile = join(root, "helper-inspection-started");
    const releaseFile = join(root, "helper-inspection-release");
    const oldBarriers = process.env.FAKE_ORCA_READ_BARRIERS;
    rmSync(startedFile, { force: true }); rmSync(releaseFile, { force: true });
    await seedHelpers(runId);
    await mutateState(s => { delete s.tasks.task_helper; delete s.dispatches.ctx_helper; });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => coordinatorStatus().checks.length > 0 ? true : null, "initial root inspection");
    process.env.FAKE_ORCA_READ_BARRIERS = JSON.stringify({ ctx_helper: { startedFile, releaseFile } });
    try {
      await mutateState(s => {
        s.tasks.task_aaa.status = "completed"; s.dispatches.ctx_parent.status = "completed";
        s.dispatches.ctx_parent.terminalState = "reclaimable";
        s.tasks.task_helper = { id: "task_helper", run_id: runId, parent_id: "task_aaa", status: "completed", deps: "[]" };
        s.dispatches.ctx_helper = { id: "ctx_helper", task_id: "task_helper", run_id: runId, status: "completed",
          workerState: "succeeded", terminalState: "reclaimable", creatorDispatchId: "ctx_parent", depth: 2 };
        s.runs[replacement] = { id: replacement, objective: "new Run", legacy: 0 };
        s.tasks.task_new = { id: "task_new", run_id: replacement, status: "ready", deps: "[]" };
      });
      await waitFor(() => existsSync(startedFile) ? true : null, "old exact helper read to block");
      const stopping = stopCoordinator();
      writeFileSync(releaseFile, "");
      await stopping;
      await startCoordinator(baseOpts(replacement));
      await dispatchIdOf("task_new");
      await waitFor(() => callsOf("worker-show", "--dispatch", "ctx_helper").length > 0 ? true : null, "old helper read to return");
      const reconciledAt = coordinatorStatus().lastReconciledAt ?? 0;
      await waitFor(() => (coordinatorStatus().lastReconciledAt ?? 0) > reconciledAt ? true : null, "new Run reconciliation");
      assert.equal(coordinatorStatus().runId, replacement);
      assert.equal(findAttempt("task_helper"), undefined);
      assert.equal(callsOf("worker-release", "--dispatch", "ctx_helper").length, 0);
      assert.equal(getState().dispatches.ctx_helper.terminalState, "reclaimable");
    } finally {
      writeFileSync(releaseFile, "");
      if (oldBarriers === undefined) delete process.env.FAKE_ORCA_READ_BARRIERS;
      else process.env.FAKE_ORCA_READ_BARRIERS = oldBarriers;
    }
  });

  it("does not mistake a planned Task parent for delegated Dispatch ownership", async () => {
    const runId = "run_planned_parent";
    await seedHelpers(runId);
    await mutateState(s => { s.dispatches.ctx_helper.creatorDispatchId = null; s.dispatches.ctx_helper.depth = 1; });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => coordinatorStatus().recovery?.unverifiable.includes("task_helper") ?? false, "foreign root remains visible");
    assert.equal(findAttempt("task_helper"), undefined);
    assert.equal(callsOf("worker-release", "--dispatch", "ctx_helper").length, 0);
    assert.equal(getState().dispatches.ctx_parent.status, "dispatched");
  });
});

describe("PTY-only automatic reuse", () => {
  it("starts a fresh dependent worker when a settled worker has a Chat handle but no PTY", async () => {
    const runId = "run_chat_no_pty";
    await mutateState(s => {
      s.runs = { [runId]: { id: runId, objective: "Chat identity", legacy: 0 } };
      s.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: '["task_aaa"]' },
      };
    });
    await startCoordinator(baseOpts(runId, { maxConcurrency: 1 }));
    const dispatchId = await dispatchIdOf("task_aaa");
    await mutateState(s => {
      s.dispatches[dispatchId].agentTerminal = "orca_session_id:chat_worker";
      s.dispatches[dispatchId].noPty = true;
    });
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_chat_done");
    await dispatchIdOf("task_bbb");
    assert.equal(attempt("task_aaa").terminalDecision, "released");
    assert.equal(calls("worker-start").some(call => call.argv.includes("--terminal")), false);
    assert.notEqual(getState().dispatches[attempt("task_bbb").dispatchId!].agentTerminal, "orca_session_id:chat_worker");
    await settleViaWorkerDone("task_bbb", "succeeded", "msg_chat_next_done");
    await waitFor(() => coordinatorStatus().phase === "completed" ? true : null, "Chat-dependent completion");
  });
});

describe("native OpenCode model boundary", () => {
  for (const scenario of [
    { name: "verified runtime model launch", model: "provider/model", advertised: true, mode: "supervised" },
    { name: "unadvertised model capability", model: "provider/model", advertised: false, mode: "legacy" },
    { name: "explicit model variant", model: "provider/model#high", advertised: true, mode: "legacy" },
  ] as const) {
    it(`settles and cleans up the correct launch path for ${scenario.name}`, async () => {
      const runId = "run_native_model_boundary";
      await singleTaskState(runId);
      await mutateState(s => {
        s.runtime = { appVersion: "1.4.241",
          capabilities: scenario.advertised ? ["orchestration.worker-launch-preferences.v1"] : [] };
      });
      await startCoordinator(baseOpts(runId, {
        defaultHarness: "opencode", modelByTask: { task_aaa: scenario.model },
      }));
      await dispatchIdOf("task_aaa");
      assert.equal(attempt("task_aaa").mode, scenario.mode);
      if (scenario.mode === "supervised") {
        assert.equal(calls("dispatch").length, 0);
      } else {
        assert.equal(calls("worker-start").length, 0);
      }
      await settleViaWorkerDone("task_aaa", "succeeded", "msg_native_model_boundary");
      await waitFor(() => coordinatorStatus().phase === "completed" ? true : null, "model-path completion");
      assert.equal(attempt("task_aaa").terminalDecision, scenario.mode === "supervised" ? "released" : "closed");
    });
  }

  it("parks a refused native model start without creating a second one-shot worker", async () => {
    const runId = "run_native_model_refused";
    await singleTaskState(runId);
    await mutateState(s => {
      s.runtime = { appVersion: "1.4.241", capabilities: ["orchestration.worker-launch-preferences.v1"] };
      s.workerStartFail = { code: "invalid_argument", message: "execution-host model verification refused" };
    });
    await startCoordinator(baseOpts(runId, {
      defaultHarness: "opencode", modelByTask: { task_aaa: "provider/model" },
    }));
    await waitFor(() => findAttempt("task_aaa")?.settledVia === "start_failed" ? true : null, "native model refusal");
    assert.equal(calls("worker-start").length, 1);
    assert.equal(calls("dispatch").length, 0);
    assert.equal(findAttempt("task_aaa")?.settled, true);
    assert.equal(getState().tasks.task_aaa.status, "ready");
  });
});

describe("recovered worker_done ownership acknowledgement", () => {
  it("decides a recovered settled worker's terminal ownership before acknowledging its Delivery", async () => {
    const runId = "run_recovered_mail";
    const deliveryId = "delivery_recovered";
    await mutateState(s => {
      s.runs = { [runId]: { id: runId, objective: "recovered mail", legacy: 0 } };
      s.tasks = { task_aaa: { id: "task_aaa", run_id: runId, status: "completed", deps: "[]" } };
      s.dispatches = { ctx_recovered: { id: "ctx_recovered", task_id: "task_aaa", run_id: runId,
        status: "completed", workerState: "succeeded", terminalState: "reclaimable", agentTerminal: "term_recovered" } };
      s.seq = { terminal: 0 };
      s.mailboxes = { term_f1: [{ deliveryId, messages: [
        { ...workerDoneMessage("task_aaa", "ctx_recovered", "succeeded", "msg_recovered"), run_id: runId, from_handle: "term_recovered" },
      ] }] };
    });
    await recordViewerLaunch(runId, "task_aaa", "ctx_recovered");
    await startCoordinator(baseOpts(runId));
    await waitFor(() => coordinatorStatus().phase === "completed" ? true : null, "recovered Delivery completion");
    const releaseIndex = firstIndexOf("worker-release", "--dispatch", "ctx_recovered");
    const ackIndex = firstIndexOf("check", "--ack", deliveryId);
    assert.ok(releaseIndex >= 0 && ackIndex > releaseIndex, "release/retain must execute before the recovered Delivery is acknowledged");
    assert.equal(getState().dispatches.ctx_recovered.terminalState, "released");
  });
});

describe("FIFO drain responsiveness", () => {
  it("drains distinct ACK-returned batches before another polling interval and holds an unanswered question", async () => {
    const runId = "run_fifo_drain";
    const deliveries = ["status", "status", "question"].map((type, index) => ({
      deliveryId: `delivery_drain_${index}`,
      messages: [{
        id: `msg_drain_${index}`, type, from_handle: "term_sender",
        to_handle: `run:${runId}`, run_id: runId, subject: `drain ${index}`,
        body: "Inspect the current batch", created_at: new Date().toISOString(),
      }],
    }));
    await mutateState(s => {
      s.runs = { [runId]: { id: runId, objective: "FIFO drain", legacy: 0 } };
      s.tasks = {};
      s.mailboxes = { term_f1: deliveries };
    });
    // Larger than the observation deadline: a cached next Delivery must not
    // wait for the next polling interval. No exact duration is asserted.
    await startCoordinator(baseOpts(runId, { tickWaitMs: 4000 }));
    await waitFor(() => {
      const status = coordinatorStatus();
      return status.phase === "awaiting_input" &&
        status.inbox.pending.some(item => item.messageId === "msg_drain_2") ? true : null;
    }, "already-delivered question before the next poll", 3000);
    assert.equal(ackCalls("delivery_drain_0").length, 1);
    assert.equal(ackCalls("delivery_drain_1").length, 1);
    assert.equal(ackCalls("delivery_drain_2").length, 0, "unanswered questions still hold ACK");
    assert.equal(coordinatorStatus().running, true, "the pending question still blocks Run completion");
  });
});

describe("Orca 1.4.242 worker-start settlement receipts", () => {
  for (const outcome of ["succeeded", "failed"] as const) {
    it(`uses the exact Task and Dispatch settlement after a ready receipt reports ${outcome}`, async () => {
      const runId = `run_242_${outcome}`;
      await mutateState((s) => {
        s.runs = { [runId]: { id: runId, objective: "worker-start receipt settlement", legacy: 0 } };
        s.tasks = {
          task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        };
        if (outcome === "succeeded") {
          s.tasks.task_bbb = { id: "task_bbb", run_id: runId, status: "pending", deps: '["task_aaa"]' };
        }
        s.workerStartSettlement = outcome;
      });
      await startCoordinator(baseOpts(runId, { maxConcurrency: 1 }));
      await waitFor(() => {
        const a = findAttempt("task_aaa");
        return a?.settled && a.startReceipt?.workerOutcome === outcome ? a : null;
      }, "242 ready/settled receipt");
      const a = attempt("task_aaa");
      assert.equal(a.startReceipt?.status, "ready");
      assert.equal(a.startReceipt?.stage, "settled");
      assert.equal(a.outcome, outcome, "Task/Dispatch evidence, not the receipt alone, settles the attempt");
      assert.equal(a.settled, true);
      assert.equal(a.settledVia, "task_status");
      assert.equal(getState().tasks.task_aaa.status, outcome === "succeeded" ? "completed" : "failed");
      assert.equal(getState().dispatches[a.dispatchId!].status, outcome === "succeeded" ? "completed" : "failed");
      await waitFor(() => ["released", "reused"].includes(attempt("task_aaa").terminalDecision) ? true : null,
        "settled Dispatch ownership decision");
      if (outcome === "succeeded") {
        await waitFor(() => calls("worker-start").some((call) => call.argv.includes("task_bbb")) ? true : null,
          "dependent Task progress");
        assert.equal(attempt("task_bbb").settled, false, "the next worker-start is still a live Task");
        await settleViaWorkerDone("task_bbb", "succeeded", "msg_242_dependent");
        await waitFor(() => coordinatorStatus().phase === "completed" ? true : null, "dependent run completion");
      } else {
        await waitForFakeQuiet();
        assert.equal(calls("worker-start").length, 1, "a failed Task is cleaned up, not automatically replaced");
        assert.equal(calls("worker-start").filter((call) => call.argv.includes("task_aaa")).length, 1);
      }
    });
  }

  it("retains an explicit unknown receipt and exact slot until positive settlement, without replay or replacement", async () => {
    const runId = "run_242_unknown";
    await mutateState((s) => {
      s.runs = { [runId]: { id: runId, objective: "unknown start recovery", legacy: 0 } };
      s.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: "[]" },
      };
      s.workerStartUnknown = true;
    });
    await startCoordinator(baseOpts(runId, { maxConcurrency: 1 }));
    await waitFor(() => findAttempt("task_aaa")?.startReceipt?.status === "outcome_unknown" ? true : null,
      "explicit outcome-unknown receipt");
    const a = attempt("task_aaa");
    const exactDispatch = a.dispatchId!;
    const exactRequest = a.startRequestId!;
    assert.ok(exactDispatch);
    assert.ok(exactRequest);
    assert.equal(a.startReceipt?.dispatchId, exactDispatch);
    assert.equal(a.startReceipt?.requestId, exactRequest);
    assert.equal(a.settled, false);
    assert.equal(a.outcome, null);
    assert.equal(a.settledVia, null);
    assert.equal(a.terminalDecision, "pending");
    assert.equal(callsOf("worker-release", "--dispatch", exactDispatch).length, 0,
      "an unknown start cannot authorize release");
    await assert.rejects(retryWorker("task_aaa"), /not positively failed/);
    await waitForFakeQuiet();
    assert.equal(calls("worker-start").filter((call) => call.argv.includes("task_aaa")).length, 1,
      "explicit unknown does not replay or place a replacement");
    assert.equal(calls("worker-start").some((call) => call.argv.includes("task_bbb")), false,
      "the unresolved exact Dispatch continues to consume the only slot");
    assert.equal(getState().tasks.task_aaa.dispatch_id, exactDispatch);

    await mutateState((s) => {
      delete s.workerStartUnknown;
      const task = s.tasks.task_aaa;
      const dispatch = s.dispatches[exactDispatch];
      task.status = "completed";
      dispatch.status = "completed";
      dispatch.terminalState = "reclaimable";
    });
    await waitFor(() => attempt("task_aaa").settled && attempt("task_aaa").outcome === "succeeded" ? true : null,
      "positive exact Task/Dispatch settlement");
    await waitFor(() => ["released", "reused"].includes(attempt("task_aaa").terminalDecision) ? true : null,
      "unknown Dispatch ownership cleanup");
    assert.equal(attempt("task_aaa").dispatchId, exactDispatch, "settlement preserves Dispatch ownership");
    assert.equal(attempt("task_aaa").startRequestId, null, "positive settlement retires the exact request pointer");
    await waitFor(() => calls("worker-start").some((call) => call.argv.includes("task_bbb")) ? true : null,
      "queued work starts after exact settlement frees the slot");
    assert.equal(calls("worker-start").filter((call) => call.argv.includes("task_aaa")).length, 1);
    await settleViaWorkerDone("task_bbb", "succeeded", "msg_242_unknown_dependent");
    await waitFor(() => coordinatorStatus().phase === "completed" ? true : null, "recovered run completion");
  });
});
