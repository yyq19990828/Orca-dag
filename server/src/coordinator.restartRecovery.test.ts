import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coordinatorStatus, retryWorker, startCoordinator, stopCoordinator } from "./coordinator";
import { ProviderSessionStore } from "./providerSessions";
import { setupCoordinatorHarness } from "./testHelpers/coordinatorHarness";

const {
  workspace,
  readLog,
  calls,
  callsOf,
  ackCalls,
  mutateState,
  getState,
  baseOpts,
  recordViewerLaunch,
  coordinatorTerminal,
  settleViaWorkerDone,
  injectMail,
  workerDoneMessage,
  waitFor,
  attempt,
  findAttempt,
  dispatchIdOf,
  processedRow,
  singleTaskState,
} = setupCoordinatorHarness();

describe("Phase 4: failed-before-ready starts", () => {
  for (const placement of ["current", "existing"] as const) {
    it(`uses native Codex launch on Orca 1.4.217 for ${placement} with model and effort`, async () => {
      const runId = `run_codex_native_${placement}`;
      await singleTaskState(runId);
      await mutateState((state) => { state.runtime = { appVersion: "1.4.217" }; });
      const selector = placement === "existing" ? "id:repoL::/ws/existing" : "current";
      await startCoordinator(baseOpts(runId, {
        harnessByTask: { task_aaa: "codex" },
        modelByTask: { task_aaa: "gpt-6-luna" },
        effortByTask: { task_aaa: "high" },
        ...(placement === "existing" ? { placementByTask: { task_aaa: { kind: "existing", selector } } } : {}),
      }));
      await waitFor(() => findAttempt("task_aaa")?.dispatchId ?? null, "native Codex dispatch");
      const argv = calls("worker-start")[0].argv;
      assert.equal(argv[argv.indexOf("--agent") + 1], "codex");
      assert.equal(argv[argv.indexOf("--model") + 1], "gpt-6-luna");
      assert.equal(argv[argv.indexOf("--effort") + 1], "high");
      assert.equal(argv[argv.indexOf("--worktree") + 1], selector);
      assert.equal(argv.includes("--terminal"), false);
      assert.equal(readLog().some((call) => call.argv[0] === "terminal" &&
        call.argv.includes("--command") && call.argv.some((arg) => arg.startsWith("codex "))), false);
      await settleViaWorkerDone("task_aaa", "succeeded", `msg_native_${placement}`);
      await waitFor(() => coordinatorStatus().phase === "completed", "native Codex settlement");
      assert.equal(attempt("task_aaa").terminalDecision, "released");
    });
  }

  for (const runtime of [{ appVersion: "1.4.216" }, { appVersion: "1.4.217-preview" }, {}]) {
    it(`keeps Codex prewarm with a new CLI and ${runtime.appVersion ?? "unknown"} runtime`, async () => {
      const runId = "run_codex_compat";
      await singleTaskState(runId);
      await mutateState((state) => { state.version = "1.4.217"; state.runtime = runtime; });
      await startCoordinator(baseOpts(runId, { harnessByTask: { task_aaa: "codex" } }));
      await waitFor(() => findAttempt("task_aaa")?.dispatchId ?? null, "compatible Codex dispatch");
      const argv = calls("worker-start")[0].argv;
      assert.ok(argv.includes("--terminal"), "the running runtime, not CLI version, chooses compatibility");
      assert.equal(argv.includes("--agent"), false);
      await stopCoordinator();
    });
  }

  it("parks a rejected native Codex preference start without launching a compatibility worker", async () => {
    const runId = "run_codex_native_rejected";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.runtime = { appVersion: "1.4.217" };
      state.workerStartFail = { code: "invalid_argument", message: "native model and effort rejected" };
    });
    await startCoordinator(baseOpts(runId, {
      harnessByTask: { task_aaa: "codex" },
      modelByTask: { task_aaa: "gpt-6-luna" },
      effortByTask: { task_aaa: "high" },
    }));
    await waitFor(() => findAttempt("task_aaa")?.settledVia === "start_failed", "native rejection to park");
    assert.equal(calls("worker-start").length, 1);
    assert.equal(calls("dispatch").length, 0);
    assert.equal(readLog().some((call) => call.argv[0] === "terminal" &&
      call.argv.includes("--command") && call.argv.some((arg) => arg === "codex" || arg.startsWith("codex "))), false);
    await stopCoordinator();
  });

  it("creates a new local Codex worktree before starting the TUI and binding its ready terminal", async () => {
    const runId = "run_codex_child_ready";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.runtime = { appVersion: "1.4.217" };
      state.terminalScreen = { source: "screen", tail: [
        "› Ask Codex to do anything", "  GPT-5.6-Sol medium fast · main · Context 96% left",
      ] };
      state.terminalScreens = [
        { source: "output", tail: ["model: GPT-6-Luna", "› Ask Codex to do anything"] },
        { source: "screen", tail: ["model: loading", "› Ask Codex to do anything"] },
      ];
    });
    await startCoordinator(baseOpts(runId, {
      harnessByTask: { task_aaa: "codex" },
      modelByTask: { task_aaa: "gpt-6-luna" },
      placementByTask: {
        task_aaa: { kind: "new-child", name: "codex-child-ready", setup: "skip" },
      },
    }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "prewarmed child to bind");
    const log = readLog();
    const create = log.findIndex((call) => call.argv[0] === "worktree" && call.argv[1] === "create");
    const launch = log.findIndex((call) => call.argv[0] === "terminal" && call.argv[1] === "send" &&
      call.argv.some((arg) => String(arg).startsWith("codex --enable hooks --dangerously-bypass-approvals-and-sandbox")));
    const bind = log.findIndex((call) => call.argv[0] === "orchestration" && call.argv[1] === "worker-start");
    assert.ok(create >= 0 && create < launch && launch < bind, "create → ready Codex → supervised bind");
    assert.ok(log[create].argv.includes("--parent-worktree"));
    assert.ok(log[create].argv.includes("--setup") && log[create].argv.includes("skip"));
    assert.ok(log[launch].argv.some((arg) => String(arg).includes("-m 'gpt-6-luna'")));
    const argv = log[bind].argv;
    assert.ok(argv.includes("--terminal"), "bind the already ready terminal");
    assert.ok(argv.includes("id:repoL::/ws/codex-child-ready"), "bind to the created exact workspace");
    assert.ok(!argv.includes("--agent") && !argv.includes("--model") && !argv.includes("--name"),
      "do not create a second Codex process or send creation-only flags on bind");
    assert.equal(log.filter((call) => call.argv[0] === "terminal" && call.argv[1] === "read").length, 4,
      "ignore output/loading frames, then accept two current Codex composer frames without model:");
    await stopCoordinator();
  });

  it("closes a prepared Codex pane when worker-start rejects it before Dispatch", async () => {
    const runId = "run_codex_bind_rejected";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.workerStartFail = { code: "invalid_argument", message: "terminal bind rejected" };
    });
    await startCoordinator(baseOpts(runId, {
      harnessByTask: { task_aaa: "codex" },
      modelByTask: { task_aaa: "gpt-6-luna" },
    }));
    await waitFor(() => (
      findAttempt("task_aaa")?.terminalDecision === "not_needed" ? true : null
    ), "prepared Codex pane closed after rejected bind");
    assert.equal(attempt("task_aaa").settledVia, "start_failed");
    assert.equal(attempt("task_aaa").dispatchId, null);
    assert.equal(calls("worker-start").length, 1);
    assert.equal(calls("dispatch").length, 0, "rejected bind must not fall through to a second legacy Dispatch");
    const prepared = readLog().find((c) => c.argv[0] === "terminal" && c.argv[1] === "create" &&
      c.argv.some((arg) => arg.startsWith("codex ")));
    assert.ok(prepared);
    assert.ok(readLog().some((c) => c.argv[0] === "terminal" && c.argv[1] === "close" &&
      c.argv.includes(attempt("task_aaa").handle!)));
    assert.deepEqual(coordinatorStatus().cleanupDebt, []);
    await stopCoordinator();
  });

  it("keeps the attempt with its receipt, owes no cleanup, never auto-retries, and retries only on request", async () => {
    const runId = "run_fbready";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.workerStartFail = {
        code: "terminal_start_failed",
        message: "agent terminal failed to become ready",
        receipt: {
          stage: "terminal_start",
          failedStage: "terminal_start",
          setup: "skipped",
          residualResources: null,
          recoveryCommands: [],
        },
      };
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (findAttempt("task_aaa")?.settledVia === "start_failed" ? true : null), "failed-before-ready recorded");
    const a = attempt("task_aaa");
    assert.equal(a.settled, true);
    assert.equal(a.outcome, "failed");
    assert.equal(a.startReceipt?.failedStage, "terminal_start", "the runtime's receipt is preserved verbatim");
    await waitFor(
      () => (findAttempt("task_aaa")?.terminalDecision === "not_needed" ? true : null),
      "ownership decided: nothing to release",
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls("worker-start").length, 1, "no automatic re-placement of a failed start");
    assert.equal(getState().tasks.task_aaa.status, "ready");

    // The explicit retry re-places with the same harness and fresh id.
    await mutateState((state) => {
      delete state.workerStartFail;
    });
    await retryWorker("task_aaa");
    await waitFor(() => (findAttempt("task_aaa")?.dispatchId === "ctx_s1" ? true : null), "retry to place");
    assert.equal(attempt("task_aaa").settled, false);
    assert.equal(attempt("task_aaa").startReceipt?.ok, true, "the new start's success receipt is on file");

    // While that retry is ACTIVE, another retry must refuse.
    await assert.rejects(retryWorker("task_aaa"), /not positively failed/, "an in-flight retry target refuses");

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_fbr1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
    assert.deepEqual(coordinatorStatus().cleanupDebt, []);
  });
});
describe("late settlement after failed worker-start", () => {
  async function beginFailedStart(runId: string): Promise<string> {
    await singleTaskState(runId);
    await mutateState((state) => {
      state.workerStartFail = {
        code: "terminal_start_failed",
        message: "Orca reported a late-start failure",
        receipt: {
          stage: "terminal_start",
          failedStage: "agent_prompt_stalled",
          taskId: "task_aaa",
          dispatchId: "ctx_late",
          residualResources: null,
          recoveryCommands: [],
        },
      };
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => findAttempt("task_aaa")?.settledVia === "start_failed" ? true : null, "failed start receipt");
    await waitFor(() => attempt("task_aaa").terminalDecision === "released" ? true : null, "failed-start custody decision");
    assert.equal(attempt("task_aaa").outcome, "failed");
    assert.equal(attempt("task_aaa").dispatchId, "ctx_late");
    assert.equal(callsOf("worker-release", "--dispatch", "ctx_late").length, 1);
    return "ctx_late";
  }

  it("accepts only exact late worker_done authority without repeating cleanup", async () => {
    const runId = "run_late_mail";
    const dispatchId = await beginFailedStart(runId);

    const rejected = {
      ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_late_rejected"),
      run_id: runId,
      subject: "Rejected worker_done: stale lifecycle",
    };
    const stale = {
      ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_late_wrong_run"),
      run_id: "run_other",
    };
    const staleDeliveryId = await injectMail([rejected, stale]);
    await waitFor(
      () => processedRow("msg_late_rejected") && processedRow("msg_late_wrong_run") ? true : null,
      "rejected and stale late reports",
    );
    await waitFor(() => ackCalls(staleDeliveryId).length === 1 ? true : null, "stale reports to be acknowledged");
    assert.equal(attempt("task_aaa").settledVia, "start_failed");
    assert.equal(attempt("task_aaa").outcome, "failed");

    await mutateState((state) => {
      state.dispatches ??= {};
      state.dispatches[dispatchId] = {
        id: dispatchId,
        task_id: "task_aaa",
        run_id: runId,
        status: "failed",
        workerState: "failed",
        terminalState: "released",
      };
      state.archives ??= {};
      state.archives[dispatchId] = "late success output";
      state.seq ??= {};
      state.seq.delivery = (state.seq.delivery ?? 0) + 1;
      const deliveryId = `delivery_late${state.seq.delivery}`;
      const rejectedAfterCompletion = {
        ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_late_rejected_after_complete"),
        run_id: runId,
        subject: "Rejected worker_done: still rejected",
      };
      const staleTask = {
        ...workerDoneMessage("other_task", dispatchId, "succeeded", "msg_late_wrong_task"),
        run_id: runId,
      };
      const accepted = {
        ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_late_accepted"),
        run_id: runId,
        from_handle: `dispatch:${dispatchId}`,
      };
      const handle = coordinatorTerminal(state).handle;
      state.mailboxes ??= {};
      state.mailboxes[handle] = [
        ...(state.mailboxes[handle] ?? []),
        {
          deliveryId,
          messages: [rejectedAfterCompletion, staleTask, accepted],
        },
      ];
      state.settleOnDelivery ??= {};
      state.settleOnDelivery[deliveryId] = {
        taskId: "task_aaa",
        dispatchId,
        outcome: "succeeded",
      };
    });

    await waitFor(
      () => attempt("task_aaa").settledVia === "worker_done" &&
        attempt("task_aaa").outcome === "succeeded" ? true : null,
      "authoritative late worker_done correction",
    );
    await waitFor(() => coordinatorStatus().phase === "completed" ? true : null, "late-success completion");
    assert.equal(attempt("task_aaa").terminalDecision, "released", "the prior custody decision is preserved");
    assert.equal(attempt("task_aaa").startReceipt?.failedStage, "agent_prompt_stalled", "the start receipt stays in history");
    assert.equal(calls("worker-start").length, 1, "the correction never retries the launch");
    assert.equal(callsOf("worker-release", "--dispatch", dispatchId).length, 1, "the retained cleanup is not repeated");
  });

  it("reconciles a late Task completion for the exact failed-start Dispatch", async () => {
    const runId = "run_late_task_status";
    const dispatchId = await beginFailedStart(runId);
    await mutateState((state) => {
      state.tasks.task_aaa.status = "completed";
      state.tasks.task_aaa.dispatch_id = dispatchId;
      state.dispatches ??= {};
      state.dispatches[dispatchId] = {
        id: dispatchId,
        task_id: "task_aaa",
        run_id: runId,
        status: "completed",
        workerState: "succeeded",
        terminalState: "released",
      };
    });

    await waitFor(
      () => attempt("task_aaa").settledVia === "task_status" &&
        attempt("task_aaa").outcome === "succeeded" ? true : null,
      "late Task-status correction",
    );
    await waitFor(() => coordinatorStatus().phase === "completed" ? true : null, "reconciled completion");
    assert.equal(attempt("task_aaa").terminalDecision, "released", "the prior custody decision is preserved");
    assert.equal(attempt("task_aaa").startReceipt?.failedStage, "agent_prompt_stalled");
    assert.equal(calls("worker-start").length, 1);
    assert.equal(callsOf("worker-release", "--dispatch", dispatchId).length, 1, "no duplicate cleanup");
  });
});


describe("worker_done acceptance", () => {
  it("keeps a rejected worker_done dispatched even when its payload says succeeded", async () => {
    const runId = "run_rejected_done";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => calls("worker-start").length === 1 ? true : null, "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");
    const rejected = {
      ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_rejected_done"),
      run_id: runId,
      subject: "Rejected worker_done: missing Dispatch capability",
    };
    await injectMail([rejected]);
    await waitFor(() => processedRow("msg_rejected_done") ? true : null,
      "rejected report to be processed");
    assert.equal(getState().tasks.task_aaa.status, "dispatched");
    assert.equal(attempt("task_aaa").settled, false);
    assert.equal(calls("worker-release").length, 0, "a rejected report grants no release authority");
    await stopCoordinator();
  });
});

