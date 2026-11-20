import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coordinatorStatus, startCoordinator, stopCoordinator, type StartOpts } from "./coordinator";
import { setupCoordinatorHarness } from "./testHelpers/coordinatorHarness";

const {
  readLog,
  calls,
  callsOf,
  firstIndexOf,
  ackCalls,
  mutateState,
  getState,
  baseOpts,
  settleViaWorkerDone,
  settleViaTaskStatus,
  waitFor,
  attempt,
  findAttempt,
  dispatchIdOf,
  startApp,
  singleTaskState,
} = setupCoordinatorHarness();

describe("Phase 5: terminal reuse and retain", () => {
  /** A → B dependency chain: B is the immediate ready follow-up. */
  async function chainState(runId: string): Promise<void> {
    await mutateState((state) => {
      state.tasks = {
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: '["task_aaa"]' },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
  }

  it("reuses the settled terminal for an immediate compatible follow-up BEFORE acknowledging the old Delivery", async () => {
    const runId = "run_reuse";
    await chainState(runId);
    await startCoordinator(baseOpts(runId, { maxConcurrency: 2 }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "A to start");
    const aDispatch = await dispatchIdOf("task_aaa");

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_ru1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "reused" ? true : null), "A's terminal reused");
    await waitFor(() => (findAttempt("task_bbb")?.dispatchId ?? null), "B started on the reused terminal");

    const bStart = calls("worker-start").find((c) => c.argv.includes("task_bbb"))!;
    assert.ok(bStart.argv.includes("--terminal"), "B started via --terminal reuse");
    assert.equal(bStart.argv.indexOf("--agent"), -1, "a reused terminal relaunches nothing");
    assert.equal(attempt("task_bbb").reuseOf, aDispatch, "B's lineage names A's Dispatch");
    assert.equal(
      callsOf("worker-release", "--dispatch", aDispatch).length,
      0,
      "A's terminal was NOT released — it changed hands",
    );
    // Ownership transferred to EXACTLY one new Dispatch, same terminal handle.
    const dispatches = getState().dispatches as Record<string, any>;
    const bDispatches = Object.values(dispatches).filter((d) => d.task_id === "task_bbb");
    assert.equal(bDispatches.length, 1, "exactly one new Dispatch");
    assert.equal(bDispatches[0].agentTerminal, dispatches[aDispatch].agentTerminal, "the SAME terminal handle moved to B");
    assert.equal(dispatches[aDispatch].terminalState, "released", "the old Dispatch no longer holds a reclaimable resource");

    // The old Delivery settles only AFTER the reuse start actually ran.
    await waitFor(() => (ackCalls("delivery_t1").length > 0 ? true : null), "A's delivery acked");
    const bStartIdx = firstIndexOf("worker-start", "--task", "task_bbb");
    const ackIdx = firstIndexOf("check", "--ack", "delivery_t1");
    assert.ok(ackIdx > bStartIdx, `reuse start (log ${bStartIdx}) must land before the ack (log ${ackIdx})`);

    await settleViaWorkerDone("task_bbb", "succeeded", "msg_ru2");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
    assert.equal(attempt("task_bbb").terminalDecision, "released", "the last worker takes the default release");
    assert.deepEqual(coordinatorStatus().cleanupDebt, []);
  });

  it("forces a fresh worker when the follow-up requests a model (--terminal cannot carry one)", async () => {
    const runId = "run_fresh_model";
    await chainState(runId);
    await startCoordinator(baseOpts(runId, { maxConcurrency: 2, modelByTask: { task_bbb: "opus" } }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "A to start");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_fm1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "A released");
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_bbb")) ? true : null), "B to start fresh");
    const bStart = calls("worker-start").find((c) => c.argv.includes("task_bbb"))!;
    assert.ok(bStart.argv.includes("--agent"), "B got its own terminal");
    assert.ok(bStart.argv.includes("--model") && bStart.argv.includes("opus"), "the requested model reached the CLI");
    assert.equal(bStart.argv.indexOf("--terminal"), -1, "no reuse when a model is requested");
    assert.equal(callsOf("worker-release", "--dispatch", attempt("task_aaa").dispatchId!).length, 1, "the settled terminal was released");
    const b = attempt("task_bbb");
    assert.equal(b.requested.model, "opus", "requested model recorded");
    assert.equal(b.requested.terminal, null, "the fresh start claims no reused terminal");
    await stopCoordinator();
  });

  it("forces a fresh worker when the follow-up uses a different harness", async () => {
    const runId = "run_fresh_harness";
    await chainState(runId);
    await startCoordinator(baseOpts(runId, {
      maxConcurrency: 2,
      harnessByTask: { task_bbb: "codex" },
      modelByTask: { task_bbb: "gpt-6-luna" },
    }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "A to start");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_fh1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "A released");
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_bbb")) ? true : null), "B to start fresh");
    const bStart = calls("worker-start").find((c) => c.argv.includes("task_bbb"))!;
    const prepared = readLog().find((c) => c.argv[0] === "terminal" &&
      c.argv[1] === "create" && c.argv.includes("--command") && c.argv.some((arg) => arg.startsWith("codex ")));
    assert.ok(prepared, "Codex was started before worker-start injected its preamble");
    assert.equal(
      prepared.argv[prepared.argv.indexOf("--worktree") + 1],
      bStart.argv[bStart.argv.indexOf("--worktree") + 1],
      "prewarm and Dispatch used the same worktree selector",
    );
    assert.ok(prepared.argv.includes("codex --enable hooks --dangerously-bypass-approvals-and-sandbox --no-alt-screen -m 'gpt-6-luna'"));
    assert.ok(bStart.argv.includes("--terminal"), "Orca bound the prepared Codex terminal");
    assert.equal(bStart.argv.indexOf("--agent"), -1, "worker-start must not relaunch Codex");
    assert.equal(bStart.argv.indexOf("--model"), -1, "model belongs to the prepared TUI command");
    assert.notEqual(
      bStart.argv[bStart.argv.indexOf("--terminal") + 1],
      getState().dispatches[attempt("task_aaa").dispatchId!].agentTerminal,
      "a terminal runs one harness and is not shared across Claude/Codex",
    );
    assert.equal(attempt("task_bbb").requested.model, "gpt-6-luna");
    assert.equal(callsOf("worker-release", "--dispatch", attempt("task_aaa").dispatchId!).length, 1);
    await stopCoordinator();
  });

  it("explicit retain-for-debugging prevents automatic release AND reuse; the follow-up starts fresh", async () => {
    const runId = "run_retain_debug";
    await chainState(runId);
    await startCoordinator(baseOpts(runId, { maxConcurrency: 2, retainByTask: { task_aaa: true } }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "A to start");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_rd1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "retained" ? true : null), "A retained");
    assert.equal(calls("worker-retain").length, 1);
    assert.equal(calls("worker-release").length, 0, "retain prevents release");
    // B still runs — but on a FRESH terminal; the retained one is the user's
    // debugging session and is never handed off.
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_bbb")) ? true : null), "B to start");
    const bStart = calls("worker-start").find((c) => c.argv.includes("task_bbb"))!;
    assert.ok(bStart.argv.includes("--agent"), "B started fresh");
    assert.equal(bStart.argv.indexOf("--terminal"), -1, "the retained terminal is never reused");
    await stopCoordinator();
  });

  it("releases the settled terminal when its reuse start definitely fails (no orphan, no lost worker)", async () => {
    const runId = "run_reuse_fail";
    await chainState(runId);
    await startCoordinator(baseOpts(runId, { maxConcurrency: 2 }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "A to start");
    // The NEXT start (the reuse) fails definitely, with a receipt.
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
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_rf1");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "A released after the failed reuse");
    assert.equal(
      callsOf("worker-release", "--dispatch", attempt("task_aaa").dispatchId!).length,
      1,
      "the unconsumed terminal takes the default release",
    );
    await waitFor(() => (findAttempt("task_bbb")?.settledVia === "start_failed" ? true : null), "B parked with its receipt");
    await waitFor(() => (findAttempt("task_bbb")?.terminalDecision === "not_needed" ? true : null), "B's ownership decided");
    assert.equal(attempt("task_bbb").terminalDecision, "not_needed", "the failed start created nothing");
    await stopCoordinator();
  });

  it("auto-reconciles donor reuse release_unknown debt once worker-list positively proves terminal transfer", async () => {
    const runId = "run_reuse_unknown_reconcile";
    await chainState(runId);
    await startCoordinator(baseOpts(runId, { maxConcurrency: 2 }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "A to start");
    const aDispatch = await dispatchIdOf("task_aaa");
    const termA = getState().dispatches[aDispatch].agentTerminal as string;

    // Simulate Orca creating B on the reused terminal while returning start_unknown.
    await mutateState((s) => {
      s.workerStartUnknown = true;
    });
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_ru_unk_1");

    await waitFor(
      () => (attempt("task_aaa").terminalDecision === "release_unknown" ? true : null),
      "donor records conservative release_unknown debt",
    );
    const bDispatch = await dispatchIdOf("task_bbb");
    assert.ok(
      coordinatorStatus().cleanupDebt.some((d) => d.kind === "release_unknown" && d.dispatchId === aDispatch),
      "donor release_unknown debt is surfaced while transfer is unproven",
    );
    assert.equal(
      callsOf("worker-release", "--dispatch", aDispatch).length,
      0,
      "donor terminal must not be auto-released when reuse outcome is unknown",
    );

    // Orca's authoritative worker-list now reports the exact durable resource transfer
    // (donor absent/not_materialized; recipient originDispatchId=A, ownerDispatchId=B, same terminal).
    await mutateState((s) => {
      delete s.workerStartUnknown;
      s.dispatches[aDispatch].terminalState = "retained";
      s.dispatches[aDispatch].resource = {
        ownershipState: "absent",
        retainedReason: "not_materialized",
        originDispatchId: null,
        ownerDispatchId: null,
        terminalHandle: null,
      };
      s.dispatches[bDispatch].resource = {
        ownershipState: "owned",
        retainedReason: null,
        originDispatchId: aDispatch,
        ownerDispatchId: bDispatch,
        terminalHandle: termA,
      };
    });

    await waitFor(
      () => (attempt("task_aaa").terminalDecision === "reused" ? true : null),
      "donor debt reconciles to reused on positive transfer evidence",
    );
    assert.deepEqual(coordinatorStatus().cleanupDebt, [], "donor cleanupDebt clears once transfer is proven");
    assert.equal(
      callsOf("worker-release", "--dispatch", aDispatch).length,
      0,
      "reconciling transfer never issues a release against the donor",
    );

    await settleViaWorkerDone("task_bbb", "succeeded", "msg_ru_unk_2");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run reaches completed");
    assert.equal(attempt("task_bbb").terminalDecision, "released");
    assert.deepEqual(coordinatorStatus().cleanupDebt, []);
  });

  it("keeps donor reuse release_unknown debt open when fleet resource evidence does not positively prove transfer", async () => {
    const runId = "run_reuse_unknown_unproven";
    await chainState(runId);
    await startCoordinator(baseOpts(runId, { maxConcurrency: 2 }));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "A to start");
    const aDispatch = await dispatchIdOf("task_aaa");
    const termA = getState().dispatches[aDispatch].agentTerminal as string;

    await mutateState((s) => {
      s.workerStartUnknown = true;
    });
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_ru_unp_1");
    await waitFor(
      () => (attempt("task_aaa").terminalDecision === "release_unknown" ? true : null),
      "donor records release_unknown debt",
    );
    const bDispatch = await dispatchIdOf("task_bbb");

    // Case 1: Donor still owns the resource even though recipient mentions originDispatchId.
    await mutateState((s) => {
      delete s.workerStartUnknown;
      s.dispatches[aDispatch].terminalState = "reclaimable";
      s.dispatches[aDispatch].resource = {
        ownershipState: "reclaimable",
        originDispatchId: aDispatch,
        ownerDispatchId: aDispatch,
        terminalHandle: termA,
      };
      s.dispatches[bDispatch].resource = {
        ownershipState: "owned",
        originDispatchId: aDispatch,
        ownerDispatchId: bDispatch,
        terminalHandle: termA,
      };
    });
    await settleViaWorkerDone("task_bbb", "succeeded", "msg_ru_unp_2");
    await waitFor(() => (attempt("task_bbb").terminalDecision === "released" ? true : null), "B released");
    await waitFor(() => (coordinatorStatus().phase === "awaiting_input" ? true : null), "held in awaiting_input");
    assert.equal(attempt("task_aaa").terminalDecision, "release_unknown");
    assert.equal(coordinatorStatus().cleanupDebt.some((d) => d.dispatchId === aDispatch), true);

    // Case 2: Donor becomes absent, but recipient's terminalHandle does not match donor's terminal.
    await mutateState((s) => {
      s.dispatches[aDispatch].terminalState = "retained";
      s.dispatches[aDispatch].resource = {
        ownershipState: "absent",
        retainedReason: "not_materialized",
        originDispatchId: null,
        ownerDispatchId: null,
        terminalHandle: null,
      };
      s.dispatches[bDispatch].resource = {
        ownershipState: "released",
        originDispatchId: aDispatch,
        ownerDispatchId: bDispatch,
        terminalHandle: "term_other_handle",
      };
    });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(attempt("task_aaa").terminalDecision, "release_unknown", "mismatched terminal handle must not clear debt");
    assert.equal(coordinatorStatus().phase, "awaiting_input");
    assert.equal(callsOf("worker-release", "--dispatch", aDispatch).length, 0);
    await stopCoordinator();
  });
});

// --- Phase 5: worker output API + launch-preference API ----------------------

describe("Phase 5: worker output API and launch-preference API", () => {
  it("serves a bounded output page: clamped limit, cursor restart on source_changed, invalid source refused", async () => {
    const { call } = await startApp();
    const runId = "run_out";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    // Wait for the START first — dispatchIdOf's predicate asserts the attempt
    // exists, and the loop needs a tick to reserve it.
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");
    await mutateState((s) => {
      s.archives ??= {};
      s.archives[dispatchId] = "hello output";
    });

    const page = await call("GET", `/api/workers/${dispatchId}/output?run=${runId}`);
    assert.equal(page.status, 200);
    const out = page.json.output as {
      source: string;
      lines: string[];
      clipped: boolean;
      sourceChanged: boolean;
      cursor: string | null;
    };
    assert.equal(out.source, "terminal");
    assert.deepEqual(out.lines, ["hello output"]);
    assert.equal(out.clipped, true, "the runtime reported the page as limited → clipped");
    assert.equal(out.sourceChanged, false);

    // limit clamps at both bounds before reaching the CLI
    await call("GET", `/api/workers/${dispatchId}/output?run=${runId}&limit=99999`);
    await call("GET", `/api/workers/${dispatchId}/output?run=${runId}&limit=0`);
    const limits = calls("worker-read").map((c) => c.argv[c.argv.indexOf("--limit") + 1]);
    assert.ok(limits.includes("200"), "upper clamp is 200");
    assert.ok(limits.includes("1"), "lower clamp is 1");

    // source_changed: the stale-cursor read is refused once, the endpoint
    // restarts fresh and labels the discontinuity.
    await mutateState((s) => {
      s.readCursorFail = { [dispatchId]: true };
    });
    const restarted = await call("GET", `/api/workers/${dispatchId}/output?run=${runId}&cursor=cur_stale`);
    assert.equal(restarted.status, 200);
    const out2 = restarted.json.output as typeof out & { warnings: string[] };
    assert.equal(out2.sourceChanged, true, "the discontinuity is labeled");
    assert.ok(out2.warnings.some((w) => w.toLowerCase().includes("changed")), "a warning explains the restart");
    assert.deepEqual(out2.lines, ["hello output"], "the restart read fresh rows");
    const reads = calls("worker-read");
    assert.ok(reads.at(-2)!.argv.includes("--cursor"), "the refused call carried the cursor");
    assert.ok(!reads.at(-1)!.argv.includes("--cursor"), "the restart dropped it");

    const bad = await call("GET", `/api/workers/${dispatchId}/output?run=${runId}&source=everywhere`);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, "invalid_source");
    await stopCoordinator();
  });

  it("threads per-task effort through /api/run: --model and --effort reach worker-start, requested prefs recorded", async () => {
    const { call } = await startApp();
    const runId = "run_effort";
    await mutateState((state) => {
      state.tasks = { task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" } };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    const res = await call("POST", "/api/run", {
      runId,
      defaultHarness: "claude",
      modelByTask: { task_aaa: "opus" },
      effortByTask: { task_aaa: "high" },
    });
    assert.equal(res.status, 200);
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const start = calls("worker-start")[0];
    assert.ok(start.argv.includes("--model") && start.argv.includes("opus"));
    assert.ok(start.argv.includes("--effort") && start.argv.includes("high"), "effort rides with the model");
    const a = await waitFor(() => {
      const x = findAttempt("task_aaa");
      return x?.requested.effort === "high" ? x : null;
    }, "requested preferences recorded");
    assert.equal(a.requested.model, "opus");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_eff1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion");
  });
});


// --- Phase 6: connected-server placement, remote authority, capabilities -----

/** Two root tasks: one placed locally, one on a saved remote environment. */
function mixedTasks(runId: string): Record<string, any> {
  return {
    task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]", task_title: "Local" },
    task_remote: { id: "task_remote", run_id: runId, status: "pending", deps: "[]", task_title: "Remote" },
  };
}

