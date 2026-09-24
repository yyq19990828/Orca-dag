import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, isAbsolute, join, normalize } from "node:path";
import {
  OrcaCliError,
  RESPONSE_LOST,
  WORKTREE_ARCHIVE_HOOK_FAILED,
  abandonWorkerReceipt,
  bindRun,
  checkReadiness,
  closeTerminal,
  createRun,
  createTempCoordinatorTerminal,
  explainReadiness,
  focusTerminal,
  isArchiveHookFailure,
  listEnvironments,
  listGates,
  listModels,
  listProjects,
  listRepos,
  listRunMessages,
  listRunMessagePage,
  listRuns,
  listWorkspaceRuns,
  listTasks,
  listTerminals,
  listWorkers,
  listWorktrees,
  normalizeLiveness,
  describeRuntimeCapabilities,
  FLEET_CAPABILITY_GAP_REASONS,
  newRequestId,
  openWorkspaceChangedFiles,
  openWorkspaceFile,
  openWorkspaceFileDiff,
  parseWorkerDonePayload,
  parsePeerCapabilities,
  previewRunAudiences,
  readLocalRuntimeCapabilities,
  readWorkerOutput,
  releaseWorker,
  removeWorktree,
  replyToMessage,
  resolveGate,
  retainWorker,
  runOrca,
  sendCoordinatorGroupMessage,
  sendCoordinatorMessage,
  showRepo,
  showRun,
  showRequest,
  showWorktree,
  showWorkerDetail,
  stopWorkerReceipt,
  taskUpdate,
  tasksToDag,
  type OrcaRun,
  type OrcaReadiness,
  type OrcaWorktreeRow,
  type WorkspaceChangedMode,
  type WorktreeRemovalReceipt,
  type WorkerObservation,
} from "./orca";
import { buildRunHealth, type RunHealthView } from "./runHealth";
import { loadConfig, saveConfig } from "./config";
import {
  answerInboxItem,
  coordinatorStatus as liveCoordinatorStatus,
  noteManualRelease,
  retryWorker,
  startCoordinator,
  stopCoordinator,
} from "./coordinator";
import {
  assertDiscoveredWorktreeAudience,
  assertEnvironmentPlacementCompatibility,
  assertLanePlacementDisjoint,
  assertLaneReferences,
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
  validateLaneTaskMap,
  validateModel,
  validatePlacementTaskMap,
  validateSelector,
  validateTaskValueMap,
  validateText,
  validateWorktreeLaneMap,
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
import { ProviderSessionStore } from "./providerSessions";
import { LaunchHistory } from "./launchHistory";

/**
 * The Express app, extracted from index.ts so it can be constructed and tested
 * without binding a fixed port (and so the route surface has one reviewable
 * home). index.ts keeps only process concerns: subcommand dispatch, skill
 * installation, listening, and opening the browser.
 */

/** The coordinator's live status projection, as the app and lane routes see it. */
export type CoordinatorStatusSnapshot = ReturnType<typeof liveCoordinatorStatus>;

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
  /**
   * Coordinator status provider, injectable for tests. Defaults to the real
   * module singleton. The lane view and the lane-scoped review/removal
   * routes read lanes from THIS projection (lane identity is viewer-
   * coordinator state — Orca has no lane table), so tests inject a snapshot
   * with lanes the same way they inject `readiness`.
   */
  coordinatorStatus?: () => CoordinatorStatusSnapshot;
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
        : code === WORKTREE_ARCHIVE_HOOK_FAILED ||
            code === "abandon_refused" ||
            code === "focus_unavailable" ||
            code === "worktree_in_use" ||
            code === "main_worktree_protected" ||
            code === "current_workspace_protected"
          ? 409 // lifecycle/ownership refusals: the state forbids it, not the request shape
          : code === "not_running" ||
              code === "lane_not_found" ||
              code === "lane_not_settled" ||
              code === "lane_unverifiable" ||
              code === "active_dispatch_required" ||
              code === "dispatch_not_active" ||
              code === "inbox_item_not_found" ||
              code === "message_not_found" ||
              code === "retry_not_allowed" ||
              code === "retry_target_not_found" ||
              code === "session_binding_mismatch" ||
              code === "session_location_unverifiable" ||
              code === "session_location_mismatch" ||
              code === "resume_not_allowed"
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
  const live = liveCoordinatorStatus();
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

/**
 * Path containment for workspace file review (`file open` / `file diff`).
 *
 * Orca resolves the path against the SELECTED worktree (relative paths, or
 * absolute paths inside it) and does its own resolution inside the CLI. The
 * HTTP boundary still refuses everything that is never a legitimate
 * workspace file, so a hostile body cannot even name an outside target:
 *   - `..` segments in either separator convention (the classic traversal),
 *   - backslashes entirely (Windows-style separators have no meaning here and
 *     only ever appear in traversal attempts against a POSIX runtime),
 *   - control characters / NUL (argv and receipt corruption),
 *   - a leading `~` (home expansion is a shell concern this route never has),
 *   - Windows drive-letter forms (`C:/…` — a colon in the first segment).
 * Absolute POSIX paths pass through: the CLI confines them to the selected
 * worktree, and worktree-relative spellings are the common case.
 */
export function validateWorkspacePath(raw: unknown, field = "path"): string {
  const v = String(raw ?? "").trim();
  if (!v) {
    throw new ValidationError(`${field} must not be empty`, "invalid_path");
  }
  if (v.length > 1024) {
    throw new ValidationError(`${field} is too long (max 1024 characters)`, "invalid_path");
  }
  if (v.includes("\\")) {
    throw new ValidationError(
      `${field} must use "/" separators — a backslash is never part of a workspace path`,
      "invalid_path",
    );
  }
  if (v.split("/").includes("..")) {
    throw new ValidationError(
      `${field} must stay inside the selected worktree — ".." segments are refused`,
      "invalid_path",
    );
  }
  if (v.startsWith("~")) {
    throw new ValidationError(`${field} must not start with "~"`, "invalid_path");
  }
  if (/^[A-Za-z]:/.test(v)) {
    throw new ValidationError(`${field} must not be a drive-letter path`, "invalid_path");
  }
  for (const ch of v) {
    if (ch < " " || ch === "\u007f") {
      throw new ValidationError(
        `${field} contains a control character`,
        "invalid_path",
      );
    }
  }
  return v;
}

/**
 * First present string field of a verbatim CLI receipt (worktree rm results
 * are passthrough records whose optional state/reason spellings vary by
 * runtime) — used to echo honest removal facts back to the UI without
 * re-interpreting the receipt.
 */
function pickReceiptString(raw: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = raw?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * Removal preconditions for one freshly-discovered worktree row — the pure
 * core of POST /api/worktrees/remove, factored out so every refusal branch is
 * testable without a CLI. `ownedSelectors` names the workspaces this viewer
 * itself occupies (the coordinator/worker workspace spellings); `activeSelectors`
 * names workspaces the live coordinator currently works (unsettled attempts +
 * non-settled lanes). A row that fails no precondition returns void; anything
 * else throws the exact 409 code the route maps.
 */
export function assertWorktreeRemovalPreconditions(
  row: OrcaWorktreeRow,
  selector: string,
  opts: {
    ownedSelectors: Iterable<string>;
    activeSelectors: Iterable<string>;
  },
): void {
  // The main worktree IS the checkout: removing it would destroy the user's
  // primary copy, not a disposable lane workspace.
  if (row.isMainWorktree === true) {
    throw new OrcaCliError(
      `${selector} is a repository's main worktree — the viewer removes only secondary workspaces.`,
      "main_worktree_protected",
    );
  }
  for (const owned of opts.ownedSelectors) {
    if (owned && owned === selector) {
      throw new OrcaCliError(
        `${selector} is this viewer's own workspace — removal would pull the coordinator out from under the Run.`,
        "current_workspace_protected",
      );
    }
  }
  for (const active of opts.activeSelectors) {
    if (active && active === selector) {
      throw new OrcaCliError(
        `${selector} hosts an active worker or an unsettled lane of this viewer's coordinator — stop them first.`,
        "worktree_in_use",
      );
    }
  }
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
  // This store is only a binding of identities. Orca's worker-list remains the
  // authority for Dispatch scope and lifecycle; provider observations cannot
  // settle a Task or grant coordinator authority.
  const providerSessions = new ProviderSessionStore(workspaceDir);
  const launchHistory = new LaunchHistory(workspaceDir);
  // worker-list has no startOptions on Orca 1.4.207. Share the one-time
  // worker-show read across overlapping 2s polls; failed/empty reads may be
  // retried later if a remote peer reconnects. GET stays read-only: only the
  // coordinator's successful launch path writes local history.
  const launchLookups = new Map<string, {
    at: number;
    value: Promise<{ agent: string } | null>;
    confirmed: boolean;
  }>();

  // The status provider, resolved once: the live module singleton by default,
  // an injected snapshot under test (same pattern as `readiness` above).
  const coordinatorStatus = opts.coordinatorStatus ?? liveCoordinatorStatus;

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
   * Run a one-off terminal mutation (release/retain/stop/abandon) under a
   * durable, ledger-recorded request id (Phase 5). Run/Task scope is recorded
   * ONLY from positive evidence — either the caller's fresh pre-action
   * `worker-show` receipt (stop/abandon/focus re-read it immediately before
   * acting) or this viewer's own coordinator projection — anything else stays
   * unscoped ("scope unknown") rather than being mis-attributed to whatever
   * Run happens to be open. The mint record lands BEFORE the CLI call, so
   * even a lost response leaves the id inspectable via `request-show`.
   * Returns the requestId so the route can journal it onto the Activity row
   * (the durable request identity of that mutation).
   */
  const terminalMutationWithLedger = async <
    T extends { state: string },
  >(
    operation: "worker-release" | "worker-retain" | "worker-stop" | "worker-abandon",
    dispatchId: string,
    run: (requestId: string) => Promise<T>,
    evidence?: { runId: string | null; taskId: string | null },
  ): Promise<{ requestId: string; receipt: T & { requestId: string } }> => {
    let runId = evidence?.runId ?? null;
    let taskId = evidence?.taskId ?? null;
    if (!evidence) {
      const live = coordinatorStatus();
      const attempt =
        live.running && live.runId
          ? live.attempts.find((a) => a.dispatchId === dispatchId)
          : undefined;
      runId = attempt ? live.runId : null;
      taskId = attempt?.taskId ?? null;
    }
    const requestId = newRequestId();
    await requestLedger
      .record({ requestId, operation, runId, taskId, dispatchId })
      .catch(() => {});
    try {
      const receipt = await run(requestId);
      // A resolved receipt is a definitive viewer observation. The one
      // exception is release/retain's `release_unknown` state, which means
      // Orca itself could not decide — the debt stays open in that case.
      const settledLocally =
        receipt.state === "release_unknown" ? false : true;
      await requestLedger
        .record({
          requestId,
          operation,
          runId,
          taskId,
          dispatchId,
          settledLocally,
          // The stop note mirrors stopCoordinator's format exactly: the
          // resume path (`resumeStoppedDispatchIds`) admits only dispatches
          // with a positively-observed `stopped` state, whichever surface
          // performed the stop.
          note:
            operation === "worker-stop"
              ? `viewer-observed stop state: ${receipt.state}`
              : `viewer-observed terminal state: ${receipt.state}`,
        })
        .catch(() => {});
      return {
        requestId,
        // The receipt ECHOES the durable id: current runtimes replay the
        // `--retry-request` value back, and the viewer guarantees that echo
        // even when an older receipt omits it — the id a client (or a human)
        // cites for request-show recovery is always visible where the
        // receipt is.
        receipt: { ...receipt, requestId },
      };
    } catch (err) {
      const lost = err instanceof OrcaCliError && err.code === RESPONSE_LOST;
      await requestLedger
        .record({
          requestId,
          operation,
          runId,
          taskId,
          dispatchId,
          // A lost response is precisely NOT settled locally — the ledger
          // keeps the id inspectable via `request-show` instead of guessing.
          settledLocally: false,
          note: lost
            ? "response lost; resolve with request-show / --retry-request"
            : `mutation failed: ${String((err as Error)?.message ?? err)}`,
        })
        .catch(() => {});
      // Carry the minted id on the error untouched (the error itself still
      // flows to fail() unchanged) so the route can point the client at the
      // `request-show` probe for exactly this attempt.
      try {
        (err as { requestId?: string }).requestId = requestId;
      } catch {
        /* a frozen error still throws unchanged */
      }
      throw err;
    }
  };

  /**
   * The same durable-identity discipline for mutations Orca does NOT run
   * under a `--retry-request` id (worktree removal, terminal focus, file
   * review opens): mint a viewer-side request id, record it with the exact
   * target BEFORE the CLI call, and close the row with the verbatim receipt
   * outcome afterwards. Orca receipt semantics are preserved by storing what
   * the receipt SAID (bounded, one line) — never a re-interpretation of it;
   * the response still carries the full receipt verbatim.
   */
  const viewerMutationWithLedger = async <T>(
    operation: "worktree-remove" | "terminal-focus" | "file-open" | "file-diff" | "file-open-changed",
    target: string,
    run: (requestId: string) => Promise<T>,
    describe: (receipt: T) => { settled: boolean; note: string },
    scope?: { runId: string | null; taskId?: string | null; dispatchId?: string | null },
  ): Promise<{ requestId: string; receipt: T }> => {
    const requestId = newRequestId();
    await requestLedger
      .record({
        requestId,
        operation,
        runId: scope?.runId ?? null,
        taskId: scope?.taskId ?? null,
        dispatchId: scope?.dispatchId ?? null,
        target,
      })
      .catch(() => {});
    try {
      const receipt = await run(requestId);
      const { settled, note } = describe(receipt);
      await requestLedger
        .record({
          requestId,
          operation,
          runId: scope?.runId ?? null,
          taskId: scope?.taskId ?? null,
          dispatchId: scope?.dispatchId ?? null,
          target,
          settledLocally: settled,
          note,
        })
        .catch(() => {});
      return { requestId, receipt };
    } catch (err) {
      await requestLedger
        .record({
          requestId,
          operation,
          runId: scope?.runId ?? null,
          taskId: scope?.taskId ?? null,
          dispatchId: scope?.dispatchId ?? null,
          target,
          settledLocally: false,
          // An archive-hook block is not a generic mutation failure: the note
          // carries the stable "archive hook failed" marker (plus the verbatim
          // CLI message) because this row is the durable waiver evidence a
          // later `allowFailedArchiveHook` attempt must cite — and nothing
          // else may ever match that marker.
          note: isArchiveHookFailure(err)
            ? `archive hook failed — removal blocked, nothing was removed (${String((err as Error)?.message ?? err)})`
            : `mutation failed: ${String((err as Error)?.message ?? err)}`,
        })
        .catch(() => {});
      try {
        (err as { requestId?: string }).requestId = requestId;
      } catch {
        /* a frozen error still throws unchanged */
      }
      throw err;
    }
  };

  /**
   * The Run scope a workspace-level mutation (lane worktree removal) can be
   * POSITIVELY journaled under: only when this viewer's live coordinator has
   * a lane whose adopted selector is the one being mutated. Anything else
   * leaves the journal row out entirely — Activity is Run-scoped, and no
   * scope is invented from the request body alone.
   */
  const laneRunScopeFor = (
    selector: string,
    status: CoordinatorStatusSnapshot,
  ): string | null => {
    if (!status.running || !status.runId) return null;
    return status.worktreeLanes.some((lane) => lane.selector === selector)
      ? status.runId
      : null;
  };

  /**
   * The pre-action evidence re-read every one-Dispatch lifecycle mutation
   * runs IMMEDIATELY before acting (never a cached row): one fresh
   * `worker-show` carries all four facts at once — liveness, agent-wait,
   * workspace identity (terminal facts), and ownership (the durable runId).
   * A missing Dispatch or one whose durable Run scope does not match the
   * requested Run is refused here, before any mutation can be minted.
   */
  const revalidateWorkerForMutation = async (
    dispatchId: string,
    runId: string,
  ): Promise<
    | { ok: true; detail: Awaited<ReturnType<typeof showWorkerDetail>> & object }
    | { ok: false; status: 404; body: { error: string; code: string } }
  > => {
    const detail = await showWorkerDetail(dispatchId);
    if (!detail) {
      return {
        ok: false,
        status: 404,
        body: { error: "no such worker dispatch", code: "worker_not_found" },
      };
    }
    if (!detail.runId || detail.runId !== runId) {
      return {
        ok: false,
        status: 404,
        body: {
          error: "worker belongs to a different Run",
          code: "worker_run_mismatch",
        },
      };
    }
    return { ok: true, detail };
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

  // --- Approved local worktree/repo discovery --------------------------------
  //
  // The LOCAL-server counterparts of the per-environment routes above (no
  // --environment flag: these list the zero-configuration local server, which
  // is exactly what placement pickers and removal targets need). "Approved"
  // is the operative property: rows come only from Orca's own discovery —
  // the UI never offers, and no route ever accepts, a workspace Orca did not
  // name itself. Read-only and token-free like every discovery read.

  /**
   * A discovery read fails LOUDLY: the surfaced message leads with the
   * adapter's own classification (`response_lost: …`), so a client can tell
   * "Orca is unreachable" apart from "the list is empty" — an empty list
   * would render as "no other workspace exists" and invite a bogus creation.
   */
  const discoveryRead = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (err) {
      const code = err instanceof OrcaCliError && typeof err.code === "string" ? err.code : "discovery_failed";
      throw new OrcaCliError(`${code}: ${String((err as Error)?.message ?? err)}`, code);
    }
  };

  /** Exact workspaces on the local server (`worktree list`, no environment). */
  app.get(
    "/api/worktrees",
    route(async (_req, res) => {
      res.json({ worktrees: await discoveryRead(() => listWorktrees()) });
    }),
  );

  /** Repositories registered on the local server (`repo list`, no environment). */
  app.get(
    "/api/repos",
    route(async (_req, res) => {
      res.json({ repos: await discoveryRead(() => listRepos()) });
    }),
  );

  /**
   * One worktree by its EXACT selector (`worktree show`) — the same
   * identity-revalidation read the removal route runs, exposed so the UI can
   * display the durable identity (id / branch / host) before offering any
   * action on it. 404 only on Orca's own definite absence; a transport
   * failure propagates (unverifiable is never rendered as "missing").
   */
  app.get(
    "/api/worktrees/:worktreeId",
    route(async (req, res) => {
      const selector = validateSelector(req.params.worktreeId, "worktree");
      const row = await showWorktree(selector);
      if (!row) {
        res.status(404).json({ error: "no such worktree", code: "worktree_not_found" });
        return;
      }
      res.json({ worktree: row });
    }),
  );

  /**
   * Cursor-paged Run lookup — ONE raw `run-list` page, verbatim.
   *
   * `GET /api/runs` (below) remains the fully-materialized, workspace-scoped
   * picker feed; this route is the paging primitive for surfaces that want to
   * walk the registry without the unbounded sweep. The opaque `nextCursor` is
   * passed through byte-for-byte (null = last page), so pagination semantics
   * stay exactly Orca's own — a stale cursor surfaces whatever the runtime
   * does with it, never a synthesized empty page.
   *
   * Run records carry no workspace field, so each row is annotated with the
   * CHEAP local evidence only (this process created it / the workspace
   * config names it); exact workspace ownership needs the task-creator
   * marker and lives on `GET /api/runs/:runId`.
   */
  app.get(
    "/api/runs/page",
    route(async (req, res) => {
      const cursor = validateText(req.query.cursor, "cursor", 512);
      const configuredRunId = (await loadConfig(workspaceDir)).runId;
      // listRuns() follows every page internally; for one HTTP page we ask
      // the CLI directly through the same adapter contract (limit 100, the
      // runtime's documented ceiling) so the cursor stays honest.
      const args = ["orchestration", "run-list", "--limit", "100"];
      if (cursor) args.push("--cursor", cursor);
      const receipt = await runOrca<{ runs?: unknown; nextCursor?: unknown }>(args);
      if (!Array.isArray(receipt.runs)) {
        throw new OrcaCliError("run-list returned an invalid receipt: runs must be an array", "invalid_pagination");
      }
      const rawNext = receipt.nextCursor;
      const nextCursor =
        typeof rawNext === "string" && rawNext.length > 0 ? rawNext : null;
      const runs = (receipt.runs as OrcaRun[])
        .filter((r) => r && typeof r.id === "string" && r.legacy !== 1);
      res.json({
        runs: runs.map((run) => ({
          ...run,
          viewerCreated: viewerCreatedRunIds.has(run.id),
          configured: configuredRunId === run.id,
        })),
        nextCursor,
      });
    }),
  );

  /**
   * Exact Run lookup (`run-show --id`) with the workspace-ownership evidence
   * the picker only approximates. 404 `run_not_found` ONLY on Orca's own
   * definite absence — a transport failure propagates, because "unreachable"
   * must never masquerade as "no such Run" (the caller would treat that as an
   * ownership dead-end). Ownership is positive-evidence: a Task created by a
   * process in THIS workspace (`::${workspaceDir}@@` marker), this process
   * having created the Run, or the workspace config naming it. A Run with no
   * local evidence reads `owned: false` — visible, but flagged foreign —
   * never silently relabeled as ours.
   */
  app.get(
    "/api/runs/:runId",
    route(async (req, res) => {
      const runId = validateId(req.params.runId, "run id");
      if (!runId) {
        res.status(400).json({ error: "run id required" });
        return;
      }
      const run = await showRun(runId);
      if (!run) {
        res.status(404).json({ error: "no such run", code: "run_not_found" });
        return;
      }
      const configuredRunId = (await loadConfig(workspaceDir)).runId;
      const marker = `::${workspaceDir}@@`;
      let taskEvidence: "creator_marker" | "none" | "unreadable" = "none";
      try {
        const tasks = await listTasks(runId, { brief: true });
        taskEvidence = tasks.some(
          (task) =>
            typeof task.created_by_process_incarnation === "string" &&
            task.created_by_process_incarnation.includes(marker),
        )
          ? "creator_marker"
          : tasks.length > 0
            ? "none"
            : // An empty Run has no tasks to prove anything — the explicit
              // inclusions below are the only local evidence available.
              "none";
      } catch {
        taskEvidence = "unreadable";
      }
      const owned =
        taskEvidence === "creator_marker" ||
        viewerCreatedRunIds.has(runId) ||
        configuredRunId === runId;
      res.json({
        run,
        workspace: {
          // True only on positive evidence; an unreadable Task read keeps
          // ownership UNKNOWN (false here, with the reason spelled out).
          owned,
          evidence:
            taskEvidence === "creator_marker"
              ? "task creator marker"
              : viewerCreatedRunIds.has(runId)
                ? "created by this viewer"
                : configuredRunId === runId
                  ? "named in workspace config"
                  : taskEvidence === "unreadable"
                    ? "task evidence unreadable"
                    : "no task in this Run was created from this workspace",
        },
      });
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
      const resumeInput = req.body?.resumeBlocked;
      let resumeBlocked: { dispatchId: string; allowUnknownProvider: boolean } | undefined;
      if (resumeInput !== undefined) {
        if (!resumeInput || typeof resumeInput !== "object" || Array.isArray(resumeInput) ||
            Object.keys(resumeInput).some((key) => key !== "dispatchId" && key !== "allowUnknownProvider") ||
            typeof resumeInput.allowUnknownProvider !== "boolean") {
          throw new ValidationError("resumeBlocked requires an exact dispatchId and explicit provider decision");
        }
        const dispatchId = validateId(resumeInput.dispatchId, "dispatchId");
        if (!dispatchId) throw new ValidationError("resumeBlocked.dispatchId is required");
        resumeBlocked = { dispatchId, allowUnknownProvider: resumeInput.allowUnknownProvider };
      }
      if (resumeBlocked && liveCoordinatorStatus().running) {
        throw new OrcaCliError("Stop the current viewer coordinator before retrying a blocked Stage.", "resume_not_allowed");
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
      // Workspace lanes (worktree-lanes epic): the full lane shapes are
      // validated here with the same strictness as placement, plus the two
      // semantic cross-checks — every laneByTask reference must name a
      // declared lane, and a task is placed directly OR by its lane, never
      // both. Whether a lane's seed workspace really exists is checked at
      // start time (exact-selector revalidation in the coordinator), exactly
      // like environment existence.
      const worktreeLanes = validateWorktreeLaneMap(req.body?.worktreeLanes, "worktreeLanes");
      const laneByTask = validateLaneTaskMap(req.body?.laneByTask, "laneByTask");
      assertLaneReferences(laneByTask, worktreeLanes);
      assertLanePlacementDisjoint(placementByTask, laneByTask);
      assertEnvironmentPlacementCompatibility(environmentByTask, placementByTask);
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
      const resumeStoppedDispatchIds = (resumeBlocked ? [] : await requestLedger.list().catch(() => []))
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
        worktreeLanes: worktreeLanes ?? undefined,
        laneByTask: laneByTask ?? undefined,
        resumeStoppedDispatchIds,
        resumeBlocked,
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
   * A provider session is a SECOND identity attached to an Orca Dispatch.
   * Binding it never changes the Dispatch or Task. Resolve all scope fields
   * from Orca's remote-inclusive accounting; a browser-supplied workspace or
   * host would let one session be mistaken for work on another server.
   */
  const exactSessionScope = async (runId: string, taskId: string, dispatchId: string) => {
    const [tasks, workers] = await Promise.all([
      listTasks(runId),
      listWorkers(runId, { includeRemote: true }),
    ]);
    const task = tasks.find((candidate) => candidate.id === taskId && candidate.run_id === runId);
    const row = workers.find((candidate) =>
      candidate.runId === runId &&
      candidate.taskId === taskId &&
      candidate.dispatchId === dispatchId
    );
    if (!task || !row) {
      throw new OrcaCliError(
        "The Run, Task and Dispatch binding was not found together in Orca's worker history.",
        "session_binding_mismatch",
      );
    }
    // Fleet snapshots in Orca 1.4.207 represent workspace as
    // `{ kind, id }`, not an absolute path. Only accept a path directly or
    // use the exact worker terminal's reported worktreePath below; passing the
    // object to `isAbsolute` throws before a session can be bound.
    let workspace = typeof row.projection?.workspace === "string"
      ? row.projection.workspace
      : null;
    let host = row.projection?.host
      ? `${row.projection.host.kind}:${row.projection.host.id}`
      : null;
    if (!workspace || !isAbsolute(workspace) || !host) {
      // Older or legacy rows may not have a fleet projection. worker-show can
      // still provide the exact terminal's execution location; a non-exact
      // observation cannot establish a session's workspace after pane reuse.
      const detail = await showWorkerDetail(dispatchId).catch(() => null);
      if (detail?.runId === runId && detail.taskId === taskId && detail.observation?.exactWorker === true) {
        if (!workspace || !isAbsolute(workspace)) workspace = detail.terminal?.worktreePath ?? null;
        if (!host) {
          const observedHost = detail.terminal?.executionHostId ?? null;
          host = observedHost === "local" ? "local:local" : observedHost;
        }
      }
    }
    if (!workspace || !isAbsolute(workspace) || !host) {
      throw new OrcaCliError(
        "Orca has not reported the exact workspace and execution host for this Dispatch; session binding is held until that evidence is available.",
        "session_location_unverifiable",
      );
    }
    return { row, workspace: normalize(workspace), host };
  };

  /** Workspace-local bindings are listed without querying provider processes. */
  app.get(
    "/api/session-bindings",
    route(async (req, res) => {
      const runId = validateId(req.query.run, "run");
      if (!runId) {
        res.status(400).json({ error: "run query parameter required", code: "run_required" });
        return;
      }
      res.json({ bindings: await providerSessions.list(runId) });
    }),
  );

  /** Attach a known exact harness session to one already-recorded Dispatch. */
  app.put(
    "/api/session-bindings/:dispatchId",
    requireToken(policy),
    route(async (req, res) => {
      const runId = validateId(req.body?.runId, "runId");
      const taskId = validateId(req.body?.taskId, "taskId");
      const dispatchId = validateId(req.params.dispatchId, "dispatch id");
      const harness = validateText(req.body?.harness, "harness", 32);
      const sessionId = validateText(req.body?.sessionId, "sessionId", 256);
      if (!runId || !taskId || !dispatchId || !sessionId ||
          (harness !== "claude" && harness !== "codex" && harness !== "opencode")) {
        throw new ValidationError("runId, taskId, dispatchId, supported harness, and exact sessionId are required");
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(sessionId)) {
        throw new ValidationError("sessionId must be one provider-issued token without whitespace");
      }
      const { row, workspace, host } = await exactSessionScope(runId, taskId, dispatchId);
      const observedHarness = row.projection?.provider?.id ?? row.projection?.launch?.agent ?? null;
      if (observedHarness && ["claude", "codex", "opencode"].includes(observedHarness) &&
          observedHarness !== harness) {
        throw new OrcaCliError("The selected harness disagrees with Orca's Dispatch record.", "session_binding_mismatch");
      }
      const proposed = {
        runId, taskId, dispatchId, harness, sessionId, workspace, host, source: "manual",
      } as const;
      const existing = await providerSessions.get({ runId, taskId, dispatchId });
      if (existing && (
        existing.harness !== harness || existing.sessionId !== sessionId ||
        existing.workspace !== workspace || existing.host !== host
      )) {
        throw new OrcaCliError(
          "This Dispatch is already bound to another provider identity; a verified handoff is required before changing it.",
          "session_binding_mismatch",
        );
      }
      const binding = await providerSessions.bind(proposed);
      res.json({ binding });
    }),
  );

  /** Probe only a previously bound exact session, on demand. */
  app.post(
    "/api/session-bindings/:dispatchId/probe",
    requireToken(policy),
    route(async (req, res) => {
      const runId = validateId(req.body?.runId, "runId");
      const dispatchId = validateId(req.params.dispatchId, "dispatch id");
      if (!runId || !dispatchId) throw new ValidationError("runId and dispatchId are required");
      const binding = (await providerSessions.list(runId)).find((entry) => entry.dispatchId === dispatchId);
      if (!binding) {
        res.status(404).json({ error: "no session binding for this Dispatch", code: "session_binding_not_found" });
        return;
      }
      const { workspace, host } = await exactSessionScope(runId, binding.taskId, dispatchId);
      if (binding.workspace !== workspace || binding.host !== host) {
        throw new OrcaCliError(
          "The Dispatch execution location changed since its session was bound; probe refused.",
          "session_location_mismatch",
        );
      }
      res.json({ observation: await providerSessions.probe(binding) });
    }),
  );

  /**
   * An abandoned Dispatch cannot send worker_done after its capability was
   * revoked. Let the operator record an independently reviewed result on the
   * blocked Task, without inventing a successful Dispatch or replaying work.
   * Re-read Orca's Task, fleet, gate and provider evidence at the mutation
   * boundary: old viewer projections and a closed terminal are insufficient.
   */
  app.post(
    "/api/workers/:dispatchId/resolve-blocked",
    requireToken(policy),
    route(async (req, res) => {
      await requireExecutionEnabled();
      const runId = validateId(req.body?.runId, "runId");
      const dispatchId = validateId(req.params.dispatchId, "dispatchId");
      const result = validateText(req.body?.result, "result", 2000);
      if (!runId || !dispatchId || !result || result.trim().length < 8 ||
          req.body?.acknowledgeUnknownProvider !== true) {
        throw new ValidationError("runId, reviewed result, and explicit provider-risk acknowledgement are required");
      }
      const live = liveCoordinatorStatus();
      if (live.running) {
        throw new OrcaCliError("Stop the viewer coordinator before manually resolving a blocked Stage.", "resume_not_allowed");
      }
      const [tasks, rows, gates, bindings] = await Promise.all([
        listTasks(runId),
        listWorkers(runId, { includeRemote: true }),
        listGates(runId),
        providerSessions.list(runId),
      ]);
      const row = rows.find((item) => item.runId === runId && item.dispatchId === dispatchId);
      const task = tasks.find((item) => item.id === row?.taskId && item.run_id === runId);
      if (!row || !task || task.status !== "blocked" ||
          row.dispatchStatus !== "failed" || row.projection?.liveness?.verdict !== "exited" ||
          rows.some((item) => item.taskId === task.id && item.dispatchStatus === "dispatched") ||
          gates.some((gate) => gate.taskId === task.id && gate.status === "pending")) {
        throw new OrcaCliError("The selected Stage is not a settled, gate-free blocked Task.", "resume_not_allowed");
      }
      const detail = await showWorkerDetail(dispatchId);
      const selectedAt = Date.parse(detail?.dispatch?.dispatchedAt ?? "");
      const siblingDetails = await Promise.all(
        rows.filter((item) => item.taskId === task.id && item.dispatchId !== dispatchId)
          .map((item) => showWorkerDetail(item.dispatchId)),
      );
      if (detail?.runId !== runId || detail.taskId !== task.id ||
          !Number.isFinite(selectedAt) || siblingDetails.some((sibling) =>
            !sibling?.dispatch?.dispatchedAt ||
            !Number.isFinite(Date.parse(sibling.dispatch.dispatchedAt)) ||
            Date.parse(sibling.dispatch.dispatchedAt) >= selectedAt
          )) {
        throw new OrcaCliError("A newer or unverifiable Dispatch exists for this Stage.", "resume_not_allowed");
      }
      const binding = bindings.find((item) => item.dispatchId === dispatchId && item.taskId === task.id);
      if (binding) {
        const observation = await providerSessions.probe(binding);
        if (observation.status === "active" || observation.status === "idle") {
          throw new OrcaCliError("The exact provider session is still active or idle; resolve its work first.", "resume_not_allowed");
        }
      }
      // The Task is the durable DAG status. The historical Dispatch remains
      // failed in Orca's accounting; the activity entry names the human action.
      await asCoordinator(runId, worktree, (from) =>
        taskUpdate(task.id, "completed", runId, from, JSON.stringify(result.trim())),
      );
      await recordActivity(createViewerActivity({
        runId,
        kind: "recovery",
        title: "Blocked Stage completed by operator",
        summary: `Reviewed result recorded for ${task.id}; historical Dispatch ${dispatchId} remains failed.`,
        taskId: task.id,
        dispatchId,
      })).catch(() => {
        // Activity is explanatory history, not the task-update receipt. A
        // journal write failure must not turn a completed Task into HTTP 500.
      });
      res.json({ taskId: task.id, dispatchId, status: "completed" });
    }),
  );

  /**
   * Run-scoped workspace-lane view (worktree-lanes epic). The coordinator's
   * lane projection (`worktreeLanes` in its status) is derived fresh from the
   * attempt map on every read, so this never shows a stale lifecycle — but it
   * only exists while THIS viewer coordinates a Run, and it must never leak
   * across the Run boundary: a lane view for any other Run is an empty answer
   * with `running: false`, not the live coordinator's lanes. Exact workspace
   * identity inside each lane is positive Orca evidence only (see
   * `WorktreeLaneIdentitySource`) — absence renders as warnings, never as a
   * reconstructed selector. This is the read half of the spec's
   * `/api/worktree-lanes` operator API; the action halves below are
   * lane-scoped so the UI never has to know how a lane maps to a selector.
   */
  app.get(
    "/api/worktree-lanes",
    route(async (req, res) => {
      const runId = validateId(req.query.run, "run");
      if (!runId) {
        res.status(400).json({ error: "run query parameter required", code: "run_required" });
        return;
      }
      const status = coordinatorStatus();
      const scoped = status.running && status.runId === runId;
      res.json({
        runId,
        running: scoped,
        lanes: scoped ? status.worktreeLanes : [],
      });
    }),
  );

  /**
   * Lane resolution shared by the two lane actions below. A lane exists only
   * while THIS viewer coordinates a Run (Orca has no lane table — the
   * projection is coordinator state), so a missing/unscoped coordinator is a
   * `not_running` refusal, never an empty answer: an action needs the same
   * live identity a view may honestly lack.
   */
  const requireLiveLane = (
    laneId: string | null,
  ): { status: CoordinatorStatusSnapshot; runId: string; lane: CoordinatorStatusSnapshot["worktreeLanes"][number] } => {
    if (!laneId) {
      throw new ValidationError("lane id required", "invalid_input");
    }
    const status = coordinatorStatus();
    if (!status.running || !status.runId) {
      throw new OrcaCliError(
        "Coordinator is not running — workspace lanes exist only while this viewer coordinates a Run.",
        "not_running",
      );
    }
    const lane = status.worktreeLanes.find((candidate) => candidate.laneId === laneId);
    if (!lane) {
      throw new OrcaCliError(
        `No lane ${laneId} is tracked for the live Run ${status.runId}.`,
        "lane_not_found",
      );
    }
    return { status, runId: status.runId, lane };
  };

  /**
   * The lane's workspace selector for a review open — positive Orca evidence
   * only. An adopted `selector` is used verbatim; when only the workspace
   * PATH was positively observed, `path:<abs>` is Orca's own exact selector
   * spelling (the same form WORKSPACE_DIR resolves to), NOT the forbidden
   * reconstruction: that rule guards lane identity ADOPTION for worker
   * placement (never start a worker on a name/branch/path guess), while a
   * review open is a read-only Orca navigation into a workspace Orca itself
   * reported — and Orca re-validates the exact workspace before opening.
   * A lane with neither fact is refused: unverifiable authorizes nothing.
   */
  const laneReviewSelector = (lane: CoordinatorStatusSnapshot["worktreeLanes"][number]): string => {
    if (lane.selector) return lane.selector;
    if (lane.path) return `path:${lane.path}`;
    throw new OrcaCliError(
      `Lane ${lane.laneId} has no positively identified workspace — nothing will be opened in a guessed one.`,
      "lane_unverifiable",
    );
  };

  /**
   * Review one lane's workspace through Orca (spec operator API): open its
   * changed files (`mode: "files"` → adapter `edit`) or its diff (`mode:
   * "diff"`). The UI verbs are mapped HERE so the adapter's closed union is
   * the only spelling that ever reaches argv. Ledger + activity ride the same
   * discipline as the workspace-scoped review route.
   */
  app.post(
    "/api/worktree-lanes/:laneId/open-changed",
    requireToken(policy),
    route(async (req, res) => {
      const laneId = validateId(req.params.laneId, "lane id");
      const modeRaw = validateText(req.body?.mode, "mode", 8);
      if (modeRaw !== "files" && modeRaw !== "diff") {
        throw new ValidationError(
          `mode must be "files" or "diff" (got ${JSON.stringify(modeRaw)})`,
          "invalid_mode",
        );
      }
      const mode: WorkspaceChangedMode = modeRaw === "diff" ? "diff" : "edit";
      const { runId, lane } = requireLiveLane(laneId);
      const selector = validateSelector(laneReviewSelector(lane), "selector");
      const { requestId, receipt } = await viewerMutationWithLedger(
        "file-open-changed",
        selector,
        () => openWorkspaceChangedFiles({ mode, worktree: selector }),
        () => ({ settled: true, note: `opened changed files (mode: ${mode})` }),
        { runId },
      );
      await recordActivity(
        createViewerActivity({
          runId,
          kind: "file_review",
          title: `Opened the lane's ${modeRaw === "diff" ? "diff" : "changed files"}`,
          summary: `Lane ${laneId} → ${selector} (mode: ${mode}).`,
          requestId,
        }),
      );
      res.json({ ok: true, requestId, receipt: { laneId, workspace: selector, note: null, requestId } });
    }),
  );

  /**
   * Remove one settled lane's worktree through `orca worktree rm` (spec
   * operator API). Gates, in order, before anything is minted: live
   * coordinator + known lane → settled ownership → positive selector → the
   * typed confirmation, compared SERVER-side against the token recomputed
   * from the same positive evidence (the UI prompt is a courtesy copy, the
   * server is the authority) → then the SHARED removal core below, which is
   * the exact gate stack the workspace-scoped route runs (execution gate,
   * owned-workspace refusal, fresh Orca discovery, main/active protections).
   */
  app.post(
    "/api/worktree-lanes/:laneId/remove",
    requireToken(policy),
    route(async (req, res) => {
      const laneId = validateId(req.params.laneId, "lane id");
      const confirm = typeof req.body?.confirm === "string" ? req.body.confirm : "";
      const { runId, lane } = requireLiveLane(laneId);
      if (lane.state !== "settled") {
        throw new OrcaCliError(
          `Lane ${laneId} is ${lane.state} — removal needs settled ownership (every task in the lane settled, no active dispatch).`,
          "lane_not_settled",
        );
      }
      if (!lane.selector) {
        throw new OrcaCliError(
          `Lane ${laneId} has no positively identified workspace — nothing will be removed by a guess.`,
          "lane_unverifiable",
        );
      }
      const selector = validateSelector(lane.selector, "selector");
      // Same derivation the UI performs (worktree id, else path tail, else
      // the lane id) — but recomputed here from coordinator evidence, so a
      // crafted body can never substitute its own "known" token.
      const expectedToken = lane.worktreeId ?? lane.path?.split("/").filter(Boolean).pop() ?? lane.laneId;
      if (confirm !== expectedToken) {
        throw new ValidationError(
          "The confirmation text did not match the lane worktree's identity — nothing was removed.",
          "confirm_mismatch",
        );
      }
      const result = await removeWorktreeThroughOrca(selector, {
        runHooks: false,
        force: false,
        allowFailedArchiveHook: false,
        evidenceRequestId: null,
        runId,
      });
      if (!result.ok) {
        res.status(result.status).json(result.body);
        return;
      }
      const { requestId, receipt } = result;
      res.json({
        ok: true,
        requestId,
        receipt: {
          laneId,
          worktreeId: receipt.worktree,
          state: pickReceiptString(receipt.raw, "state") ?? "removed",
          reason:
            pickReceiptString(receipt.raw, "reason", "detail", "warning") ??
            (receipt.archiveHookOverride != null
              ? "removed past an explicitly waived archive-hook failure"
              : null),
          requestId,
        },
      });
    }),
  );

  /**
   * Read-only runtime capability projection (operations epic O1).
   *
   * `status --json` advertises the local runtime's capability ids under
   * `result.runtime.capabilities`. Project those ids, never the version, onto
   * the orchestration table. A missing field stays null and gates rows off.
   * Peer environments have their own advertisements in /api/environments;
   * this local projection does not grant a remote peer any capability.
   * Token-free and read-only like the other discovery reads; safe on
   * view-only runtimes (no execution gate — this endpoint mutates nothing).
   */
  app.get(
    "/api/capabilities",
    route(async (_req, res) => {
      const [r, advertised] = await Promise.all([readiness(), readLocalRuntimeCapabilities()]);
      const projection = describeRuntimeCapabilities(advertised);
      res.json({
        runtime: {
          cli: r.cli,
          version: r.version,
          executionEnabled: r.executionEnabled,
          reason: r.reason,
        },
        /** Verbatim local advertisement; null means the status receipt omitted it. */
        advertised,
        advertisedSource: "local-runtime-status",
        ...projection,
        // Status also lists browser, terminal, and other unrelated namespaces.
        // Keep the full advertisement above for inspection, but only call out
        // unknown orchestration ids here. The two family-wide umbrella ids
        // are known informational markers, not unknown actionable features.
        unknownAdvertised: projection.unknownAdvertised.filter(
          (id) => id.startsWith("orchestration.") &&
            id !== "orchestration.contract.v1" &&
            id !== "orchestration.federation.v1",
        ),
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
      const workers = await listWorkers(runId, { includeRemote: true });
      // A damaged/unreadable viewer history file must not hide Orca's worker
      // inventory. The API can still backfill supervised rows from Orca.
      const saved = await launchHistory.list(runId).catch(() => new Map());
      const enriched = workers.map((row) => {
        const fleetAgent = row.projection?.launch?.agent ?? row.projection?.provider?.id ?? null;
        const recorded = saved.get(row.dispatchId);
        const scopedRecord = recorded?.taskId === row.taskId ? recorded : null;
        return {
          ...row,
          launchEvidence: fleetAgent
            ? { agent: fleetAgent, source: "fleet" as const }
            : scopedRecord
              ? { agent: scopedRecord.harness, source: scopedRecord.source }
              : null,
        };
      });
      const needsDetail = enriched.filter((row) =>
        row.dispatchId && row.workerState !== "unsupervised" &&
        row.launchEvidence?.source !== "fleet" &&
        row.launchEvidence?.source !== "worker-show"
      );
      // A historical Run may contain many workers. Bound concurrent Orca
      // processes, and never turn one unavailable detail into a missing fleet
      // inventory. The badge stays unknown until positive evidence arrives.
      for (let i = 0; i < needsDetail.length; i += 6) {
        await Promise.all(needsDetail.slice(i, i + 6).map(async (row) => {
          const key = `${runId}:${row.dispatchId}`;
          let cached = launchLookups.get(key);
          if (!cached || (!cached.confirmed && Date.now() - cached.at > 60_000)) {
            const value = showWorkerDetail(row.dispatchId)
              .then((detail) =>
                detail?.runId === runId && detail.taskId === row.taskId && detail.launch?.agent
                  ? { agent: detail.launch.agent }
                  : null,
              )
              .catch(() => null);
            cached = { at: Date.now(), value, confirmed: false };
            const entry = cached;
            void value.then((observed) => {
              if (observed) entry.confirmed = true;
            });
            launchLookups.set(key, cached);
            if (launchLookups.size > 2_000) launchLookups.clear();
          }
          const observed = await cached.value;
          if (!observed) return;
          row.launchEvidence = { agent: observed.agent, source: "worker-show" };
        }));
      }
      res.json({ workers: enriched });
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
   * Stop ONE Dispatch (one-Dispatch lifecycle control). Distinct from
   * /api/run-stop (which tears the whole coordinator down): this stops a
   * single worker's Dispatch and touches nothing else — no other attempt is
   * settled, closed, or even re-decided.
   *
   * Ordering inside the handler:
   *   1. token (middleware) → 2. id validation → 3. execution gate →
   *   4. FRESH `worker-show` re-read (liveness + agentWait + workspace
   *   identity + ownership, immediately before acting — never a cached row) →
   *   5. durable `--retry-request` mint + ledger record → 6. `worker-stop`.
   * A lost response answers 502 `response_lost` with the minted requestId so
   * the client resolves the outcome through the request-show probe instead of
   * retrying blind. Stop is deliberately allowed for every lifecycle state
   * the re-read can show (live, unverifiable, exited, already settled) —
   * de-escalation is safe and Orca's receipt reports what actually happened;
   * only MISSING or UNVERIFIABLE evidence (no Dispatch, foreign Run, failed
   * read) authorizes no mutation.
   */
  app.post(
    "/api/workers/:dispatchId/stop",
    requireToken(policy),
    route(async (req, res) => {
      const dispatchId = validateId(req.params.dispatchId, "dispatch id");
      const runId = validateId(req.body?.runId, "runId");
      if (!dispatchId || !runId) {
        res.status(400).json({ error: "runId required" });
        return;
      }
      await requireExecutionEnabled();
      const evidence = await revalidateWorkerForMutation(dispatchId, runId);
      if (!evidence.ok) {
        res.status(evidence.status).json(evidence.body);
        return;
      }
      const detail = evidence.detail;
      try {
        const { requestId, receipt } = await terminalMutationWithLedger(
          "worker-stop",
          dispatchId,
          (rid) => stopWorkerReceipt(dispatchId, { retryRequestId: rid }),
          { runId: detail.runId, taskId: detail.taskId },
        );
        await recordActivity(
          createViewerActivity({
            runId: detail.runId!,
            kind: "stop",
            taskId: detail.taskId,
            dispatchId,
            title: receipt.alreadySettled ? "Stop found the Dispatch already settled" : "Coordinator stopped a worker",
            summary: `Stop state: ${receipt.state}.`,
            detail: receipt.warning ?? null,
            severity: receipt.state === "stopped" || receipt.alreadySettled ? "info" : "warning",
            requestId,
          }),
        );
        res.json({
          ok: true,
          requestId,
          receipt,
          // The fresh evidence this action was authorized by — the same
          // read that gated it, returned so the UI can show its basis.
          evidence: {
            liveness: detail.liveness,
            agentWait: detail.observation?.agentWait ?? null,
            workspace: detail.terminal
              ? { worktreePath: detail.terminal.worktreePath, branch: detail.terminal.branch }
              : null,
          },
        });
      } catch (err) {
        if (err instanceof OrcaCliError && err.code === RESPONSE_LOST) {
          res.status(502).json({
            error: String((err as Error).message),
            code: RESPONSE_LOST,
            requestId: (err as { requestId?: string }).requestId ?? null,
          });
          return;
        }
        throw err;
      }
    }),
  );

  /**
   * Abandon ONE Dispatch (`worker-abandon`) — the outcome_unknown tool for
   * when stop is NOT right: it fences the worker from orchestration while
   * explicitly NOT claiming its process stopped. That contract is why the
   * lifecycle gate differs from stop's: abandoning a worker Orca proves LIVE
   * would fence a working agent, so that state is REFUSED with
   * `abandon_refused` (use stop). Unverifiable liveness is abandon's exact
   * purpose, and an exited/settled Dispatch converges to `alreadySettled`.
   * Same evidence, ledger, and response-loss semantics as stop.
   */
  app.post(
    "/api/workers/:dispatchId/abandon",
    requireToken(policy),
    route(async (req, res) => {
      const dispatchId = validateId(req.params.dispatchId, "dispatch id");
      const runId = validateId(req.body?.runId, "runId");
      if (!dispatchId || !runId) {
        res.status(400).json({ error: "runId required" });
        return;
      }
      await requireExecutionEnabled();
      const evidence = await revalidateWorkerForMutation(dispatchId, runId);
      if (!evidence.ok) {
        res.status(evidence.status).json(evidence.body);
        return;
      }
      const detail = evidence.detail;
      if (
        normalizeLiveness(detail.liveness?.verdict) === "live" &&
        (detail.dispatch?.status ?? null) === "dispatched"
      ) {
        res.status(409).json({
          error:
            "Orca proves this Dispatch live — abandoning it would fence a working agent. Stop it instead.",
          code: "abandon_refused",
        });
        return;
      }
      try {
        const { requestId, receipt } = await terminalMutationWithLedger(
          "worker-abandon",
          dispatchId,
          (rid) => abandonWorkerReceipt(dispatchId, { retryRequestId: rid }),
          { runId: detail.runId, taskId: detail.taskId },
        );
        await recordActivity(
          createViewerActivity({
            runId: detail.runId!,
            kind: "abandon",
            taskId: detail.taskId,
            dispatchId,
            title: receipt.alreadySettled ? "Abandon found the Dispatch already settled" : "Coordinator abandoned a worker",
            summary: `Abandon state: ${receipt.state}. The worker is fenced from orchestration; its process was not touched.`,
            detail: receipt.warning ?? null,
            severity: receipt.alreadySettled ? "info" : "warning",
            requestId,
          }),
        );
        res.json({
          ok: true,
          requestId,
          receipt,
          evidence: {
            liveness: detail.liveness,
            agentWait: detail.observation?.agentWait ?? null,
            workspace: detail.terminal
              ? { worktreePath: detail.terminal.worktreePath, branch: detail.terminal.branch }
              : null,
          },
        });
      } catch (err) {
        if (err instanceof OrcaCliError && err.code === RESPONSE_LOST) {
          res.status(502).json({
            error: String((err as Error).message),
            code: RESPONSE_LOST,
            requestId: (err as { requestId?: string }).requestId ?? null,
          });
          return;
        }
        throw err;
      }
    }),
  );

  /**
   * Focus ONE worker's agent terminal (`terminal switch --terminal`) — a
   * surface-level UI action, not an orchestration mutation: it changes which
   * pane is visible and nothing else, so unlike stop/abandon it stays
   * available on view-only runtimes (no execution gate). The same fresh
   * evidence re-read still gates it: a Dispatch without positive terminal
   * facts (remote worker, archived terminal) has nothing to focus and is
   * refused with `focus_unavailable` — the focus handle always comes from
   * Orca's own receipt, never from the request body.
   */
  app.post(
    "/api/workers/:dispatchId/focus",
    requireToken(policy),
    route(async (req, res) => {
      const dispatchId = validateId(req.params.dispatchId, "dispatch id");
      const runId = validateId(req.body?.runId, "runId");
      if (!dispatchId || !runId) {
        res.status(400).json({ error: "runId required" });
        return;
      }
      const evidence = await revalidateWorkerForMutation(dispatchId, runId);
      if (!evidence.ok) {
        res.status(evidence.status).json(evidence.body);
        return;
      }
      const detail = evidence.detail;
      // The focus handle comes ONLY from the fresh receipt's terminal facts —
      // the PTY observation layer. The fleet row's `agentTerminalHandle` is
      // accounting state that can outlive an archived/closed terminal (and is
      // absent entirely for a remote worker), so falling back to it could
      // switch to whatever pane happens to own that stale handle. No positive
      // terminal facts → nothing to focus → refuse, never guess.
      const handle = detail.terminal?.handle ?? null;
      if (!handle) {
        res.status(409).json({
          error: "This worker has no terminal this viewer can focus (remote or archived).",
          code: "focus_unavailable",
        });
        return;
      }
      const { requestId, receipt } = await viewerMutationWithLedger(
        "terminal-focus",
        handle,
        () => focusTerminal(handle),
        () => ({ settled: true, note: `focused terminal ${handle}` }),
        { runId: detail.runId, taskId: detail.taskId, dispatchId },
      );
      await recordActivity(
        createViewerActivity({
          runId: detail.runId!,
          kind: "focus",
          taskId: detail.taskId,
          dispatchId,
          title: "Focused a worker terminal",
          summary: `Terminal ${handle} is now the focused pane.`,
          requestId,
        }),
      );
      res.json({ ok: true, requestId, receipt });
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
      const { requestId, receipt } = await terminalMutationWithLedger("worker-release", dispatchId, (r) =>
        releaseWorker(dispatchId, { retryRequestId: r }),
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
            requestId,
          }),
        );
      }
      res.json({ ok: true, requestId, receipt });
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
      const { requestId, receipt } = await terminalMutationWithLedger("worker-retain", dispatchId, (r) =>
        retainWorker(dispatchId, { retryRequestId: r }),
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
            requestId,
          }),
        );
      }
      res.json({ ok: true, requestId, receipt });
    }),
  );

  // --- Local file/diff review ------------------------------------------------
  //
  // The viewer never reads the worktree filesystem itself: "open this file",
  // "show me the diff", "open what changed" all drive Orca's own editor
  // surface through the adapter, with the worktree selector passed through
  // verbatim from a discovery read (never inferred). Paths are contained at
  // the HTTP boundary (validateWorkspacePath — traversal, separators, control
  // characters) and every request mints a durable ledger identity with the
  // exact path as target, so a review action is auditable even though the
  // CLI call has no Orca-side request id. These are editor-surface actions,
  // not orchestration mutations, so they stay available on view-only
  // runtimes (token still required).

  /** Open one workspace file in the Orca editor (`file open`). */
  app.post(
    "/api/files/open",
    requireToken(policy),
    route(async (req, res) => {
      const path = validateWorkspacePath(req.body?.path);
      const worktree = req.body?.worktree ? validateSelector(req.body.worktree, "worktree") : undefined;
      const runId = req.body?.runId ? validateId(req.body.runId, "runId") : null;
      const { requestId, receipt } = await viewerMutationWithLedger(
        "file-open",
        path,
        () => openWorkspaceFile(path, { worktree }),
        () => ({ settled: true, note: `opened ${path}` }),
        { runId },
      );
      if (runId) {
        await recordActivity(
          createViewerActivity({
            runId,
            kind: "file_review",
            title: "Opened a workspace file for review",
            summary: path,
            detail: worktree ? `Worktree: ${worktree}` : null,
            requestId,
          }),
        );
      }
      res.json({ ok: true, requestId, receipt });
    }),
  );

  /** Open one file's source-control diff in the Orca editor (`file diff`). */
  app.post(
    "/api/files/diff",
    requireToken(policy),
    route(async (req, res) => {
      const path = validateWorkspacePath(req.body?.path);
      const staged = req.body?.staged === true;
      const worktree = req.body?.worktree ? validateSelector(req.body.worktree, "worktree") : undefined;
      const runId = req.body?.runId ? validateId(req.body.runId, "runId") : null;
      const { requestId, receipt } = await viewerMutationWithLedger(
        "file-diff",
        path,
        () => openWorkspaceFileDiff(path, { staged, worktree }),
        () => ({ settled: true, note: `opened ${staged ? "staged " : ""}diff for ${path}` }),
        { runId },
      );
      if (runId) {
        await recordActivity(
          createViewerActivity({
            runId,
            kind: "file_review",
            title: `Opened a ${staged ? "staged " : ""}diff for review`,
            summary: path,
            detail: worktree ? `Worktree: ${worktree}` : null,
            requestId,
          }),
        );
      }
      res.json({ ok: true, requestId, receipt });
    }),
  );

  /**
   * Open every changed file of a workspace in the Orca editor
   * (`file open-changed`). The mode is the adapter's closed union — a typo
   * fails here as 400 before any CLI call.
   */
  app.post(
    "/api/files/open-changed",
    requireToken(policy),
    route(async (req, res) => {
      const modeRaw = validateText(req.body?.mode, "mode", 8);
      if (modeRaw && !["edit", "diff", "both"].includes(modeRaw)) {
        throw new ValidationError(
          `mode must be one of edit|diff|both (got ${JSON.stringify(modeRaw)})`,
          "invalid_mode",
        );
      }
      const mode = (modeRaw || undefined) as WorkspaceChangedMode | undefined;
      const worktree = req.body?.worktree ? validateSelector(req.body.worktree, "worktree") : undefined;
      const runId = req.body?.runId ? validateId(req.body.runId, "runId") : null;
      const { requestId, receipt } = await viewerMutationWithLedger(
        "file-open-changed",
        worktree ?? workspaceDir,
        () => openWorkspaceChangedFiles({ mode, worktree }),
        () => ({ settled: true, note: `opened changed files (mode: ${mode ?? "both"})` }),
        { runId },
      );
      if (runId) {
        await recordActivity(
          createViewerActivity({
            runId,
            kind: "file_review",
            title: "Opened the workspace's changed files",
            summary: `Mode: ${mode ?? "both"}.`,
            requestId,
          }),
        );
      }
      res.json({ ok: true, requestId, receipt });
    }),
  );

  /**
   * The shared execution core of evidence-gated worktree removal
   * (`worktree rm`) — used verbatim by the workspace-scoped route below AND
   * by the lane-scoped removal route (spec operator API), so both surfaces
   * run the SAME gate stack in the SAME order and can never drift:
   *
   *   1. execution gate → 2. this viewer's own workspace is refused BEFORE
   *   any discovery read (the protection is absolute and local — removal
   *   would pull the coordinator out from under the Run — so it must not
   *   depend on Orca listing the workspace under this exact selector
   *   spelling) → 3. fresh `worktree show` re-read: the row is the evidence
   *   a removal is authorized on; Orca's definite absence is a 404-shaped
   *   refusal, a failed read propagates (unverifiable authorizes nothing) →
   *   4. preconditions (assertWorktreeRemovalPreconditions): main worktree
   *   and any workspace hosting an active attempt or unsettled lane are
   *   refused → 5. waiver evidence from THIS workspace's durable ledger →
   *   6. the removal itself, ledger'd before and after, Run-scoped activity
   *   when the scope is positively known.
   *
   * Refusals come back as a typed result (the established
   * `revalidateWorkerForMutation` shape) so each route maps them to its own
   * response verbatim; the archive-hook block additionally carries the
   * minted requestId — the ONLY id a later waiver may cite.
   */
  const removeWorktreeThroughOrca = async (
    selector: string,
    flags: {
      runHooks: boolean;
      force: boolean;
      allowFailedArchiveHook: boolean;
      evidenceRequestId: string | null;
      /** Requested Run scope; null falls back to a positively-matched lane. */
      runId: string | null;
    },
  ): Promise<
    | { ok: false; status: number; body: Record<string, unknown> }
    | { ok: true; requestId: string; receipt: WorktreeRemovalReceipt }
  > => {
    await requireExecutionEnabled();

    for (const owned of new Set([worktree, `path:${workspaceDir}`])) {
      if (owned && owned === selector) {
        throw new OrcaCliError(
          `${selector} is this viewer's own workspace — removal would pull the coordinator out from under the Run.`,
          "current_workspace_protected",
        );
      }
    }

    // Fresh identity re-read through Orca: `null` is Orca's own definite
    // absence; anything else (transport, timeout) throws — unverifiable is
    // never rendered as "no such workspace".
    const row = await showWorktree(selector);
    if (!row) {
      return {
        ok: false,
        status: 404,
        body: { error: "no such worktree", code: "worktree_not_found" },
      };
    }

    // Precondition inputs: the workspaces hosting active work (unsettled
    // attempts + non-settled lanes). Ownership was already refused above.
    const activeSelectors = new Set<string>();
    const status = coordinatorStatus();
    if (status.running) {
      for (const attempt of status.attempts) {
        if (attempt.settled) continue;
        for (const prefs of [attempt.requested, attempt.effective]) {
          if (prefs?.worktree) activeSelectors.add(prefs.worktree);
        }
      }
      for (const lane of status.worktreeLanes) {
        if (lane.selector && lane.state !== "settled" && lane.state !== "removed") {
          activeSelectors.add(lane.selector);
        }
      }
    }
    assertWorktreeRemovalPreconditions(row, selector, {
      ownedSelectors: new Set([worktree, `path:${workspaceDir}`]),
      activeSelectors,
    });

    // Waiver evidence is read from THIS workspace's durable ledger: the id
    // must name a previous removal attempt against the SAME selector that
    // was blocked by the archive hook. Orca's request-show cannot confirm
    // a worktree-rm (no --retry-request), so the viewer's own durable
    // record of the blocked attempt is the evidence — and absence of that
    // record authorizes nothing.
    if (flags.allowFailedArchiveHook && flags.evidenceRequestId) {
      const rows = await requestLedger.list();
      const evidence = rows.find(
        (candidate) =>
          candidate.requestId === flags.evidenceRequestId &&
          candidate.operation === "worktree-remove" &&
          candidate.target === selector &&
          (candidate.note ?? "").includes("archive hook failed"),
      );
      if (!evidence) {
        return {
          ok: false,
          status: 403,
          body: {
            error:
              "No durable evidence that this worktree's removal was blocked by a failed archive hook — " +
              "waiving the hook requires the ledger id of that blocked attempt.",
            code: "removal_evidence_required",
          },
        };
      }
    }

    try {
      const scopeRunId = flags.runId ?? laneRunScopeFor(selector, status);
      const { requestId, receipt } = await viewerMutationWithLedger(
        "worktree-remove",
        selector,
        () =>
          removeWorktree(selector, {
            runHooks: flags.runHooks,
            force: flags.force,
            allowFailedArchiveHook: flags.allowFailedArchiveHook,
          }),
        (r) => ({
          settled: true,
          note:
            r.archiveHookOverride != null
              ? "removed with waived archive-hook failure"
              : "removed",
        }),
        { runId: scopeRunId },
      );
      if (scopeRunId) {
        await recordActivity(
          createViewerActivity({
            runId: scopeRunId,
            kind: "worktree",
            title: "Removed a worktree",
            summary: `${selector} was removed from Orca and git.`,
            detail:
              receipt.archiveHookOverride != null
                ? "Removal proceeded past an explicitly waived archive-hook failure."
                : null,
            severity: receipt.archiveHookOverride != null ? "warning" : "info",
            requestId,
          }),
        );
      }
      return { ok: true, requestId, receipt };
    } catch (err) {
      if (isArchiveHookFailure(err)) {
        // Nothing was removed (documented 1.4.206 contract). The result
        // carries this attempt's requestId: the ONLY id a later waiver can
        // cite as evidence.
        return {
          ok: false,
          status: 409,
          body: {
            error: String((err as Error).message),
            code: WORKTREE_ARCHIVE_HOOK_FAILED,
            requestId: (err as { requestId?: string }).requestId ?? null,
            hint: "Retry with runHooks + allowFailedArchiveHook + evidenceRequestId=<this requestId> to waive.",
          },
        };
      }
      throw err;
    }
  };

  /**
   * Evidence-gated worktree removal (`worktree rm`), workspace-scoped form:
   * the caller names the exact selector. Every gate lives in the shared
   * `removeWorktreeThroughOrca` core above — this handler only validates the
   * request shape and maps the core's typed result onto the response.
   */
  app.post(
    "/api/worktrees/remove",
    requireToken(policy),
    route(async (req, res) => {
      const selector = validateSelector(req.body?.worktree, "worktree");
      const runHooks = req.body?.runHooks === true;
      const force = req.body?.force === true;
      const allowFailedArchiveHook = req.body?.allowFailedArchiveHook === true;
      const evidenceRequestId = req.body?.evidenceRequestId
        ? validateId(req.body.evidenceRequestId, "evidenceRequestId")
        : null;
      const runId = req.body?.runId ? validateId(req.body.runId, "runId") : null;
      if (allowFailedArchiveHook && !evidenceRequestId) {
        throw new ValidationError(
          "allowFailedArchiveHook requires evidenceRequestId — the ledger id of the blocked removal this waiver resolves",
          "removal_evidence_required",
        );
      }
      const result = await removeWorktreeThroughOrca(selector, {
        runHooks,
        force,
        allowFailedArchiveHook,
        evidenceRequestId,
        runId,
      });
      if (!result.ok) {
        res.status(result.status).json(result.body);
        return;
      }
      res.json({ ok: true, requestId: result.requestId, receipt: result.receipt });
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
      const configEnvironmentByTask = validateEnvironmentTaskMap(body.environmentByTask, "environmentByTask");
      const configPlacementByTask = validatePlacementTaskMap(body.placementByTask, "placementByTask");
      // Workspace lanes (worktree-lanes epic): the full lane shapes get the
      // same strictness, plus the same semantic cross-checks as the run
      // request — lane references must resolve, placement and lane
      // membership stay disjoint, and the environment/placement matrix holds.
      const configWorktreeLanes = validateWorktreeLaneMap(body.worktreeLanes, "worktreeLanes");
      const configLaneByTask = validateLaneTaskMap(body.laneByTask, "laneByTask");
      // PUT /api/config is a patch, not a replacement. Validate cross-map
      // relationships against the resulting plan: a lane membership edit may
      // omit worktreeLanes because that map was saved earlier, and a runId-only
      // update must never force the browser to resend every launch setting.
      if (["environmentByTask", "placementByTask", "worktreeLanes", "laneByTask"].some((key) => key in body)) {
        const stored = await loadConfig(workspaceDir);
        const environmentByTask = configEnvironmentByTask ?? stored.environmentByTask ?? null;
        const placementByTask = configPlacementByTask ?? stored.placementByTask ?? null;
        const worktreeLanes = configWorktreeLanes ?? stored.worktreeLanes ?? null;
        const laneByTask = configLaneByTask ?? stored.laneByTask ?? null;
        assertLaneReferences(laneByTask, worktreeLanes);
        assertLanePlacementDisjoint(placementByTask, laneByTask);
        assertEnvironmentPlacementCompatibility(environmentByTask, placementByTask);
      }
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
