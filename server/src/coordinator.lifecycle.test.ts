import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coordinatorStatus, noteManualRelease, startCoordinator, stopCoordinator, type CoordinatorActivityNotice, type StopReport } from "./coordinator";
import { checkReadiness } from "./orca";
import { setupCoordinatorHarness } from "./testHelpers/coordinatorHarness";

const {
  readLog,
  calls,
  callsOf,
  mutateState,
  getState,
  baseOpts,
  recordViewerLaunch,
  coordinatorTerminal,
  settleViaWorkerDone,
  waitFor,
  attempt,
  findAttempt,
  dispatchIdOf,
  startApp,
  singleTaskState,
} = setupCoordinatorHarness();

describe("release_pending and release_unknown", () => {
  it("retries a deferred release and completes once Orca settles it", async () => {
    const runId = "run_pending";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");
    await mutateState((s) => {
      s.releaseMode = s.releaseMode ?? {};
      s.releaseMode[dispatchId] = "release_pending";
    });

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_p1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "release_pending" ? true : null), "release to defer");
    const deferredReleases = callsOf("worker-release", "--dispatch", dispatchId).length;
    assert.ok(deferredReleases >= 1);

    // Orca finishes settling the terminal; the next reconciliation retry lands.
    await mutateState((s) => {
      s.releaseMode[dispatchId] = "normal";
    });
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "release to settle");
    assert.ok(callsOf("worker-release", "--dispatch", dispatchId).length > deferredReleases, "release was retried after release_pending");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });

  it("surfaces release_unknown as debt, never auto-retries it; completion waits for the explicit decision", async () => {
    const { call } = await startApp();
    const runId = "run_unknown";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");
    await mutateState((s) => {
      s.releaseMode = s.releaseMode ?? {};
      s.releaseMode[dispatchId] = "release_unknown";
    });

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_u1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "release_unknown" ? true : null), "release_unknown surfaced");
    await waitFor(() => (coordinatorStatus().cleanupDebt.length === 1 ? true : null), "debt recorded");
    assert.equal(coordinatorStatus().cleanupDebt[0].dispatchId, dispatchId);
    assert.equal(coordinatorStatus().phase, "awaiting_input");
    // The ambiguous outcome must NOT be retried behind the user's back.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(callsOf("worker-release", "--dispatch", dispatchId).length, 1, "no automatic retry of release_unknown");
    assert.notEqual(coordinatorStatus().phase, "completed", "completion blocked by debt");

    // The user resolves it explicitly over HTTP. The coordinator folds the
    // receipt into its projection and the boundary passes.
    await mutateState((s) => {
      s.releaseMode[dispatchId] = "normal";
    });
    const rel = await call("POST", `/api/workers/${dispatchId}/release`, { runId });
    assert.equal(rel.status, 200);
    assert.equal(noteManualRelease(dispatchId, "released"), true, "projection updated");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion after manual release");
    assert.deepEqual(coordinatorStatus().cleanupDebt, []);
  });
  it("prunes externally released reclaimable debt before completion gating", async () => {
    const runId = "run_external_release";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");

    await mutateState((state) => {
      state.dispatches = state.dispatches ?? {};
      state.dispatches.ctx_external = {
        id: "ctx_external",
        task_id: "task_external",
        run_id: runId,
        status: "completed",
        workerState: "supervised",
        terminalState: "reclaimable",
      };
    });
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_external_release");
    await waitFor(
      () => (coordinatorStatus().cleanupDebt.some((debt) => debt.kind === "reclaimable" && debt.dispatchId === "ctx_external") ? true : null),
      "reclaimable fleet debt",
    );

    // Model another Orca client releasing the worker; do not shortcut through
    // the viewer's noteManualRelease projection update.
    await mutateState((state) => {
      state.dispatches.ctx_external.terminalState = "released";
    });
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion after external release");
    assert.deepEqual(coordinatorStatus().cleanupDebt, [], "stale reclaimable debt is pruned from the authoritative fleet read");
  });
});

