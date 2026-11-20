import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  executeNativeResume,
  previewNativeResume,
  type NativeResumeDeps,
} from "./nativeResume";
import {
  OrcaCliError,
  RESPONSE_LOST,
  type Gate,
  type OrcaTask,
  type OrcaWorkerRow,
  type StartedWorker,
  type WorkerDetailView,
} from "./orca";
import { PluginBridge } from "./pluginBridge";
import { ProviderSessionStore } from "./providerSessions";

function makeFixture(
  dir: string,
  overrides: {
    harness?: string;
    sessionWorkspaceId?: string;
    terminalWorkspacePath?: string;
    gates?: Gate[];
    hostKind?: string;
    sessionRunning?: boolean;
    resumeReceipt?: Record<string, unknown>;
    globalWorkers?: OrcaWorkerRow[];
    startWorkerImpl?: (opts: Parameters<NonNullable<NativeResumeDeps["startSupervisedWorker"]>>[0]) => Promise<StartedWorker | null>;
    showRequestImpl?: NativeResumeDeps["showRequest"];
  } = {},
) {
  // Orca returns this path-bearing Host API ID for local folder projects.
  const workspaceListId = `repo-1::${dir}`;
  const bridge = new PluginBridge();
  bridge.hello({
    pluginId: "orchestration-panel",
    version: "0.1.0",
    hostApiMinor: 10,
    grantedCapabilities: ["workspace:read", "agent:read", "agent:launch", "history:read"],
  });
  bridge.ingestEvents({
    statusEvents: [
      {
        terminalId: "term_old",
        workspaceId: `repo-1::${dir}`,
        workspaceListId,
        agent: overrides.harness ?? "codex",
        state: "done",
        sessionId: "sess_exact_1",
      },
    ],
  });

  let resumeCalls = 0;
  // Auto-answer plugin commands queued by nativeResume.
  const autoAnswer = async () => {
    while (bridge.status().connected) {
      const inbox = await bridge.pullInbox(50);
      for (const cmd of inbox.commands) {
        if (cmd.kind === "workspace.list") {
          bridge.submitReceipt(cmd.id, {
            ok: true,
            workspaces: [{ id: workspaceListId, path: dir, hostId: "local" }],
          });
        } else if (cmd.kind === "agent.listSessions") {
          bridge.submitReceipt(cmd.id, {
            ok: true,
            sessions: [
              {
                sessionId: "sess_exact_1",
                workspaceId: overrides.sessionWorkspaceId ?? workspaceListId,
                hostId: "local",
                agent: overrides.harness ?? "codex",
                title: "Fix build",
                updatedAt: Date.now(),
                running: overrides.sessionRunning ?? false,
              },
            ],
          });
        } else if (cmd.kind === "agent.resume") {
          resumeCalls++;
          bridge.submitReceipt(
            cmd.id,
            overrides.resumeReceipt ?? { ok: true, terminalId: "term_resumed_1", started: true },
          );
        }
      }
      if (!inbox.commands.length) await new Promise((r) => setTimeout(r, 10));
    }
  };
  const responder = autoAnswer();

  const row: OrcaWorkerRow = {
    dispatchId: "ctx_failed_1",
    taskId: "task_1",
    runId: "run_1",
    workerState: "failed",
    supervision: "supervised",
    dispatchStatus: "failed",
    agentTerminalHandle: "term_old",
    terminalState: "released",
    projection: {
      outcome: "failed",
      liveness: { verdict: "exited", reason: "exited" },
      resource: { state: "released", reason: null },
      stage: { worker: "failed", dispatch: "failed", detail: null, activity: "exited" },
      nextAction: null,
      attention: null,
      host: { kind: overrides.hostKind ?? "local", id: overrides.hostKind === "remote" ? "env_remote" : "local" },
      workspace: `repo-1::${dir}`,
      launch: { agent: overrides.harness ?? "codex", model: null, effort: null, worktree: null },
    },
  };

  const detail: WorkerDetailView = {
    dispatchId: "ctx_failed_1",
    runId: "run_1",
    taskId: "task_1",
    launch: {
      agent: overrides.harness ?? "codex",
      model: null,
      effort: null,
      resolvedWorktreeId: `repo-1::${dir}`,
    },
    requestedLaunch: { agent: overrides.harness ?? "codex", model: null, effort: null },
    terminalResource: null,
    fleet: row,
    dispatch: {
      id: "ctx_failed_1",
      runId: "run_1",
      taskId: "task_1",
      status: "failed",
      failureCount: 1,
      lastFailure: "lost",
      terminationReason: "lost",
      dispatchedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      lastHeartbeatAt: null,
      retryOfDispatchId: null,
      depth: 0,
    },
    worker: { state: "failed", stage: "failed", setupState: null, lastError: "lost", createdAt: null, updatedAt: null },
    terminal: {
      handle: "term_old",
      worktreePath: overrides.terminalWorkspacePath ?? dir,
      branch: "main",
      title: null,
      connected: false,
      orphaned: false,
      executionHostId: "local",
      agentIdentity: overrides.harness ?? "codex",
      lastOutputAt: null,
      preview: null,
    },
    observation: null,
    liveness: { verdict: "exited", fleetReason: "exited", qualifiedWorking: false, qualifiedReason: null, observationStatus: null },
    providerSession: null,
  };

  const task: OrcaTask = {
    id: "task_1",
    parent_id: null,
    created_by_terminal_handle: null,
    run_id: "run_1",
    spec: "Do work",
    status: "blocked",
    deps: "[]",
    result: null,
    created_at: new Date().toISOString(),
    completed_at: null,
    task_title: "Task 1",
    display_name: null,
  };

  const store = new ProviderSessionStore(dir);
  let startCalls = 0;

  const deps: NativeResumeDeps = {
    pluginBridge: bridge,
    providerSessions: store,
    showWorkerDetail: async () => detail,
    listWorkers: async (runId) => ({
      workers: runId ? [row] : (overrides.globalWorkers ?? [row]),
      partialHostErrors: [],
    }),
    listTasks: async () => [task],
    listGates: async () => overrides.gates ?? [],
    listTerminals: async () => [
      {
        handle: "term_resumed_1",
        title: "codex",
        worktreeId: `repo-1::${dir}`,
        worktreePath: dir,
        branch: "main",
        connected: true,
        writable: true,
      },
    ],
    showRequest: overrides.showRequestImpl ?? (async () => null),
    waitForTuiIdle: async () => {},
    startSupervisedWorker: async (opts) => {
      startCalls += 1;
      const override = await overrides.startWorkerImpl?.(opts);
      if (override) return override;
      assert.equal(opts.terminal, "term_resumed_1");
      assert.equal(opts.retryOf, "ctx_failed_1");
      assert.equal(opts.model, undefined);
      assert.equal(opts.effort, undefined);
      assert.equal(opts.on, undefined);
      return {
        dispatchId: "ctx_resumed_2",
        handle: "term_resumed_1",
        mode: "supervised",
        requestId: opts.retryRequestId ?? "req_1",
        replayed: false,
        adopted: false,
        receipt: {
          ok: true,
          requestId: opts.retryRequestId ?? "req_1",
          dispatchId: "ctx_resumed_2",
          taskId: "task_1",
          status: "ready",
          workerOutcome: null,
          stage: "ready",
          failedStage: null,
          error: null,
          code: null,
          terminalHandle: "term_resumed_1",
          setup: null,
          effects: [],
          residualResources: [],
          recoveryCommands: [],
          effective: {
            agent: opts.agent,
            model: null,
            effort: null,
            worktree: null,
            terminal: "term_resumed_1",
            on: null,
            name: null,
            baseBranch: null,
            displayName: null,
          },
          raw: {},
        },
        launch: null,
      };
    },
  };

  return {
    deps,
    store,
    bridge,
    getStartCalls: () => startCalls,
    getResumeCalls: () => resumeCalls,
    cleanup: async () => {
      bridge.close();
      await responder.catch(() => {});
    },
  };
}

