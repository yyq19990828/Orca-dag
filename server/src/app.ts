import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import {
  OrcaCliError,
  bindRun,
  checkReadiness,
  closeTerminal,
  createRun,
  createTempCoordinatorTerminal,
  explainReadiness,
  listEnvironments,
  listGates,
  listModels,
  listProjects,
  listRepos,
  listRunMessages,
  listRunMessagePage,
  listWorkspaceRuns,
  listTasks,
  listTerminals,
  listWorkers,
  listWorktrees,
  normalizeLiveness,
  describeRuntimeCapabilities,
  FLEET_CAPABILITY_GAP_REASONS,
  parseWorkerDonePayload,
  parsePeerCapabilities,
  previewRunAudiences,
  readWorkerOutput,
  releaseWorker,
  replyToMessage,
  resolveGate,
  retainWorker,
  runOrca,
  sendCoordinatorGroupMessage,
  sendCoordinatorMessage,
  showRun,
  showRequest,
  showWorkerDetail,
  tasksToDag,
  newRequestId,
  type OrcaReadiness,
  type WorkerObservation,
} from "./orca";
import { buildRunHealth, type RunHealthView } from "./runHealth";
import { loadConfig, saveConfig } from "./config";
import {
  answerInboxItem,
  coordinatorStatus,
  noteManualRelease,
  retryWorker,
  startCoordinator,
  stopCoordinator,
} from "./coordinator";
import {
  assertDiscoveredWorktreeAudience,
  requireToken,
  validateBooleanTaskMap,
  validateConcurrency,
  validateEffort,
  validateEnvironmentSelector,
  validateEnvironmentTaskMap,
  validateGroupAudience,
  validateGroupMessagePriority,
  validateGroupMessageType,
  validateHarness,
  validateId,
  validateModel,
  validatePlacementTaskMap,
  validateSelector,
  validateTaskValueMap,
  validateText,
  ValidationError,
  type SecurityPolicy,
} from "./security";
import {
  ActivityJournal,
  buildActivitySnapshot,
  createViewerActivity,
  type ActivitySnapshot,
} from "./activity";
import { RequestLedger } from "./requestLedger";

/**
 * The Express app, extracted from index.ts so it can be constructed and tested
 * without binding a fixed port (and so the route surface has one reviewable
 * home). index.ts keeps only process concerns: subcommand dispatch, skill
 * installation, listening, and opening the browser.
 */

export interface CreateAppOptions {
  /** Workspace the viewer config lives in (and `active` worktrees resolve from). */
  workspaceDir: string;
  /** Orca worktree selector used for coordinator/worker terminals. */
  worktree: string;
  /** Per-process mutation token + custom-command policy (see security.ts). */
  policy: SecurityPolicy;
  /**
   * SPA assets embedded at `bun build --compile` time. Absent/empty → serve
   * `web/dist` from disk instead (or nothing, under `npm run dev`).
   */
  embeddedAssets?: Map<string, { type: string; body: Buffer }> | null;
  /**
   * Readiness probe, injectable for tests. Defaults to the real one-shot
   * checkReadiness() (cached 30s inside orca.ts). The execution gate below
   * awaits this on every mutating orchestration route.
   */
  readiness?: () => Promise<OrcaReadiness>;
}