describe("native resume recovery custody", () => {
  for (const scenario of ["bound", "unresolved", "wrong_lineage"] as const) {
    it(`uses exact native resume evidence on restart: ${scenario}`, async () => {
      const runId = `run_native_resume_${scenario}`;
      const taskId = "task_aaa";
      const requestId = "req_native_resume";
      const originalDispatchId = "ctx_old";
      const dispatchId = "ctx_resumed";
      const resumedTerminalId = "term_resumed";
      const timestamp = new Date().toISOString();
      const store = new ProviderSessionStore(workspace);
      await singleTaskState(runId);
      await store.recordResumeAttempt({
        requestId, runId, taskId, originalDispatchId, harness: "claude", sessionId: "session_old",
        workspaceId: "workspace_exact", resumedTerminalId,
        newDispatchId: scenario === "unresolved" ? null : dispatchId, state: scenario === "unresolved" ? "unknown" : "bound",
        error: null, createdAt: timestamp, updatedAt: timestamp,
      });
      const publishNativeBinding = () => mutateState(s => {
        s.tasks[taskId].status = "dispatched";
        s.tasks[taskId].dispatch_id = dispatchId;
        s.dispatches = { [dispatchId]: { id: dispatchId, task_id: taskId, run_id: runId, status: "dispatched",
          workerState: "ready", terminalState: "active", agentTerminal: resumedTerminalId, creatorDispatchId: null } };
        s.workerShow = { [dispatchId]: { dispatch: { id: dispatchId, taskId, runId, status: "dispatched",
          retryOfDispatchId: scenario === "wrong_lineage" ? "ctx_unrelated" : originalDispatchId, creatorDispatchId: null },
          terminal: { handle: resumedTerminalId, connected: true }, worker: { state: "ready" } } };
        s.requests ??= {};
        s.requests[requestId] = { state: "completed", method: "orchestration.workerStart",
          outcome: { runId, taskId, dispatchId, state: "ready", stage: "ready", mutation: { requestId } } };
      });
      if (scenario !== "unresolved") await publishNativeBinding();
      await startCoordinator(baseOpts(runId));
      if (scenario === "unresolved") {
        await waitFor(() => coordinatorStatus().phase === "awaiting_input" ? true : null, "unresolved native resume hold");
        assert.equal(calls("worker-start").length, 0, "automatic dispatch must not replace the unresolved resume");
        await assert.rejects(retryWorker(originalDispatchId), { code: "resume_unknown" });
        await publishNativeBinding();
        await waitFor(() => findAttempt(taskId)?.dispatchId === dispatchId ? true : null, "later exact resume recovery");
        assert.equal((await store.listResumeAttempts(runId))[0].state, "bound");
      }
      const resumed = findAttempt(taskId);
      assert.equal(resumed?.retriedFrom, scenario === "wrong_lineage" ? undefined : originalDispatchId);
      assert.equal(calls("worker-start").length, 0);
      const report = await stopCoordinator();
      assert.equal(callsOf("worker-stop", "--dispatch", dispatchId).length, scenario === "wrong_lineage" ? 0 : 1);
      assert.equal(callsOf("worker-stop", "--dispatch", originalDispatchId).length, 0);
      if (scenario === "wrong_lineage") assert.equal(report.results.find(row => row.target === requestId)?.result, "unknown");
      else assert.equal(report.results.find(row => row.target === dispatchId)?.result, "stopped");
    });
  }
});

