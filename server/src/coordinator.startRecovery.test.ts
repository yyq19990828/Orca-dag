import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coordinatorStatus, retryWorker, startCoordinator, stopCoordinator } from "./coordinator";
import { setupCoordinatorHarness } from "./testHelpers/coordinatorHarness";

const {
  calls,
  callsOf,
  mutateState,
  getState,
  baseOpts,
  settleViaWorkerDone,
  waitFor,
  attempt,
  findAttempt,
  dispatchIdOf,
  startApp,
  singleTaskState,
} = setupCoordinatorHarness();

describe("Phase 4: ambiguous worker-start recovery", () => {
  it("resolves a lost worker-start response via request-show + same-id replay: exactly ONE Dispatch, concurrency held", async () => {
    const runId = "run_ambiguous";
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: '["task_aaa"]' },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      // The fake performs the FULL mutation, records the request as completed,
      // then dies with garbage output — the response is lost after the fact.
      state.workerStartAmbiguous = "lost";
    });
    await startCoordinator(baseOpts(runId, { maxConcurrency: 1 }));

    await waitFor(() => {
      const current = findAttempt("task_aaa");
      return current?.dispatchId && !current.startRequestId ? current.dispatchId : null;
    }, "dispatch to be recovered and its durable request resolved");
    const a = attempt("task_aaa");
    assert.equal(a.dispatchId, "ctx_s1");
    assert.equal(a.settled, false, "the recovered start is a live worker, not a settlement");
    assert.equal(a.startRequestId, null, "the durable id retires once the outcome is known");
    const starts = calls("worker-start");
    assert.equal(starts.length, 2, "original + idempotent replay, nothing else");
    const ids = starts.map((c) => c.argv[c.argv.indexOf("--retry-request") + 1]);
    assert.ok(ids[0], "original call carried a durable retry-request id");
    assert.equal(ids[0], ids[1], "the replay reuses the SAME durable id");
    assert.equal(ids[0], a.startReceipt?.requestId, "the receipt echoes the id the start ran under");
    assert.ok(calls("request-show").length >= 1, "request-show ran before any replay");
    assert.equal(Object.keys(getState().dispatches ?? {}).length, 1, "no second Dispatch was minted");

    // Concurrency: the dependent holds until the recovered worker settles.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(calls("worker-start").length, 2, "no placement behind the unresolved-but-live worker");

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_amb1");
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_bbb")) ? true : null), "dependent to start");
    await settleViaWorkerDone("task_bbb", "succeeded", "msg_amb2");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
    assert.deepEqual(coordinatorStatus().cleanupDebt, [], "a recovered run completes clean");
  });

  it("keeps a lost start unresolved: receipt and request pointer retained, no replacement retry", async () => {
    const runId = "run_lostnr";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.workerStartAmbiguous = "lost_noreceipt";
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (findAttempt("task_aaa")?.startReceipt?.failedStage === "response_lost" ? true : null), "unresolved start recorded");
    const a = attempt("task_aaa");
    assert.equal(a.settled, false, "a lost response is not positive failure evidence");
    assert.equal(a.outcome, null);
    assert.equal(a.settledVia, null);
    assert.equal(a.startReceipt?.failedStage, "response_lost", "the unresolved ambiguity is IN the receipt");
    assert.equal(a.startRequestId, a.startReceipt?.requestId, "the exact request remains available for reconciliation");
    assert.ok(calls("request-show").length >= 1, "Orca was asked whether the start landed");
    assert.equal(Object.keys(getState().dispatches ?? {}).length, 0, "no Dispatch exists");
    assert.equal(a.terminalDecision, "pending", "unknown ownership is not marked as cleaned up");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls("worker-start").length, 1, "the parked start is never retried blindly");
    assert.equal(getState().tasks.task_aaa.status, "ready", "the task stays ready, not re-placed");
    assert.equal(coordinatorStatus().error, null, "a receipt-bearing failure stays on the attempt, not the global error");
    await assert.rejects(retryWorker("task_aaa"), /not positively failed/, "unknown liveness cannot be retried");
    assert.equal(calls("worker-start").length, 1, "an unresolved request never authorizes a replacement start");
    await stopCoordinator();
  });

  for (const keepOldPointer of [true, false]) {
    it(`does not settle an unresolved retry from ${keepOldPointer ? "an old Task pointer" : "a terminal Task without a pointer"}`, async () => {
      const runId = `run_retry_unknown_${keepOldPointer}`;
      await mutateState((state) => {
        state.tasks = {
          task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
          task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: "[]" },
        };
        state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      });
      await startCoordinator(baseOpts(runId));
      const oldDispatch = await dispatchIdOf("task_aaa");
      await dispatchIdOf("task_bbb");
      await settleViaWorkerDone("task_aaa", "failed", `msg_retry_unknown_${keepOldPointer}`);
      await waitFor(() => attempt("task_aaa").terminalDecision === "released" ? true : null, "failed worker release");
      await mutateState((state) => {
        state.workerStartAmbiguous = "lost_noreceipt";
        if (!keepOldPointer) delete state.tasks.task_aaa.dispatch_id;
      });

      await assert.rejects(retryWorker("task_aaa"), (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "response_lost");
      const requestId = attempt("task_aaa").startRequestId;
      assert.ok(requestId, "the unresolved retry retains its own mutation identity");
      // Cross two complete passes so an already-running read cannot mask the
      // stale failed Task pointer being folded into the new candidate.
      for (let pass = 0; pass < 2; pass += 1) {
        const lastPass = coordinatorStatus().lastReconciledAt ?? 0;
        await waitFor(() => (coordinatorStatus().lastReconciledAt ?? 0) > lastPass ? true : null, "post-retry reconciliation");
      }
      const current = attempt("task_aaa");
      assert.equal(current.dispatchId, null, "the previous Dispatch cannot identify this request");
      assert.equal(current.retriedFrom, oldDispatch);
      assert.equal(current.settled, false, "old Task failure does not settle an unknown retry");
      assert.equal(current.outcome, null);
      assert.equal(current.settledVia, null);
      assert.equal(current.startRequestId, requestId);
      assert.equal(current.startReceipt?.requestId, requestId);
      assert.equal(current.terminalDecision, "pending");
      assert.equal(coordinatorStatus().busy, 2, "unknown retry still reserves its slot beside task B");
      await assert.rejects(retryWorker("task_aaa"), /not positively failed/);
      assert.equal(calls("worker-start").length, 3, "no replacement is started over the unknown request");
      await stopCoordinator();
    });
  }

  it("settles a positively failed new Dispatch despite an unresolved start response", async () => {
    const runId = "run_retry_unknown_settled";
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: "[]" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(baseOpts(runId));
    const oldDispatch = await dispatchIdOf("task_aaa");
    await dispatchIdOf("task_bbb");
    await settleViaWorkerDone("task_aaa", "failed", "msg_retry_unknown_settled");
    await waitFor(() => attempt("task_aaa").terminalDecision === "released" ? true : null, "old worker release");
    await mutateState((state) => {
      state.workerStartRetryFailure = {
        landDispatch: true,
        code: "terminal_start_failed",
        failedStage: "response_lost",
        message: "Start response is unknown but the new Dispatch has settled",
      };
    });
    await assert.rejects(retryWorker("task_aaa"), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "terminal_start_failed");
    const newDispatch = getState().tasks.task_aaa.dispatch_id;
    assert.notEqual(newDispatch, oldDispatch);
    await waitFor(() => attempt("task_aaa").settled ? true : null, "exact new Dispatch settlement");
    assert.equal(attempt("task_aaa").dispatchId, newDispatch);
    assert.equal(attempt("task_aaa").outcome, "failed");
    assert.equal(attempt("task_aaa").settledVia, "task_status");
    await stopCoordinator();
  });

  it("keeps a prior Dispatch when Orca rejects retry and reports only confirmed retries over HTTP", async () => {
    const { call } = await startApp();
    const runId = "run_retry_not_startable";
    const selector = "id:repoL::/ws/retry-existing";
    const requestRecords: import("./requestLedger").MutationRequestMeta[] = [];
    await mutateState((state) => {
      state.version = "1.4.226";
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]", task_title: "A" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: "[]", task_title: "B" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.worktrees = [
        { id: selector, repoId: "repoL", path: "/ws/retry-existing", displayName: "retry-existing", isMainWorktree: false },
      ];
    });
    await startCoordinator(baseOpts(runId, {
      maxConcurrency: 2,
      harnessByTask: { task_aaa: "claude" },
      modelByTask: { task_aaa: "provider/model" },
      effortByTask: { task_aaa: "high" },
      placementByTask: { task_aaa: { kind: "existing", selector } },
      onRequestRecord: async (meta) => { requestRecords.push({ ...meta }); },
    }));
    await waitFor(() => calls("worker-start").some((c) => c.argv.includes("task_aaa")) &&
      calls("worker-start").some((c) => c.argv.includes("task_bbb")) ? true : null, "two root workers to start");
    const oldDispatch = await dispatchIdOf("task_aaa");
    const originalPrefs = { ...attempt("task_aaa").requested };

    await settleViaWorkerDone("task_aaa", "failed", "msg_retry_base_failed");
    await waitFor(() => attempt("task_aaa").terminalDecision === "released" ? true : null, "old failed Dispatch release");
    assert.equal(coordinatorStatus().running, true, "task B keeps the Run available for an explicit retry");
    await mutateState((state) => {
      state.workerStartRetryFailure = {
        code: "task_not_startable",
        message: "Task has exhausted the failed worker-start retry limit",
      };
    });

    const beforeActivity = await call("GET", `/api/activity?run=${runId}`);
    const beforeRetryEvents = ((beforeActivity.json.events as Array<Record<string, unknown>>) ?? [])
      .filter((event) => event.title === "Coordinator retried a failed stage").length;
    const rejected = await call("POST", "/api/workers/task_aaa/retry", {});
    assert.equal(rejected.status, 409);
    assert.equal(rejected.json.code, "task_not_startable");
    assert.match(String(rejected.json.error), /exhausted the failed worker-start retry limit/);

    const refusedStart = callsOf("worker-start", "--retry-of", oldDispatch).at(-1)!;
    assert.ok(refusedStart, "the retry reached Orca instead of being preflighted away");
    assert.equal(refusedStart.argv[refusedStart.argv.indexOf("--task") + 1], "task_aaa");
    assert.equal(refusedStart.argv[refusedStart.argv.indexOf("--agent") + 1], "claude");
    assert.equal(refusedStart.argv[refusedStart.argv.indexOf("--model") + 1], "provider/model");
    assert.equal(refusedStart.argv[refusedStart.argv.indexOf("--effort") + 1], "high");
    assert.equal(refusedStart.argv[refusedStart.argv.indexOf("--worktree") + 1], selector);
    const afterReject = attempt("task_aaa");
    assert.equal(afterReject.dispatchId, oldDispatch, "the old Dispatch stays authoritative");
    assert.equal(afterReject.settled, true);
    assert.equal(afterReject.outcome, "failed");
    assert.equal(afterReject.terminalDecision, "released", "the old cleanup decision is preserved");
    assert.equal(afterReject.retriedFrom, null, "the old lineage is preserved");
    assert.deepEqual(afterReject.requested, originalPrefs, "the old launch parameters are preserved");
    assert.equal(afterReject.startReceipt?.ok, false);
    assert.equal(afterReject.startReceipt?.failedStage, "task_not_startable");
    const refusedRequestId = refusedStart.argv[refusedStart.argv.indexOf("--retry-request") + 1];
    assert.equal(afterReject.startReceipt?.requestId, refusedRequestId);
    const refusedLedger = requestRecords.filter((record) => record.requestId === refusedRequestId).at(-1);
    assert.equal(refusedLedger?.dispatchId, null);
    assert.equal(refusedLedger?.settledLocally, true);
    assert.match(refusedLedger?.note ?? "", /failed before ready/);
    assert.equal(getState().tasks.task_aaa.dispatch_id, oldDispatch, "Orca's rejected retry did not replace the Task identity");
    const afterRejectActivity = await call("GET", `/api/activity?run=${runId}`);
    const afterRejectRetryEvents = ((afterRejectActivity.json.events as Array<Record<string, unknown>>) ?? [])
      .filter((event) => event.title === "Coordinator retried a failed stage").length;
    assert.equal(afterRejectRetryEvents, beforeRetryEvents, "a rejection emits no success Activity");

    await mutateState((state) => { delete state.workerStartRetryFailure; });
    const succeeded = await call("POST", "/api/workers/task_aaa/retry", {});
    assert.equal(succeeded.status, 200);
    assert.equal(succeeded.json.retriedFrom, oldDispatch);
    const successfulDispatch = String(succeeded.json.dispatchId);
    assert.ok(successfulDispatch.startsWith("ctx_s"));
    await waitFor(() => attempt("task_aaa").dispatchId === successfulDispatch ? true : null, "successful retry promotion");
    const retryStarts = callsOf("worker-start", "--retry-of", oldDispatch);
    assert.equal(retryStarts.length, 2, "the later success uses the same authoritative old Dispatch lineage");
    const successActivity = await call("GET", `/api/activity?run=${runId}`);
    const retryEvents = ((successActivity.json.events as Array<Record<string, unknown>>) ?? [])
      .filter((event) => event.title === "Coordinator retried a failed stage");
    assert.equal(retryEvents.length, beforeRetryEvents + 1);
    assert.equal(retryEvents.at(-1)?.dispatchId, successfulDispatch);

    await settleViaWorkerDone("task_aaa", "failed", "msg_retry_success_failed");
    await waitFor(() => attempt("task_aaa").terminalDecision === "released" ? true : null, "successful retry failure release");
    await mutateState((state) => {
      state.workerStartRetryFailure = {
        code: "terminal_start_failed",
        message: "terminal failed after Orca minted the retry Dispatch",
        landDispatch: true,
        failedStage: "terminal_start",
      };
    });
    const failedBeforeReady = await call("POST", "/api/workers/task_aaa/retry", {});
    assert.equal(failedBeforeReady.status, 500);
    assert.equal(failedBeforeReady.json.code, "terminal_start_failed");
    await waitFor(() => attempt("task_aaa").dispatchId !== successfulDispatch ? true : null, "new failed-before-ready identity");
    const failedDispatch = attempt("task_aaa").dispatchId!;
    assert.notEqual(failedDispatch, oldDispatch);
    assert.equal(attempt("task_aaa").retriedFrom, successfulDispatch);
    assert.equal(attempt("task_aaa").settledVia, "start_failed");
    assert.equal(attempt("task_aaa").startReceipt?.dispatchId, failedDispatch);
    assert.equal(attempt("task_aaa").startReceipt?.failedStage, "terminal_start");
    await waitFor(() => attempt("task_aaa").terminalDecision === "released" ? true : null, "new failed Dispatch cleanup");
    const afterFailedBeforeReadyActivity = await call("GET", `/api/activity?run=${runId}`);
    const afterFailedRetryEvents = ((afterFailedBeforeReadyActivity.json.events as Array<Record<string, unknown>>) ?? [])
      .filter((event) => event.title === "Coordinator retried a failed stage").length;
    assert.equal(afterFailedRetryEvents, beforeRetryEvents + 1, "a failed-before-ready Dispatch emits no success Activity");

    await settleViaWorkerDone("task_bbb", "succeeded", "msg_retry_other_complete");
    await waitFor(() => coordinatorStatus().phase === "awaiting_input" ? true : null, "failed-before-ready attempt remains parked");
    await stopCoordinator();
  });

  it("uses exact dispatch counters, preserves same-id evidence, clears on rebinding, and inherits runtime count", async () => {
    const runId = "run_retry_accounting";
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: "[]" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(baseOpts(runId, { maxConcurrency: 2 }));
    await waitFor(() => calls("worker-start").length === 2 ? true : null, "both initial Dispatches");
    const firstDispatch = await dispatchIdOf("task_aaa");
    assert.equal(attempt("task_aaa").failureCount, null, "missing detail count is unknown, never zero");

    await mutateState((state) => { state.dispatches[firstDispatch].failureCount = 0; });
    await settleViaWorkerDone("task_aaa", "failed", "msg_accounting_worker_failed");
    await waitFor(() => attempt("task_aaa").terminalDecision === "released" ? true : null, "failed worker release");
    assert.equal(attempt("task_aaa").failureCount, 0, "worker-reported failure does not increment Orca's counter locally");
    assert.equal(attempt("task_aaa").dispatchStatus, "failed");

    const refusal = { code: "task_not_startable", message: "scripted runtime refusal" };
    const showReceipt = (
      id: string,
      shownRun: string,
      taskId: string,
      failureCount?: unknown,
      includeFailureCount = true,
    ) => ({
      dispatch: {
        id,
        runId: shownRun,
        task_id: taskId,
        status: "failed",
        ...(includeFailureCount ? { failureCount } : {}),
      },
    });
    for (const [shownId, shownRun, shownTask] of [
      ["ctx_wrong_identity", runId, "task_aaa"],
      [firstDispatch, "run_other", "task_aaa"],
      [firstDispatch, runId, "task_other"],
    ]) {
      await mutateState((state) => {
        state.workerShow = { [firstDispatch]: showReceipt(shownId!, shownRun!, shownTask!, 9) };
        state.workerStartRetryFailure = refusal;
      });
      await assert.rejects(retryWorker("task_aaa"), (error: unknown) =>
        (error as { code?: string }).code === "task_not_startable");
      assert.equal(attempt("task_aaa").dispatchId, firstDispatch);
      assert.equal(attempt("task_aaa").failureCount, 0, "a wrong Run, Task, or Dispatch cannot replace evidence");
    }
    for (const detail of [
      showReceipt(firstDispatch, runId, "task_aaa", undefined, false),
      showReceipt(firstDispatch, runId, "task_aaa", null),
    ]) {
      await mutateState((state) => {
        state.workerShow = { [firstDispatch]: detail };
        state.workerStartRetryFailure = refusal;
      });
      await assert.rejects(retryWorker("task_aaa"), (error: unknown) =>
        (error as { code?: string }).code === "task_not_startable");
      assert.equal(attempt("task_aaa").failureCount, 0, "missing or null evidence retains the same-ID known value");
    }

    await mutateState((state) => {
      state.dispatches[firstDispatch].failureCount = 1;
      delete state.workerShow;
      state.workerStartRetryFailure = refusal;
    });
    await assert.rejects(retryWorker("task_aaa"), (error: unknown) =>
      (error as { code?: string }).code === "task_not_startable");
    assert.equal(attempt("task_aaa").dispatchId, firstDispatch);
    assert.equal(attempt("task_aaa").failureCount, 1, "the exact first retry-chain count is exposed");

    await mutateState((state) => {
      state.workerShowFailure = { [firstDispatch]: { message: "detail read failed" } };
    });
    await assert.rejects(retryWorker("task_aaa"), (error: unknown) =>
      (error as { code?: string }).code === "task_not_startable");
    assert.equal(attempt("task_aaa").dispatchId, firstDispatch);
    assert.equal(attempt("task_aaa").failureCount, 1, "a failed same-id read retains last known count");

    await mutateState((state) => {
      delete state.workerShowFailure;
      delete state.workerShow;
      state.dispatches[firstDispatch].failureCount = null;
    });
    await assert.rejects(retryWorker("task_aaa"), (error: unknown) =>
      (error as { code?: string }).code === "task_not_startable");
    assert.equal(attempt("task_aaa").failureCount, 1, "a valid null from the same Dispatch also retains last known count");

    const nextDispatch = `ctx_s${Number(getState().seq.dispatch) + 1}`;
    await mutateState((state) => {
      delete state.workerStartRetryFailure;
      state.workerShowFailure = { [nextDispatch]: { message: "new Dispatch detail is not yet available" } };
    });
    await retryWorker("task_aaa");
    await waitFor(() => attempt("task_aaa").dispatchId === nextDispatch ? true : null, "retry Dispatch promotion");
    assert.equal(attempt("task_aaa").failureCount, null, "a new Dispatch does not inherit the prior local count when its detail is unavailable");

    await mutateState((state) => {
      delete state.workerShowFailure;
      state.dispatches[nextDispatch].failureCount = 3;
    });
    await settleViaWorkerDone("task_aaa", "failed", "msg_accounting_retry_failed");
    await waitFor(() => attempt("task_aaa").terminalDecision === "released" ? true : null, "retry Dispatch release");
    assert.equal(attempt("task_aaa").failureCount, 3, "the counter is read from Orca after failure settlement");

    await mutateState((state) => {
      state.dispatches[nextDispatch].status = "completed";
      state.dispatches[nextDispatch].failureCount = 3;
    });
    await retryWorker("task_aaa");
    await waitFor(() => attempt("task_aaa").dispatchId !== nextDispatch ? true : null, "corrected Dispatch retry");
    assert.equal(attempt("task_aaa").failureCount, 3, "the new Dispatch inherits only Orca's exact count");
    assert.equal(attempt("task_aaa").dispatchStatus, "dispatched", "completed correction is not treated as circuit_broken");

    await settleViaWorkerDone("task_bbb", "succeeded", "msg_accounting_other_complete");
    await stopCoordinator();
  });

  it("preflights an exact circuit_broken status without starting or recording retry success", async () => {
    const { call } = await startApp();
    const runId = "run_retry_circuit_preflight";
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: "[]" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(baseOpts(runId, { maxConcurrency: 2 }));
    await waitFor(() => calls("worker-start").length === 2 ? true : null, "both Dispatches");
    const dispatchId = await dispatchIdOf("task_aaa");
    await settleViaWorkerDone("task_aaa", "failed", "msg_circuit_base_failed");
    await waitFor(() => attempt("task_aaa").terminalDecision === "released" ? true : null, "failed Dispatch release");
    await mutateState((state) => {
      state.dispatches[dispatchId].failureCount = 3;
      state.dispatches[dispatchId].status = "circuit_broken";
    });
    await waitFor(
      () => attempt("task_aaa").dispatchStatus === "circuit_broken" && attempt("task_aaa").failureCount === 3
        ? true : null,
      "exact circuit count refresh before retry",
    );

    const beforeActivity = await call("GET", `/api/activity?run=${runId}`);
    const beforeRetryEvents = ((beforeActivity.json.events as Array<Record<string, unknown>>) ?? [])
      .filter((event) => event.title === "Coordinator retried a failed stage").length;
    const beforeRetryStarts = callsOf("worker-start", "--retry-of", dispatchId).length;
    const rejected = await call("POST", "/api/workers/task_aaa/retry", {});
    assert.equal(rejected.status, 409);
    assert.equal(rejected.json.code, "task_not_startable");
    assert.match(String(rejected.json.error), /circuit_broken/);
    assert.equal(callsOf("worker-start", "--retry-of", dispatchId).length, beforeRetryStarts, "preflight sends no worker-start");
    assert.equal(attempt("task_aaa").dispatchId, dispatchId, "the rejected retry keeps the authoritative Dispatch");
    assert.equal(attempt("task_aaa").failureCount, 3);
    assert.equal(attempt("task_aaa").dispatchStatus, "circuit_broken");
    const afterActivity = await call("GET", `/api/activity?run=${runId}`);
    const afterRetryEvents = ((afterActivity.json.events as Array<Record<string, unknown>>) ?? [])
      .filter((event) => event.title === "Coordinator retried a failed stage").length;
    assert.equal(afterRetryEvents, beforeRetryEvents, "preflight rejection is not reported as a successful retry Activity");

    await settleViaWorkerDone("task_bbb", "succeeded", "msg_circuit_other_complete");
    await stopCoordinator();
  });

  it("serializes simultaneous retry requests before either can issue a second start", async () => {
    const runId = "run_retry_concurrent";
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: "[]" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(baseOpts(runId, { maxConcurrency: 2 }));
    await waitFor(() => calls("worker-start").some((c) => c.argv.includes("task_aaa")) &&
      calls("worker-start").some((c) => c.argv.includes("task_bbb")) ? true : null, "two root workers to start");
    const oldDispatch = await dispatchIdOf("task_aaa");
    await settleViaWorkerDone("task_aaa", "failed", "msg_retry_concurrent_failed");
    await waitFor(() => attempt("task_aaa").terminalDecision === "released" ? true : null, "failed Dispatch release");

    const results = await Promise.allSettled([retryWorker("task_aaa"), retryWorker("task_aaa")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.equal((refused.reason as { code?: string }).code, "retry_not_allowed");
    assert.equal(callsOf("worker-start", "--retry-of", oldDispatch).length, 1, "only one candidate reaches worker-start");
    assert.notEqual(attempt("task_aaa").dispatchId, oldDispatch, "the confirmed candidate becomes authoritative");

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_retry_concurrent_ok");
    await settleViaWorkerDone("task_bbb", "succeeded", "msg_retry_concurrent_other_ok");
    await waitFor(() => coordinatorStatus().phase === "completed" ? true : null, "concurrent retry Run completion");
  });

  it("does not restore a retry candidate after Stop while its success receipt is returning", async () => {
    const runId = "run_retry_stop_race";
    let pauseRetryReceipt = false;
    let resumeReceipt!: () => void;
    let notifyReceipt!: () => void;
    const entered = new Promise<void>((resolve) => { notifyReceipt = resolve; });
    const receiptGate = new Promise<void>((resolve) => { resumeReceipt = resolve; });
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: "[]" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(baseOpts(runId, {
      maxConcurrency: 2,
      onRequestRecord: async (meta) => {
        if (pauseRetryReceipt && meta.operation === "worker-start" && meta.taskId === "task_aaa" &&
            meta.settledLocally === true && meta.dispatchId) {
          pauseRetryReceipt = false;
          notifyReceipt();
          await receiptGate;
        }
      },
    }));
    await waitFor(() => calls("worker-start").some((c) => c.argv.includes("task_aaa")) &&
      calls("worker-start").some((c) => c.argv.includes("task_bbb")) ? true : null, "two root workers to start");
    const oldDispatch = await dispatchIdOf("task_aaa");
    await settleViaWorkerDone("task_aaa", "failed", "msg_retry_stop_failed");
    await waitFor(() => attempt("task_aaa").terminalDecision === "released" ? true : null, "failed Dispatch release");

    pauseRetryReceipt = true;
    const retryPromise = retryWorker("task_aaa");
    await entered;
    const landedDispatch = getState().tasks.task_aaa.dispatch_id as string;
    assert.notEqual(landedDispatch, oldDispatch, "the fake Orca has minted the candidate Dispatch");
    const retryRejected = assert.rejects(retryPromise, (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "not_running");
    const stopping = stopCoordinator();
    resumeReceipt();
    await retryRejected;
    const stop = await stopping;
    assert.ok(stop.results.some((row) => row.target === landedDispatch && row.result === "stopped"),
      "Stop includes the in-flight retry candidate by its exact identity");
    assert.equal(coordinatorStatus().attempts.length, 0, "the late result did not restore a stale Run attempt");
    assert.equal(coordinatorStatus().phase, "idle");
    assert.equal(callsOf("worker-stop", "--dispatch", landedDispatch).length, 1);
  });

  it("refuses a replacement when an exact pending start appears behind a failed Task", async () => {
    const runId = "run_retry_pending";
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: "[]" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(baseOpts(runId));
    const oldDispatch = await dispatchIdOf("task_aaa");
    await dispatchIdOf("task_bbb");
    await settleViaWorkerDone("task_aaa", "failed", "msg_retry_pending_failed");
    await waitFor(() => attempt("task_aaa").terminalDecision === "released" ? true : null, "failed worker cleanup");
    await mutateState((state) => {
      state.dispatches.ctx_pending_retry = {
        id: "ctx_pending_retry", task_id: "task_aaa", run_id: runId,
        status: "pending", workerState: "start_unknown", terminalState: "active",
      };
    });
    const starts = calls("worker-start").length;
    await assert.rejects(retryWorker(oldDispatch), /live Dispatch/);
    assert.equal(calls("worker-start").length, starts, "pending is duplicate-prevention evidence even without dispatched status");
    assert.equal(attempt("task_aaa").dispatchId, oldDispatch, "refusal preserves the failed attempt's identity");
    await stopCoordinator();
  });

  it("refuses to retry an active attempt, and refuses while cleanup debt is open", async () => {
    const runId = "run_refuse";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    const dispatchId = (await waitFor(
      () => (findAttempt("task_aaa")?.dispatchId ?? null),
      "first worker to start",
    ))!;

    // Active: positively NOT failed.
    await assert.rejects(retryWorker("task_aaa"), /not positively failed/, "active attempt refuses");
    await assert.rejects(retryWorker(dispatchId), /not positively failed/, "by-dispatch-id refusal works too");

    // Settle as FAILED, then make the release ambiguous so debt opens.
    await mutateState((state) => {
      state.releaseMode ??= {};
      state.releaseMode[dispatchId] = "release_unknown";
    });
    await settleViaWorkerDone("task_aaa", "failed", "msg_ref1");
    await waitFor(() => (coordinatorStatus().cleanupDebt.length === 1 ? true : null), "release_unknown debt to surface");
    await assert.rejects(retryWorker("task_aaa"), /cleanup debt/, "open debt refuses the retry");
    await stopCoordinator();
  });
});

describe("explicit bootstrap recovery", () => {
  const runId = "run_bootstrap_recovery";
  const oldDispatch = "ctx_bootstrap";
  const selector = "id:repoL::/ws/bootstrap-recovery";

  async function seedClosedBootstrap(overrides: {
    reason?: string;
    verdict?: string;
    exactWorker?: boolean;
    observationStatus?: string;
    terminalHandle?: string;
    connected?: boolean;
  } = {}) {
    await mutateState((s) => {
      const liveness = {
        verdict: overrides.verdict ?? "unverifiable",
        reason: overrides.reason ?? "missing_status",
      };
      s.version = "1.4.226";
      s.runs = { [runId]: { id: runId, objective: "bootstrap recovery", legacy: 0 } };
      s.tasks = { task_aaa: { id: "task_aaa", run_id: runId, status: "blocked", deps: "[]" } };
      s.worktrees = [{ id: selector, path: "/ws/bootstrap-recovery", repoId: "repoL" }];
      s.dispatches = {
        [oldDispatch]: {
          id: oldDispatch, task_id: "task_aaa", run_id: runId, status: "failed",
          workerState: "abandoned", terminalState: "retained", agentTerminal: "term_old",
        },
      };
      s.livenessOverride = { [oldDispatch]: liveness.verdict };
      s.livenessReason = { [oldDispatch]: liveness.reason };
      s.workerShow = {
        [oldDispatch]: {
          dispatch: {
            id: oldDispatch, task_id: "task_aaa", runId, status: "failed",
            dispatchedAt: "2026-10-15T00:00:00.000Z",
          },
          worker: {
            state: "abandoned",
            startOptions: {
              agent: "codex", resolvedWorktreeId: selector.slice(3),
              launch: { effective: { agent: "codex", model: "gpt-6-luna", effort: "max" } },
            },
          },
          projection: {
            dispatchId: oldDispatch, taskId: "task_aaa", runId, role: "worker",
            host: { kind: "local", id: "local" }, liveness,
          },
          terminal: {
            handle: overrides.terminalHandle ?? "term_old",
            connected: overrides.connected ?? false,
            worktreePath: "/ws/bootstrap-recovery",
          },
          observation: {
            status: overrides.observationStatus ?? "exited",
            exactWorker: overrides.exactWorker ?? true,
          },
        },
      };
    });
  }

  for (const reason of ["missing_status", "capability_unsupported"]) {
    it(`retries an exactly exited bootstrap worker despite ${reason}`, async () => {
      await seedClosedBootstrap({ reason });
      await startCoordinator(baseOpts(runId, {
        resumeBlocked: { dispatchId: oldDispatch, allowUnknownProvider: true },
      }));
      await waitFor(() => findAttempt("task_aaa")?.dispatchId ?? null, "explicit bootstrap retry");
      const retried = attempt("task_aaa");
      assert.equal(retried.retriedFrom, oldDispatch);
      assert.notEqual(retried.dispatchId, oldDispatch);
      assert.equal(retried.requested.agent, "codex");
      assert.equal(retried.requested.model, "gpt-6-luna");
      assert.equal(retried.requested.effort, "max");
      assert.equal(retried.requested.worktree, selector);
      assert.equal(getState().tasks.task_aaa.status, "dispatched");
      assert.equal(getState().dispatches[oldDispatch].status, "failed");
      assert.equal(calls("worker-start").length, 1);
      assert.ok(calls("worker-start")[0].argv.includes(oldDispatch));
      assert.equal(calls("task-update").length, 0,
        "native --retry-of must see the original blocked Task, not an operator-created ready state");
      await stopCoordinator();
    });
  }

  for (const scenario of [
    { name: "host contact loss", overrides: { reason: "host_unavailable" } },
    { name: "positive fleet liveness", overrides: { verdict: "live" } },
    { name: "an inexact observation", overrides: { exactWorker: false } },
    { name: "a different terminal", overrides: { terminalHandle: "term_other" } },
    { name: "a still-connected terminal", overrides: { connected: true } },
    { name: "a live terminal observation", overrides: { observationStatus: "live" } },
  ]) {
    it(`refuses bootstrap recovery with ${scenario.name}`, async () => {
      await seedClosedBootstrap(scenario.overrides);
      await assert.rejects(startCoordinator(baseOpts(runId, {
        resumeBlocked: { dispatchId: oldDispatch, allowUnknownProvider: true },
      })), { code: "resume_not_allowed" });
      assert.equal(getState().tasks.task_aaa.status, "blocked");
      assert.equal(calls("task-update").length, 0);
      assert.equal(calls("worker-start").length, 0);
    });
  }

  it("still requires the explicit decision about detached provider work", async () => {
    await seedClosedBootstrap();
    await assert.rejects(startCoordinator(baseOpts(runId, {
      resumeBlocked: { dispatchId: oldDispatch, allowUnknownProvider: false },
    })), { code: "resume_not_allowed" });
    assert.equal(getState().tasks.task_aaa.status, "blocked");
    assert.equal(calls("task-update").length, 0);
    assert.equal(calls("worker-start").length, 0);
  });
});