describe("explicit retain", () => {
  it("keeps the accepted Dispatch when early keep-open fails", async () => {
    const runId = "run_early_keep_open_failure";
    await singleTaskState(runId);
    await mutateState(s => {
      s.version = "1.4.247";
      s.runtime = { state: "ready", reachable: true, appVersion: "1.4.247",
        capabilities: ["orchestration.worker-keep-open.v1"] };
      s.keepOpenFailure = "release_pending";
    });
    try {
      await checkReadiness(true);
      await startCoordinator(baseOpts(runId, { retainByTask: { task_aaa: true } }));
      const dispatchId = await dispatchIdOf("task_aaa");
      await waitFor(() => findAttempt("task_aaa")?.startReceipt?.keepOpen === "release_pending", "accepted keep-open failure receipt");
      assert.equal(attempt("task_aaa").settled, false);
      assert.equal(calls("worker-start").length, 1);
      assert.equal(getState().tasks.task_aaa.dispatch_id, dispatchId);
      const report = await stopCoordinator();
      assert.ok(report.results.some(row => row.target === dispatchId));
    } finally {
      await stopCoordinator();
      await mutateState(s => { s.version = "1.4.205"; delete s.runtime; delete s.keepOpenFailure; });
      await checkReadiness(true);
    }
  });
  for (const [mode, decision] of [
    ["already_released", "released"], ["release_pending", "release_unknown"], ["no_owned_resource", "not_needed"],
  ] as const) {
    it(`reports ${mode} honestly after a retained start without replacing it`, async () => {
      const runId = `run_retain_${mode}`;
      await singleTaskState(runId);
      await startCoordinator(baseOpts(runId, { retainByTask: { task_aaa: true } }));
      const dispatchId = await dispatchIdOf("task_aaa");
      await mutateState(s => { s.retainMode = { [dispatchId]: mode }; });
      await settleViaWorkerDone("task_aaa", "succeeded", `msg_retain_${mode}`);
      await waitFor(() => findAttempt("task_aaa")?.terminalDecision === decision, `retain ${mode} decision`);
      assert.equal(calls("worker-start").length, 1);
      assert.equal(calls("worker-release").length, 0);
      if (mode === "release_pending") assert.ok(coordinatorStatus().cleanupDebt.some(row => row.dispatchId === dispatchId));
      await stopCoordinator();
    });
  }
  it("keeps a settled worker's terminal when retainByTask asks for it", async () => {
    const runId = "run_retain";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId, { retainByTask: { task_aaa: true } }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_r1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "retained" ? true : null), "retained");
    assert.equal(calls("worker-retain").length, 1);
    assert.equal(calls("worker-release").length, 0, "no release on explicit retain");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });
});