/** Turn an Orca CLI failure into a response the UI can explain to the user. */
function fail(res: express.Response, err: unknown): void {
  if (err instanceof ValidationError) {
    // execution_disabled is not a malformed request — the server is (still)
    // unable to execute, so 503 tells the client to retry after fixing the
    // runtime rather than 400 "you did it wrong".
    const status = err.code === "execution_disabled" ? 503 : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  const e = err as OrcaCliError;
  const code = e?.code ?? null;
  const status =
    code === "run_required" || code === "run_not_found"
      ? 409
      : code === "coordinator_conflict"
        ? 409 // another live viewer owns this workspace's coordinator slot
        : code === "not_running" ||
            code === "active_dispatch_required" ||
            code === "dispatch_not_active" ||
            code === "inbox_item_not_found" ||
            code === "message_not_found" ||
            code === "retry_not_allowed" ||
            code === "retry_target_not_found"
          ? 409 // Phase 4 safe-retry refusals: the state forbids it, not the request shape
          : 500;
  // Orca hands back the exact unblocking command for some refusals — most
  // usefully `run-use --takeover-legacy` for a Run adopted by the 1.4.160
  // migration, which plain `run-use` refuses while it still has live work.
  const recovery = e?.recoveryCommand ?? null;
  const message = recovery ? `${e.message}\n\nUnblock with: ${recovery}` : String(e?.message ?? err);
  res.status(status).json({ error: message, code, recoveryCommand: recovery });
}

/**
 * Express 4 does not route rejected async-handler promises anywhere — a throw
 * inside a handler would hang the request (the client waits forever, the test
 * runner with it). This wrapper guarantees every rejection becomes a JSON
 * error response, so no route ever has to remember to try/catch.
 */
function route(h: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler {
  return (req, res) => {
    h(req, res).catch((err) => {
      if (!res.headersSent) fail(res, err);
    });
  };
}

/**
 * Run a mutating orchestration call as the bound coordinator.
 *
 * Mutations (`gate-resolve`, `dispatch`, `worker-start`, …) are rejected unless
 * the caller is the live Orca terminal currently bound to the Run, so we borrow
 * one. If the coordinator loop is already running we reuse its terminal;
 * otherwise we create one, bind, act, and close it again so we don't sit on the
 * Run's coordinator slot (which would keep the user's agent fenced).
 */
async function asCoordinator<T>(runId: string, worktree: string, fn: (from: string) => Promise<T>): Promise<T> {
  const live = coordinatorStatus();
  if (live.running && live.coordinatorHandle && live.runId === runId) {
    return fn(live.coordinatorHandle);
  }
  // NEVER reuse the loop's terminal here: rebinding it to another Run would
  // fence the running coordinator, and the finally below would then close its
  // terminal. A throwaway uniquely-titled terminal keeps the paths independent.
  const handle = await createTempCoordinatorTerminal(worktree);
  try {
    await bindRun(runId, handle);
    return await fn(handle);
  } finally {
    await closeTerminal(handle);
  }
}

/**
 * Recover the durable identity behind a worker question before journaling the
 * reply. Live-loop replies already carry this evidence in the pending inbox;
 * stopped-Run replies must prove the message belongs to the requested Run via
 * the Run-scoped global inbox before the throwaway coordinator may mutate it.
 */
async function resolveReplyIdentity(
  runId: string,
  messageId: string,
  seed?: { taskId?: string | null; dispatchId?: string | null },
): Promise<{ taskId: string | null; dispatchId: string | null }> {
  let taskId = seed?.taskId ?? null;
  let dispatchId = seed?.dispatchId ?? null;
  let source: Awaited<ReturnType<typeof listRunMessages>>[number] | null = null;

  if (!seed || !taskId || !dispatchId) {
    source = (await listRunMessages(runId)).find((message) => message.id === messageId) ?? null;
    if (!source && !seed) {
      throw new OrcaCliError(
        `Message ${messageId} does not belong to Run ${runId} or is no longer available.`,
        "message_not_found",
      );
    }
  }

  if (source) {
    const payload = parseWorkerDonePayload(source);
    taskId ??= payload?.taskId ?? null;
    dispatchId ??= payload?.dispatchId ?? null;
  }

  // Some older worker messages omit payload identity. A scoped fleet row can
  // fill the gap; absence stays null rather than being guessed from a task's
  // saved configuration.
  if (!taskId || !dispatchId) {
    const rows = await listWorkers(runId, { includeRemote: true });
    const row = rows.find(
      (candidate) =>
        (dispatchId !== null && candidate.dispatchId === dispatchId) ||
        (taskId !== null && candidate.taskId === taskId) ||
        (taskId === null && dispatchId === null && source?.from_handle === candidate.agentTerminalHandle),
    );
    taskId ??= row?.taskId ?? null;
    dispatchId ??= row?.dispatchId ?? null;
  }
  return { taskId, dispatchId };
}

export function createApp(opts: CreateAppOptions): { app: express.Express; servingUI: boolean } {
  const { workspaceDir, worktree, policy } = opts;
  const readiness = opts.readiness ?? checkReadiness;
  // Run records have no workspace field. Remember empty Runs created through
  // this viewer until their first Task supplies durable creator-worktree
  // evidence (or the selected Run is persisted in workspace config).
  const viewerCreatedRunIds = new Set<string>();
  const activityJournal = new ActivityJournal(workspaceDir);
  const activityCache = new Map<string, { at: number; value: Promise<ActivitySnapshot> }>();
  // Durable, bounded metadata for viewer-originated mutation requests
  // (Phase 5). Ids and scope only — the recorded state of a mutation is
  // ALWAYS re-read live from Orca (`request-show`); this ledger never
  // becomes a second lifecycle authority.
  const requestLedger = new RequestLedger(workspaceDir);

  /**
   * One bounded, strictly Run-scoped activity projection. Message history is
   * the expensive read (`orchestration inbox`), so concurrent HTTP/SSE consumers share
   * a short cache window. The returned snapshot is still rebuilt frequently
   * enough to match the viewer's existing two-second freshness contract.
   */
  const loadActivity = (runId: string, force = false): Promise<ActivitySnapshot> => {
    const cached = activityCache.get(runId);
    if (!force && cached && Date.now() - cached.at < 1_200) return cached.value;
    const value = (async () => {
      const status = coordinatorStatus();
      // Phase 3: the history read reports the global-inbox window it observed
      // (rows counted BEFORE Run filtering + whether the window came back
      // full). A failed read leaves the window null — completeness is then
      // unknown, which the UI renders as no claim instead of a false "all
      // history present".
      const [tasks, page, workers, config, history] = await Promise.all([
        listTasks(runId),
        listRunMessagePage(runId).catch(() => ({ messages: [], window: null })),
        listWorkers(runId, { includeRemote: true }).catch(() => []),
        loadConfig(workspaceDir),
        activityJournal.listHistory(runId),
      ]);
      // Phase 2: Chat's presence strip must not render a false disconnect for
      // the documented fleet capability gaps. Rows the fleet could not decide
      // for (`missing_status` / `capability_unsupported`) get ONE exact
      // `worker-show` observation each — a small bounded sweep, because a
      // healthy runtime reports none of these rows — and the positive exact-
      // worker evidence rides into the snapshot as qualified presentation.
      // The fleet verdict itself is never replaced (see presentWorkerLiveness).
      const gapRows = workers
        .filter(
          (worker) =>
            worker.projection?.liveness?.verdict === "unverifiable" &&
            worker.projection.liveness.reason != null &&
            FLEET_CAPABILITY_GAP_REASONS.has(worker.projection.liveness.reason),
        )
        .slice(0, 6);
      const observations = new Map<string, WorkerObservation>();
      if (gapRows.length > 0) {
        const probes = await Promise.allSettled(
          gapRows.map(async (worker) => [worker.dispatchId, await showWorkerDetail(worker.dispatchId)] as const),
        );
        for (const probe of probes) {
          if (probe.status !== "fulfilled" || !probe.value[1]?.observation) continue;
          observations.set(probe.value[0], probe.value[1].observation);
        }
      }
      return buildActivitySnapshot({
        runId,
        tasks,
        messages: page.messages,
        inboxWindow: page.window,
        workers,
        leadTaskId: config.leadTaskByRun?.[runId] ?? null,
        status,
        journal: history.events,
        persistedChecks: history.checks,
        observations,
      });
    })();
    activityCache.set(runId, { at: Date.now(), value });
    value.catch(() => {
      if (activityCache.get(runId)?.value === value) activityCache.delete(runId);
    });
    return value;
  };

  const recordActivity = async (event: ReturnType<typeof createViewerActivity>): Promise<void> => {
    try {
      await activityJournal.append(event);
    } catch {
      // The journal is explanatory UI state, not part of Orca's lifecycle
      // transaction. A full disk or torn auxiliary file must never turn a
      // successful worker action into an ambiguous HTTP failure that invites
      // the user to repeat the mutation.
    } finally {
      activityCache.delete(event.runId);
    }
  };

  /**
   * Execution gate (Phase 2): mutating orchestration routes refuse to run
   * against a runtime that can't drive the supervised-worker contract. The
   * check runs AFTER token + request validation, so Phase 1's "reject garbage
   * before doing any work" ordering is preserved and readiness is only asked
   * of requests that are otherwise well-formed.
   */
  const requireExecutionEnabled = async (): Promise<void> => {
    const r = await readiness();
    if (!r.executionEnabled) {
      throw new ValidationError(r.reason ?? "Orca execution is unavailable.", "execution_disabled");
    }
  };

  /**
   * Run a one-off terminal mutation (release/retain) under a durable,
   * ledger-recorded request id (Phase 5). Run/Task scope is recorded ONLY
   * when this viewer's own coordinator projection positively proves it;
   * anything else stays unscoped ("scope unknown") rather than being
   * mis-attributed to whatever Run happens to be open. The mint record
   * lands BEFORE the CLI call, so even a lost response leaves the id
   * inspectable via `request-show`.
   */
  const terminalMutationWithLedger = async (
    operation: "worker-release" | "worker-retain",
    dispatchId: string,
    run: (requestId: string) => Promise<{ state: string }>,
  ): Promise<{ state: string }> => {
    const live = coordinatorStatus();
    const attempt =
      live.running && live.runId
        ? live.attempts.find((a) => a.dispatchId === dispatchId)
        : undefined;
    const runId = attempt ? live.runId : null;
    const taskId = attempt?.taskId ?? null;
    const requestId = newRequestId();
    await requestLedger
      .record({ requestId, operation, runId, taskId, dispatchId })
      .catch(() => {});
    try {
      const receipt = await run(requestId);
      await requestLedger
        .record({
          requestId,
          operation,
          runId,
          taskId,
          dispatchId,
          settledLocally: receipt.state !== "release_unknown",
          note: `viewer-observed terminal state: ${receipt.state}`,
        })
        .catch(() => {});
      return receipt;
    } catch (err) {
      await requestLedger
        .record({
          requestId,
          operation,
          runId,
          taskId,
          dispatchId,
          settledLocally: false,
          note: `mutation failed: ${String((err as Error)?.message ?? err)}`,
        })
        .catch(() => {});
      throw err;
    }
  };

  const app = express();
  // No cors() on purpose: the only legitimate client is the same-origin SPA
  // (and Vite's dev proxy, which is same-origin from the browser's view).
  // Cross-origin JS must not be able to read /api/session or drive mutations.
  app.use(express.json({ limit: "2mb" }));

  // --- session -------------------------------------------------------------
  // The web client fetches this once at boot and echoes the token back on
  // every mutation. no-store keeps the token out of any cache along the way.
  app.get("/api/session", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ token: policy.token, allowCustomCommands: policy.allowCustomCommands });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, workspace: workspaceDir, worktree });
  });

  /**
   * Resolved CLI + runtime version + whether execution is enabled (Phase 2).
   * Read-only, token-free: the SPA calls it once at boot to decide whether the
   * Run/gate controls render at all. On an Orca between 1.4.160 and
   * 1.4.204 this reports view-only with an upgrade pointer instead of letting
   * the user start a DAG that would fail mid-flight.
   */
  app.get(
    "/api/readiness",
    route(async (_req, res) => {
      res.json(await readiness());
    }),
  );

  /**
   * Runs available to this exact workspace. Orca's registry is global, so the
   * adapter derives scope from Task creator identities; see listWorkspaceRuns.
   */
  app.get(
    "/api/runs",
    route(async (_req, res) => {
      const configuredRunId = (await loadConfig(workspaceDir)).runId;
      const explicitIds = configuredRunId
        ? [...viewerCreatedRunIds, configuredRunId]
        : [...viewerCreatedRunIds];
      res.json({ runs: await listWorkspaceRuns(workspaceDir, explicitIds) });
    }),
  );

  /** Create a new Run (and bind it just long enough to create it). */
  app.post(
    "/api/runs",
    requireToken(policy),
    route(async (req, res) => {
      const objective = validateText(req.body?.objective, "objective", 20000);
      if (!objective) {
        res.status(400).json({ error: "objective required" });
        return;
      }
      // Creating a Run spawns a coordinator terminal — an execution mutation.
      await requireExecutionEnabled();
      // Throwaway terminal — see asCoordinator for why we never reuse the loop's.
      const handle = await createTempCoordinatorTerminal(worktree);
      try {
        const run = await createRun(objective, handle);
        viewerCreatedRunIds.add(run.id);
        res.json({ run });
      } finally {
        await closeTerminal(handle);
      }
    }),
  );

  /**
   * The DAG of one Run. `?run=<id>` is required — an unscoped `task-list` fails
   * with `run_required` because this process is not a bound coordinator.
   */
  app.get(
    "/api/dag",
    route(async (req, res) => {
      const runId = validateId(req.query.run, "run");
      if (!runId) {
        res.status(400).json({ error: "run query parameter required", code: "run_required" });
        return;
      }
      const [tasks, gates] = await Promise.all([listTasks(runId), listGates(runId)]);
      const { nodes, edges, hierarchy } = tasksToDag(tasks);
      // Capacity evidence (Phase 4 scheduler surface): ONLY this viewer's
      // coordinator occupancy on THIS Run counts. Any other state — not
      // running, running a different Run — leaves capacity unknown (null),
      // never zero: we must not claim "no free slots" from a coordinator
      // that isn't ours.
      const coord = coordinatorStatus();
      const occupancy =
        coord.running && coord.runId === runId && coord.maxConcurrency !== null
          ? { busy: coord.busy, maxConcurrency: coord.maxConcurrency }
          : null;
      const { readyWave, readiness } = explainReadiness(tasks, gates, occupancy);
      res.json({
        runId,
        nodes,
        edges,
        hierarchy,
        gates,
        readyWave,
        readiness,
        generatedAt: Date.now(),
      });
    }),
  );

  /** Live terminals (running agent/shell sessions). */
  app.get(
    "/api/terminals",
    route(async (_req, res) => {
      res.json({ terminals: await listTerminals() });
    }),
  );

  // --- Phase 6: saved environments + exact placement discovery -------------
  //
  // Read-only, token-free like the other reads. These endpoints are the ONLY
  // way the UI learns about remote targets — placement pickers are populated
  // exclusively from what Orca itself discovered, never from free-text input.
  // Each environment row carries `peer`: the parsed advertised-capability set
  // (model/effort forwarding, transcript reads, fleet snapshot) the UI gates
  // remote controls on. Nothing advertised → all gates off (mixed-version
  // peers hide unsupported controls).

  /** Saved Orca runtime environments (`orca environment list`). */
  app.get(
    "/api/environments",
    route(async (_req, res) => {
      const environments = (await listEnvironments()).map((env) => ({
        ...env,
        peer: parsePeerCapabilities(env.capabilities),
        // Canonical projection of the same advertisement (epic O1): the UI's
        // readable matrix, while `peer` keeps gating the remote controls.
        runtimeCapabilities: describeRuntimeCapabilities(env.capabilities),
      }));
      res.json({ environments });
    }),
  );

  /**
   * Exact workspaces on ONE saved environment (`worktree list --environment`).
   * `id` on each row is the full `id:<repoId>::<path>` selector the placement
   * picker stores verbatim — a bare repo id is NOT a worktree id.
   */
  app.get(
    "/api/environments/:envId/worktrees",
    route(async (req, res) => {
      const envId = validateEnvironmentSelector(req.params.envId, "environment");
      const repo = req.query.repo ? validateSelector(req.query.repo, "repo") : undefined;
      res.json({ worktrees: await listWorktrees(envId, { repo, limit: 100 }) });
    }),
  );

  /** Repositories registered on ONE saved environment (`repo list --environment`). */
  app.get(
    "/api/environments/:envId/repos",
    route(async (req, res) => {
      const envId = validateEnvironmentSelector(req.params.envId, "environment");
      res.json({ repos: await listRepos(envId) });
    }),
  );

  /** Project groupings visible on ONE saved environment (`project list --environment`). */
  app.get(
    "/api/environments/:envId/projects",
    route(async (req, res) => {
      const envId = validateEnvironmentSelector(req.params.envId, "environment");
      res.json({ projects: await listProjects(envId) });
    }),
  );

  /**
   * Start the self-driven coordinator on one Run. It binds a coordinator terminal
   * (fencing any agent currently coordinating that Run) and then dispatches every
   * ready task in parallel until the DAG settles.
   */
  app.post(
    "/api/run",
    requireToken(policy),
    route(async (req, res) => {
      const runId = validateId(req.body?.runId, "runId");
      if (!runId) {
        res.status(400).json({ error: "runId required", code: "run_required" });
        return;
      }
      // Strict validation happens here — before any Orca terminal exists — so a
      // bad harness or model string can never reach the CLI/shell boundary.
      const defaultHarness = req.body?.defaultHarness
        ? validateHarness(req.body.defaultHarness, policy)
        : "claude";
      const harnessByTask = validateTaskValueMap(
        req.body?.harnessByTask,
        "harnessByTask",
        { maxKeys: 500, valueKind: "harness" },
        (v) => validateHarness(v, policy),
      );
      // A model is validated against its task's EFFECTIVE harness (override
      // else default) — that's the harness whose launch path will consume it.
      const modelByTask = validateTaskValueMap(
        req.body?.modelByTask,
        "modelByTask",
        { maxKeys: 500, valueKind: "model" },
        (v, key) => validateModel(v, harnessByTask?.[key] ?? defaultHarness),
      );
      // Per-task effort (Phase 5): charset-validated, and only ever accepted
      // alongside a model for the SAME task — `worker-start --effort` requires
      // `--model`, so an unpaired effort is a request bug, rejected here
      // (before any Orca work) instead of silently dropped later.
      const effortByTask = validateTaskValueMap(
        req.body?.effortByTask,
        "effortByTask",
        { maxKeys: 500, valueKind: "effort" },
        (v) => validateEffort(v),
      );
      if (effortByTask) {
        const models = modelByTask ?? {};
        for (const taskId of Object.keys(effortByTask)) {
          if (!models[taskId]) {
            throw new ValidationError(
              `effortByTask["${taskId}"] requires a model for the same task — per-task effort applies only to a selected model.`,
              "effort_requires_model",
            );
          }
        }
      }
      const maxConcurrency = validateConcurrency(req.body?.maxConcurrency);
      // Phase 6: per-task saved-environment + exact placement. Shape-validated
      // here (charset, kinds, required fields); whether an environment really
      // exists is checked at start time (environment_unknown start failure),
      // and the adapter re-refuses remote current/new-child as the last gate.
      const environmentByTask = validateEnvironmentTaskMap(req.body?.environmentByTask, "environmentByTask");
      const placementByTask = validatePlacementTaskMap(req.body?.placementByTask, "placementByTask");
      // Per-task opt-out from automatic release (plan §7.3 retainByTask).
      // The request wins; the persisted config fills it in so a hand-edited
      // `.orca-dag.config.json` works without any UI for it yet. Absent
      // everywhere → default behavior (release after settlement).
      const retainByTask =
        validateBooleanTaskMap(req.body?.retainByTask, "retainByTask") ??
        (await loadConfig(workspaceDir)).retainByTask;
      // Starting the coordinator binds a terminal and dispatches workers — the
      // main execution surface, and the first thing a too-old runtime would
      // fail confusingly (unknown worker-start flags). Refuse with the reason.
      await requireExecutionEnabled();
      // `worker-stop` parks an interrupted Task as blocked. A later Run click
      // is the user's explicit resume decision, but only Dispatches for which
      // this viewer observed a definitive `stopped` receipt may be retried.
      // The coordinator cross-checks these identities against live fleet state
      // before changing a Task; this audit metadata is a selector, never the
      // lifecycle authority by itself.
      const resumeStoppedDispatchIds = (await requestLedger.list().catch(() => []))
        .filter(
          (record) =>
            record.operation === "worker-stop" &&
            record.runId === runId &&
            record.settledLocally === true &&
            record.note === "viewer-observed stop state: stopped" &&
            record.dispatchId,
        )
        .map((record) => record.dispatchId!);
      await startCoordinator({
        runId,
        harnessByTask: harnessByTask ?? {},
        modelByTask: modelByTask ?? {},
        effortByTask: effortByTask ?? {},
        defaultHarness,
        maxConcurrency,
        worktree,
        retainByTask: retainByTask ?? undefined,
        environmentByTask: environmentByTask ?? undefined,
        placementByTask: placementByTask ?? undefined,
        resumeStoppedDispatchIds,
        onActivity: async (event) => {
          await recordActivity(
            createViewerActivity({
              runId: event.runId,
              kind: event.kind,
              title: event.title,
              summary: event.summary,
              detail: event.detail,
              taskId: event.taskId,
              dispatchId: event.dispatchId,
            }),
          );
        },
        onCheck: async (receipt) => {
          await activityJournal.appendCheck(runId, receipt);
          activityCache.delete(runId);
        },
        // Phase 5: the coordinator's mutation requests (worker-start/release/
        // retain/stop) land in the durable ledger — best-effort, metadata
        // only, so every `--retry-request` id stays inspectable via
        // `request-show` even after a response loss or viewer restart.
        onRequestRecord: (meta) => requestLedger.record(meta),
      });
      await recordActivity(
        createViewerActivity({
          runId,
          kind: "dispatch_started",
          title: "Coordinator started this Run",
          summary: `Scheduling ready stages with up to ${maxConcurrency} worker${maxConcurrency === 1 ? "" : "s"}.`,
        }),
      );
      res.json({ ok: true, ...coordinatorStatus() });
    }),
  );

  /**
   * Explicit Stop (Phase 3): enumerate active Dispatches, stop the supervised
   * ones, close only terminals this viewer provably created, and report every
   * outcome per Dispatch instead of an unconditional `{ ok: true }`. Unknown
   * results come back as `unknown` entries — never swallowed.
   */
  app.post(
    "/api/run-stop",
    requireToken(policy),
    route(async (_req, res) => {
      const before = coordinatorStatus();
      const report = await stopCoordinator();
      if (before.runId) {
        await recordActivity(
          createViewerActivity({
            runId: before.runId,
            kind: "status",
            title: "Coordinator stopped this Run",
            summary: report.clean ? "Every worker and coordinator resource reached a known state." : "Some cleanup outcomes remain unknown.",
            severity: report.clean ? "info" : "warning",
          }),
        );
      }
      res.json({ ok: true, clean: report.clean, results: report.results });
    }),
  );

  /** Live coordinator status (phase, attempts, inbox, cleanup debt). */
  app.get("/api/run-status", (_req, res) => {
    res.json(coordinatorStatus());
  });

  /**
   * Read-only runtime capability projection (operations epic O1).
   *
   * The local CLI exposes no capability advertisement this viewer can read
   * (there is no `--version`-style surface listing capability ids), so the
   * local projection honestly reports `advertised: null` — every canonical
   * capability reads "absent", nothing is inferred from the version number.
   * The canonical machinery is exercised for real on peer environments, see
   * /api/environments below, whose rows DO carry advertised capability lists.
   * Token-free and read-only like the other discovery reads; safe on
   * view-only runtimes (no execution gate — this endpoint mutates nothing).
   */
  app.get(
    "/api/capabilities",
    route(async (_req, res) => {
      const r = await readiness();
      res.json({
        runtime: {
          cli: r.cli,
          version: r.version,
          executionEnabled: r.executionEnabled,
          reason: r.reason,
        },
        /** null = this source exposes no capability list (unknown, never "none needed"). */
        advertised: null,
        advertisedSource: "local-runtime",
        ...describeRuntimeCapabilities(null),
      });
    }),
  );

  /**
   * Ownership + health of ONE Run (operations epic O2). Read-only, strictly
   * `?run=`-scoped like the other Run reads, and available on view-only
   * runtimes (everything here is a read; no execution gate).
   *
   * Authority comes from `run-show` (the durable binding) plus this process's
   * coordinator facts; counts come from the same Run-scoped reads the rest of
   * the UI uses. A failed read leaves its count `null` and raises a warning —
   * never a silent zero. Results share a short cache because each projection
   * fans out to five CLI reads and the UI polls this alongside the DAG.
   */
  const runHealthCache = new Map<string, { at: number; value: Promise<RunHealthView> }>();
  const RUN_HEALTH_CACHE_MS = 1_500;
  const loadRunHealth = (runId: string): Promise<RunHealthView> => {
    const cached = runHealthCache.get(runId);
    if (cached && Date.now() - cached.at < RUN_HEALTH_CACHE_MS) return cached.value;
    const value = (async (): Promise<RunHealthView> => {
      const viewer = coordinatorStatus();
      const [runRes, taskRes, gateRes, messageRes, workerRes] = await Promise.allSettled([
        showRun(runId),
        listTasks(runId),
        listGates(runId),
        listRunMessages(runId),
        listWorkers(runId, { includeRemote: true }),
      ]);
      const valueOf = <T,>(r: PromiseSettledResult<T>): { value: T | null; error: string | null } =>
        r.status === "fulfilled"
          ? { value: r.value, error: null }
          : { value: null, error: String((r.reason as Error)?.message ?? r.reason).slice(0, 300) };
      const run = valueOf(runRes);
      const tasks = valueOf(taskRes);
      const gates = valueOf(gateRes);
      const messages = valueOf(messageRes);
      const workers = valueOf(workerRes);
      return buildRunHealth({
        runId,
        // showRun resolves null both for "Orca doesn't know this id" and for a
        // failed read — either way ownership is unverifiable, which is the
        // state the projection renders.
        run: run.value,
        viewer: {
          running: viewer.running,
          runId: viewer.runId,
          coordinatorHandle: viewer.coordinatorHandle,
        },
        evidence: {
          tasks: tasks.value,
          taskError: tasks.error,
          gates: gates.value,
          gateError: gates.error,
          messages: messages.value,
          messageError: messages.error,
          workers: workers.value,
          workerError: workers.error,
        },
        workspaceDir,
      });
    })();
    runHealthCache.set(runId, { at: Date.now(), value });
    value.catch(() => {
      if (runHealthCache.get(runId)?.value === value) runHealthCache.delete(runId);
    });
    return value;
  };

  app.get(
    "/api/run-health",
    route(async (req, res) => {
      const runId = validateId(req.query.run, "run");
      if (!runId) {
        res.status(400).json({ error: "run query parameter required", code: "run_required" });
        return;
      }
      res.json({ health: await loadRunHealth(runId) });
    }),
  );


  /**
   * Complete worker accounting for one Run: normalized worker-list rows across
   * every cursor page, including connected-server observations. This endpoint
   * is also the UI's durable "has this Task ever started?" source, so omitting
   * remote or older rows would incorrectly unlock immutable launch settings.
   * Read-only, token-free.
   */
  app.get(
    "/api/workers",
    route(async (req, res) => {
      const runId = validateId(req.query.run, "run");
      if (!runId) {
        res.status(400).json({ error: "run query parameter required", code: "run_required" });
        return;
      }
      res.json({ workers: await listWorkers(runId, { includeRemote: true }) });
    }),
  );

  /**
   * Run-scoped detail for ONE worker (Phase 2): the durable accounting row
   * plus `worker-show` evidence — Dispatch/Worker records, PTY terminal facts,
   * and the exact-worker observation with agent-wait evidence. Read-only,
   * token-free, and deliberately independent of the coordinator loop so a
   * historical worker stays inspectable after a viewer restart or when this
   * viewer is not coordinating the Run.
   *
   * `worker-show` itself has no `--run` flag, so Run scoping is enforced by
   * comparing the receipt's durable runId with the requested Run: a worker
   * from another Run 404s rather than leaking across the scope boundary.
   */
  app.get(
    "/api/workers/:dispatchId",
    route(async (req, res) => {
      const dispatchId = validateId(req.params.dispatchId, "dispatch id");
      if (!dispatchId) {
        res.status(400).json({ error: "dispatch id required" });
        return;
      }
      const runId = validateId(req.query.run, "run");
      if (!runId) {
        res.status(400).json({ error: "run query parameter required", code: "run_required" });
        return;
      }
      const detail = await showWorkerDetail(dispatchId);
      if (!detail) {
        res.status(404).json({ error: "no such worker dispatch", code: "worker_not_found" });
        return;
      }
      if (detail.runId !== runId) {
        res.status(404).json({
          error: "worker belongs to a different Run",
          code: "worker_run_mismatch",
        });
        return;
      }
      res.json({ detail });
    }),
  );

  /**
   * Bounded output page for ONE worker (Phase 5): `worker-read` with an
   * optional `--source` and `--cursor`, plus a clamped `--limit`. Read-only,
   * token-free like the other reads. A cursor pinned to a replaced source is
   * resolved inside the adapter — the response says so via `sourceChanged`
   * and a warning, so the UI explains the discontinuity instead of silently
   * jumping back to the start.
   */
  app.get(
    "/api/workers/:dispatchId/output",
    route(async (req, res) => {
      const dispatchId = validateId(req.params.dispatchId, "dispatch id");
      if (!dispatchId) {
        res.status(400).json({ error: "dispatch id required" });
        return;
      }
      const source = validateText(req.query.source, "source", 16);
      if (source && !["auto", "terminal", "transcript"].includes(source)) {
        throw new ValidationError(
          `source must be auto, terminal, or transcript (got "${source}")`,
          "invalid_source",
        );
      }
      const cursor = validateText(req.query.cursor, "cursor", 512);
      const limitRaw = req.query.limit === undefined ? NaN : Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.round(limitRaw))) : 40;
      res.json({ output: await readWorkerOutput(dispatchId, { source: source ?? undefined, cursor: cursor ?? undefined, limit }) });
    }),
  );

  // --- Phase 5: mutation-request audit (read-only) --------------------------
  //
  // The durable ledger of viewer-originated mutation requests, plus a live
  // `request-show` inspection endpoint. Both are strictly read-only: nothing
  // here replays, retries, or settles anything. `request-show` only asks
  // Orca what ALREADY happened, and its `absent` answer never proves a
  // mutation did not happen — the UI says so in plain text.

  /**
   * Recovery/audit list for one Run: bounded ledger rows recorded by this
   * workspace's viewer, filtered to the requested Run. Rows whose recorded
   * operation supplied no Run scope stay inspectable under every Run —
   * labeled unscoped — because an unscoped lost-response id is exactly what
   * an operator needs to find, never silently dropped. Newest first, capped
   * server-side (RequestLedger.list).
   */
  app.get(
    "/api/requests",
    route(async (req, res) => {
      const runId = validateId(req.query.run, "run");
      if (!runId) {
        res.status(400).json({ error: "run query parameter required", code: "run_required" });
        return;
      }
      const all = await requestLedger.list();
      const requests = all.filter((row) => row.runId === runId || row.runId === null);
      res.json({
        runId,
        requests,
        /** Rows that positively name ANOTHER Run — excluded, but counted. */
        otherRunCount: all.filter((row) => row.runId !== null && row.runId !== runId).length,
        generatedAt: Date.now(),
      });
    }),
  );

  /**
   * Live inspection of ONE recorded mutation request: the durable ledger row
   * plus a fresh, read-only `request-show` probe. Orca's own state and
   * interpretation ride through verbatim (`completed` / `pending` / `absent`
   * / whatever new state a newer runtime introduces); a failed probe
   * degrades to state "unknown" — never to a guess. This surface NEVER
   * replays a mutation: the only CLI verb reachable from here is
   * `request-show`, and no method on this route accepts an action.
   */
  app.get(
    "/api/requests/:requestId",
    route(async (req, res) => {
      const requestId = validateId(req.params.requestId, "request id");
      const runId = validateId(req.query.run, "run");
      if (!requestId || !runId) {
        res.status(400).json({ error: "run query parameter required", code: "run_required" });
        return;
      }
      const request = (await requestLedger.list()).find((row) => row.requestId === requestId);
      if (!request) {
        res.status(404).json({ error: "no such recorded request", code: "request_not_found" });
        return;
      }
      // Scope guard, mirroring worker detail: a row that positively names
      // another Run 404s instead of leaking across the Run boundary.
      // (Unscoped rows — the ledger's "scope unknown" — remain inspectable.)
      if (request.runId !== null && request.runId !== runId) {
        res.status(404).json({
          error: "request belongs to a different Run",
          code: "request_run_mismatch",
        });
        return;
      }
      const receipt = await showRequest(requestId);
      res.json({
        request,
        receipt: receipt
          ? {
              state: receipt.state,
              interpretation: receipt.interpretation,
              outcome: receipt.outcome,
              probe: "orca",
              probedAt: new Date().toISOString(),
            }
          : {
              // The probe itself failed (transport trouble, missing CLI).
              // The mutation's outcome stays UNRESOLVED — reporting it as
              // anything else would be inventing a lifecycle fact.
              state: "unknown",
              interpretation: null,
              outcome: null,
              probe: "failed",
              probedAt: new Date().toISOString(),
            },
      });
    }),
  );

  /**
   * The coordinator's pending questions/escalations plus its cleanup debt —
   * what InboxPanel renders. Read-only: the run-status route carries the same
   * data; this one exists so the panel can poll it without dragging the whole
   * attempt projection across the wire every 2s.
   */
  app.get("/api/inbox", (req, res) => {
    const runId = validateId(req.query.run, "run");
    if (!runId) {
      res.status(400).json({ error: "run query parameter required", code: "run_required" });
      return;
    }
    const status = coordinatorStatus();
    if (status.runId !== runId) {
      res.json({
        runId,
        inbox: { pending: [], pendingDeliveryId: null, recent: [], lastAckedDeliveryId: null },
        cleanupDebt: [],
        phase: "idle",
      });
      return;
    }
    res.json({ runId, inbox: status.inbox, cleanupDebt: status.cleanupDebt, phase: status.phase });
  });

  /** Human-readable, Run-scoped history. `after` returns only newer rows. */
  app.get(
    "/api/activity",
    route(async (req, res) => {
      const runId = validateId(req.query.run, "run");
      if (!runId) {
        res.status(400).json({ error: "run query parameter required", code: "run_required" });
        return;
      }
      const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 200;
      const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 200;
      const after = typeof req.query.after === "string" ? req.query.after : null;
      const snapshot = await loadActivity(runId);
      let events = snapshot.events;
      let reset = false;
      if (after) {
        const index = events.findIndex((event) => event.id === after);
        if (index >= 0) events = events.slice(0, index);
        else reset = true;
      }
      res.json({
        ...snapshot,
        events: events.slice(0, limit),
        nextCursor: snapshot.events[0]?.id ?? after,
        hasMore: events.length > limit,
        reset,
      });
    }),
  );

  /**
   * Live Activity snapshots through SSE. Full snapshots keep reconnect and
   * deletion semantics simple, while the server-side cache prevents each
   * client from spawning its own global-inbox polling storm.
   */
  app.get("/api/activity/stream", (req, res) => {
    let runId: string | null;
    try {
      runId = validateId(req.query.run, "run");
    } catch (err) {
      fail(res, err);
      return;
    }
    if (!runId) {
      res.status(400).json({ error: "run query parameter required", code: "run_required" });
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    let closed = false;
    let lastSignature = "";
    const send = async () => {
      try {
        const snapshot = await loadActivity(runId!);
        const signature = JSON.stringify([
          snapshot.events[0]?.id ?? "empty",
          snapshot.events.length,
          snapshot.pendingCount,
          snapshot.events.slice(0, 20).map((event) => [event.id, event.createdAt, event.groupedCount]),
        ]);
        if (signature !== lastSignature && !closed) {
          lastSignature = signature;
          res.write(`id: ${snapshot.events[0]?.id ?? snapshot.generatedAt}\n`);
          res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
        }
      } catch (err) {
        if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: String((err as Error).message ?? err) })}\n\n`);
      }
    };
    void send();
    const timer = setInterval(() => void send(), 2_000);
    req.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
  });

  /**
   * Reply to a worker question/escalation. While the coordinator loop is live
   * the reply must go through it: it owns the unacknowledged Delivery and
   * acknowledges it exactly once after the reply lands. With no live loop
   * (mail viewed on a stopped Run) we borrow a throwaway coordinator terminal,
   * same as gate resolution.
   */
  app.post(
    "/api/messages/:id/reply",
    requireToken(policy),
    route(async (req, res) => {
      const messageId = validateId(req.params.id, "message id");
      const runId = validateId(req.body?.runId, "runId");
      const body = validateText(req.body?.body, "body", 20000);
      if (!messageId || !body || !runId) {
        res.status(400).json({ error: "body and runId required" });
        return;
      }
      await requireExecutionEnabled();
      const live = coordinatorStatus();
      if (live.running && live.runId === runId && live.coordinatorHandle) {
        // Capture the Run-scoped conversation before answerInboxItem removes
        // it from the pending inbox. Preserve Task/Dispatch identity in the
        // optimistic journal row so it renders in the correct thread before
        // the global Orca inbox observes and supersedes that row.
        const pending = live.inbox.pending.find((item) => item.messageId === messageId);
        const identity = await resolveReplyIdentity(runId, messageId, pending);
        await answerInboxItem(messageId, body);
        await recordActivity(
          createViewerActivity({
            runId,
            kind: "reply",
            title: "Coordinator replied to a worker",
            summary: body,
            taskId: identity.taskId,
            dispatchId: identity.dispatchId,
            // The durable reply Orca serializes for this message carries
            // thread_id = messageId; mirror that on the optimistic row so its
            // reply context survives until the inbox row supersedes it.
            threadId: messageId,
          }),
        );
        res.json({ ok: true, via: "coordinator" });
        return;
      }
      const identity = await resolveReplyIdentity(runId, messageId);
      await asCoordinator(runId, worktree, (from) => replyToMessage(messageId, body, from));
      await recordActivity(
        createViewerActivity({
          runId,
          kind: "reply",
          title: "Coordinator replied to a worker",
          summary: body,
          taskId: identity.taskId,
          dispatchId: identity.dispatchId,
          threadId: messageId,
        }),
      );
      res.json({ ok: true, via: "adhoc" });
    }),
  );

  /**
   * Send proactive coordinator guidance to one active Task attempt.
   *
   * Unlike a reply, this has no pending worker question to anchor authority,
   * so it is deliberately available only while THIS viewer owns the Run's
   * live coordinator terminal. Borrowing a throwaway terminal here would fence
   * a real coordinator merely because somebody opened an old Run in Chat.
   */
  app.post(
    "/api/tasks/:taskId/messages",
    requireToken(policy),
    route(async (req, res) => {
      const taskId = validateId(req.params.taskId, "task id");
      const runId = validateId(req.body?.runId, "runId");
      const body = validateText(req.body?.body, "body", 20000);
      if (!taskId || !runId || !body) {
        res.status(400).json({ error: "body and runId required" });
        return;
      }
      await requireExecutionEnabled();
      const live = coordinatorStatus();
      if (!live.running || live.runId !== runId || !live.coordinatorHandle) {
        throw new OrcaCliError(
          "This viewer is not the live coordinator for the selected Run; it cannot send worker guidance.",
          "not_running",
        );
      }
      // Keep the explicit Run check even though the adapter passes `--run`:
      // this boundary should fail closed if a mixed-version CLI ever returns
      // an unscoped or foreign row in a supposedly scoped receipt.
      const task = (await listTasks(runId)).find(
        (candidate) => candidate.id === taskId && candidate.run_id === runId,
      );
      if (!task || task.status !== "dispatched" || !task.dispatch_id) {
        throw new OrcaCliError(
          "Coordinator guidance requires a Task with an active Dispatch.",
          "active_dispatch_required",
        );
      }

      // Task rows can briefly lag the fleet after settlement, and a remote
      // host can disappear while the Dispatch id remains on the Task. Refuse
      // unless Orca's remote-inclusive accounting currently proves both an
      // active Dispatch and a live worker; never send guidance into an
      // unverifiable or already-settled attempt.
      const worker = (await listWorkers(runId, { includeRemote: true })).find(
        (candidate) =>
          candidate.runId === runId &&
          candidate.taskId === taskId &&
          candidate.dispatchId === task.dispatch_id &&
          candidate.dispatchStatus === "dispatched" &&
          normalizeLiveness(candidate.projection?.liveness?.verdict) === "live",
      );
      if (!worker) {
        throw new OrcaCliError(
          "Coordinator guidance requires Orca to verify that the Task Dispatch is still active and live.",
          "active_dispatch_required",
        );
      }

      await sendCoordinatorMessage({
        runId,
        taskId,
        dispatchId: task.dispatch_id,
        from: live.coordinatorHandle,
        subject: "Coordinator guidance",
        body,
      });
      await recordActivity(
        createViewerActivity({
          runId,
          kind: "status",
          title: "Coordinator sent guidance",
          summary: body,
          taskId,
          dispatchId: task.dispatch_id,
        }),
      );
      res.json({ ok: true, dispatchId: task.dispatch_id });
    }),
  );

  /**
   * Audience discovery for the Run-control group composer (Phase 6, read-only).
   *
   * Returns every supported group audience with an ESTIMATE of who it would
   * reach, derived from the same Run-scoped worker facts the rest of the
   * viewer renders. `previewRunAudiences` marks every option `exact: false`
   * because Orca exposes no group-membership read — the UI must present these
   * counts as estimates, never as a proven recipient list. Worktree audiences
   * appear only for exact `worktree list` identities, so the composer can
   * never offer — and the send route can never accept — an invented workspace.
   *
   * Read failures degrade to an explicit error field instead of an empty
   * "no audiences" answer: absence of evidence is not evidence of absence.
   */
  app.get(
    "/api/audiences",
    route(async (req, res) => {
      const runId = validateId(req.query.run, "run");
      if (!runId) {
        res.status(400).json({ error: "run query parameter required", code: "run_required" });
        return;
      }
      const live = coordinatorStatus();
      const coordinatorActive = live.running && live.runId === runId && Boolean(live.coordinatorHandle);
      const [workersResult, worktreesResult] = await Promise.allSettled([
        listWorkers(runId, { includeRemote: true }),
        listWorktrees(),
      ]);
      const workers = workersResult.status === "fulfilled" ? workersResult.value : null;
      const worktrees = worktreesResult.status === "fulfilled" ? worktreesResult.value : null;
      res.json({
        runId,
        coordinatorActive,
        audiences:
          workers && worktrees
            ? previewRunAudiences({ workers, worktrees })
            : [],
        workersError:
          workersResult.status === "rejected"
            ? String((workersResult.reason as Error)?.message ?? workersResult.reason).slice(0, 300)
            : null,
        worktreesError:
          worktreesResult.status === "rejected"
            ? String((worktreesResult.reason as Error)?.message ?? worktreesResult.reason).slice(0, 300)
            : null,
      });
    }),
  );

  /**
   * Send one deliberate Run-level GROUP message from the live coordinator
   * (Phase 6). The one-to-one guidance route above anchors authority to a
   * single active Dispatch; this route anchors it to Run coordination itself:
   * only THIS viewer's live coordinator terminal for the selected Run may
   * send, and never via a borrowed throwaway terminal (that would fence a
   * real coordinator just by opening an old Run's Run-control thread).
   *
   * Safety ordering inside the handler:
   *   1. token (middleware) → 2. shape validation (audience grammar, body,
   *   subject, type, priority) → 3. FRESH `worktree list` discovery + exact
   *   membership for `@worktree:` audiences → 4. execution gate → 5. live
   *   coordinator check → 6. send. A client can therefore never choose an
   *   arbitrary recipient, a lifecycle type, or an undiscovered workspace —
   *   and never reach the CLI at all unless every gate passed.
   */
  app.post(
    "/api/messages/group",
    requireToken(policy),
    route(async (req, res) => {
      const runId = validateId(req.body?.runId, "runId");
      const body = validateText(req.body?.body, "body", 20000);
      const subject = validateText(req.body?.subject, "subject", 200) ?? "Coordinator broadcast";
      const type = validateGroupMessageType(req.body?.type);
      const priority = validateGroupMessagePriority(req.body?.priority);
      const audience = validateGroupAudience(req.body?.audience);
      if (!runId || !body) {
        res.status(400).json({ error: "body and runId required" });
        return;
      }
      // Worktree audiences must name a workspace Orca itself discovered, in
      // this send's own discovery read — a stale or client-supplied list is
      // exactly the free-text hole this route exists to close. Other address
      // shapes return from the gate before any CLI call is spent. Discovery
      // failure fails CLOSED: an unverifiable workspace is never a recipient.
      await assertDiscoveredWorktreeAudience(audience, async () => {
        try {
          return new Set((await listWorktrees()).map((worktree) => worktree.id));
        } catch (err) {
          throw new ValidationError(
            "Worktree audiences cannot be verified right now (worktree discovery failed: " +
              `${String((err as Error)?.message ?? err).slice(0, 200)}).`,
            "unknown_audience",
          );
        }
      });
      await requireExecutionEnabled();
      const live = coordinatorStatus();
      if (!live.running || live.runId !== runId || !live.coordinatorHandle) {
        throw new OrcaCliError(
          "This viewer is not the live coordinator for the selected Run; it cannot send group messages.",
          "not_running",
        );
      }
      const receipt = await sendCoordinatorGroupMessage({
        runId,
        audience,
        subject,
        body,
        type,
        priority,
        from: live.coordinatorHandle,
      });
      // Journal the accepted enqueue receipt: the optimistic row renders the
      // send immediately (with audience + requested priority as provenance)
      // and `removeJournalMessageDuplicates` supersedes it once the durable
      // Orca row lands in the global inbox window.
      await recordActivity(
        createViewerActivity({
          runId,
          kind: type === "question" ? "question" : "status",
          title: type === "question" ? `Coordinator asked ${audience}` : `Coordinator messaged ${audience}`,
          summary: body,
          detail: subject === "Coordinator broadcast" ? null : `Subject: ${subject}`,
          audience,
          priority,
          // The enqueue receipt itself is the durable evidence this row
          // journals; the UI never re-interprets it as a read receipt.
          payload: receipt,
        }),
      );
      res.json({ ok: true, audience, type, priority, receipt });
    }),
  );

  /**
   * Explicit post-settlement worker release — the way a user resolves
   * release_unknown/close debt the coordinator refuses to guess its way out
   * of. `worker-release` takes no `--from`: ownership follows the Dispatch.
   */
  app.post(
    "/api/workers/:dispatchId/release",
    requireToken(policy),
    route(async (req, res) => {
      const dispatchId = validateId(req.params.dispatchId, "dispatch id");
      if (!dispatchId) {
        res.status(400).json({ error: "dispatch id required" });
        return;
      }
      await requireExecutionEnabled();
      const receipt = await terminalMutationWithLedger("worker-release", dispatchId, (requestId) =>
        releaseWorker(dispatchId, { retryRequestId: requestId }),
      );
      // Fold the receipt into the coordinator projection — a KNOWN terminal
      // state resolves the attempt + its debt; unknown/pending keeps them.
      noteManualRelease(dispatchId, receipt.state);
      const live = coordinatorStatus();
      if (live.runId) {
        await recordActivity(
          createViewerActivity({
            runId: live.runId,
            kind: "release",
            dispatchId,
            title: "Coordinator released a worker",
            summary: `Terminal ownership is ${receipt.state}.`,
            severity: receipt.state === "released" || receipt.state === "already_released" ? "success" : "warning",
          }),
        );
      }
      res.json({ ok: true, receipt });
    }),
  );

  /**
   * Explicit debug retention (the "keep this terminal for inspection" opt-out).
   */
  app.post(
    "/api/workers/:dispatchId/retain",
    requireToken(policy),
    route(async (req, res) => {
      const dispatchId = validateId(req.params.dispatchId, "dispatch id");
      if (!dispatchId) {
        res.status(400).json({ error: "dispatch id required" });
        return;
      }
      await requireExecutionEnabled();
      const receipt = await terminalMutationWithLedger("worker-retain", dispatchId, (requestId) =>
        retainWorker(dispatchId, { retryRequestId: requestId }),
      );
      noteManualRelease(dispatchId, receipt.state);
      const live = coordinatorStatus();
      if (live.runId) {
        await recordActivity(
          createViewerActivity({
            runId: live.runId,
            kind: "release",
            dispatchId,
            title: "Coordinator retained a worker",
            summary: "The terminal remains available for debugging.",
          }),
        );
      }
      res.json({ ok: true, receipt });
    }),
  );

  /**
   * Explicit safe retry (Phase 4): re-place ONE attempt that positively
   * failed — a failed-before-ready start (receipt on file) or a Dispatch Orca
   * reports failed/stopped. The coordinator refuses anything ambiguous
   * (unverifiable liveness, open cleanup debt, a live Dispatch) with 409
   * retry_not_allowed; the retry repeats harness/model/placement and carries
   * `--retry-of` lineage. Requires the live coordinator (the start mutation
   * needs its bound terminal).
   */
  app.post(
    "/api/workers/:id/retry",
    requireToken(policy),
    route(async (req, res) => {
      const id = validateId(req.params.id, "dispatch or task id");
      if (!id) {
        res.status(400).json({ error: "dispatch or task id required" });
        return;
      }
      await requireExecutionEnabled();
      const result = await retryWorker(id);
      const live = coordinatorStatus();
      if (live.runId) {
        await recordActivity(
          createViewerActivity({
            runId: live.runId,
            kind: "dispatch_started",
            taskId: result.taskId,
            dispatchId: result.dispatchId,
            title: "Coordinator retried a failed stage",
            summary: `Retry of ${result.retriedFrom ?? id}.`,
          }),
        );
      }
      res.json({ ok: true, ...result });
    }),
  );

  /** Resolve a decision gate (human approval) — a Run-scoped mutation. */
  app.post(
    "/api/gates/:id/resolve",
    requireToken(policy),
    route(async (req, res) => {
      const gateId = validateId(req.params.id, "gate id");
      const runId = validateId(req.body?.runId, "runId");
      // Resolutions are the option strings the gate was created with (usually
      // approved/rejected, but gates may define their own) — so charset/length
      // validation rather than a fixed enum.
      const resolution = validateText(req.body?.resolution, "resolution", 128);
      if (!gateId || !resolution || !runId) {
        res.status(400).json({ error: "resolution and runId required" });
        return;
      }
      // gate-resolve is a Run-scoped mutation (it needs the bound coordinator).
      await requireExecutionEnabled();
      await asCoordinator(runId, worktree, (from) => resolveGate(gateId, resolution, from));
      res.json({ ok: true });
    }),
  );

  // There is deliberately no reset route: `orca orchestration reset --tasks`
  // has no --run flag and wipes every local Run at once, so the viewer never
  // wires it up. Redrawing a graph means creating a fresh Run (POST /api/runs);
  // a POST to the retired reset path falls through to the unknown-route 404.

  /** Viewer config (harness choices, concurrency, layout, last Run). */
  app.get(
    "/api/config",
    route(async (_req, res) => {
      res.json(await loadConfig(workspaceDir));
    }),
  );

  app.put(
    "/api/config",
    requireToken(policy),
    route(async (req, res) => {
      // saveConfig's sanitizer stays deliberately lenient (it also reads
      // hand-edited files), but the *request* must at least be a plain object
      // with sane map shapes — reject garbage instead of silently storing it.
      const body = req.body;
      if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
        res.status(400).json({ error: "config body must be a JSON object", code: "invalid_input" });
        return;
      }
      validateTaskValueMap(
        body.harnessByTask,
        "harnessByTask",
        { maxKeys: 500, valueKind: "harness" },
        (v) => String(v),
      );
      validateTaskValueMap(
        body.modelByTask,
        "modelByTask",
        { maxKeys: 500, valueKind: "model" },
        (v) => String(v),
      );
      // Phase 5: effort values are charset-bound in the store too — pairing
      // with a model is enforced at run time (POST /api/run), not here, so a
      // hand-edited file's loose ends keep loading (backward compatibility).
      validateTaskValueMap(
        body.effortByTask,
        "effortByTask",
        { maxKeys: 500, valueKind: "effort" },
        (v) => validateEffort(v),
      );
      // Phase 6: environment selectors and placement specs are validated at
      // the same strictness as the run request — the store keeps viewer
      // PREFERENCES, and a malformed placement must 400 here rather than sit
      // in the file waiting to fail a future run.
      validateEnvironmentTaskMap(body.environmentByTask, "environmentByTask");
      validatePlacementTaskMap(body.placementByTask, "placementByTask");
      // One semantic lead Task per Run. It is presentation metadata rather
      // than an Orca mutation, but both sides of the map are still real Orca
      // ids and receive the same strict HTTP-boundary validation as Task maps.
      validateTaskValueMap(
        body.leadTaskByRun,
        "leadTaskByRun",
        { maxKeys: 500, valueKind: "task id" },
        (v) => {
          if (typeof v !== "string") {
            throw new ValidationError("leadTaskByRun task id must be a string");
          }
          const taskId = validateId(v, "leadTaskByRun task id");
          if (!taskId) throw new ValidationError("leadTaskByRun task id must not be empty");
          return taskId;
        },
      );
      res.json(await saveConfig(workspaceDir, body));
    }),
  );

  /**
   * Models available for a harness, for the node model picker.
   *
   * Only opencode actually has an enumerable list (`opencode models`). claude/
   * codex/cursor return an empty array here — their models have no programmatic
   * source, so the UI offers free-text input for them instead.
   */
  app.get(
    "/api/models/:harness",
    route(async (req, res) => {
      const harness = String(req.params.harness ?? "").trim().toLowerCase();
      res.json({ harness, models: await listModels(harness) });
    }),
  );

  // Unknown API routes answer JSON (not the SPA fallback) so a typo'd client
  // call fails loudly instead of rendering HTML into a JSON parser. Registered
  // BEFORE the static/SPA handlers below on purpose.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not found", code: "not_found" });
  });

  // --- Serve the built SPA -------------------------------------------------
  // Two sources, in priority order:
  //   1. assets embedded at `bun build --compile` time  → portable single binary
  //   2. a `web/dist` folder on disk                     → plain `npm run build && npm start`
  // In `npm run dev` neither is used: Vite serves the UI on :5173 and proxies /api.
  let servingUI = false;
  const embedded = opts.embeddedAssets;
  if (embedded && embedded.size > 0) {
    const indexHtml = embedded.get("index.html");
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
      const key = req.path.replace(/^\/+/, "") || "index.html";
      // Exact asset, else fall back to index.html for SPA client routes.
      const hit = embedded.get(key) ?? (extname(key) ? undefined : indexHtml);
      if (!hit) return next();
      res.setHeader("Content-Type", hit.type);
      res.setHeader("Cache-Control", key === "index.html" ? "no-cache" : "public, max-age=31536000, immutable");
      res.end(hit.body);
    });
    servingUI = true;
  } else {
    // Same depth contract as the esbuild bundle: this file lands at
    // <root>/dist/server/index.mjs when staged for npm (import.meta.url of the
    // BUNDLE, since app.ts is inlined into index.mjs), and at server/src/app.ts
    // in a checkout — "..",".." resolves onto <root>/web/dist in both.
    const here = dirname(fileURLToPath(import.meta.url));
    const distDir = join(here, "..", "..", "web", "dist");
    if (existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get("*", (_req, res) => res.sendFile(join(distDir, "index.html")));
      servingUI = true;
    }
  }

  return { app, servingUI };
}

/**
 * Bind the server loopback-only and resolve once listening.
 *
 * Explicit `127.0.0.1` is the point: Node's default binds every interface,
 * which would expose orchestration mutations (that fence real agent terminals)
 * to the whole LAN. Tests use port 0 and assert the resolved address.
 */
export function listenLoopback(app: express.Express, port: number): Promise<import("node:http").Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}