const REMOTE_ENV_OPTS: Partial<StartOpts> = {
  environmentByTask: { task_remote: "env_remote" },
  placementByTask: { task_remote: { kind: "existing", selector: "id:repoA::/srv/remote-ws" } },
};

describe("Phase 6: mixed local/remote DAG", () => {
  it("starts local and remote workers in one run, routes everything by Dispatch ID, and completes", async () => {
    const runId = "run_mixed";
    await mutateState((state) => {
      state.tasks = mixedTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.environments = [
        {
          id: "env_remote",
          name: "work-laptop",
          connected: true,
          capabilities: ["model.effort", "fleet.snapshot"],
        },
      ];
    });

    await startCoordinator(baseOpts(runId, REMOTE_ENV_OPTS));

    await waitFor(() => (calls("worker-start").length >= 2 ? true : null), "both workers to start");
    const remoteStart = calls("worker-start").find((c) => c.argv.includes("task_remote"))!;
    const localStart = calls("worker-start").find((c) => c.argv.includes("task_aaa"))!;
    // Remote: exact-existing placement + --on, no creation flags.
    assert.ok(remoteStart.argv.includes("--on") && remoteStart.argv.includes("env_remote"));
    assert.ok(
      remoteStart.argv.includes("--worktree") && remoteStart.argv.includes("id:repoA::/srv/remote-ws"),
    );
    assert.ok(
      !remoteStart.argv.includes("--repo") && !remoteStart.argv.includes("--name"),
      "an exact existing workspace carries no creation flags",
    );
    // Local: byte-identical zero-config default, never a --on.
    assert.ok(!localStart.argv.includes("--on"), "the local worker stays on the home server");
    assert.ok(localStart.argv.includes("current"));
    // The peer was inspected before the remote start (capability evidence).
    assert.ok(
      readLog().some((c) => c.argv[0] === "environment" && c.argv[1] === "show"),
      "environment show ran before the remote start",
    );
    // Reconciliation sees remote rows at all.
    assert.ok(calls("worker-list").some((c) => c.argv.includes("--include-remote")));

    await waitFor(() => {
      const r = findAttempt("task_remote");
      return r && r.host?.kind === "environment" ? true : null;
    }, "the remote attempt to adopt its execution host");
    assert.equal(attempt("task_remote").requested.on, "env_remote");
    assert.equal(attempt("task_remote").effective?.on, "env_remote", "the receipt echo names the server");
    assert.equal(attempt("task_aaa").host?.id, "local", "the local attempt reports the local host");

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_a1");
    await settleViaWorkerDone("task_remote", "succeeded", "msg_r1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");
    assert.equal(attempt("task_remote").terminalDecision, "released");
    // Cleanup is addressed by Dispatch ID only — no --on, no terminal handles.
    const release = callsOf("worker-release", "--dispatch", attempt("task_remote").dispatchId!)[0];
    assert.ok(release, "the remote dispatch was released");
    assert.ok(!release.argv.includes("--on"));
    assert.deepEqual(coordinatorStatus().cleanupDebt, []);
  });

  it("places a remote worker with new-top-level: exact repo selector plus explicit name", async () => {
    const runId = "run_newtl";
    await mutateState((state) => {
      state.tasks = {
        task_remote: { id: "task_remote", run_id: runId, status: "pending", deps: "[]" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.environments = [{ id: "env_remote", name: "work-laptop" }];
    });
    await startCoordinator(
      baseOpts(runId, {
        environmentByTask: { task_remote: "env_remote" },
        placementByTask: {
          task_remote: { kind: "new-top-level", repo: "id:repoA", name: "phase6-wt", setup: "run" },
        },
      }),
    );
    await waitFor(() => (calls("worker-start").length >= 1 ? true : null), "remote worker to start");
    const start = calls("worker-start").find((c) => c.argv.includes("task_remote"))!;
    assert.ok(start.argv.includes("new-top-level"));
    assert.ok(start.argv.includes("--repo") && start.argv.includes("id:repoA"));
    assert.ok(start.argv.includes("--name") && start.argv.includes("phase6-wt"));
    assert.ok(start.argv.includes("--on") && start.argv.includes("env_remote"));
    await stopCoordinator();
  });
});

describe("Phase 6: refusal gates before Orca", () => {
  it("refuses a remote 'current' placement before any mutation and parks the attempt — no local fallback", async () => {
    const runId = "run_refuse";
    await mutateState((state) => {
      state.tasks = { task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" } };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.environments = [{ id: "env_remote", name: "work-laptop" }];
    });
    await startCoordinator(
      baseOpts(runId, {
        environmentByTask: { task_aaa: "env_remote" }, // no placement → current → refused
      }),
    );
    await waitFor(
      () => (findAttempt("task_aaa")?.settledVia === "start_failed" ? true : null),
      "the attempt to fail closed",
    );
    assert.equal(calls("worker-start").length, 0, "no worker-start was ever attempted");
    assert.equal(calls("dispatch").length, 0, "no tracking dispatch — never a synthetic local fallback");
    const created = readLog().filter((c) => c.argv[0] === "terminal" && c.argv[1] === "create" && !(c.argv.includes("--title") && c.argv.join(" ").includes("orca-dag coordinator")));
    assert.equal(created.length, 0, "no worker terminal was created locally either");
    assert.match(attempt("task_aaa").terminalDetail ?? "", /ambiguous across servers/);
    await waitFor(() => coordinatorStatus().phase === "awaiting_input" ? true : null, "the failed start to park the run");
    assert.equal(calls("worker-start").length, 0, "parking does not retry the refused placement");
    assert.equal(calls("dispatch").length, 0, "parking does not create a fallback dispatch");
    await stopCoordinator();
  });

  it("forwards model/effort remotely only when the peer advertises the capability", async () => {
    const runId = "run_caps";
    await mutateState((state) => {
      state.tasks = {
        task_old: { id: "task_old", run_id: runId, status: "pending", deps: "[]" },
        task_new: { id: "task_new", run_id: runId, status: "pending", deps: "[]" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.environments = [
        // Old peer: no capability field at all — nothing is advertised.
        { id: "env_plain", name: "old peer" },
        // New peer: advertises model/effort forwarding.
        { id: "env_caps", name: "new peer", capabilities: ["model.effort", "fleet.snapshot"] },
      ];
    });
    // BOTH nodes carry valid remote placements (exact-existing selectors) —
    // a remote node with no placement would be `current`, which the adapter
    // refuses BEFORE the capability question even arises.
    await startCoordinator(
      baseOpts(runId, {
        environmentByTask: { task_old: "env_plain", task_new: "env_caps" },
        placementByTask: {
          task_old: { kind: "existing", selector: "id:repoA::/srv/old-ws" },
          task_new: { kind: "existing", selector: "id:repoA::/srv/new-ws" },
        },
        modelByTask: { task_old: "opus", task_new: "opus" },
      }),
    );
    await waitFor(
      () => (findAttempt("task_old")?.settledVia === "start_failed" ? true : null),
      "the unproven-capability start to fail closed",
    );
    assert.match(attempt("task_old").terminalDetail ?? "", /model\/effort capability/);
    assert.equal(
      calls("worker-start").filter((c) => c.argv.includes("task_old")).length,
      0,
      "no start was attempted against the peer that does not advertise",
    );
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_new")) ? true : null), "the advertising peer's worker to start");
    const newStart = calls("worker-start").find((c) => c.argv.includes("task_new"))!;
    assert.ok(newStart.argv.includes("--model") && newStart.argv.includes("opus"));
    assert.ok(newStart.argv.includes("--on") && newStart.argv.includes("env_caps"));
    assert.equal(attempt("task_new").requested.model, "opus");
    assert.equal(attempt("task_new").requested.on, "env_caps");
    await stopCoordinator();
  });
});

describe("Phase 6: remote authority across disconnect/reconnect", () => {
  it("keeps a disconnected remote Dispatch unverifiable with zero destructive calls, then the same Dispatch settles on reconnect", async () => {
    const runId = "run_drop";
    await mutateState((state) => {
      state.tasks = mixedTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.environments = [
        { id: "env_remote", name: "work-laptop", capabilities: ["fleet.snapshot"] },
      ];
    });

    await startCoordinator(baseOpts(runId, REMOTE_ENV_OPTS));
    await waitFor(() => (calls("worker-start").length >= 2 ? true : null), "both workers to start");
    await waitFor(
      () => (attempt("task_remote").liveness === "live" && attempt("task_remote").host?.kind === "environment" ? true : null),
      "the remote worker to report live",
    );
    const rDispatch = await dispatchIdOf("task_remote");

    // The execution host stops reporting: its row vanishes from worker-list.
    await mutateState((s) => {
      s.offlineDispatch = s.dispatches[rDispatch];
      delete s.dispatches[rDispatch];
    });
    await waitFor(() => (attempt("task_remote").liveness === "unverifiable" ? true : null), "remote liveness to read unverifiable");
    assert.match(attempt("task_remote").livenessReason ?? "", /not reported/);
    assert.equal(attempt("task_remote").nextAction, null, "absence earns no prescribed action");
    assert.equal(attempt("task_remote").settled, false);
    assert.equal(attempt("task_remote").terminalDecision, "pending");
    assert.equal(callsOf("worker-stop", "--dispatch", rDispatch).length, 0);
    assert.equal(callsOf("worker-release", "--dispatch", rDispatch).length, 0);
    assert.equal(calls("worker-abandon").length, 0);
    await new Promise((r) => setTimeout(r, 150));
    assert.notEqual(coordinatorStatus().phase, "completed");

    // Reconnect: the host reports the SAME dispatch again — liveness is
    // restored from the fleet, and the original Dispatch settles.
    await mutateState((s) => {
      s.dispatches[rDispatch] = s.offlineDispatch;
    });
    await waitFor(() => (attempt("task_remote").liveness === "live" ? true : null), "reconnect to restore liveness");
    await settleViaWorkerDone("task_remote", "succeeded", "msg_r1");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_a1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");
    assert.equal(attempt("task_remote").dispatchId, rDispatch, "the ORIGINAL Dispatch settled");
    assert.equal(attempt("task_remote").terminalDecision, "released");
    assert.equal(callsOf("worker-release", "--dispatch", rDispatch).length, 1);
  });
});

describe("Phase 6: reuse never crosses placement", () => {
  it("does not hand a settled local terminal to a remote follow-up — fresh worker with its own placement", async () => {
    const runId = "run_noreuse_r";
    await mutateState((state) => {
      state.tasks = mixedTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.environments = [{ id: "env_remote", name: "work-laptop" }];
    });
    // Concurrency 1: the local worker settles while the remote task is the
    // only ready candidate — exactly the case old reuse logic would consume.
    await startCoordinator(baseOpts(runId, { ...REMOTE_ENV_OPTS, maxConcurrency: 1 }));
    await waitFor(() => (calls("worker-start").length >= 1 ? true : null), "local worker to start");
    await settleViaTaskStatus("task_aaa", "succeeded");
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "local worker to release");
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_remote")) ? true : null), "remote follow-up to start");
    const remoteStart = calls("worker-start").find((c) => c.argv.includes("task_remote"))!;
    assert.ok(remoteStart.argv.includes("--agent"), "a fresh agent terminal is launched");
    assert.ok(!remoteStart.argv.includes("--terminal"), "the settled terminal is never inherited across placement");
    assert.ok(remoteStart.argv.includes("--on") && remoteStart.argv.includes("env_remote"));
    await settleViaWorkerDone("task_remote", "succeeded", "msg_r1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");
  });

  it("does not hand a settled REMOTE terminal to a local follow-up — the remote worker takes the default release", async () => {
    const runId = "run_noreuse_l";
    await mutateState((state) => {
      // task_remote is inserted FIRST so it is the one that starts under
      // concurrency 1 (listTasks preserves insertion order) — task_aaa stays
      // `ready` as the follow-up candidate at the ownership decision.
      state.tasks = {
        task_remote: { id: "task_remote", run_id: runId, status: "pending", deps: "[]" },
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.environments = [{ id: "env_remote", name: "work-laptop" }];
    });
    await startCoordinator(baseOpts(runId, { ...REMOTE_ENV_OPTS, maxConcurrency: 1 }));
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_remote")) ? true : null), "remote worker to start first");
    await settleViaTaskStatus("task_remote", "succeeded");
    await waitFor(() => (attempt("task_remote").terminalDecision === "released" ? true : null), "remote worker released (never reused)");
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("task_aaa")) ? true : null), "local follow-up to start fresh");
    const localStart = calls("worker-start").find((c) => c.argv.includes("task_aaa"))!;
    assert.ok(localStart.argv.includes("--agent") && !localStart.argv.includes("--terminal"));
    assert.ok(!localStart.argv.includes("--on"));
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_a1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");
  });
});

// --- Phase 6: environment/placement discovery + config API -------------------

describe("Phase 6: environment discovery API", () => {
  it("lists saved environments with parsed peer capabilities, and scopes discovery with --environment", async () => {
    await mutateState((state) => {
      state.environments = [
        { id: "env_a", name: "work-laptop", connected: true, capabilities: ["model.effort", "fleet.snapshot"] },
        { id: "env_b", name: "old box" },
      ];
      state.repos = [
        { id: "repoA", path: "/srv/repo", displayName: "repo-a", kind: "git", executionHostId: "ssh:h1" },
      ];
      state.worktrees = [
        {
          id: "repoA::/srv/remote-ws",
          repoId: "repoA",
          path: "/srv/remote-ws",
          displayName: "remote-ws",
          branch: "refs/heads/main",
          hostId: "ssh:h1",
          parentWorktreeId: null,
          isMainWorktree: true,
        },
      ];
      state.projects = [{ id: "proj1", displayName: "Project", kind: "git", sourceRepoIds: ["repoA"] }];
    });
    const { call } = await startApp();
    const { status, json } = await call("GET", "/api/environments");
    assert.equal(status, 200);
    const envs = json.environments as Array<Record<string, unknown>>;
    assert.equal(envs.length, 2);
    assert.equal(envs[0].id, "env_a");
    assert.deepEqual((envs[0].peer as Record<string, unknown>), {
      modelEffort: true,
      transcriptRead: false,
      fleetSnapshot: true,
      raw: ["model.effort", "fleet.snapshot"],
    });
    assert.equal((envs[1].peer as Record<string, unknown>).modelEffort, false, "nothing advertised → gates off");

    const wt = await call("GET", "/api/environments/env_a/worktrees");
    assert.equal(wt.status, 200);
    assert.equal((wt.json.worktrees as unknown[]).length, 1);
    assert.equal(
      readLog().some((c) => c.argv[0] === "worktree" && c.argv.includes("--environment") && c.argv.includes("env_a")),
      true,
      "worktree discovery names the environment",
    );
    const repos = await call("GET", "/api/environments/env_a/repos");
    assert.equal((repos.json.repos as unknown[]).length, 1);
    const projects = await call("GET", "/api/environments/env_a/projects");
    assert.equal((projects.json.projects as unknown[]).length, 1);
    // A malformed selector never reaches the CLI.
    const bad = await call("GET", "/api/environments/bad%20env/worktrees");
    assert.equal(bad.status, 400);
  });
});

// --- Phase 5: durable mutation-request audit trail ---------------------------
//
// The coordinator's request ledger sink is metadata only — ids, scope, and a
// bounded viewer note. What Phase 5 adds to the recovery story: the SAME
// durable `--retry-request` id that makes a lost response idempotently
// recoverable ALSO survives in the ledger, so `request-show` stays reachable
// after the in-memory attempt projection is gone (response loss, viewer
// restart). These tests capture the sink's output verbatim.

describe("Phase 5: durable mutation-request audit trail", () => {
  /** Start the loop with a capturing ledger sink (still fully best-effort). */
  async function startWithAuditCapture(runId: string, extra: Partial<StartOpts> = {}) {
    const records: import("./requestLedger").MutationRequestMeta[] = [];
    await startCoordinator(
      baseOpts(runId, {
        ...extra,
        onRequestRecord: async (meta) => {
          records.push({ ...meta });
        },
      }),
    );
    return records;
  }

  it("records a worker-start request BEFORE the CLI call and links the Dispatch after recovery", async () => {
    const runId = "run_audit_lost";
    await mutateState((state) => {
      state.tasks = { task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" } };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      // The start LANDS and the response is lost — recovered via
      // request-show + same-id replay, exactly as in Phase 4.
      state.workerStartAmbiguous = "lost";
    });
    const records = await startWithAuditCapture(runId);
    await waitFor(() => {
      const current = findAttempt("task_aaa");
      return current?.dispatchId && records.some((record) => record.dispatchId === current.dispatchId)
        ? current.dispatchId
        : null;
    }, "recovered dispatch linked in the request ledger");
    const a = attempt("task_aaa");

    const startRecords = records.filter((r) => r.operation === "worker-start");
    assert.ok(startRecords.length >= 2, "mint record + resolution record");
    const mint = startRecords[0];
    assert.equal(mint.dispatchId, null, "the mint record precedes any Dispatch knowledge");
    assert.equal(mint.runId, runId, "the run scope rides from the operation itself");
    assert.equal(mint.taskId, "task_aaa");
    // The minted id is EXACTLY the durable id both CLI calls ran under —
    // this is what keeps request-show reachable after a restart.
    const argvIds = calls("worker-start").map(
      (c) => c.argv[c.argv.indexOf("--retry-request") + 1],
    );
    assert.equal(argvIds[0], mint.requestId);
    assert.deepEqual(argvIds, [mint.requestId, mint.requestId], "same id on original + replay");
    const resolved = startRecords[startRecords.length - 1];
    assert.equal(resolved.requestId, mint.requestId);
    assert.equal(resolved.dispatchId, a.dispatchId, "the Dispatch is linked once known");
    assert.equal(resolved.settledLocally, true, "the replay resolved the outcome");
    assert.match(resolved.note ?? "", /landed as dispatch/);
    await stopCoordinator();
  });

  it("leaves an unresolved lost start inspectable: unsettled attempt and request-show pointer", async () => {
    const runId = "run_audit_noreceipt";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.workerStartAmbiguous = "lost_noreceipt";
    });
    const records = await startWithAuditCapture(runId);
    await waitFor(() => (findAttempt("task_aaa")?.startReceipt?.failedStage === "response_lost" ? true : null), "unknown start recorded");
    assert.equal(attempt("task_aaa").settled, false);
    assert.ok(attempt("task_aaa").startRequestId);
    assert.equal(attempt("task_aaa").startRequestId, attempt("task_aaa").startReceipt?.requestId);
    const startRecords = records.filter((r) => r.operation === "worker-start");
    const resolved = startRecords[startRecords.length - 1];
    assert.equal(resolved.settledLocally, false, "the outcome is NOT known — never recorded as if it were");
    assert.match(resolved.note ?? "", /response lost/);
    assert.match(resolved.note ?? "", /request-show/);
    assert.ok(calls("request-show").length >= 1, "Orca was asked before anything else");
    await stopCoordinator();
  });

  it("records worker-release at settlement with Dispatch/Task linkage and the observed state", async () => {
    const runId = "run_audit_release";
    await singleTaskState(runId);
    const records = await startWithAuditCapture(runId);
    await waitFor(() => (findAttempt("task_aaa")?.dispatchId ?? null), "dispatch");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_audit1");
    await waitFor(() => (findAttempt("task_aaa")?.terminalDecision === "released" ? true : null), "release");
    const releaseRecords = records.filter((r) => r.operation === "worker-release");
    assert.ok(releaseRecords.length >= 2, "mint + resolution records");
    const mint = releaseRecords[0];
    assert.equal(mint.dispatchId, attempt("task_aaa").dispatchId, "release knows its Dispatch");
    assert.equal(mint.taskId, "task_aaa");
    const releaseArgv = calls("worker-release")[0].argv;
    const argvId = releaseArgv[releaseArgv.indexOf("--retry-request") + 1];
    assert.equal(argvId, mint.requestId, "the recorded id is the id the CLI ran under");
    const resolved = releaseRecords[releaseRecords.length - 1];
    assert.equal(resolved.settledLocally, true);
    assert.match(resolved.note ?? "", /released/);
    await stopCoordinator();
  });

  it("records worker-stop requests when the coordinator is stopped with live workers", async () => {
    const runId = "run_audit_stop";
    await singleTaskState(runId);
    const records = await startWithAuditCapture(runId);
    await waitFor(() => (findAttempt("task_aaa")?.dispatchId ?? null), "dispatch");
    await stopCoordinator();
    const stopRecords = records.filter((r) => r.operation === "worker-stop");
    assert.ok(stopRecords.length >= 2, "mint + resolution records");
    assert.equal(stopRecords[0].taskId, "task_aaa");
    assert.equal(stopRecords[0].dispatchId, "ctx_s1");
    assert.equal(stopRecords[0].runId, runId);
    const resolved = stopRecords[stopRecords.length - 1];
    assert.equal(resolved.settledLocally, true);
    assert.match(resolved.note ?? "", /stop state:/);
    const stopArgv = calls("worker-stop")[0].argv;
    const argvId = stopArgv[stopArgv.indexOf("--retry-request") + 1];
    assert.equal(argvId, stopRecords[0].requestId, "the recorded id is the id the CLI ran under");
  });

  it("captures release-archive facts on the attempt without claiming settlement", async () => {
    const runId = "run_audit_archive";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.archives = { ctx_s1: ["ARCHIVED OUTPUT LINE"] };
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (findAttempt("task_aaa")?.dispatchId ?? null), "dispatch");
    await settleViaWorkerDone("task_aaa", "succeeded", "msg_audit2");
    await waitFor(() => (findAttempt("task_aaa")?.terminalDecision === "released" ? true : null), "release");
    // The release receipt the fake answers carries archive facts; the attempt
    // projects them as a bounded summary alongside — never instead of — the
    // authoritative terminal state.
    const a = attempt("task_aaa");
    assert.equal(a.terminalDecision, "released", "the fleet answer stays the authority");
    const archive = (a as unknown as { terminalArchive: string | null }).terminalArchive;
    assert.ok(archive, "archive facts from the release receipt are projected");
    assert.match(archive!, /ARCHIVED OUTPUT LINE/, "the summary carries the receipt's archive");
    await stopCoordinator();
  });
});