describe("explicit stop", () => {
  it("stops supervised workers, fences the opencode tracking dispatch, closes only its own terminal, and reports mixed outcomes distinctly", async () => {
    const { call } = await startApp();
    const runId = "run_stop";
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: "[]" },
        task_ccc: { id: "task_ccc", run_id: runId, status: "pending", deps: "[]" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(
      baseOpts(runId, {
        maxConcurrency: 3,
        harnessByTask: { task_bbb: "opencode", task_ccc: "claude" },
      }),
    );
    await waitFor(() => (calls("worker-start").length === 2 ? true : null), "two supervised workers to start");
    await waitFor(() => (calls("dispatch").length === 1 ? true : null), "opencode tracking dispatch");
    // The tracking dispatch id is adopted from Orca's task record on the next
    // reconciliation — Stop must report it, so wait for the adoption first.
    await waitFor(() => (attempt("task_bbb").dispatchId !== null ? true : null), "tracking dispatch adopted");
    await waitFor(() => (attempt("task_bbb").handle !== null ? true : null), "legacy terminal recorded");

    // Capture identities BEFORE the stop: stopCoordinator clears the attempts.
    const aDispatch = attempt("task_aaa").dispatchId!;
    const cDispatch = attempt("task_ccc").dispatchId!;
    const legacyTerm = attempt("task_bbb").handle!;
    const trackingId = attempt("task_bbb").dispatchId!;
    await mutateState((s) => {
      // Make C's stop unverifiable — the report must carry the uncertainty.
      s.stopMode = s.stopMode ?? {};
      s.stopMode[cDispatch] = "fail";
    });

    const stop = await call("POST", "/api/run-stop", {});
    assert.equal(stop.status, 200);
    const report = stop.json as unknown as StopReport & { ok: boolean };
    assert.equal(report.ok, true);
    assert.equal(report.clean, false, "an unverifiable stop must mark the report unclean");

    const aResult = report.results.find((r) => r.target === aDispatch);
    const cResult = report.results.find((r) => r.target === cDispatch);
    const trackResult = report.results.find((r) => r.target === trackingId);
    const termResult = report.results.find((r) => r.target === legacyTerm);
    assert.equal(aResult?.result, "stopped", `A: ${JSON.stringify(aResult)}`);
    assert.equal(aResult?.kind, "supervised");
    assert.equal(cResult?.result, "unknown", `C: ${JSON.stringify(cResult)}`);
    assert.ok(trackResult, `tracking dispatch reported: ${JSON.stringify(report.results)}`);
    assert.equal(trackResult.result, "fenced");
    assert.equal(trackResult.kind, "tracking_dispatch");
    assert.equal(termResult?.result, "closed", `legacy terminal: ${JSON.stringify(termResult)}`);
    assert.equal(termResult?.kind, "legacy_terminal");

    // Only the viewer-created bare shell was closed — no worker-stop stood in
    // for it, and the supervised terminals were never "closed" to fake a stop.
    const state = getState();
    assert.equal((state.terminals as any[]).find((t) => t.handle === legacyTerm)?.connected, false);
    // Coordinator terminal closed → the user's agent can rebind the Run.
    const coordHandle = coordinatorTerminal(state)?.handle;
    await waitFor(
      () => ((getState().terminals as any[]).find((t) => t.handle === coordHandle)?.connected === false ? true : null),
      "coordinator terminal closed",
    );
    // Stop uncertainty stays visible after the phase resets.
    assert.ok(coordinatorStatus().cleanupDebt.length >= 1, "stop uncertainty surfaces as cleanup debt");
    assert.equal(coordinatorStatus().running, false);
    assert.notEqual(coordinatorStatus().lastStopReport, null);
  });

  for (const state of ["stop_unknown", "unknown"]) {
    it(`keeps a ${state} stop receipt unknown without closing the supervised terminal`, async () => {
      const runId = `run_stop_${state}`;
      await singleTaskState(runId);
      const records: Array<{ operation: string; settledLocally?: boolean; note?: string | null }> = [];
      await startCoordinator(baseOpts(runId, {
        defaultHarness: "codex",
        onRequestRecord: async (record) => { records.push(record); },
      }));
      const dispatchId = await waitFor(() => findAttempt("task_aaa")?.dispatchId ?? null, "Codex Dispatch recorded");
      const terminal = attempt("task_aaa").handle;
      assert.ok(terminal, "the prewarmed terminal is known but is not a substitute for a confirmed worker stop");
      await mutateState((s) => { s.stopMode = { [dispatchId]: state }; });

      const report = await stopCoordinator();
      const result = report.results.find((row) => row.target === dispatchId);
      assert.equal(result?.result, "unknown");
      assert.match(result?.detail ?? "", /unconfirmed/);
      assert.equal(report.clean, false);
      assert.ok(coordinatorStatus().cleanupDebt.some((debt) =>
        debt.kind === "stop_unknown" && debt.dispatchId === dispatchId));
      assert.ok(records.some((record) => record.operation === "worker-stop" &&
        record.settledLocally === false && record.note?.includes(state)));
      assert.equal(getState().dispatches[dispatchId].status, "dispatched");
      assert.equal(readLog().some((call) =>
        call.argv[0] === "terminal" && call.argv.includes("close") && call.argv.includes(terminal)), false);
    });
  }

  it("Run again holds a viewer-stopped opencode stage without exact provider exit evidence", async () => {
    const { call } = await startApp();
    const runId = "run_stop_resume";
    await singleTaskState(runId);

    const body = { runId, defaultHarness: "opencode", maxConcurrency: 1 };
    const started = await call("POST", "/api/run", body);
    assert.equal(started.status, 200);
    await waitFor(() => (calls("dispatch").length === 1 ? true : null), "first tracking Dispatch");
    await waitFor(() => (findAttempt("task_aaa")?.dispatchId ? true : null), "tracking Dispatch adoption");
    const firstDispatch = attempt("task_aaa").dispatchId!;
    assert.ok(firstDispatch);

    const stopped = await call("POST", "/api/run-stop", {});
    assert.equal(stopped.status, 200);
    assert.equal(getState().tasks.task_aaa.status, "blocked", "Orca parks the interrupted Task");

    const resumed = await call("POST", "/api/run", body);
    assert.equal(resumed.status, 200);
    assert.equal(calls("dispatch").length, 1, "a terminal stop does not prove the provider process exited");
    assert.equal(getState().tasks.task_aaa.status, "blocked");
    assert.ok(coordinatorStatus().recovery?.retryBlocked.includes(firstDispatch));
  });

  it("Run again holds a stopped supervised stage without exact provider exit evidence", async () => {
    const { call } = await startApp();
    const runId = "run_stop_resume_supervised";
    await singleTaskState(runId);

    const body = { runId, defaultHarness: "claude", maxConcurrency: 1 };
    assert.equal((await call("POST", "/api/run", body)).status, 200);
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "first supervised Dispatch");
    const firstDispatch = await dispatchIdOf("task_aaa");

    assert.equal((await call("POST", "/api/run-stop", {})).status, 200);
    assert.equal(getState().tasks.task_aaa.status, "blocked");

    assert.equal((await call("POST", "/api/run", body)).status, 200);
    assert.equal(calls("worker-start").length, 1, "a terminal stop does not prove detached work exited");
    assert.equal(getState().tasks.task_aaa.status, "blocked");
    assert.ok(coordinatorStatus().recovery?.retryBlocked.includes(firstDispatch));
  });
});

