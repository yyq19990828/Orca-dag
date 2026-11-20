import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { answerInboxItem, sendTaskGuidance, coordinatorStatus, recordResumedWorker, startCoordinator, stopCoordinator, withLifecycleMutation } from "./coordinator";
import { initOrcaRuntime, parseWorkerStartReceipt } from "./orca";
import { ProviderSessionStore } from "./providerSessions";
import { setupCoordinatorHarness } from "./testHelpers/coordinatorHarness";

const {
  root,
  workspace,
  fixturePath,
  calls,
  callsOf,
  firstIndexOf,
  ackCalls,
  mutateState,
  getState,
  baseTasks,
  baseOpts,
  recordViewerLaunch,
  coordinatorTerminal,
  settleViaWorkerDone,
  settleViaTaskStatus,
  injectMail,
  workerDoneMessage,
  waitFor,
  attempt,
  findAttempt,
  dispatchIdOf,
  processedRow,
  singleTaskState,
} = setupCoordinatorHarness();

describe("two-wave DAG: dependency order, concurrency cap, completion boundary", () => {
  it("runs two parallel roots then the dependent, releases every settled worker (success AND failure), and completes with zero reclaimable workers", async () => {
    const runId = "run_t";
    await mutateState((state) => {
      state.tasks = baseTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });

    await startCoordinator(baseOpts(runId, { maxConcurrency: 2 }));

    // Wave 1: both roots start before either settles; the dependent does not.
    await waitFor(() => (calls("worker-start").length >= 2 ? true : null), "both root tasks to start");
    const startOrder = calls("worker-start").map((c) => c.argv[c.argv.indexOf("--task") + 1]);
    assert.ok(startOrder.includes("task_aaa") && startOrder.includes("task_bbb"), `wave 1 started ${startOrder}`);
    assert.equal(calls("worker-start").filter((c) => c.argv.includes("task_ccc")).length, 0, "dependent must not start before its deps settle");

    // A settles via an accepted worker_done; B via Orca's own task record
    // (worker_done ack lost is not a stuck run — but C still waits for both).
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_a1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "A to release");
    assert.equal(attempt("task_aaa").settledVia, "worker_done");
    assert.ok(attempt("task_aaa").output && attempt("task_aaa").output!.lines.includes("output of task_aaa"), "output archived before release");

    await settleViaTaskStatus("task_bbb", "succeeded");
    // Phase 5: B settles LAST, so C is already ready at B's ownership
    // decision — B's terminal is the immediate compatible follow-up (same
    // harness, no model) and is REUSED for C instead of released. A, which
    // settled while C was still pending, took the default release.
    await waitFor(() => (attempt("task_bbb").terminalDecision === "reused" ? true : null), "B's terminal to be reused for C");
    assert.equal(attempt("task_bbb").settledVia, "task_status");

    // Wave 2: the dependent starts only after BOTH roots settled — C on B's
    // reused terminal (--terminal, never --agent), A genuinely released first.
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_ccc")) ? true : null), "C to start");
    const cStart = calls("worker-start").find((c) => c.argv.includes("task_ccc"))!;
    const cStartIdx = firstIndexOf("worker-start", "--task", "task_ccc");
    const aReleaseIdx = firstIndexOf("worker-release", "--dispatch", attempt("task_aaa").dispatchId!);
    assert.ok(aReleaseIdx >= 0 && aReleaseIdx < cStartIdx, `A released before C started (release at ${aReleaseIdx}, C start at ${cStartIdx})`);
    const bTerminal = (getState().dispatches as Record<string, any>)[attempt("task_bbb").dispatchId!].agentTerminal;
    assert.ok(cStart.argv.includes("--terminal"), "C started via terminal reuse");
    assert.ok(cStart.argv.includes(bTerminal), `C must run on B's terminal ${bTerminal}`);
    assert.ok(!cStart.argv.includes("--agent"), "a reused terminal relaunches nothing");
    assert.equal(findAttempt("task_ccc")!.reuseOf, attempt("task_bbb").dispatchId, "C inherited B's Dispatch lineage");
    assert.equal(
      callsOf("worker-release", "--dispatch", attempt("task_bbb").dispatchId!).length,
      0,
      "B's terminal was never released — ownership transferred, exactly one new Dispatch",
    );

    // C FAILS — a failed worker reaches `released` too (after archiving).
    await settleViaWorkerDone("task_ccc", "failed", "msg_c1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");

    const status = coordinatorStatus();
    assert.equal(status.error, null);
    assert.equal(status.attempts.length, 3);
    for (const a of status.attempts) {
      // B's terminal was REUSED by C; the rest took the default release.
      const expected = a.taskId === "task_bbb" ? "reused" : "released";
      assert.equal(a.terminalDecision, expected, `${a.taskId} must be ${expected}`);
      assert.ok(a.settledVia === "worker_done" || a.settledVia === "task_status", `${a.taskId} settledVia ${a.settledVia}`);
      assert.ok(a.output, `${a.taskId} output archived`);
    }
    assert.equal(attempt("task_ccc").outcome, "failed");
    assert.deepEqual(status.cleanupDebt, [], "no cleanup debt at completion");
    assert.ok(status.completedAt !== null && status.completedAt > 0);
    assert.ok(status.checks.length > 0, "every rolling inbox pass leaves a bounded receipt");
    assert.ok(status.checks.some((receipt) => receipt.messageCount === 0), "empty checks remain visible");
    assert.ok(
      status.checks.some((receipt) => receipt.messageTypes.includes("worker_done")),
      "message-bearing checks retain their readable message types",
    );
    const agentSnapshot = status.checks.flatMap((receipt) => receipt.agents).find((agent) => agent.taskId === "task_aaa");
    assert.ok(agentSnapshot, "a check receipt carries a compact per-agent snapshot");
    assert.equal(agentSnapshot.agent, "claude");

    // Boundary clause 4: the coordinator itself queried the fleet and refused
    // to complete while anything was reclaimable — so a completed phase plus
    // the log proves the query ran and returned empty.
    assert.ok(calls("worker-list").some((c) => c.argv.includes("reclaimable")), "completion queried worker-list --terminal-state reclaimable");
    const remaining = Object.values(getState().dispatches as Record<string, any>).filter((d) => d.terminalState === "reclaimable");
    assert.deepEqual(remaining, [], "no reclaimable worker at completion");

    // Boundary clause 6: the coordinator terminal verifiably closed — poll the
    // runtime's own record rather than a snapshot taken mid-close.
    await waitFor(() => {
      const closed = (getState().terminals as any[]).filter((t) => (t.title ?? "").startsWith("orca-dag coordinator"));
      return closed.length > 0 && closed.every((t) => t.connected === false) ? true : null;
    }, "coordinator terminal to close in Orca");
  });

  it("respects maxConcurrency=1: no second start slips through before settlement", async () => {
    const runId = "run_cap";
    await mutateState((state) => {
      state.tasks = baseTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(baseOpts(runId, { maxConcurrency: 1 }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "first worker to start");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls("worker-start").length, 1, "concurrency cap holds before settlement");
    await stopCoordinator();
  });
});

describe("guidance custody", () => {
  it("tracks the actual follow-up created during settlement and stops it", async () => {
    const runId = "run_guidance_race";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    const oldDispatch = await dispatchIdOf("task_aaa");
    await mutateState(s => { s.followUpOnSend = { taskId: "task_followup", dispatchId: "ctx_followup" }; });
    const receipt = await sendTaskGuidance({ runId, taskId: "task_aaa", subject: "Guidance", body: "Please refine" });
    assert.equal(receipt.kind, "follow_up");
    assert.equal(receipt.requestedDispatchId, oldDispatch);
    assert.equal(receipt.dispatchId, "ctx_followup");
    const report = await stopCoordinator();
    assert.ok(report.results.some(row => row.target === "ctx_followup" && row.result !== "unknown"));
    assert.equal(getState().dispatches.ctx_followup.status, "stopped");
  });

  it("holds unknown follow-up readiness, but still stops the natively proven root", async () => {
    const runId = "run_guidance_unknown";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await dispatchIdOf("task_aaa");
    await mutateState(s => { s.followUpOnSend = { taskId: "task_uncertain", dispatchId: "ctx_uncertain", unknown: true }; });
    await assert.rejects(sendTaskGuidance({ runId, taskId: "task_aaa", subject: "Guidance", body: "Please refine" }));
    const beforeStop = await new ProviderSessionStore(workspace).listGuidanceSends(runId);
    assert.equal(beforeStop[0].state, "unknown");
    const sentBeforeRetry = calls("send").length;
    await assert.rejects(sendTaskGuidance({
      runId, taskId: "task_aaa", subject: "New guidance", body: "This draft must wait for the previous outcome.",
    }), { code: "guidance_unknown" });
    assert.equal(calls("send").length, sentBeforeRetry, "an unresolved send must not be called reconciled or sent again");
    const report = await stopCoordinator();
    assert.ok(report.results.some(row => row.target === "ctx_uncertain" && row.result !== "unknown"));
    const afterStop = await new ProviderSessionStore(workspace).listGuidanceSends(runId);
    assert.equal(afterStop[0].state, "follow_up", "positive worker settlement resolves custody");
    assert.equal(afterStop[0].startEvidence?.status, "outcome_unknown", "the original readiness receipt remains unknown");
  });

  it("does not claim a clean Stop when a lost send has no recoverable identity", async () => {
    const runId = "run_guidance_lost_unavailable";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await dispatchIdOf("task_aaa");
    await mutateState(s => {
      s.hideSendRequests = true;
      s.followUpOnSend = { taskId: "task_lost", dispatchId: "ctx_lost", loseResponse: true };
    });
    await assert.rejects(sendTaskGuidance({ runId, taskId: "task_aaa", subject: "Guidance", body: "Continue" }));
    const report = await stopCoordinator();
    assert.equal(report.clean, false);
    assert.equal(getState().dispatches.ctx_lost.status, "dispatched");
    assert.ok(report.results.some(row => row.result === "unknown" && row.detail?.includes("Guidance")));
  });

  it("does not claim a foreign root when Orca steers guidance to it", async () => {
    // This escalation belongs to the original Dispatch, not the routed destination.
    const runId = "run_guidance_steered";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId, { maxConcurrency: 3 }));
    const original = await dispatchIdOf("task_aaa");
    const event = { ...workerDoneMessage("task_aaa", original, "succeeded", "msg_steered_original"),
      type: "escalation", payload: JSON.stringify({ dispatchId: original, stopReason: "needs-input" }) };
    await injectMail([event]);
    await waitFor(() => coordinatorStatus().inbox.pending.some(item => item.messageId === event.id), "original stop event");
    await mutateState(s => {
      s.tasks.task_foreign = { id: "task_foreign", run_id: runId, status: "dispatched", deps: "[]", dispatch_id: "ctx_steered" };
      s.dispatches.ctx_steered = { id: "ctx_steered", run_id: runId, task_id: "task_foreign",
        status: "dispatched", workerState: "supervised", terminalState: "active", agentTerminal: "term_steered" };
      s.steerDispatchOnSend = "ctx_steered";
    });
    const receipt = await sendTaskGuidance({ runId, taskId: "task_aaa", subject: "Guidance", body: "Continue" });
    assert.equal(receipt.kind, "follow_up");
    assert.equal(receipt.dispatchId, "ctx_steered");
    assert.ok(coordinatorStatus().inbox.pending.some(item => item.messageId === event.id));
    assert.ok((await new ProviderSessionStore(workspace).listMailboxChecks(runId))
      .every(row => !row.resolvedStopEvents?.[event.id]));
    const report = await stopCoordinator();
    assert.ok(!report.results.some(row => row.target === "ctx_steered"));
    assert.equal(getState().dispatches.ctx_steered.status, "dispatched");
    await startCoordinator(baseOpts(runId, { maxConcurrency: 3 }));
    await waitFor(() => coordinatorStatus().unownedDispatches.some(value => value.includes("ctx_steered")), "steered root remains unowned");
    assert.equal(findAttempt("task_foreign"), undefined);
    await stopCoordinator();
  });

  for (const evidence of ["exact", "missing_request", "other_run"] as const) {
    it(`adopts finalized guidance only with exact native request and worker evidence: ${evidence}`, async () => {
      const runId = `run_guidance_restart_${evidence}`;
      const dispatchId = "ctx_follow_up";
      const requestId = "req_follow_up";
      const followUpOf = "ctx_original";
      const taskId = "task_follow_up";
      const workerRun = evidence === "other_run" ? "run_other" : runId;
      const timestamp = new Date().toISOString();
      await singleTaskState(runId);
      await mutateState(s => {
        s.tasks.task_aaa.status = "completed";
        s.tasks[taskId] = { id: taskId, run_id: workerRun, status: "dispatched", deps: "[]", dispatch_id: dispatchId };
        s.dispatches = { [dispatchId]: { id: dispatchId, run_id: workerRun, task_id: taskId,
          status: "dispatched", workerState: "ready", terminalState: "active", agentTerminal: "term_follow_up", creatorDispatchId: null } };
        if (workerRun !== runId) s.runs[workerRun] = { id: workerRun, objective: "Other Run", legacy: 0 };
        if (evidence !== "missing_request") {
          s.requests = { [requestId]: { state: "completed", method: "orchestration.send",
            outcome: { runId, taskId, dispatchId, state: "ready", delivery: "follow_up", followUpOf, mutation: { requestId } } } };
        }
      });
      await new ProviderSessionStore(workspace).recordGuidanceSend({
        requestId, runId, requestedTaskId: "task_aaa", requestedDispatchId: followUpOf, from: "term_old",
        state: "follow_up", creationProven: true, createdAt: timestamp, updatedAt: timestamp, error: null,
        receipt: { kind: "follow_up", runId, taskId, dispatchId, followUpOf, requestId,
          requestedTaskId: "task_aaa", requestedDispatchId: followUpOf, destinationRunId: null },
      });
      await startCoordinator(baseOpts(runId));
      assert.ok(callsOf("request-show", "--request", requestId).length);
      assert.equal(findAttempt(taskId)?.dispatchId, evidence === "exact" ? dispatchId : undefined);
      const report = await stopCoordinator();
      assert.equal(callsOf("worker-stop", "--dispatch", dispatchId).length, evidence === "exact" ? 1 : 0);
      if (evidence === "exact") {
        assert.ok(callsOf("worker-show", "--dispatch", dispatchId).length);
        assert.equal(getState().dispatches[dispatchId].status, "stopped");
      } else {
        assert.equal(getState().dispatches[dispatchId].status, "dispatched");
        assert.equal(report.results.find(row => row.target === requestId)?.result, "unknown");
      }
    });
  }

  it("leaves a foreign supervised root visible but neither adopts nor stops it", async () => {
    const runId = "run_foreign_root";
    await singleTaskState(runId);
    await mutateState(s => {
      s.tasks.task_aaa.status = "dispatched";
      s.tasks.task_aaa.dispatch_id = "ctx_foreign";
      s.dispatches = { ctx_foreign: { id: "ctx_foreign", run_id: runId, task_id: "task_aaa",
        status: "dispatched", workerState: "supervised", terminalState: "active" } };
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => coordinatorStatus().unownedDispatches.some(value => value.includes("ctx_foreign")), "foreign root shown");
    assert.equal(findAttempt("task_aaa"), undefined);
    const report = await stopCoordinator();
    assert.ok(!report.results.some(row => row.target === "ctx_foreign"));
    assert.equal(getState().dispatches.ctx_foreign.status, "dispatched");
  });
});

