import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { coordinatorStatus, retryWorker, startCoordinator, stopCoordinator } from "./coordinator";
import { deriveWorktreeName } from "./orca";
import { CONFIG_FILE, loadConfig, saveConfig } from "./config";
import { setupCoordinatorHarness } from "./testHelpers/coordinatorHarness";

const {
  workspace,
  readLog,
  calls,
  mutateState,
  getState,
  baseOpts,
  recordViewerLaunch,
  settleViaWorkerDone,
  waitFor,
  attempt,
  findAttempt,
  dispatchIdOf,
  startApp,
  singleTaskState,
} = setupCoordinatorHarness();

describe("unverified harness rejection", () => {
  for (const harness of ["gemini", "grok", "cursor", "droid", "kimi"]) {
    it(`rejects ${harness} default and task override before coordinator side effects`, async () => {
      await singleTaskState(`run_unverified_${harness}`);
      await assert.rejects(
        startCoordinator(baseOpts(`run_unverified_${harness}`, { defaultHarness: harness })),
        (error: unknown) => (error as { code?: string }).code === "unverified_harness",
      );
      assert.equal(coordinatorStatus().running, false);
      assert.equal(readLog().length, 0);

      await assert.rejects(
        startCoordinator(baseOpts(`run_unverified_${harness}`, { harnessByTask: { task_aaa: harness } })),
        (error: unknown) => (error as { code?: string }).code === "unverified_harness",
      );
      assert.equal(coordinatorStatus().running, false);
      assert.equal(readLog().length, 0);
    });
  }
});