describe("legacy (opencode) lane settlement", () => {
  it("closes its proven viewer-created terminal and settles the unsupervised tracking dispatch without worker-stop, then completes", async () => {
    const runId = "run_legacy";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.runtime = { appVersion: "1.4.219" };
    });
    const events: CoordinatorActivityNotice[] = [];
    await startCoordinator(
      baseOpts(runId, {
        harnessByTask: { task_aaa: "opencode" },
        onActivity: async (event) => {
          events.push(event);
        },
      }),
    );

    // Legacy start: bare shell + tracking dispatch + preamble typed in.
    await waitFor(() => (calls("dispatch").length === 1 ? true : null), "tracking dispatch");
    await waitFor(() => (calls("dispatch-show").length === 1 ? true : null), "preamble fetch");
    await waitFor(
      () =>
        readLog().some(
          (c) =>
            c.argv[0] === "terminal" &&
            c.argv[1] === "send" &&
            c.argv.some((a) => String(a).includes("exec opencode run --auto")),
        )
          ? true
          : null,
      "opencode launched by replacing the bare shell",
    );
    // The mode folds into the projection only after startOpencodeWorker's
    // await resolves — the launch log line lands first, so poll, don't assert.
    await waitFor(() => (attempt("task_aaa").mode === "legacy" ? true : null), "legacy attempt recorded");
    await waitFor(() => (attempt("task_aaa").handle !== null ? true : null), "viewer-created terminal recorded");
    await waitFor(() => (attempt("task_aaa").dispatchId !== null ? true : null), "tracking dispatch adopted");
    await waitFor(() => (events.length === 1 ? true : null), "legacy assignment activity");
    assert.equal(events[0].dispatchId, attempt("task_aaa").dispatchId);
    const legacyHandle = attempt("task_aaa").handle!;

    // The worker settles itself (its preamble sends worker_done from its own
    // pane; the runtime accepts it and completes the task).
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_leg1");

    await waitFor(() => (attempt("task_aaa").terminalDecision === "closed" ? true : null), "legacy terminal closed");
    assert.equal(calls("worker-stop").length, 0, "no worker-stop on the happy path");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
    const state = getState();
    assert.equal((state.terminals as any[]).find((t) => t.handle === legacyHandle)?.connected, false, "only the proven viewer-created terminal closed");
    const reclaimable = Object.values(state.dispatches as Record<string, any>).filter((d) => d.terminalState === "reclaimable");
    assert.deepEqual(reclaimable, [], "no reclaimable workers after the legacy lane settles");
  });
});
describe("custom command routing", () => {
  it("starts an opt-in custom command directly through the legacy path", async () => {
    const runId = "run_custom_command";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId, { defaultHarness: "aider --yes" }));
    await waitFor(() => findAttempt("task_aaa")?.mode === "legacy" ? true : null, "custom legacy launch");
    await waitFor(() => findAttempt("task_aaa")?.dispatchId ? true : null, "custom tracking Dispatch");

    assert.equal(calls("worker-start").length, 0, "custom commands never probe native agent launch");
    assert.equal(calls("dispatch").length, 1, "custom command keeps a tracking Dispatch");
    assert.ok(readLog().some((call) =>
      call.argv[0] === "terminal" && call.argv[1] === "create" &&
      call.argv[call.argv.indexOf("--command") + 1] === "aider --yes"));
    await stopCoordinator();
  });
});


