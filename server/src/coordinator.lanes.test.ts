import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { answerInboxItem, coordinatorStatus, retryWorker, startCoordinator, stopCoordinator, type StartOpts } from "./coordinator";
import { deriveWorktreeName } from "./orca";
import { setupCoordinatorHarness } from "./testHelpers/coordinatorHarness";

const {
  workspace,
  readLog,
  calls,
  callsOf,
  firstIndexOf,
  namespaceCalls,
  mutateState,
  getState,
  baseTasks,
  baseOpts,
  coordinatorTerminal,
  settleViaWorkerDone,
  settleViaTaskStatus,
  injectMail,
  workerDoneMessage,
  waitFor,
  attempt,
  findAttempt,
  dispatchIdOf,
} = setupCoordinatorHarness();

// --- worktree lanes (durable local workspace lanes + integration gates) -----

/** A two-member lane chain: lane_t1 → lane_t2 (totally dependency-ordered). */
function laneTasks(runId: string): Record<string, any> {
  return {
    lane_t1: { id: "lane_t1", run_id: runId, status: "pending", deps: "[]", task_title: "L1" },
    lane_t2: { id: "lane_t2", run_id: runId, status: "pending", deps: '["lane_t1"]', task_title: "L2" },
  };
}

/** One exact-existing worktree row the fake's discovery/revalidation serves. */
function worktreeRow(id: string, name: string, repoId = "repoA"): Record<string, any> {
  return {
    id,
    repoId,
    path: `/srv/${name}`,
    displayName: name,
    branch: `feature/${name}`,
    hostId: null,
    parentWorktreeId: null,
    isMainWorktree: false,
  };
}