describe("native OMP and Antigravity workers", { skip: process.platform !== "linux" }, () => {
  for (const harness of ["omp", "antigravity"]) {
    it(`checks saved ${harness} plans in preview and sparse Run requests before side effects`, async () => {
      const runId = `run_native_saved_${harness}`;
      await singleTaskState(runId);
      await mutateState(s => { s.version = "1.4.245"; });
      const previous = await loadConfig(workspace);
      const { call } = await startApp();
      const model = " provider/model#variant:opaque value ";
      try {
        await saveConfig(workspace, { defaultHarness: harness, harnessByTask: {},
          modelByTask: { task_aaa: model }, effortByTask: {}, environmentByTask: {},
          placementByTask: {}, worktreeLanes: {}, laneByTask: {} });
        const preview = await call("POST", "/api/launch-preview", { runId });
        assert.equal(preview.status, 200);
        const row = (preview.json.tasks as Record<string, unknown>[])[0];
        assert.equal(row.harness, harness);
        assert.equal(row.model, model);
        assert.equal(row.route, "supervised");
        for (const modelByTask of [{ task_aaa: model }, {}]) {
          await saveConfig(workspace, { modelByTask, effortByTask: { task_aaa: "high" } });
          for (const path of ["/api/launch-preview", "/api/run"]) {
            const result = await call("POST", path, { runId });
            assert.equal(result.status, 400);
            assert.equal(result.json.code, "unsupported_effort", "effort is rejected even without a selected model");
          }
        }
        await saveConfig(workspace, { effortByTask: {}, placementByTask: {
          task_aaa: { kind: "new-child", setup: "skip" },
        } });
        for (const path of ["/api/launch-preview", "/api/run"]) {
          const result = await call("POST", path, { runId });
          assert.equal(result.status, 503);
          assert.equal(result.json.code, "execution_disabled", "new worktrees require both CLI and runtime 1.4.246");
        }
        await saveConfig(workspace, { placementByTask: {} });
        await mutateState(s => { s.version = "1.4.244"; });
        for (const path of ["/api/launch-preview", "/api/run"]) {
          const result = await call("POST", path, { runId });
          assert.equal(result.status, 503);
          assert.equal(result.json.code, "execution_disabled");
        }
        assert.equal(calls("worker-start").length, 0);
        assert.equal(calls("run-use").length, 0);
        assert.equal(readLog().some(c => c.argv[0] === "terminal" && c.argv[1] === "create"), false);
      } finally {
        writeFileSync(join(workspace, CONFIG_FILE), JSON.stringify(previous));
      }
    });

    for (const placement of ["current", "existing"] as const) {
      it(`starts ${harness} natively on ${placement}, then omits the model for a fresh default session`, async () => {
        const runId = `run_native_${harness}_${placement}`;
        const selector = "id:repoL::/ws/native-existing";
        const model = harness === "omp" ? "openai-codex/gpt-6.1-sol" : "gemini-4-argon-low";
        await mutateState(s => {
          s.version = "1.4.245";
          s.runs = { [runId]: { id: runId, objective: "native worker lifecycle", legacy: 0 } };
          s.tasks = {
            task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
            task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: '["task_aaa"]' },
          };
          s.worktrees = [{ id: selector, path: "/ws/native-existing", hostId: "local" }];
        });
        await startCoordinator(baseOpts(runId, { defaultHarness: harness, modelByTask: { task_aaa: model },
          ...(placement === "existing" ? { placementByTask: {
            task_aaa: { kind: "existing", selector }, task_bbb: { kind: "existing", selector },
          } } : {}),
        }));
        const firstDispatch = await dispatchIdOf("task_aaa");
        const first = calls("worker-start")[0].argv;
        assert.equal(first[first.indexOf("--agent") + 1], harness);
        assert.equal(first[first.indexOf("--model") + 1], model);
        assert.equal(first[first.indexOf("--worktree") + 1], placement === "existing" ? selector : "current");
        assert.equal(attempt("task_aaa").requested.model, model);
        await settleViaWorkerDone("task_aaa", "succeeded", "msg_native_first");
        const secondDispatch = await dispatchIdOf("task_bbb");
        assert.notEqual(firstDispatch, secondDispatch);
        const second = calls("worker-start")[1].argv;
        assert.equal(second[second.indexOf("--agent") + 1], harness);
        assert.equal(second.includes("--model"), false, "default means omit the selector, not inherit the previous model");
        for (const call of [first, second]) {
          assert.equal(call.includes("--terminal") || call.includes("--surface") || call.includes("--effort"), false);
        }
        assert.equal(attempt("task_aaa").terminalDecision, "released", "settled native sessions are not generic reuse candidates");
        await settleViaWorkerDone("task_bbb", "succeeded", "msg_native_second");
        await waitFor(() => coordinatorStatus().phase === "completed" ? true : null, "native accounting completion");
        assert.equal(calls("worker-start").length, 2);
        assert.equal(calls("dispatch").length, 0);
        assert.equal(readLog().filter(c => c.argv[0] === "terminal" && c.argv[1] === "create").length, 1,
          "only the coordinator pane is viewer-created; Orca owns worker launch/custody");
      });
    }

    for (const kind of ["new-child", "new-top-level"] as const) {
      it(`runs ${harness} lane members in one ${kind} workspace with distinct native sessions`, async () => {
        const runId = `run_native_lane_${harness}_${kind}`;
        await mutateState(s => {
          s.version = "1.4.246";
          s.runs = { [runId]: { id: runId, objective: "native lane custody", legacy: 0 } };
          s.tasks = {
            task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
            task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: '["task_aaa"]' },
          };
          s.repos = [{ id: "repoL", path: workspace, kind: "git", hostId: "local" }];
          s.worktrees = [{ id: `id:repoL::${workspace}`, repoId: "repoL", path: workspace, hostId: "local" }];
        });
        const placement = kind === "new-child"
          ? { kind, setup: "skip" as const }
          : { kind, setup: "skip" as const, repo: "id:repoL" };
        const opts = baseOpts(runId, {
          defaultHarness: harness, modelByTask: { task_aaa: "native/explicit-model" },
          worktreeLanes: { lane_native: { placement } },
          laneByTask: { task_aaa: "lane_native", task_bbb: "lane_native" },
        });
        const previous = await loadConfig(workspace);
        const { call } = await startApp();
        try {
          await saveConfig(workspace, opts);
          const preview = await call("POST", "/api/launch-preview", { runId });
          assert.equal(preview.status, 200, "preview validates the lane seed, not absent per-Task placement");
          await startCoordinator(opts);
          const first = await dispatchIdOf("task_aaa");
          assert.equal(findAttempt("task_bbb"), undefined, "dependency/lane admission does not dispatch the successor early");
          await settleViaWorkerDone("task_aaa", "succeeded", "msg_native_lane_first");
          const second = await dispatchIdOf("task_bbb");
          assert.notEqual(first, second);
          const lane = coordinatorStatus().worktreeLanes.find(row => row.laneId === "lane_native")!;
          assert.equal(lane.selector, `id:repoL::/ws/${deriveWorktreeName(runId, "lane_native")}`);
          const starts = calls("worker-start").map(row => row.argv);
          assert.equal(starts.length, 2);
          assert.ok(starts[0].includes(kind));
          assert.ok(starts[1].includes(lane.selector!));
          assert.equal(starts[1].includes("--name") || starts[1].includes("--repo") || starts[1].includes("--model"), false,
            "follow-up creates nothing and omits the previous explicit model");
          for (const argv of starts) {
            assert.equal(argv[argv.indexOf("--agent") + 1], harness);
            assert.equal(argv.includes("--terminal") || argv.includes("--surface"), false);
          }
          assert.equal(attempt("task_aaa").terminalDecision, "released", "workspace reuse never takes external-terminal custody");
          await settleViaWorkerDone("task_bbb", "succeeded", "msg_native_lane_second");
          await waitFor(() => coordinatorStatus().phase === "completed", "native lane settlement");
          assert.equal(getState().worktrees.length, 2, "one parent plus one lane worktree, not a worktree per Task");
          assert.deepEqual(coordinatorStatus().cleanupDebt, []);
        } finally {
          await stopCoordinator();
          writeFileSync(join(workspace, CONFIG_FILE), JSON.stringify(previous));
        }
      });
    }

    for (const scenario of [
      { name: "old CLI", version: "1.4.244", runtime: { appVersion: "1.4.245", state: "ready" } },
      { name: "old runtime", version: "1.4.245", runtime: { appVersion: "1.4.244", state: "ready" } },
      { name: "unknown runtime", version: "1.4.245", runtime: { state: "ready" } },
      { name: "starting runtime", version: "1.4.245", runtime: { appVersion: "1.4.245", state: "starting" } },
    ]) {
      it(`rejects ${harness} with ${scenario.name} before launch side effects`, async () => {
        const runId = `run_native_version_${harness}`;
        await singleTaskState(runId);
        await mutateState(s => { s.version = scenario.version; s.runtime = scenario.runtime; });
        await assert.rejects(startCoordinator(baseOpts(runId, { defaultHarness: harness })), { code: "execution_disabled" });
        assert.equal(calls("worker-start").length, 0);
        assert.equal(calls("run-use").length, 0);
        assert.equal(readLog().some(c => c.argv[0] === "terminal" && c.argv[1] === "create"), false);
      });
    }

    for (const failure of ["invalid_argument", "agent_unconfigured", "start_unknown"]) {
      it(`preserves ${harness} ${failure} without a second start or fallback`, async () => {
        const runId = `run_native_failure_${harness}`;
        await singleTaskState(runId);
        await mutateState(s => {
          s.version = "1.4.245";
          if (failure === "start_unknown") s.workerStartUnknown = true;
          else s.workerStartFail = { code: failure, message: "native refusal" };
        });
        await startCoordinator(baseOpts(runId, { defaultHarness: harness }));
        await waitFor(() => failure === "start_unknown"
          ? findAttempt("task_aaa")?.startReceipt?.status === "outcome_unknown" ? true : null
          : findAttempt("task_aaa")?.settledVia === "start_failed" ? true : null, "native result retained");
        assert.equal(calls("worker-start").length, 1);
        assert.equal(calls("dispatch").length, 0);
        assert.equal(readLog().some(c => c.argv[0] === "agent" && c.argv[1] === "launch"), false);
        assert.equal(readLog().filter(c => c.argv[0] === "terminal" && c.argv[1] === "create").length, 1);
        if (failure === "start_unknown") {
          assert.ok(attempt("task_aaa").dispatchId);
          assert.ok(attempt("task_aaa").startRequestId);
          assert.equal(attempt("task_aaa").settled, false);
          await assert.rejects(retryWorker("task_aaa"), { code: "retry_not_allowed" });
        }
      });
    }

    it(`rechecks ${harness} version eligibility on an explicit retry without replacing the parked attempt`, async () => {
      const runId = `run_native_retry_${harness}`;
      await singleTaskState(runId);
      await mutateState(s => { s.version = "1.4.245"; s.workerStartFail = { code: "invalid_argument", message: "native refusal" }; });
      await startCoordinator(baseOpts(runId, { defaultHarness: harness }));
      await waitFor(() => findAttempt("task_aaa")?.settledVia === "start_failed" ? true : null, "parked native start");
      const originalRequest = attempt("task_aaa").startReceipt?.requestId;
      await mutateState(s => { s.version = "1.4.244"; delete s.workerStartFail; });
      await assert.rejects(retryWorker("task_aaa"), { code: "execution_disabled" });
      assert.equal(calls("worker-start").length, 1);
      assert.equal(attempt("task_aaa").settledVia, "start_failed");
      assert.equal(attempt("task_aaa").startReceipt?.requestId, originalRequest);
    });

    it(`recovers an exact active ${harness} Dispatch without applying replacement-launch gates`, async () => {
      const runId = `run_native_recovery_${harness}`;
      await singleTaskState(runId);
      await mutateState(s => {
        // An older runtime or today's unsupported new-worktree preference does
        // not cancel a historical worker, including blocked pending starts.
        s.tasks.task_aaa.status = "blocked";
        s.dispatches = { ctx_existing: { id: "ctx_existing", task_id: "task_aaa", run_id: runId,
          status: "pending", workerState: "start_unknown", terminalState: "active",
          agentTerminal: "term_existing", liveness: "live",
          launch: { agent: harness, model: null, effort: null, worktree: "current", on: null } } };
      });
      await recordViewerLaunch(runId, "task_aaa", "ctx_existing", harness);
      await startCoordinator(baseOpts(runId, { defaultHarness: harness,
        placementByTask: { task_aaa: { kind: "new-child", setup: "skip" } } }));
      await waitFor(() => findAttempt("task_aaa")?.adopted ? true : null, "native exact adoption");
      assert.equal(attempt("task_aaa").dispatchId, "ctx_existing");
      assert.equal(attempt("task_aaa").settled, false);
      assert.equal(calls("worker-start").length, 0);
      assert.equal(calls("worker-release").length, 0);
    });
  }
});