describe("Phase 4: restart projection classes", () => {
  /** One dispatched task with a pre-existing Dispatch row (a crashed viewer's). */
  async function crashedState(runId: string, dispatch: Record<string, any>, taskStatus: string): Promise<void> {
    await mutateState((state) => {
      state.tasks = {
        task_zzz: {
          id: "task_zzz",
          run_id: runId,
          status: taskStatus,
          deps: "[]",
          dispatch_id: dispatch.id,
        },
      };
      state.dispatches = { [dispatch.id]: { id: dispatch.id, task_id: "task_zzz", run_id: runId, workerState: "supervised", ...dispatch } };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await recordViewerLaunch(runId, "task_zzz", dispatch.id);
  }

  for (const workerState of ["ready", "starting"]) {
    it(`adopts modern ${workerState} lifecycle evidence without a duplicate launch or terminal close`, async () => {
      const runId = `run_modern_${workerState}`;
      await crashedState(runId, {
        id: "ctx_modern", status: "dispatched", workerState,
        terminalState: "active", agentTerminal: "term_user_owned",
      }, "dispatched");
      await mutateState((state) => {
        state.version = "1.4.226";
        state.tasks.task_aaa = { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" };
      });
      await startCoordinator(baseOpts(runId, { maxConcurrency: 1 }));
      await waitFor(() => coordinatorStatus().lastReconciledAt ? true : null, "modern recovery reconciliation");
      assert.equal(attempt("task_zzz").mode, "supervised");
      assert.equal(attempt("task_zzz").adopted, true);
      assert.equal(attempt("task_zzz").settled, false);
      assert.equal(calls("worker-start").length, 0, "the adopted lifecycle holds the only slot");
      const report = await stopCoordinator();
      assert.equal(report.results.find((row) => row.target === "ctx_modern")?.result, "stopped");
      assert.equal(readLog().some((call) =>
        call.argv[0] === "terminal" && call.argv.includes("close") && call.argv.includes("term_user_owned")), false);
    });
  }

  for (const taskStatus of ["dispatched", "completed"]) {
    it(`adopts a succeeded lifecycle for ${taskStatus} Task cleanup without legacy fallback`, async () => {
      const runId = `run_modern_succeeded_${taskStatus}`;
      await crashedState(runId, {
        id: "ctx_succeeded", status: "completed", workerState: "succeeded", terminalState: "reclaimable",
      }, taskStatus);
      await mutateState((state) => {
        state.version = "1.4.226";
        if (taskStatus === "completed") delete state.tasks.task_zzz.dispatch_id;
      });
      await startCoordinator(baseOpts(runId));
      await waitFor(() => findAttempt("task_zzz")?.terminalDecision === "released" ? true : null,
        "modern succeeded cleanup");
      assert.equal(attempt("task_zzz").mode, "supervised");
      assert.equal(attempt("task_zzz").outcome, "succeeded");
      assert.equal(callsOf("worker-release", "--dispatch", "ctx_succeeded").length, 1);
      assert.equal(calls("worker-start").length, 0);
    });
  }

  for (const pointer of [true, false]) {
    it(`holds blocked pending/start_unknown using ${pointer ? "the Task pointer" : "unique exact history"}`, async () => {
      const runId = `run_pending_start_${pointer}`;
      await crashedState(runId, {
        id: "ctx_start_unknown", status: "pending", workerState: "start_unknown",
        terminalState: "active", agentTerminal: "term_shell",
      }, "blocked");
      await mutateState((state) => {
        state.version = "1.4.226";
        if (!pointer) delete state.tasks.task_zzz.dispatch_id;
        state.tasks.task_aaa = { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" };
      });
      await startCoordinator(baseOpts(runId, { maxConcurrency: 1 }));
      await waitFor(() => coordinatorStatus().lastReconciledAt ? true : null, "pending-start reconciliation");
      assert.equal(attempt("task_zzz").dispatchId, "ctx_start_unknown");
      assert.equal(attempt("task_zzz").mode, "supervised");
      assert.equal(attempt("task_zzz").settled, false, "a live shell does not settle a pending agent launch");
      assert.equal(attempt("task_zzz").terminalDecision, "pending");
      assert.equal(getState().tasks.task_zzz.status, "blocked");
      assert.equal(calls("worker-start").length, 0, "the pending start reserves the concurrency slot");
      assert.equal(calls("worker-release").length, 0);
      assert.equal(calls("worker-stop").length, 0);
      await assert.rejects(retryWorker("task_zzz"), /not positively failed/);
      await stopCoordinator();
    });
  }

  it("holds ambiguous pending history without guessing latest or completing the Run", async () => {
    const runId = "run_pending_ambiguous";
    await crashedState(runId, {
      id: "ctx_pending_old", status: "pending", workerState: "start_unknown", terminalState: "active",
    }, "blocked");
    await mutateState((state) => {
      delete state.tasks.task_zzz.dispatch_id;
      state.dispatches.ctx_pending_new = {
        ...state.dispatches.ctx_pending_old, id: "ctx_pending_new",
      };
      state.tasks.task_aaa = { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" };
    });
    await startCoordinator(baseOpts(runId, { maxConcurrency: 2 }));
    await waitFor(() => coordinatorStatus().lastReconciledAt ? true : null, "ambiguous occupancy");
    assert.equal(findAttempt("task_zzz"), undefined);
    assert.equal(coordinatorStatus().unownedDispatches.length, 2, "both uncertain Dispatches consume slots");
    assert.equal(coordinatorStatus().busy, 2);
    assert.equal(findAttempt("task_aaa"), undefined, "no third worker exceeds the budget");
    assert.ok(coordinatorStatus().recovery?.retryBlockedDetails.some((row) =>
      row.reason.includes("without choosing latest")));
    assert.notEqual(coordinatorStatus().phase, "completed");
    const report = await stopCoordinator();
    assert.equal(report.results.some((row) => row.target.startsWith("ctx_pending_")), false);
    assert.equal(calls("worker-start").length, 0);
    assert.equal(calls("worker-stop").length, 0);
    assert.equal(calls("worker-release").length, 0);
  });

  for (const workerState of ["worker", "future_lifecycle"]) {
    it(`does not grant supervision from ${workerState} or projection.role alone`, async () => {
      const runId = `run_unknown_${workerState}`;
      await crashedState(runId, {
        id: "ctx_unknown", status: "pending", workerState, terminalState: "active",
        agentTerminal: "term_external",
      }, "blocked");
      await startCoordinator(baseOpts(runId));
      await waitFor(() => coordinatorStatus().unownedDispatches.length === 1 ? true : null, "unknown lifecycle held");
      assert.equal(findAttempt("task_zzz"), undefined);
      assert.deepEqual(coordinatorStatus().recovery?.unverifiable, ["task_zzz"]);
      await stopCoordinator();
      assert.equal(calls("worker-start").length, 0);
      assert.equal(calls("worker-stop").length, 0);
      assert.equal(calls("worker-release").length, 0);
      assert.equal(readLog().some((call) =>
        call.argv[0] === "terminal" && call.argv.includes("close") && call.argv.includes("term_external")), false);
    });
  }

  it("stale projection: task row says dispatched, worker-list says completed → adopted settled and auto-released", async () => {
    const runId = "run_stale";
    // The task row is the STALE side: it still says dispatched even though the
    // Dispatch settled — worker-list is authoritative (plan §6.3).
    await crashedState(runId, { id: "ctx_stale", status: "completed", terminalState: "reclaimable" }, "dispatched");
    await startCoordinator(baseOpts(runId));
    assert.deepEqual(coordinatorStatus().recovery?.settledAdopted, ["task_zzz"], "the stale case is settled from worker-list");
    await waitFor(() => (attempt("task_zzz").terminalDecision === "released" ? true : null), "positively reclaimable worker auto-released");
    assert.equal(attempt("task_zzz").settledVia, "task_status");
    assert.equal(attempt("task_zzz").outcome, "succeeded");
    assert.equal(callsOf("worker-release", "--dispatch", "ctx_stale").length, 1, "released exactly once");
    assert.equal(calls("worker-start").length, 0, "never re-placed over a settled Dispatch");
    await stopCoordinator();
  });

  it("retained projection: an already-decided row is left exactly as Orca holds it", async () => {
    const runId = "run_retained";
    await crashedState(runId, { id: "ctx_ret", status: "completed", terminalState: "retained" }, "completed");
    await startCoordinator(baseOpts(runId));
    assert.equal(coordinatorStatus().recovery?.leftDecided, 1, "the retained row is counted as decided");
    assert.equal(coordinatorStatus().attempts.length, 0, "no attempt is invented for it");
    assert.equal(calls("worker-release").length, 0, "no release behind the user's retain");
    assert.equal(calls("worker-retain").length, 0);
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });

  it("release_unknown projection on restart: adopted, surfaced as debt, never auto-retried", async () => {
    const runId = "run_unk";
    await crashedState(runId, { id: "ctx_unk", status: "failed", terminalState: "release_unknown" }, "failed");
    await mutateState((state) => {
      state.releaseMode = { ctx_unk: "release_unknown" };
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(
      () => (coordinatorStatus().cleanupDebt.some((d) => d.dispatchId === "ctx_unk") ? true : null),
      "the ambiguous release to surface as debt",
    );
    assert.equal(attempt("task_zzz").terminalDecision, "release_unknown");
    const releases = callsOf("worker-release", "--dispatch", "ctx_unk").length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(callsOf("worker-release", "--dispatch", "ctx_unk").length, releases, "release_unknown is never auto-retried");
    await stopCoordinator();
  });

  it("release_pending projection on restart: retried under the SAME durable id until Orca settles it", async () => {
    const runId = "run_pend";
    await crashedState(runId, { id: "ctx_pend", status: "completed", terminalState: "release_pending" }, "completed");
    await mutateState((state) => {
      state.releaseMode = { ctx_pend: "release_pending" };
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (attempt("task_zzz").terminalDecision === "release_pending" ? true : null), "deferred release recorded");
    await mutateState((state) => {
      delete state.releaseMode.ctx_pend;
    });
    await waitFor(() => (attempt("task_zzz").terminalDecision === "released" ? true : null), "the deferred release to settle");
    const ids = new Set(
      callsOf("worker-release", "--dispatch", "ctx_pend").map((c) => c.argv[c.argv.indexOf("--retry-request") + 1]),
    );
    assert.equal(ids.size, 1, "every release_pending retry runs under ONE durable id");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });
});

describe("Phase 4: literal nextAction (item 6)", () => {
  it("follows a prescribed worker-release argv verbatim — no extra id is added", async () => {
    const runId = "run_nextact";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.nextAction = {
        ctx_s1: { kind: "release", argv: ["orchestration", "worker-release", "--dispatch", "ctx_s1"] },
      };
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "start");
    const dispatchId = await dispatchIdOf("task_aaa");
    assert.equal(dispatchId, "ctx_s1");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_na1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "released");
    const rel = callsOf("worker-release", "--dispatch", "ctx_s1");
    assert.equal(rel.length, 1);
    assert.equal(rel[0].argv.includes("--retry-request"), false, "the prescribed argv ran VERBATIM");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });

  it("uses the idempotent direct release when no nextAction is prescribed (never invents one)", async () => {
    const runId = "run_nonextact";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "start");
    const dispatchId = await dispatchIdOf("task_aaa");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_nn1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "released");
    const rel = callsOf("worker-release", "--dispatch", dispatchId);
    assert.equal(rel.length, 1);
    assert.equal(rel[0].argv.includes("--retry-request"), true, "the direct release carries a durable id");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });
});

// --- Phase 5: terminal reuse, forced-fresh launch choices, explicit retain ---