describe("native OpenCode 2", () => {
  // 1.4.222 fixes submit readiness for both OpenCode agent ids, but its
  // launch-time model support is for `opencode`, not our `opencode2` path.
  // Exercise the original floor and the newer runtime without broadening
  // model selection or allowing a second worker after a rejected start.
  for (const appVersion of ["1.4.220", "1.4.222"]) {
    it(`maps the existing opencode choice to a supervised TUI worker on Orca ${appVersion}`, async () => {
      const runId = "run_opencode2";
      await singleTaskState(runId);
      await mutateState((state) => {
        state.runtime = { appVersion };
      });
      await startCoordinator(baseOpts(runId, { defaultHarness: "opencode" }));
      await waitFor(() => findAttempt("task_aaa")?.dispatchId ?? null, "native OpenCode 2 Dispatch");
      assert.equal(attempt("task_aaa").mode, "supervised");
      assert.equal(callsOf("worker-start", "--agent", "opencode2").length, 1);
      assert.equal(calls("dispatch").length, 0, "no unsupervised tracking Dispatch");
      await settleViaWorkerDone("task_aaa", "succeeded", "msg_oc2");
      await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "native terminal release");
      await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "native completion");
    });

    it(`parks a rejected native start without a second legacy worker on Orca ${appVersion}`, async () => {
      const runId = "run_opencode2_unconfigured";
      await singleTaskState(runId);
      await mutateState((state) => {
        state.runtime = { appVersion };
        state.workerStartFail = { code: "agent_unconfigured", message: "opencode2 is unavailable" };
      });
      await startCoordinator(baseOpts(runId, { defaultHarness: "opencode" }));
      await waitFor(() => findAttempt("task_aaa")?.settledVia === "start_failed", "unconfigured agent to park");
      assert.equal(callsOf("worker-start", "--agent", "opencode2").length, 1);
      assert.equal(calls("dispatch").length, 0);
      assert.equal(readLog().some((call) => call.argv[0] === "terminal" &&
        call.argv[1] === "create" && call.argv.includes("--command") &&
        call.argv[call.argv.indexOf("--command") + 1] === "opencode2"), false);
    });

    it(`preserves a chosen OpenCode model on the one-shot path on Orca ${appVersion}`, async () => {
      const runId = "run_opencode_model";
      await singleTaskState(runId);
      await mutateState((state) => {
        state.runtime = {
          appVersion,
          capabilities: ["orchestration.worker-launch-preferences.v1"],
        };
      });
      await startCoordinator(baseOpts(runId, {
        defaultHarness: "opencode",
        modelByTask: { task_aaa: "provider/model" },
      }));
      await waitFor(() => (calls("dispatch").length === 1 ? true : null), "model-pinned tracking Dispatch");
      await waitFor(() => readLog().some((call) => call.argv[0] === "terminal" &&
        call.argv[1] === "send" && call.argv.some((arg) => String(arg).includes(' -m "provider/model"')))
        ? true : null, "model passed to one-shot OpenCode");
      assert.equal(calls("worker-start").length, 0);
      await waitFor(() => findAttempt("task_aaa")?.dispatchId ?? null, "tracking Dispatch adopted");
      await settleViaWorkerDone("task_aaa", "succeeded", "msg_oc_model");
      await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "model-pinned completion");
    });
  }

  it("explains a disabled OpenCode 2 launcher while preserving the runtime refusal and parking the task", async () => {
    const runId = "run_opencode_disabled";
    const refusal = "Agent launcher opencode2 is disabled or unavailable. Orchestration mutation request ID: req_disabled.";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.runtime = { appVersion: "1.4.222" };
      state.workerStartFail = { code: "agent_unconfigured", message: refusal };
    });
    await startCoordinator(baseOpts(runId, { defaultHarness: "opencode" }));
    await waitFor(() => coordinatorStatus().phase === "awaiting_input" ? true : null, "disabled launcher recovery hint");
    const detail = attempt("task_aaa").terminalDetail ?? "";
    assert.ok(detail.includes(refusal), "retain the exact runtime error and request id");
    assert.equal((attempt("task_aaa").startReceipt?.raw.error as { message?: string })?.message, refusal,
      "do not rewrite the runtime receipt");
    assert.match(detail, /Settings.*Agents.*OpenCode 2/);
    assert.match(detail, /Stop.*Run.*retry/);
    assert.match(detail, /execution host/);
    const message = coordinatorStatus().inbox.recent.find((msg) => msg.type.startsWith("start_failed"))?.subject ?? "";
    assert.ok(message.includes(refusal));
    assert.match(message, /Settings.*Agents.*OpenCode 2/);
    assert.equal(attempt("task_aaa").terminalDecision, "not_needed", "no resource needs cleanup");
    assert.equal(callsOf("worker-start", "--agent", "opencode2").length, 1);
    assert.equal(calls("dispatch").length, 0, "a disabled launcher does not authorize a replacement worker");
  });

  it("does not label other OpenCode startup failures as a disabled launcher", async () => {
    const runId = "run_opencode_other_refusal";
    const refusal = "OpenCode model is unavailable";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.runtime = { appVersion: "1.4.222" };
      state.workerStartFail = { code: "agent_unconfigured", message: refusal };
    });
    await startCoordinator(baseOpts(runId, { defaultHarness: "opencode" }));
    await waitFor(() => coordinatorStatus().phase === "awaiting_input" ? true : null, "other refusal to park");
    const detail = attempt("task_aaa").terminalDetail ?? "";
    assert.ok(detail.includes(refusal));
    assert.doesNotMatch(detail, /Settings.*Agents/);
    assert.equal(callsOf("worker-start", "--agent", "opencode2").length, 1);
    assert.equal(calls("dispatch").length, 0);
  });

  for (const runtime of [{ appVersion: "1.4.219" }, { appVersion: "1.4.222-preview" }, {}]) {
    it(`keeps the one-shot path with a 1.4.222 CLI and ${"appVersion" in runtime ? runtime.appVersion : "unknown"} runtime`, async () => {
      const runId = "run_opencode_runtime_floor";
      await singleTaskState(runId);
      await mutateState((state) => {
        state.version = "1.4.222";
        state.runtime = runtime;
      });
      await startCoordinator(baseOpts(runId, { defaultHarness: "opencode" }));
      await waitFor(() => findAttempt("task_aaa")?.dispatchId ?? null, "compatibility Dispatch");
      assert.equal(attempt("task_aaa").mode, "legacy");
      assert.equal(calls("worker-start").length, 0, "CLI version alone cannot enable native startup");
      assert.equal(calls("dispatch").length, 1);
      await settleViaWorkerDone("task_aaa", "succeeded", "msg_oc_compatibility");
      await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "compatibility completion");
    });
  }

  it("refuses a model-pinned lane before worker effects even when Orca 1.4.222 advertises launch preferences", async () => {
    const runId = "run_opencode_model_lane";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.runtime = {
        appVersion: "1.4.222",
        capabilities: ["orchestration.worker-launch-preferences.v1"],
      };
    });
    await startCoordinator(baseOpts(runId, {
      defaultHarness: "opencode",
      modelByTask: { task_aaa: "provider/model" },
      worktreeLanes: { lane_model: { placement: { kind: "new-child", setup: "skip" } } },
      laneByTask: { task_aaa: "lane_model" },
    }));
    await waitFor(() => findAttempt("task_aaa")?.settledVia === "start_failed", "unsupported model lane to park");
    assert.equal(calls("worker-start").length, 0);
    assert.equal(calls("dispatch").length, 0);
    assert.equal(readLog().some((call) => call.argv[0] === "worktree" && call.argv[1] === "create"), false);
    assert.equal(attempt("task_aaa").handle, null, "no worker terminal was created");
  });
});

