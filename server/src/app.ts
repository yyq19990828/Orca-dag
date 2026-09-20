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
  listEnvironments,
  listGates,
  listModels,
  listProjects,
  listRepos,
  listRuns,
  listTasks,
  listTerminals,
  listWorkers,
  listWorktrees,
  parsePeerCapabilities,
  readWorkerOutput,
  releaseWorker,
  replyToMessage,
  resolveGate,
  retainWorker,
  runOrca,
  tasksToDag,
  type OrcaReadiness,
} from "./orca";
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
  requireToken,
  validateBooleanTaskMap,
  validateConcurrency,
  validateEffort,
  validateEnvironmentSelector,
  validateEnvironmentTaskMap,
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
        : code === "not_running" || code === "retry_not_allowed" || code === "retry_target_not_found"
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

export function createApp(opts: CreateAppOptions): { app: express.Express; servingUI: boolean } {
  const { workspaceDir, worktree, policy } = opts;
  const readiness = opts.readiness ?? checkReadiness;

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
   * Run/gate/reset controls render at all. On an Orca between 1.4.160 and
   * 1.4.204 this reports view-only with an upgrade pointer instead of letting
   * the user start a DAG that would fail mid-flight.
   */
  app.get(
    "/api/readiness",
    route(async (_req, res) => {
      res.json(await readiness());
    }),
  );

  /** Runs available to view. Tasks are Run-scoped since Orca 1.4.160. */
  app.get(
    "/api/runs",
    route(async (_req, res) => {
      res.json({ runs: await listRuns() });
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
        res.json({ run: await createRun(objective, handle) });
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
      const { nodes, edges } = tasksToDag(tasks);
      res.json({ runId, nodes, edges, gates, generatedAt: Date.now() });
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
      });
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
      const report = await stopCoordinator();
      res.json({ ok: true, clean: report.clean, results: report.results });
    }),
  );

  /** Live coordinator status (phase, attempts, inbox, cleanup debt). */
  app.get("/api/run-status", (_req, res) => {
    res.json(coordinatorStatus());
  });

  /**
   * Worker accounting for one Run (plan §7.2): normalized worker-list rows —
   * terminal state, liveness verdict, outcome. Read-only, token-free.
   */
  app.get(
    "/api/workers",
    route(async (req, res) => {
      const runId = validateId(req.query.run, "run");
      if (!runId) {
        res.status(400).json({ error: "run query parameter required", code: "run_required" });
        return;
      }
      res.json({ workers: await listWorkers(runId) });
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

  /**
   * The coordinator's pending questions/escalations plus its cleanup debt —
   * what InboxPanel renders. Read-only: the run-status route carries the same
   * data; this one exists so the panel can poll it without dragging the whole
   * attempt projection across the wire every 2s.
   */
  app.get("/api/inbox", (_req, res) => {
    const status = coordinatorStatus();
    res.json({ inbox: status.inbox, cleanupDebt: status.cleanupDebt, phase: status.phase });
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
        await answerInboxItem(messageId, body);
        res.json({ ok: true, via: "coordinator" });
        return;
      }
      await asCoordinator(runId, worktree, (from) => replyToMessage(messageId, body, from));
      res.json({ ok: true, via: "adhoc" });
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
      const receipt = await releaseWorker(dispatchId);
      // Fold the receipt into the coordinator projection — a KNOWN terminal
      // state resolves the attempt + its debt; unknown/pending keeps them.
      noteManualRelease(dispatchId, receipt.state);
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
      const receipt = await retainWorker(dispatchId);
      noteManualRelease(dispatchId, receipt.state);
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

  /**
   * Clear orchestration tasks.
   *
   * `orchestration reset` has NO `--run` flag: it wipes the whole local
   * orchestration database, every Run at once. That used to be "clear my graph"
   * back when tasks were global; it is now a much bigger hammer, so the caller
   * has to say so explicitly.
   */
  app.post(
    "/api/reset",
    requireToken(policy),
    route(async (req, res) => {
      if (req.body?.confirmAllRuns !== true) {
        res.status(400).json({
          error:
            "orca orchestration reset clears tasks in ALL local Runs — it has no --run scope. " +
            "Retry with confirmAllRuns: true to confirm.",
          code: "confirm_required",
        });
        return;
      }
      // Wiping tasks is as mutating as it gets — gated like the rest.
      await requireExecutionEnabled();
      await runOrca(["orchestration", "reset", "--tasks"]);
      res.json({ ok: true });
    }),
  );

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