describe("worktree lanes: plan validation before mutation", () => {
  it("refuses to start when a lane's members are not dependency-ordered — no terminal, no binding", async () => {
    const runId = "run_lane_invalid";
    await mutateState((state) => {
      // Two UNORDERED roots assigned to one lane: a lane runs one task at a
      // time, so this plan would silently serialize independent work.
      state.tasks = {
        lane_p1: { id: "lane_p1", run_id: runId, status: "pending", deps: "[]", task_title: "P1" },
        lane_p2: { id: "lane_p2", run_id: runId, status: "pending", deps: "[]", task_title: "P2" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await assert.rejects(
      startCoordinator(
        baseOpts(runId, {
          worktreeLanes: { lane_x: { placement: { kind: "existing", selector: "id:repoA::/srv/x" } } },
          laneByTask: { lane_p1: "lane_x", lane_p2: "lane_x" },
        }),
      ),
      /not ordered by any dependency path/,
    );
    assert.equal(coordinatorStatus().phase, "error");
    // The refusal happened BEFORE any mutation: no coordinator terminal was
    // created, the Run was never bound, nothing was dispatched.
    assert.deepEqual(getState().terminals ?? [], [], "no terminal exists");
    assert.equal(calls("run-use").length, 0, "the Run was never bound");
    assert.equal(calls("worker-start").length, 0, "nothing was dispatched");
    assert.equal(calls("gate-create").length, 0, "no gate was created");
  });
});

describe("coordinator terminal follows the backend lifetime", () => {
  it("closes the provisional coordinator terminal when the Run binding refuses after creation", async () => {
    const runId = "run_bind_refused";
    await mutateState((state) => {
      state.tasks = baseTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      // Scripted refusal (fake-orca): run-use fails AFTER ensureCoordinatorTerminal
      // created the pane — the exact window where a failed start used to leak it.
      state.runUseFail = true;
    });
    await assert.rejects(startCoordinator(baseOpts(runId)), /scripted: binding refused/);
    assert.equal(coordinatorStatus().phase, "error");
    // The pane WAS created for the attempt …
    const pane = coordinatorTerminal(getState());
    assert.ok(pane, "the provisional coordinator terminal was created");
    assert.equal(calls("run-use").length, 1, "the binding was attempted");
    // … and the failed start closed it: a leaked coordinator-titled pane holds
    // the workspace's coordinator slot and would turn every retry into
    // coordinator_conflict until a manual uninstall.
    assert.equal(
      readLog().filter(
        (c) => c.argv[0] === "terminal" && c.argv[1] === "close" && c.argv.includes(pane.handle),
      ).length,
      1,
      "exactly one close of the provisional pane",
    );
    const leftover = (getState().terminals ?? []).filter(
      (t: any) => (t.title ?? "").startsWith("orca-dag coordinator") && t.connected,
    );
    assert.equal(leftover.length, 0, "no coordinator-titled pane outlives the failed start");
    assert.equal(coordinatorStatus().coordinatorHandle, null, "the errored projection owns no terminal");
  });
});

describe("worktree lanes: seeds, serialization, and identity", () => {
  it("seeds an exact-existing lane: revalidates the selector, runs members serially on it, and never sends creation flags", async () => {
    const runId = "run_lane_existing";
    await mutateState((state) => {
      state.tasks = laneTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.worktrees = [worktreeRow("id:repoA::/srv/ws-a", "ws-a")];
    });
    await startCoordinator(
      baseOpts(runId, {
        worktreeLanes: {
          lane_a: { placement: { kind: "existing", selector: "id:repoA::/srv/ws-a" } },
        },
        laneByTask: { lane_t1: "lane_a", lane_t2: "lane_a" },
        maxConcurrency: 3,
      }),
    );

    // First member: the selector is positively revalidated through Orca
    // (worktree show) BEFORE the start, and no creation flag rides along.
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "first lane member to start");
    const first = calls("worker-start")[0];
    assert.ok(first.argv.includes("--worktree") && first.argv.includes("id:repoA::/srv/ws-a"));
    assert.ok(
      !first.argv.includes("--repo") && !first.argv.includes("--name") && !first.argv.includes("--setup"),
      "an existing lane carries no creation flags",
    );
    const showCall = namespaceCalls("worktree", "show").find((c) => c.argv.includes("id:repoA::/srv/ws-a"));
    assert.ok(showCall, "the exact selector was revalidated through worktree show before start");
    const showIdx = readLog().findIndex(
      (c) => c.argv[0] === "worktree" && c.argv[1] === "show" && c.argv.includes("id:repoA::/srv/ws-a"),
    );
    const startIdx = firstIndexOf("worker-start", "--task", "lane_t1");
    assert.ok(showIdx >= 0 && startIdx > showIdx, `revalidation (${showIdx}) happens before the start (${startIdx})`);

    // Same-lane serialization: with 3 slots free, the second member still
    // cannot start while the first Dispatch is unsettled.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(calls("worker-start").length, 1, "one unsettled Dispatch per lane");

    // Settle the first member; the second reuses the SAME exact selector —
    // positive lane identity, never a name/branch/path reconstruction.
    await settleViaWorkerDone("lane_t1", "succeeded", "msg_l1");
    await waitFor(() => (calls("worker-start").length === 2 ? true : null), "second lane member to start");
    const second = calls("worker-start")[1];
    assert.ok(second.argv.includes("id:repoA::/srv/ws-a"), "the exact selector is reused");
    assert.ok(!second.argv.includes("--name"), "the follow-up start creates nothing");

    await settleViaWorkerDone("lane_t2", "succeeded", "msg_l2");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");
    const laneView = coordinatorStatus().worktreeLanes.find((l) => l.laneId === "lane_a");
    assert.ok(laneView, "the lane is projected");
    assert.equal(laneView!.state, "settled");
    assert.equal(laneView!.selector, "id:repoA::/srv/ws-a");

    // No Git mutation: every CLI call this coordinator made stays inside the
    // resolved Orca surface — the fixture IS the only executable, and it has
    // no git handler, so any git attempt would have failed loudly. The log
    // assertion makes the guarantee explicit.
    const namespaces = new Set(readLog().map((c) => c.argv[0]));
    assert.deepEqual(
      [...namespaces].filter((ns) => !["--version", "status"].includes(ns)).sort(),
      ["orchestration", "terminal", "worktree"],
      "only Orca CLI namespaces were ever invoked",
    );
  });

  it("refuses to start an existing-lane task whose selector Orca does not positively confirm", async () => {
    const runId = "run_lane_gone";
    await mutateState((state) => {
      state.tasks = laneTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      // No worktrees: the selector revalidation answers selector_not_found.
    });
    await startCoordinator(
      baseOpts(runId, {
        worktreeLanes: {
          lane_a: { placement: { kind: "existing", selector: "id:repoA::/srv/gone" } },
        },
        laneByTask: { lane_t1: "lane_a", lane_t2: "lane_a" },
      }),
    );
    // The start is REFUSED — the attempt parks with the refusal on record,
    // and Orca never saw a worker-start for it.
    await waitFor(() => (findAttempt("lane_t1")?.settled === true ? true : null), "the start to be refused");
    assert.equal(calls("worker-start").length, 0, "no worker-start without positive identity");
    const refused = attempt("lane_t1");
    assert.equal(refused.settledVia, "start_failed");
    assert.match(refused.terminalDetail ?? "", /no workspace for/, "the refusal names the missing workspace");
    // The ownership decision runs on the pass AFTER the failed start: the
    // receipt-less refusal positively created nothing, so nothing is owed.
    await waitFor(() => (attempt("lane_t1").terminalDecision === "not_needed" ? true : null), "ownership to be decided");
    assert.equal(attempt("lane_t1").terminalDecision, "not_needed", "nothing was created, so nothing is owed");
    assert.equal(findAttempt("lane_t2"), undefined, "the lane never advanced");
    // A parked refused start is human-owed work, not completion.
    await waitFor(() => (coordinatorStatus().phase === "awaiting_input" ? true : null), "awaiting_input after refusal");
    await stopCoordinator();
  });

  it("seeds a new-child lane: deterministic name on the creating start, exact selector on the follow-up", async () => {
    const runId = "run_lane_child";
    await mutateState((state) => {
      state.tasks = laneTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(
      baseOpts(runId, {
        worktreeLanes: {
          lane_c: { placement: { kind: "new-child", setup: "skip", baseBranch: "feature/x", comment: "lane under test" } },
        },
        laneByTask: { lane_t1: "lane_c", lane_t2: "lane_c" },
      }),
    );

    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "creating start");
    const creation = calls("worker-start")[0];
    assert.ok(creation.argv.includes("new-child"), "the creation mode rides to the adapter");
    const derivedName = deriveWorktreeName(runId, "lane_c");
    assert.ok(creation.argv.includes("--name") && creation.argv.includes(derivedName), "the lane-derived deterministic name");
    assert.ok(creation.argv.includes("--base-branch") && creation.argv.includes("feature/x"));
    assert.ok(creation.argv.includes("--setup") && creation.argv.includes("skip"));
    assert.ok(creation.argv.includes("--comment") && creation.argv.includes("lane under test"));
    assert.ok(!creation.argv.includes("--repo"), "a new-child anchors on the current repo — no --repo");

    // The creating start's receipt echoed the RESOLVED selector: the lane
    // adopted it as positive identity.
    const selector = `id:repoL::/ws/${derivedName}`;
    await waitFor(() => {
      const view = coordinatorStatus().worktreeLanes.find((l) => l.laneId === "lane_c");
      return view?.selector === selector ? true : null;
    }, "the lane to adopt the resolved selector from the receipt");
    const adopted = coordinatorStatus().worktreeLanes.find((l) => l.laneId === "lane_c")!;
    assert.equal(adopted.source, "worker_start_receipt");
    assert.equal(adopted.creationDispatchId, attempt("lane_t1").dispatchId);

    await settleViaWorkerDone("lane_t1", "succeeded", "msg_l1");
    await waitFor(() => (calls("worker-start").length === 2 ? true : null), "follow-up start");
    const followup = calls("worker-start")[1];
    assert.ok(followup.argv.includes(selector), "the follow-up runs on the exact created workspace");
    assert.ok(
      !followup.argv.includes("new-child") && !followup.argv.includes("--name") && !followup.argv.includes("--base-branch"),
      "the follow-up start creates nothing",
    );

    await settleViaWorkerDone("lane_t2", "succeeded", "msg_l2");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");
    assert.equal(coordinatorStatus().worktreeLanes.find((l) => l.laneId === "lane_c")!.state, "settled");
  });

  it("seeds a new-top-level lane with an explicit name and exact repo selector", async () => {
    const runId = "run_lane_top";
    await mutateState((state) => {
      state.tasks = laneTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(
      baseOpts(runId, {
        worktreeLanes: {
          lane_t: {
            placement: {
              kind: "new-top-level",
              repo: "id:repoB",
              name: "top-wt",
              displayName: "Top Level Lane",
              setup: "run",
            },
          },
        },
        laneByTask: { lane_t1: "lane_t", lane_t2: "lane_t" },
      }),
    );

    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "creating start");
    const creation = calls("worker-start")[0];
    assert.ok(creation.argv.includes("new-top-level"));
    assert.ok(creation.argv.includes("--repo") && creation.argv.includes("id:repoB"), "the exact repo selector");
    assert.ok(creation.argv.includes("--name") && creation.argv.includes("top-wt"), "the explicit name wins over derivation");
    assert.ok(creation.argv.includes("--display-name") && creation.argv.includes("Top Level Lane"));

    await settleViaWorkerDone("lane_t1", "succeeded", "msg_l1");
    await waitFor(() => (calls("worker-start").length === 2 ? true : null), "follow-up start");
    const followup = calls("worker-start")[1];
    assert.ok(followup.argv.includes("id:repoB::/ws/top-wt"), "follow-up reuses the created workspace identity");
    assert.ok(!followup.argv.includes("--repo"), "no creation flags on the follow-up");
    await stopCoordinator();
  });

  it("retries a failed lane task on the exact recovered selector — never a second creation", async () => {
    const runId = "run_lane_retry";
    await mutateState((state) => {
      state.tasks = laneTasks(runId);
      delete state.tasks.lane_t2;
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(
      baseOpts(runId, {
        worktreeLanes: { lane_c: { placement: { kind: "new-child", setup: "skip" } } },
        laneByTask: { lane_t1: "lane_c" },
      }),
    );

    // First (creating) start lands; the lane adopts the resolved selector.
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "creating start");
    const selector = `id:repoL::/ws/${deriveWorktreeName(runId, "lane_c")}`;
    await waitFor(() => {
      const view = coordinatorStatus().worktreeLanes.find((l) => l.laneId === "lane_c");
      return view?.selector === selector ? true : null;
    }, "identity adoption");

    // The lane's task FAILS positively; the user retries it explicitly.
    await settleViaWorkerDone("lane_t1", "failed", "msg_fail");
    await waitFor(() => (attempt("lane_t1").terminalDecision === "released" ? true : null), "failed attempt released");
    const firstDispatch = attempt("lane_t1").dispatchId!;
    await retryWorker("lane_t1");

    // The retry runs on the SAME exact workspace — positive identity, with
    // --retry-of lineage and NO creation flags (no replacement worktree).
    await waitFor(() => (calls("worker-start").length === 2 ? true : null), "retry start");
    const retry = calls("worker-start")[1];
    assert.ok(retry.argv.includes(selector), "the retry reuses the exact selector");
    assert.ok(
      !retry.argv.includes("new-child") && !retry.argv.includes("--name") && !retry.argv.includes("--base-branch"),
      "the retry creates nothing",
    );
    assert.ok(retry.argv.includes("--retry-of") && retry.argv.includes(firstDispatch), "lineage points at the failed Dispatch");

    await settleViaWorkerDone("lane_t1", "succeeded", "msg_retry_ok");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");
    const laneView = coordinatorStatus().worktreeLanes.find((l) => l.laneId === "lane_c")!;
    assert.equal(laneView.state, "settled");
    assert.equal(laneView.selector, selector);
    assert.equal(calls("worker-start").filter((c) => c.argv.includes("new-child")).length, 1, "exactly one creation start in the whole run");
  });

  it("recovers a lane's workspace identity across a viewer restart from the worker-list launch echo", async () => {
    const runId = "run_lane_restart";
    // The lane grows between restarts: the first incarnation knows one member
    // (still valid — a single-member lane is trivially ordered); after the
    // restart a second member joins the SAME lane.
    const opts = (members: string[]): StartOpts =>
      baseOpts(runId, {
        worktreeLanes: { lane_r: { placement: { kind: "new-child", setup: "skip" } } },
        laneByTask: Object.fromEntries(members.map((m) => [m, "lane_r"])),
      });
    await mutateState((state) => {
      state.tasks = laneTasks(runId);
      delete state.tasks.lane_t2;
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(opts(["lane_t1"]));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "creating start");
    await settleViaTaskStatus("lane_t1", "succeeded");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "first incarnation completes");
    const selector = `id:repoL::/ws/${deriveWorktreeName(runId, "lane_r")}`;
    assert.equal(attempt("lane_t1").effective?.worktree, selector);

    // Restart: a new task joins the SAME lane. Recovery must adopt the exact
    // selector from the durable launch echo — no new-child, no creation flags.
    const startsBeforeRestart = calls("worker-start").length;
    await mutateState((state) => {
      state.tasks.lane_t2 = {
        id: "lane_t2",
        run_id: runId,
        status: "ready",
        deps: '["lane_t1"]',
        task_title: "L2",
      };
    });
    await startCoordinator(opts(["lane_t1", "lane_t2"]));
    await waitFor(
      () => (calls("worker-start").length === startsBeforeRestart + 1 ? true : null),
      "restarted lane to place its next member",
    );
    const restarted = calls("worker-start")[startsBeforeRestart];
    assert.ok(restarted.argv.includes(selector), "the exact selector survived the restart");
    assert.ok(
      !restarted.argv.includes("new-child") && !restarted.argv.includes("--name"),
      "the restart start creates nothing",
    );
    const laneView = coordinatorStatus().worktreeLanes.find((l) => l.laneId === "lane_r")!;
    assert.equal(laneView.source, "worker_list", "identity recovered from the durable launch projection");
    await stopCoordinator();
  });

  it("adopts identity from worktree discovery when no launch echo exists, and refuses a replacement when identity stays unverifiable", async () => {
    const runId = "run_lane_unverifiable";
    const opts = (): StartOpts =>
      baseOpts(runId, {
        worktreeLanes: { lane_u: { placement: { kind: "new-child", setup: "run" } } },
        laneByTask: { lane_t1: "lane_u", lane_t2: "lane_u" },
      });
    await mutateState((state) => {
      state.tasks = laneTasks(runId);
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      // The creating start lands and Orca holds the workspace — but its
      // listings carry no echo and no row this viewer can see.
      state.laneDiscoveryOnly = true;
      state.hideWorktrees = true;
    });
    await startCoordinator(opts());
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "creating start");
    // identityMissing is sticky-flagged only after the post-start echo +
    // discovery attempts BOTH fail to name a workspace — wait for the
    // warning, which implies the full unverifiable verdict.
    await waitFor(() => {
      const view = coordinatorStatus().worktreeLanes.find((l) => l.laneId === "lane_u");
      return view && view.warnings.length > 0 && view.state === "unverifiable" ? true : null;
    }, "the lane to report unverifiable identity");
    const view = coordinatorStatus().worktreeLanes.find((l) => l.laneId === "lane_u")!;
    assert.equal(view.selector, null, "no selector is guessed");
    assert.ok(view.warnings.length > 0, "the unverifiable verdict carries its warning");

    // The lane's second member must REFUSE — not re-create, not fall back.
    await settleViaWorkerDone("lane_t1", "succeeded", "msg_l1");
    await waitFor(() => (findAttempt("lane_t2")?.settled === true ? true : null), "the follow-up to be refused");
    assert.equal(calls("worker-start").length, 1, "no second worker-start without identity");
    assert.equal(attempt("lane_t2").settledVia, "start_failed");
    assert.match(attempt("lane_t2").terminalDetail ?? "", /never creates a replacement/);
    await stopCoordinator();

    // Restart with listings RESTORED: recovery adopts the workspace the first
    // creation left behind (positive discovery), and the follow-up starts on
    // the exact selector.
    await mutateState((state) => {
      delete state.hideWorktrees;
    });
    const startsBeforeRestart = calls("worker-start").length;
    await startCoordinator(opts());
    await waitFor(
      () => (calls("worker-start").length === startsBeforeRestart + 1 ? true : null),
      "the follow-up to start after recovery",
    );
    const recovered = calls("worker-start")[startsBeforeRestart];
    assert.ok(
      recovered.argv.includes(`id:repoL::/ws/${deriveWorktreeName(runId, "lane_u")}`),
      "the discovered exact selector is used",
    );
    assert.ok(!recovered.argv.includes("new-child"), "recovery reused the existing workspace — no replacement");
    await stopCoordinator();
  });

  it("runs distinct lanes in parallel while serializing within each lane", async () => {
    const runId = "run_lane_parallel";
    await mutateState((state) => {
      state.tasks = {
        a1: { id: "a1", run_id: runId, status: "pending", deps: "[]", task_title: "A1" },
        a2: { id: "a2", run_id: runId, status: "pending", deps: '["a1"]', task_title: "A2" },
        b1: { id: "b1", run_id: runId, status: "pending", deps: "[]", task_title: "B1" },
        b2: { id: "b2", run_id: runId, status: "pending", deps: '["b1"]', task_title: "B2" },
        c1: { id: "c1", run_id: runId, status: "pending", deps: "[]", task_title: "C1" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.worktrees = [
        worktreeRow("id:repoA::/srv/ws-a", "ws-a"),
        worktreeRow("id:repoB::/srv/ws-b", "ws-b", "repoB"),
      ];
    });
    await startCoordinator(
      baseOpts(runId, {
        worktreeLanes: {
          lane_a: { placement: { kind: "existing", selector: "id:repoA::/srv/ws-a" } },
          lane_b: { placement: { kind: "existing", selector: "id:repoB::/srv/ws-b" } },
        },
        laneByTask: { a1: "lane_a", a2: "lane_a", b1: "lane_b", b2: "lane_b" },
        maxConcurrency: 3,
      }),
    );

    // Wave 1: lane_a's head, lane_b's head, and the implicit current lane's
    // task all start CONCURRENTLY — distinct lanes take distinct slots.
    await waitFor(() => (calls("worker-start").length === 3 ? true : null), "all three lane heads to start");
    const worktreeOf = (taskId: string): string => {
      const call = calls("worker-start").find((c) => c.argv.includes(taskId))!;
      return call.argv[call.argv.indexOf("--worktree") + 1];
    };
    assert.equal(worktreeOf("a1"), "id:repoA::/srv/ws-a");
    assert.equal(worktreeOf("b1"), "id:repoB::/srv/ws-b");
    assert.equal(worktreeOf("c1"), "current", "the implicit current lane stays on the coordinator workspace");

    // In-lane serialization holds even with the cap not yet reached.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls("worker-start").length, 3, "no second Dispatch in either lane");

    // a1 settles → a2 starts on lane_a's exact selector; b1 still holds lane_b.
    await settleViaTaskStatus("a1", "succeeded");
    await waitFor(() => (calls("worker-start").length === 4 ? true : null), "a2 to start");
    assert.equal(worktreeOf("a2"), "id:repoA::/srv/ws-a");
    assert.equal(
      calls("worker-start").filter((c) => c.argv.includes("b2")).length,
      0,
      "lane_b stays serialized while b1 runs",
    );

    await settleViaTaskStatus("b1", "succeeded");
    await waitFor(() => (calls("worker-start").length === 5 ? true : null), "b2 to start");
    assert.equal(worktreeOf("b2"), "id:repoB::/srv/ws-b");

    await settleViaTaskStatus("a2", "succeeded");
    await settleViaTaskStatus("b2", "succeeded");
    await settleViaTaskStatus("c1", "succeeded");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");
    const views = Object.fromEntries(coordinatorStatus().worktreeLanes.map((l) => [l.laneId, l]));
    assert.equal(views.lane_a.state, "settled");
    assert.equal(views.lane_b.state, "settled");
    await stopCoordinator();
  });
});

describe("worktree lanes: cross-lane integration gates", () => {
  it("holds a CURRENT task joining a lane's output behind one idempotent gate, released only by `integrated`", async () => {
    const runId = "run_gate_current";
    await mutateState((state) => {
      state.tasks = {
        ...laneTasks(runId),
        join_t: { id: "join_t", run_id: runId, status: "pending", deps: '["lane_t1"]', task_title: "Join" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.worktrees = [worktreeRow("id:repoA::/srv/ws-a", "ws-a")];
    });
    await startCoordinator(
      baseOpts(runId, {
        worktreeLanes: {
          lane_a: { placement: { kind: "existing", selector: "id:repoA::/srv/ws-a" } },
        },
        laneByTask: { lane_t1: "lane_a", lane_t2: "lane_a" },
        maxConcurrency: 3,
      }),
    );
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "lane member to start");

    // The lane member settles; the current-lane join becomes ready — and the
    // coordinator must answer that with a gate, not a Dispatch.
    await settleViaWorkerDone("lane_t1", "succeeded", "msg_l1");
    await waitFor(() => (calls("gate-create").length === 1 ? true : null), "the integration gate to be created");
    const gateCall = calls("gate-create")[0];
    assert.ok(gateCall.argv.includes("--task") && gateCall.argv.includes("join_t"));
    assert.ok(
      gateCall.argv.includes(JSON.stringify(["integrated"])),
      "the gate offers ONLY the integrated resolution",
    );
    const question = gateCall.argv[gateCall.argv.indexOf("--question") + 1];
    assert.ok(question.includes("[orca-dag:integration]"), "the question carries the stable viewer marker");
    assert.equal(
      calls("worker-start").filter((c) => c.argv.includes("join_t")).length,
      0,
      "the join never starts before integration",
    );

    // Idempotency: passes while the gate is pending never mint a duplicate.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls("gate-create").length, 1, "duplicate-gate prevention");
    assert.equal((getState().gates as any[]).length, 1, "exactly one Orca gate exists");

    // The lane's own second member still runs alongside the gated join.
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("lane_t2"))) ? true : null, "lane work to continue");
    await settleViaWorkerDone("lane_t2", "succeeded", "msg_l2");
    await waitFor(() => (findAttempt("lane_t2")?.terminalDecision === "released") ? true : null, "lane work settled");
    // With only the gated join left, the run waits on the human decision —
    // it must not complete around a cross-lane integration checkpoint.
    await waitFor(() => (coordinatorStatus().phase === "awaiting_input" ? true : null), "the run waits on the human gate");

    // A resolution that is not `integrated` does not unblock a marker gate.
    await mutateState((state) => {
      state.gates[0].status = "resolved";
      state.gates[0].resolution = "approved";
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      calls("worker-start").filter((c) => c.argv.includes("join_t")).length,
      0,
      "only the integrated resolution releases a cross-lane join",
    );
    assert.equal(coordinatorStatus().phase, "awaiting_input", "still waiting after a non-integrated resolution");

    // The human integrates; the join is released and dispatched on current.
    await mutateState((state) => {
      state.gates[0].resolution = "integrated";
    });
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("join_t")) ? true : null), "the join to start");
    const joinStart = calls("worker-start").find((c) => c.argv.includes("join_t"))!;
    assert.equal(joinStart.argv[joinStart.argv.indexOf("--worktree") + 1], "current");
    assert.equal(calls("gate-create").length, 1, "still exactly one gate for the whole run");

    await settleViaWorkerDone("join_t", "succeeded", "msg_join");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");
  });

  it("holds a LANE task joining another lane's output behind the gate (non-current-to-non-current)", async () => {
    const runId = "run_gate_lanes";
    await mutateState((state) => {
      state.tasks = {
        a1: { id: "a1", run_id: runId, status: "pending", deps: "[]", task_title: "A1" },
        b1: { id: "b1", run_id: runId, status: "pending", deps: '["a1"]', task_title: "B1" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.worktrees = [
        worktreeRow("id:repoA::/srv/ws-a", "ws-a"),
        worktreeRow("id:repoB::/srv/ws-b", "ws-b", "repoB"),
      ];
    });
    await startCoordinator(
      baseOpts(runId, {
        worktreeLanes: {
          lane_a: { placement: { kind: "existing", selector: "id:repoA::/srv/ws-a" } },
          lane_b: { placement: { kind: "existing", selector: "id:repoB::/srv/ws-b" } },
        },
        laneByTask: { a1: "lane_a", b1: "lane_b" },
        maxConcurrency: 3,
      }),
    );
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "lane_a head to start");
    await settleViaWorkerDone("a1", "succeeded", "msg_a1");

    // b1 (lane_b) depends on a1 (lane_a): a cross-lane join between two
    // non-current lanes — gated, never started on lane_b's workspace.
    await waitFor(() => (calls("gate-create").length === 1 ? true : null), "the integration gate to be created");
    assert.ok(calls("gate-create")[0].argv.includes("b1"));
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      calls("worker-start").filter((c) => c.argv.includes("b1")).length,
      0,
      "the lane join never starts ungated",
    );
    let laneB = coordinatorStatus().worktreeLanes.find((l) => l.laneId === "lane_b")!;
    assert.equal(laneB.state, "integration_required", "the lane explains why its task is blocked");

    await mutateState((state) => {
      state.gates[0].status = "resolved";
      state.gates[0].resolution = "integrated";
    });
    await waitFor(() => (calls("worker-start").some((c) => c.argv.includes("b1"))) ? true : null, "the join to start after integration");
    const b1Start = calls("worker-start").find((c) => c.argv.includes("b1"))!;
    assert.equal(b1Start.argv[b1Start.argv.indexOf("--worktree") + 1], "id:repoB::/srv/ws-b", "the join runs in its OWN lane");
    await settleViaWorkerDone("b1", "succeeded", "msg_b1");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");
    assert.equal(calls("gate-create").length, 1);
  });

  it("keeps same-lane and all-current joins ungated (no gate is ever created)", async () => {
    const runId = "run_no_gate";
    await mutateState((state) => {
      // a1 → a2 same lane; c1 → c2 both current; plus the two-wave DAG —
      // none of these cross lanes.
      state.tasks = {
        a1: { id: "a1", run_id: runId, status: "pending", deps: "[]", task_title: "A1" },
        a2: { id: "a2", run_id: runId, status: "pending", deps: '["a1"]', task_title: "A2" },
        c1: { id: "c1", run_id: runId, status: "pending", deps: "[]", task_title: "C1" },
        c2: { id: "c2", run_id: runId, status: "pending", deps: '["c1"]', task_title: "C2" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.worktrees = [worktreeRow("id:repoA::/srv/ws-a", "ws-a")];
    });
    await startCoordinator(
      baseOpts(runId, {
        worktreeLanes: {
          lane_a: { placement: { kind: "existing", selector: "id:repoA::/srv/ws-a" } },
        },
        laneByTask: { a1: "lane_a", a2: "lane_a" },
        maxConcurrency: 3,
      }),
    );
    // Wave 1: the lane head and the current head start together.
    await waitFor(() => (calls("worker-start").length === 2 ? true : null), "both heads to start");
    for (const id of ["a1", "c1"]) {
      await settleViaTaskStatus(id, "succeeded");
    }
    await waitFor(() => (calls("worker-start").length === 4 ? true : null), "all four tasks to start");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls("gate-create").length, 0, "same-lane and current-only joins are never gated");
    for (const id of ["a2", "c2"]) {
      await settleViaTaskStatus(id, "succeeded");
    }
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "run to complete");
    assert.deepEqual((getState().gates ?? []), [], "no gate exists in Orca");
  });
});

describe("committed Stage integration before development", () => {
  it("parks development until three parallel Stage commits are merged into the clean target", async () => {
    const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    git(workspace, "init", "-b", "main");
    git(workspace, "config", "user.name", "Test");
    git(workspace, "config", "user.email", "test@example.com");
    writeFileSync(join(workspace, ".gitignore"), "*\n");
    for (const id of ["a", "b", "c"]) writeFileSync(join(workspace, `${id}.txt`), "base\n");
    git(workspace, "add", "-f", ".gitignore", "a.txt", "b.txt", "c.txt");
    git(workspace, "commit", "-m", "base");
    const base = git(workspace, "rev-parse", "HEAD");
    const paths = Object.fromEntries(["a", "b", "c"].map((id) => [id, `${workspace}-${id}`]));
    for (const id of ["a", "b", "c"]) git(workspace, "worktree", "add", "-b", `stage-${id}`, paths[id], base);
    const runId = "run_t";
    const selectors = Object.fromEntries(["a", "b", "c"].map((id) => [id, `id:repoA::${paths[id]}`]));
    await mutateState((state) => {
      state.tasks = {
        a: { id: "a", run_id: runId, status: "pending", deps: "[]", spec: "stage a" },
        b: { id: "b", run_id: runId, status: "pending", deps: "[]", spec: "stage b" },
        c: { id: "c", run_id: runId, status: "pending", deps: "[]", spec: "stage c" },
        merge: { id: "merge", run_id: runId, status: "pending", deps: '["a","b","c"]', spec: "[orca-dag:merge-prep] [orca-dag:merge-inputs-v3] Merge only" },
        dev: { id: "dev", run_id: runId, status: "pending", deps: '["merge"]', spec: "Develop after merge" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
      state.worktrees = ["a", "b", "c"].map((id) => ({
        id: selectors[id], repoId: "repoA", path: paths[id], displayName: `stage-${id}`,
        branch: `stage-${id}`, hostId: null, parentWorktreeId: null, isMainWorktree: false,
      }));
    });
    await startCoordinator(baseOpts(runId, {
      maxConcurrency: 3,
      worktreeLanes: Object.fromEntries(["a", "b", "c"].map((id) =>
        [`lane_${id}`, { placement: { kind: "existing", selector: selectors[id] } }])),
      laneByTask: { a: "lane_a", b: "lane_b", c: "lane_c" },
    }));
    await waitFor(() => (calls("worker-start").length === 3 ? true : null), "three parallel source Stages");
    assert.equal(coordinatorStatus().stageGit?.base, base);
    for (const id of ["a", "b", "c"]) {
      writeFileSync(join(paths[id], `${id}.txt`), `${id} result\n`);
      git(paths[id], "add", `${id}.txt`);
      git(paths[id], "commit", "-m", `stage ${id}`);
      await settleViaWorkerDone(id, "succeeded", `msg_${id}`);
    }
    await waitFor(() => (callsOf("worker-start", "--task", "merge").length === 1 ? true : null), "merge preparation to start");
    assert.equal(callsOf("worker-start", "--task", "dev").length, 0);
    const mergeDispatch = await dispatchIdOf("merge");
    const question = { ...workerDoneMessage("merge", mergeDispatch, "succeeded", "msg_merge_inputs"),
      type: "question", from_handle: `dispatch:${mergeDispatch}`, subject: "orca-dag:merge-inputs",
      body: "Please provide immutable inputs",
      payload: JSON.stringify({ taskId: "merge", dispatchId: mergeDispatch, question: "orca-dag:merge-inputs" }) };
    await injectMail([{ ...question, id: "msg_spoofed_inputs", from_handle: "dispatch:ctx_foreign" }, question]);
    await waitFor(() => (getState().replies ?? []).some((row: { id: string }) => row.id === question.id), "immutable inputs replied");
    const reply = getState().replies.find((row: { id: string }) => row.id === question.id);
    for (const id of ["a", "b", "c"]) assert.ok(reply.body.includes(git(paths[id], "rev-parse", "HEAD")));
    assert.ok(!(getState().replies ?? []).some((row: { id: string }) => row.id === "msg_spoofed_inputs"));
    assert.equal(calls("send").length, 0);
    await answerInboxItem("msg_spoofed_inputs", "Not authorized");
    await settleViaWorkerDone("merge", "succeeded", "msg_merge");
    await waitFor(() => (coordinatorStatus().stageGit?.errors.merge ? true : null), "missing merge to be rejected");
    assert.equal(callsOf("worker-start", "--task", "dev").length, 0, "worker_done alone cannot start development");
    for (const id of ["a", "b", "c"]) git(workspace, "merge", "--no-ff", "--no-edit", git(paths[id], "rev-parse", "HEAD"));
    await waitFor(() => (callsOf("worker-start", "--task", "dev").length === 1 ? true : null), "development after verified merge");
    assert.equal(coordinatorStatus().stageGit?.errors.merge, undefined);
    await dispatchIdOf("dev");
    writeFileSync(join(workspace, "a.txt"), "development result\n");
    await settleViaWorkerDone("dev", "succeeded", "msg_dev");
    await waitFor(() => (coordinatorStatus().stageGit?.errors.dev ? true : null), "uncommitted final Stage to be rejected");
    assert.equal(coordinatorStatus().phase, "awaiting_input", "a dirty final Stage cannot complete the Run");
    git(workspace, "add", "a.txt");
    git(workspace, "commit", "-m", "development");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "clean committed Run to finish");
    await stopCoordinator();
    for (const id of ["a", "b", "c"]) git(workspace, "worktree", "remove", "--force", paths[id]);
  });

  it("passes the captured base SHA when Orca creates a new Stage worktree", async () => {
    const git = (...args: string[]) => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
    const runId = "run_stage_base";
    await mutateState((state) => {
      state.tasks = {
        source: { id: "source", run_id: runId, status: "pending", deps: "[]", spec: "source" },
        merge: { id: "merge", run_id: runId, status: "pending", deps: '["source"]', spec: "[orca-dag:merge-prep] [orca-dag:merge-inputs-v3] merge" },
        dev: { id: "dev", run_id: runId, status: "pending", deps: '["merge"]', spec: "develop" },
      };
      state.runs = { [runId]: { id: runId, objective: "test", legacy: 0 } };
    });
    await startCoordinator(baseOpts(runId, {
      worktreeLanes: { source_lane: { placement: { kind: "new-child", setup: "skip" } } },
      laneByTask: { source: "source_lane" },
    }));
    await waitFor(() => (callsOf("worker-start", "--task", "source").length === 1 ? true : null), "new source worktree start");
    const argv = callsOf("worker-start", "--task", "source")[0].argv;
    assert.equal(argv[argv.indexOf("--base-branch") + 1], git("rev-parse", "HEAD"));
    await stopCoordinator();
  });
});