describe("L1 native session resume (M3)", () => {
  it("journals prepared -> resumed_terminal -> bound and binds new Dispatch on --terminal --retry-of", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odag-resume-ok-"));
    const fx = makeFixture(dir);
    try {
      await fx.store.bind({
        runId: "run_1", taskId: "task_1", dispatchId: "ctx_failed_1",
        harness: "codex", sessionId: "sess_exact_1", workspace: dir, host: "local:local",
        source: "provider-evidence",
      });
      const preview = await previewNativeResume({ runId: "run_1", dispatchId: "ctx_failed_1" }, fx.deps);
      assert.equal(preview.eligible, true);
      assert.equal(preview.sessionId, "sess_exact_1");
      assert.deepEqual(preview.candidateSessions, []);
      assert.equal(preview.workspaceId, `repo-1::${dir}`);

      const result = await executeNativeResume(
        {
          runId: "run_1",
          dispatchId: "ctx_failed_1",
          runAsCoordinator: async (fn) => fn("term_coord_1"),
        },
        fx.deps,
      );
      assert.equal(result.dispatchId, "ctx_resumed_2");
      assert.equal(result.retriedFrom, "ctx_failed_1");
      assert.equal(result.resumedTerminalId, "term_resumed_1");
      assert.equal(result.sessionId, "sess_exact_1");
      assert.equal(fx.getStartCalls(), 1);

      const history = await fx.store.listResumeAttempts("run_1");
      assert.equal(history.length, 1);
      assert.equal(history[0].state, "bound");
      assert.equal(history[0].newDispatchId, "ctx_resumed_2");

      const binding = await fx.store.get({ runId: "run_1", taskId: "task_1", dispatchId: "ctx_resumed_2" });
      assert.equal(binding?.sessionId, "sess_exact_1");
    } finally {
      await fx.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses unverified harnesses and paired remote runtimes without any side effects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odag-resume-gates-"));
    const fxUnverified = makeFixture(dir, { harness: "gemini" });
    const fxRemote = makeFixture(dir, { harness: "codex", hostKind: "remote" });
    try {
      const p1 = await previewNativeResume({ runId: "run_1", dispatchId: "ctx_failed_1" }, fxUnverified.deps);
      assert.equal(p1.eligible, false);
      assert.equal(p1.code, "unverified_harness");

      const p2 = await previewNativeResume({ runId: "run_1", dispatchId: "ctx_failed_1" }, fxRemote.deps);
      assert.equal(p2.eligible, false);
      assert.equal(p2.code, "resume_not_allowed");
      assert.match(p2.reason ?? "", /--on/);
    } finally {
      await fxUnverified.cleanup();
      await fxRemote.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses active sessions and existing personal panes even without a Dispatch owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odag-resume-active-"));
    const fxActive = makeFixture(dir, { sessionRunning: true });
    const fxOwned = makeFixture(dir, {
      resumeReceipt: { ok: true, terminalId: "term_personal", started: false },
    });
    try {
      const p1 = await previewNativeResume({ runId: "run_1", dispatchId: "ctx_failed_1", sessionId: "sess_exact_1" }, fxActive.deps);
      assert.equal(p1.eligible, false);
      assert.equal(p1.code, "resume_session_active");

      await assert.rejects(
        () =>
          executeNativeResume(
            {
              runId: "run_1",
              dispatchId: "ctx_failed_1",
              sessionId: "sess_exact_1",
              runAsCoordinator: async (fn) => fn("term_coord_1"),
            },
            fxOwned.deps,
          ),
        (err: unknown) => err instanceof OrcaCliError && err.code === "resume_session_active",
      );
      assert.equal(fxOwned.getStartCalls(), 0);
    } finally {
      await fxActive.cleanup();
      await fxOwned.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds unknown outcomes on RESPONSE_LOST without second launch and reconciles via request-show", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odag-resume-unknown-"));
    let requestState: "absent" | "failed" = "absent";
    const fx = makeFixture(dir, {
      startWorkerImpl: async () => {
        if (requestState === "failed") return null;
        throw new OrcaCliError("lost reply", RESPONSE_LOST);
      },
      showRequestImpl: async (requestId) =>
        requestState === "failed"
          ? { requestId, state: "failed", interpretation: "timed out", outcome: null, raw: { requestId, method: "orchestration.workerStart" } }
          : null,
    });
    try {
      await assert.rejects(
        () =>
          executeNativeResume(
            {
              runId: "run_1",
              dispatchId: "ctx_failed_1",
              sessionId: "sess_exact_1",
              runAsCoordinator: async (fn) => fn("term_coord_1"),
            },
            fx.deps,
          ),
        (err: unknown) => err instanceof OrcaCliError && err.code === RESPONSE_LOST,
      );

      // While request-show returns absent, a second resume is blocked as resume_unknown.
      const blocked = await previewNativeResume({ runId: "run_1", dispatchId: "ctx_failed_1" }, fx.deps);
      assert.equal(blocked.eligible, false);
      assert.equal(blocked.code, "resume_unknown");
      assert.ok(blocked.unresolvedRequestId);

      // Once request-show positively reports failed, the checkpoint reconciles cleanly.
      requestState = "failed";
      const cleared = await previewNativeResume({ runId: "run_1", dispatchId: "ctx_failed_1", sessionId: "sess_exact_1" }, fx.deps);
      assert.equal(cleared.eligible, true);
      const resumed = await executeNativeResume({
        runId: "run_1", dispatchId: "ctx_failed_1", sessionId: "sess_exact_1",
        runAsCoordinator: async (fn) => fn("term_coord_1"),
      }, fx.deps);
      assert.equal(resumed.dispatchId, "ctx_resumed_2");
      assert.deepEqual((await fx.store.listResumeAttempts("run_1")).map((row) => row.state), ["refused", "bound"]);
    } finally {
      await fx.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires matching history and coordinator consent before opening a session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odag-resume-authority-"));
    const fx = makeFixture(dir);
    const other = makeFixture(dir, { sessionWorkspaceId: "identity:wt2:local:other" });
    const conflict = makeFixture(dir, { terminalWorkspacePath: join(dir, "different-worktree") });
    const opts = { runId: "run_1", dispatchId: "ctx_failed_1", sessionId: "sess_exact_1" };
    try {
      const unauthorized = new OrcaCliError("Control confirmation required", "coordinator_control_required");
      await assert.rejects(
        () => executeNativeResume({ ...opts, runAsCoordinator: async () => { throw unauthorized; } }, fx.deps),
        { code: "coordinator_control_required" },
      );
      assert.deepEqual(await fx.store.listResumeAttempts(opts.runId), []);
      assert.equal(fx.getResumeCalls(), 0);
      const mismatch = await previewNativeResume(opts, other.deps);
      assert.equal(mismatch.eligible, false);
      assert.deepEqual(mismatch.candidateSessions, []);
      assert.equal(other.getResumeCalls(), 0);
      const workspaceConflict = await previewNativeResume(opts, conflict.deps);
      assert.equal(workspaceConflict.code, "resume_workspace_missing");
      assert.equal(conflict.getResumeCalls(), 0);
    } finally {
      await fx.cleanup();
      await other.cleanup();
      await conflict.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not launch after an explicit gate rejection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odag-resume-gate-"));
    const fx = makeFixture(dir, {
      gates: [{ id: "gate_rejected", taskId: "task_1", question: "Proceed?", options: ["approve", "reject"], status: "resolved", resolution: "reject", raw: {} }],
    });
    try {
      const preview = await previewNativeResume({ runId: "run_1", dispatchId: "ctx_failed_1", sessionId: "sess_exact_1" }, fx.deps);
      assert.equal(preview.eligible, false);
      assert.match(preview.reason ?? "", /approval gate/);
      assert.equal(fx.getResumeCalls(), 0);
    } finally {
      await fx.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