describe("Stop lifecycle boundary", () => {
  it("shares one Stop and rejects a replacement Start for the entire mailbox wait", async () => {
    const runId = "run_stopping";
    const replacement = "run_replacement";
    const nextDispatch = "ctx_replacement";
    const startedFile = join(root, "replacement-check-started");
    const releaseFile = join(root, "replacement-check-release");
    const previousBarrier = process.env.FAKE_ORCA_CHECK_BARRIER;
    await singleTaskState(runId);
    await mutateState(s => {
      s.runs[replacement] = { id: replacement, objective: "Replacement", legacy: 0 };
      s.tasks.task_bbb = { id: "task_bbb", run_id: replacement, status: "dispatched", deps: "[]", dispatch_id: nextDispatch };
      s.dispatches = { [nextDispatch]: { id: nextDispatch, run_id: replacement, task_id: "task_bbb",
        status: "dispatched", workerState: "ready", terminalState: "active", agentTerminal: "term_replacement" } };
    });
    await recordViewerLaunch(replacement, "task_bbb", nextDispatch);
    await startCoordinator(baseOpts(runId));
    const oldDispatch = await dispatchIdOf("task_aaa");
    process.env.FAKE_ORCA_CHECK_BARRIER = JSON.stringify({ startedFile, releaseFile });
    try {
      await waitFor(() => existsSync(startedFile) ? true : null, "Run A mailbox wait");
      const firstStop = stopCoordinator();
      const secondStop = stopCoordinator();
      assert.equal(firstStop, secondStop);
      assert.equal(coordinatorStatus().phase, "stopping");
      await assert.rejects(startCoordinator(baseOpts(replacement)), { code: "coordinator_conflict" });
      assert.equal(coordinatorStatus().runId, runId);
      assert.equal(callsOf("run-use", "--id", replacement).length, 0);
      writeFileSync(releaseFile, "");
      const report = await firstStop;
      assert.equal(await secondStop, report);
      assert.equal(callsOf("worker-stop", "--dispatch", oldDispatch).length, 1);
      assert.equal(callsOf("worker-stop", "--dispatch", nextDispatch).length, 0);
      await startCoordinator(baseOpts(replacement));
      assert.equal(attempt("task_bbb").dispatchId, nextDispatch);
      assert.equal(getState().dispatches[nextDispatch].status, "dispatched");
    } finally {
      writeFileSync(releaseFile, "");
      if (previousBarrier === undefined) delete process.env.FAKE_ORCA_CHECK_BARRIER;
      else process.env.FAKE_ORCA_CHECK_BARRIER = previousBarrier;
    }
  });

  it("reports closing a provisional coordinator whose Run binding completes during Stop", async () => {
    const runId = "run_stop_binding";
    const startedFile = join(root, "binding-started");
    const releaseFile = join(root, "binding-release");
    const wrapper = join(root, "binding-barrier.mjs");
    await singleTaskState(runId);
    writeFileSync(wrapper, `
import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "orchestration" && args[1] === "run-use") {
  writeFileSync(${JSON.stringify(startedFile)}, "");
  const deadline = Date.now() + 10_000;
  while (!existsSync(${JSON.stringify(releaseFile)}) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
process.exit(spawnSync(process.execPath, [${JSON.stringify(fixturePath)}, ...args], { stdio: "inherit" }).status ?? 1);
`);
    initOrcaRuntime({ env: { ORCA_CLI_COMMAND: JSON.stringify(process.execPath) + " " + JSON.stringify(wrapper),
      WORKSPACE_DIR: workspace }, cwd: root });
    const starting = startCoordinator(baseOpts(runId));
    try {
      await waitFor(() => existsSync(startedFile) ? true : null, "provisional binding in flight");
      const handle = coordinatorTerminal(getState()).handle;
      assert.equal(coordinatorStatus().coordinatorHandle, null, "binding has not published the provisional handle");
      const stopping = stopCoordinator();
      writeFileSync(releaseFile, "");
      await starting;
      const report = await stopping;
      assert.equal(report.results.find(row => row.target === handle)?.result, "closed");
      assert.equal(coordinatorTerminal(getState()).connected, false);
      assert.equal(calls("worker-start").length, 0);
    } finally {
      writeFileSync(releaseFile, "");
      await starting.catch(() => {});
      await stopCoordinator();
      initOrcaRuntime({ env: { ORCA_CLI_COMMAND: fixturePath, WORKSPACE_DIR: workspace }, cwd: root });
    }
  });

  it("stops a same-Run native resume accepted while Stop drains the lifecycle lock", async () => {
    const runId = "run_stop_during_resume";
    const taskId = "task_aaa";
    const dispatchId = "ctx_inflight_resume";
    const terminalId = "term_inflight_resume";
    await singleTaskState(runId);
    await mutateState(s => { s.tasks[taskId].status = "blocked"; });
    await startCoordinator(baseOpts(runId));
    let admit!: () => void;
    let finishBinding!: () => void;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    const binding = new Promise<void>(resolve => { finishBinding = resolve; });
    const resuming = withLifecycleMutation(async () => {
      admit();
      await binding;
      await mutateState(s => {
        s.tasks[taskId].status = "dispatched";
        s.tasks[taskId].dispatch_id = dispatchId;
        s.dispatches = { [dispatchId]: { id: dispatchId, run_id: runId, task_id: taskId,
          status: "dispatched", workerState: "ready", terminalState: "active", agentTerminal: terminalId, creatorDispatchId: null } };
      });
      const receipt = parseWorkerStartReceipt({ runId, taskId, dispatchId, state: "ready", stage: "ready" }, true);
      recordResumedWorker(runId, { taskId, terminalId, harness: "claude", retriedFrom: "ctx_prior" },
        { dispatchId, mode: "supervised", receipt, handle: null, replayed: false, adopted: false });
    });
    await admitted;
    const stopping = stopCoordinator();
    finishBinding();
    await resuming;
    const report = await stopping;
    assert.equal(report.results.find(row => row.target === dispatchId)?.result, "stopped");
    assert.equal(callsOf("worker-stop", "--dispatch", dispatchId).length, 1);
  });
});