describe("unowned dispatched tasks", () => {
  it("adopts a pre-existing active Dispatch (Phase 4), counts it against the budget, and never double-places over it", async () => {
    const runId = "run_unowned";
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_zzz: {
          id: "task_zzz",
          run_id: runId,
          status: "dispatched",
          deps: "[]",
          dispatch_id: "ctx_preexisting",
          assignee_handle: "term_elsewhere",
        },
      };
      state.dispatches = {
        ctx_preexisting: {
          id: "ctx_preexisting",
          task_id: "task_zzz",
          run_id: runId,
          status: "dispatched",
          workerState: "supervised",
          terminalState: "active",
          agentTerminal: "term_elsewhere",
        },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await recordViewerLaunch(runId, "task_zzz", "ctx_preexisting");
    await startCoordinator(baseOpts(runId, { maxConcurrency: 1 }));
    // Recovery adopts the active Dispatch into the projection…
    await waitFor(
      () =>
        (attempt("task_zzz").adopted === true && attempt("task_zzz").dispatchId === "ctx_preexisting"
          ? true
          : null),
      "pre-existing Dispatch to be adopted",
    );
    assert.deepEqual(coordinatorStatus().recovery?.activeAdopted, ["task_zzz"]);
    // …it occupies the only concurrency slot…
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(calls("worker-start").length, 0, "no placement over an adopted Dispatch at cap 1");
    // …and the projection no longer reports it as unowned (it is OURS now).
    assert.deepEqual(coordinatorStatus().unownedDispatches, []);
    // Stopping the coordinator must account for the adopted Dispatch too.
    const stop = await stopCoordinator();
    const zzz = stop.results.find((r) => r.target === "ctx_preexisting");
    assert.ok(zzz, "adopted Dispatch appears in the stop report");
    assert.equal(zzz.result, "stopped");
  });

  it("surfaces an unverifiable Dispatch (no supervised row) without adopting or placing over it", async () => {
    const runId = "run_unverifiable";
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_zzz: {
          id: "task_zzz",
          run_id: runId,
          status: "dispatched",
          deps: "[]",
          dispatch_id: "ctx_nowhere",
          assignee_handle: "term_elsewhere",
        },
      };
      // NO dispatch row for ctx_nowhere — worker-list has nothing verifiable.
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(baseOpts(runId, { maxConcurrency: 1 }));
    await waitFor(
      () => (coordinatorStatus().unownedDispatches.length === 1 ? true : null),
      "unverifiable dispatch surfaced",
    );
    assert.deepEqual(coordinatorStatus().unownedDispatches, ["task_zzz (ctx_nowhere)"]);
    assert.deepEqual(coordinatorStatus().recovery?.unverifiable, ["task_zzz"]);
    // Nothing was adopted, nothing placed: the unverifiable slot holds the budget.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(calls("worker-start").length, 0, "no placement while an unverifiable Dispatch holds the cap");
    // And nothing destructive ever ran against it.
    assert.equal(calls("worker-stop").length, 0);
    assert.equal(calls("worker-release").length, 0);
    await stopCoordinator();
  });
});

// --- Phase 4: restart recovery, idempotent mutations, safe retry -------------