describe("worker_done validation", () => {
  for (const outcome of ["empty", "batch", "lost", "hung"] as const) {
    it(`settles Stop against an in-flight ${outcome} mailbox check without another check`, async () => {
      const runId = `run_stop_check_${outcome}`;
      const startedFile = join(root, `check-${outcome}-started`);
      const releaseFile = join(root, `check-${outcome}-release`);
      const previousBarrier = process.env.FAKE_ORCA_CHECK_BARRIER;
      rmSync(startedFile, { force: true });
      rmSync(releaseFile, { force: true });
      await singleTaskState(runId);
      await mutateState(s => { s.mailboxV3 = true; });
      process.env.FAKE_ORCA_CHECK_BARRIER = JSON.stringify({ startedFile, releaseFile });
      try {
        await startCoordinator(baseOpts(runId));
        await waitFor(() => existsSync(startedFile) ? true : null, "native check at barrier");
        const store = new ProviderSessionStore(workspace);
        const rows = await store.listMailboxChecks(runId);
        const pending = rows.find(row => row.state === "prepared");
        assert.ok(pending);
        const requestId = pending.requestId;
        const checksBeforeStop = calls("check").length;
        const message = { ...workerDoneMessage("task_aaa", "ctx_prior", "succeeded", `msg_stop_${outcome}`),
          run_id: runId, type: "question", subject: "Decision", body: "Choose", payload: null };
        if (outcome === "batch" || outcome === "lost") {
          await mutateState(s => {
            const handle = coordinatorTerminal(s).handle;
            s.mailboxes ??= {};
            s.mailboxes[handle] = [{ deliveryId: `delivery_stop_${outcome}`, messages: [message] }];
            if (outcome === "lost") s.loseCheckResponseOnce = true;
          });
        }
        const stopping = stopCoordinator();
        if (outcome !== "hung") writeFileSync(releaseFile, "");
        const report = await stopping;
        const saved = (await store.listMailboxChecks(runId)).find(row => row.requestId === requestId);
        assert.ok(saved);
        assert.equal(calls("check").length, checksBeforeStop + (outcome === "hung" ? 0 : 1),
          "Stop must not issue another consuming check or ACK");
        assert.equal(calls("reply").length, 0);
        if (outcome === "empty") {
          assert.equal(saved.state, "completed");
          assert.deepEqual(saved.delivery?.messages, []);
          assert.equal(saved.delivery?.timedOut, true);
          assert.equal(report.clean, true);
        } else {
          assert.equal(report.clean, false);
          assert.ok(report.results.some(row => row.result === "unknown" && row.detail?.includes(requestId)));
          if (outcome === "hung") {
            assert.equal(saved.state, "prepared");
            assert.equal(saved.delivery, null);
          } else if (outcome === "batch") {
            assert.equal(saved.state, "received");
            assert.deepEqual(saved.delivery?.messages, [message]);
          } else {
            assert.equal(saved.state, "unknown");
            assert.equal(saved.delivery, null);
            assert.equal(getState().requests[requestId].outcome.deliveryId, `delivery_stop_${outcome}`);
          }
        }
      } finally {
        writeFileSync(releaseFile, "");
        if (previousBarrier === undefined) delete process.env.FAKE_ORCA_CHECK_BARRIER;
        else process.env.FAKE_ORCA_CHECK_BARRIER = previousBarrier;
      }
    });
  }

  it("retires only an unsent ACK preparation when Stop interrupts it, and recovers the original batch", async () => {
    const runId = "run_stop_unsent_ack";
    await singleTaskState(runId);
    const originalRecord = ProviderSessionStore.prototype.recordMailboxCheck;
    let notifyPrepared!: () => void;
    let resumePreparation!: () => void;
    const prepared = new Promise<void>(resolve => { notifyPrepared = resolve; });
    const gate = new Promise<void>(resolve => { resumePreparation = resolve; });
    let ackRequestId: string | null = null;
    ProviderSessionStore.prototype.recordMailboxCheck = async function (this: ProviderSessionStore, row) {
      await originalRecord.call(this, row);
      if (row.runId === runId && row.ack && row.state === "prepared" && !ackRequestId) {
        ackRequestId = row.requestId;
        notifyPrepared();
        await gate;
      }
    };
    try {
      await startCoordinator(baseOpts(runId));
      const dispatchId = await dispatchIdOf("task_aaa");
      const message = { ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_unsent_ack"),
        type: "heartbeat", run_id: runId };
      const deliveryId = await injectMail([message]);
      await prepared;
      const stopping = stopCoordinator();
      resumePreparation();
      const report = await stopping;
      const rows = await new ProviderSessionStore(workspace).listMailboxChecks(runId);
      const cancelled = rows.find(row => row.requestId === ackRequestId);
      const original = rows.find(row => row.delivery?.deliveryId === deliveryId);
      assert.equal(cancelled?.state, "completed");
      assert.equal(cancelled?.delivery, null);
      assert.equal(original?.state, "pending_input");
      assert.equal(ackCalls(deliveryId).length, 0);
      assert.equal(report.clean, false, "the original unacknowledged delivery remains debt");
      ProviderSessionStore.prototype.recordMailboxCheck = originalRecord;
      await startCoordinator(baseOpts(runId));
      await waitFor(() => ackCalls(deliveryId).length === 1 ? true : null, "original batch ACK after restart");
      await stopCoordinator();
    } finally {
      resumePreparation();
      ProviderSessionStore.prototype.recordMailboxCheck = originalRecord;
    }
  });

  it("retains a consumed mixed batch across a transient task read failure", async () => {
    const runId = "run_v3_mixed_failure";
    await singleTaskState(runId);
    await mutateState(s => { s.mailboxV3 = true; });
    await startCoordinator(baseOpts(runId));
    const dispatchId = await dispatchIdOf("task_aaa");
    const question = { ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_v3_fault_question"),
      type: "question", from_handle: `dispatch:${dispatchId}`, subject: "Need a decision",
      body: "Which option?", payload: JSON.stringify({ taskId: "task_aaa", dispatchId, question: "Which option?" }) };
    const done = workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_v3_fault_done");
    await mutateState(s => {
      s.settleOnDelivery ??= {};
      s.settleOnDelivery.delivery_mixed_fault = { taskId: "task_aaa", dispatchId, outcome: "succeeded" };
      s.failTaskListAfterConsume = 1;
      const handle = coordinatorTerminal(s).handle;
      s.mailboxes ??= {};
      s.mailboxes[handle] = [...(s.mailboxes[handle] ?? []), { deliveryId: "delivery_mixed_fault", messages: [question, done] }];
    });
    await waitFor(() => coordinatorStatus().inbox.pending.some(item => item.messageId === question.id), "question survives failed read");
    await waitFor(() => findAttempt("task_aaa")?.settled === true, "completion survives failed read");
    assert.equal(ackCalls("delivery_mixed_fault").length, 0);
    assert.equal(getState().mailboxes[coordinatorTerminal(getState()).handle].find((d: { deliveryId: string }) => d.deliveryId === "delivery_mixed_fault").open, false);
    await stopCoordinator();
  });

  it("replays a lost consuming response with its original request and does not consume twice", async () => {
    const runId = "run_v3_lost_check";
    await singleTaskState(runId);
    await mutateState(s => { s.mailboxV3 = true; });
    await startCoordinator(baseOpts(runId));
    const dispatchId = await dispatchIdOf("task_aaa");
    const question = { ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_v3_lost"),
      type: "question", from_handle: `dispatch:${dispatchId}`, subject: "Choose", body: "Choose",
      payload: JSON.stringify({ taskId: "task_aaa", dispatchId, question: "Choose" }) };
    await mutateState(s => {
      s.loseCheckResponseOnce = true;
      const handle = coordinatorTerminal(s).handle;
      s.mailboxes ??= {};
      s.mailboxes[handle] = [...(s.mailboxes[handle] ?? []), { deliveryId: "delivery_lost", messages: [question] }];
    });
    await waitFor(() => coordinatorStatus().inbox.pending.some(item => item.messageId === question.id), "lost check replayed");
    const request = Object.entries(getState().requests).find(([, value]) =>
      !!value && typeof value === "object" && "outcome" in value &&
      !!value.outcome && typeof value.outcome === "object" && "deliveryId" in value.outcome &&
      value.outcome.deliveryId === "delivery_lost");
    assert.ok(request);
    const matching = calls("check").filter(call => call.argv.includes(request[0]));
    assert.ok(matching.length >= 2);
    assert.equal(getState().mailboxes[coordinatorTerminal(getState()).handle].find((d: { deliveryId: string }) => d.deliveryId === "delivery_lost").seen, 1);
    await stopCoordinator();
  });

  it("restores a consumed request receipt after a new coordinator terminal binds", async () => {
    const runId = "run_v3_request_restart";
    await singleTaskState(runId);
    const requestId = randomUUID();
    const question = { ...workerDoneMessage("task_aaa", "ctx_prior", "succeeded", "msg_v3_restart_lost"),
      run_id: runId, type: "question", subject: "Decision", body: "Choose", payload: null };
    const outcome = { runId, deliveryId: "delivery_restart_lost", messages: [question], count: 1,
      replayed: false, deliveryAcknowledged: true, acknowledged: null, timedOut: false, cancelled: false, connectionLost: false };
    await mutateState(s => { s.requests = { [requestId]: { state: "completed", method: "orchestration.check", outcome } }; });
    const now = new Date().toISOString();
    await new ProviderSessionStore(workspace).recordMailboxCheck({ requestId, runId, from: "term_previous", ack: null,
      state: "unknown", delivery: null, processedMessageIds: [], pendingQuestionIds: [], createdAt: now, updatedAt: now, error: "lost" });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => coordinatorStatus().inbox.pending.some(item => item.messageId === question.id), "restart recovered exact check");
    assert.equal(ackCalls("delivery_restart_lost").length, 0);
    await stopCoordinator();
  });

  it("keeps a reply pending until a lost reply receipt is recovered", async () => {
    const runId = "run_v3_lost_reply";
    await singleTaskState(runId);
    await mutateState(s => { s.mailboxV3 = true; });
    await startCoordinator(baseOpts(runId));
    const dispatchId = await dispatchIdOf("task_aaa");
    const question = { ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_reply_lost"),
      type: "question", subject: "Decision", body: "Choose", payload: null };
    await mutateState(s => { s.loseReplyResponseOnce = true; });
    await injectMail([question]);
    await waitFor(() => coordinatorStatus().inbox.pending.some(item => item.messageId === question.id), "reply question");
    await assert.rejects(answerInboxItem(question.id, "yes"));
    await waitFor(() => !coordinatorStatus().inbox.pending.some(item => item.messageId === question.id), "lost reply recovered");
    assert.equal(getState().replies.length, 1);
    assert.equal(getState().replies[0].body, "yes");
    await stopCoordinator();
  });
  for (const ackOnly of [true, false]) {
    it(`processes the next legacy batch when ACK ${ackOnly ? "returns empty" : "returns it"}`, async () => {
      const runId = `run_legacy_ack_${ackOnly}`;
      await singleTaskState(runId);
      await mutateState(s => { s.ackOnly = ackOnly; });
      await startCoordinator(baseOpts(runId));
      const dispatchId = await dispatchIdOf("task_aaa");
      const first = { ...workerDoneMessage("task_aaa", dispatchId, "succeeded", `msg_ack_first_${ackOnly}`),
        type: "question", subject: "First", body: "First", payload: null };
      const second = { ...first, id: `msg_ack_second_${ackOnly}`, subject: "Second" };
      await mutateState(s => {
        const handle = coordinatorTerminal(s).handle;
        s.mailboxes ??= {};
        s.mailboxes[handle] = [...(s.mailboxes[handle] ?? []),
          { deliveryId: `delivery_first_${ackOnly}`, messages: [first] },
          { deliveryId: `delivery_second_${ackOnly}`, messages: [second] }];
      });
      await waitFor(() => coordinatorStatus().inbox.pending.some(item => item.messageId === first.id), "first legacy question");
      await answerInboxItem(first.id, "continue");
      await waitFor(() => coordinatorStatus().inbox.pending.some(item => item.messageId === second.id), "second legacy question");
      assert.equal(ackCalls(`delivery_first_${ackOnly}`).length, 1);
      await stopCoordinator();
    });
  }
  it("replays a persisted mixed V3 batch after restart, including rejected reports and questions", async () => {
    const runId = "run_v3_mixed_replay";
    await singleTaskState(runId);
    const timestamp = new Date().toISOString();
    const stale = { ...workerDoneMessage("missing", "ctx_missing", "succeeded", "msg_mixed_stale"), run_id: runId };
    const question = { ...stale, id: "msg_mixed_question", type: "question", subject: "Decision", body: "Choose one", payload: null };
    const store = new ProviderSessionStore(workspace);
    await store.recordMailboxCheck({ requestId: "request_v3_mixed", runId, from: "term_previous", ack: null, state: "received",
      delivery: { runId, deliveryId: "delivery_v3_mixed", messages: [stale, question], count: 2, replayed: false,
        deliveryAcknowledged: true, acknowledged: null, timedOut: false, cancelled: false, connectionLost: false },
      processedMessageIds: [], pendingQuestionIds: [], createdAt: timestamp, updatedAt: timestamp, error: null });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => coordinatorStatus().inbox.pending.some(item => item.messageId === question.id), "replayed question");
    const saved = await waitFor(() => {
      const rows = JSON.parse(readFileSync(join(workspace, ".orca-dag", "sessions.json"), "utf8")).mailboxChecks as Array<{ requestId: string; state: string; processedMessageIds: string[]; pendingQuestionIds: string[] }>;
      const row = rows.find(item => item.requestId === "request_v3_mixed");
      return row?.state === "pending_input" ? row : null;
    }, "mixed batch checkpoint");
    assert.deepEqual(saved.processedMessageIds, [stale.id, question.id]);
    assert.deepEqual(saved.pendingQuestionIds, [question.id]);
    assert.equal(ackCalls("delivery_v3_mixed").length, 0);
    await stopCoordinator();
  });
  it("restores a V3 pending question and continues processing newer worker completion", async () => {
    const runId = "run_v3_restart_question";
    await singleTaskState(runId);
    const timestamp = new Date().toISOString();
    const question = { ...workerDoneMessage("task_aaa", "ctx_earlier", "succeeded", "msg_v3_question"),
      run_id: runId, type: "question", subject: "Need review", body: "Please decide", payload: null };
    await new ProviderSessionStore(workspace).recordMailboxCheck({
      requestId: "request_v3_question", runId, from: "term_previous", ack: null, state: "pending_input",
      delivery: { runId, deliveryId: "delivery_v3_question", messages: [question], count: 1, replayed: false,
        deliveryAcknowledged: true, acknowledged: null, timedOut: false, cancelled: false, connectionLost: false },
      processedMessageIds: [question.id], pendingQuestionIds: [question.id], createdAt: timestamp, updatedAt: timestamp, error: null,
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => coordinatorStatus().inbox.pending.some(item => item.messageId === question.id), "restored question");
    await waitFor(() => findAttempt("task_aaa")?.dispatchId ?? null, "worker started despite pending V3 question");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_after_question");
    await waitFor(() => findAttempt("task_aaa")?.terminalDecision === "released", "newer completion processed");
    assert.ok(coordinatorStatus().inbox.pending.some(item => item.messageId === question.id));
    assert.equal(ackCalls("delivery_v3_question").length, 0);
    await stopCoordinator();
  });
  it("recovers a nested-Run reply using its original mailbox thread after restart", async () => {
    const runId = "run_nested_reply_recovery";
    await singleTaskState(runId);
    const timestamp = new Date().toISOString();
    const message = { ...workerDoneMessage("task_aaa", "ctx_prior", "succeeded", "msg_nested_report"),
      run_id: runId, type: "escalation", thread_id: "thread_original", payload: null };
    const requestId = "request_nested_reply";
    await mutateState(s => { s.requests = { [requestId]: { state: "completed", method: "orchestration.reply",
      outcome: { message: { id: "answer_nested", run_id: "run_child", to_handle: "run:run_child", thread_id: "thread_original" } } } }; });
    await new ProviderSessionStore(workspace).recordMailboxCheck({
      requestId: "check_nested", runId, from: "term_previous", ack: null, state: "pending_input",
      delivery: { runId, deliveryId: "delivery_nested", messages: [message], count: 1, replayed: false,
        deliveryAcknowledged: true, acknowledged: null, timedOut: false, cancelled: false, connectionLost: false },
      processedMessageIds: [message.id], pendingQuestionIds: [message.id],
      replyRequests: { [message.id]: { requestId, from: "term_previous",
        bodyHash: createHash("sha256").update("yes").digest("hex"), state: "unknown" } },
      createdAt: timestamp, updatedAt: timestamp, error: null,
    });
    await startCoordinator(baseOpts(runId));
    const rows = await new ProviderSessionStore(workspace).listMailboxChecks(runId);
    assert.equal(rows.find(row => row.requestId === "check_nested")?.replyRequests?.[message.id].state, "completed");
    assert.equal(calls("reply").length, 0);
    await stopCoordinator();
  });
  it("ignores a duplicate/replayed worker_done: no double release, no state change, run still completes", async () => {
    const runId = "run_replay";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_first");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "release");

    // The same settlement replayed as a NEW message (runtime redelivery).
    // Whether the loop processes it before or after completing is immaterial —
    // both orders must leave exactly one release and one settled attempt.
    await injectMail([workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_dup")]);
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
    assert.equal(callsOf("worker-release", "--dispatch", dispatchId).length, 1, "no double release");
    const a = attempt("task_aaa");
    assert.equal(a.settled, true);
    assert.equal(a.terminalDecision, "released");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });

  it("acknowledges stale and unknown worker_done reports without settling their task", async () => {
    const runId = "run_strange";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");

    const dispatchId = await dispatchIdOf("task_aaa");
    const deliveryId = await injectMail([
      workerDoneMessage("task_aaa", "ctx_foreign", "succeeded", "msg_foreign"),
      workerDoneMessage("task_aaa", dispatchId, "probably_fine", "msg_unverifiable"),
    ]);
    await waitFor(() => (processedRow("msg_foreign") && processedRow("msg_unverifiable") ? true : null), "strange rows to be processed");
    assert.equal(attempt("task_aaa").settled, false, "unverifiable/foreign worker_done must not settle");
    assert.notEqual(coordinatorStatus().phase, "completed");
    await waitFor(() => (ackCalls(deliveryId).length === 1 ? true : null), "invalid lifecycle delivery to be acknowledged");
    await stopCoordinator();
  });
  it("acks an ordinary FIFO batch before processing the following actionable Delivery", async () => {
    const runId = "run_ordinary_mail";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");

    const ordinaryDeliveryId = await injectMail([{
      ...workerDoneMessage("task_aaa", "ctx_foreign", "succeeded", "msg_ordinary"),
      type: "progress",
      subject: "ordinary lifecycle notice",
    }]);
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_actionable");
    const actionableDeliveryId = Object.values(
      getState().mailboxes as Record<string, { deliveryId: string }[]>,
    ).flat().find((delivery) => delivery.deliveryId !== ordinaryDeliveryId)?.deliveryId;
    assert.ok(actionableDeliveryId, "actionable Delivery queued behind ordinary FIFO batch");

    await waitFor(() => (ackCalls(ordinaryDeliveryId).length === 1 ? true : null), "ordinary Delivery ack");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "actionable lifecycle processed");
    await waitFor(() => (ackCalls(actionableDeliveryId).length === 1 ? true : null), "actionable Delivery ack");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });
});

