import { isOrcaPluginFrame, pluginApiRequest } from "./bridge/orcaBridge";
import type {
  ActivitySnapshot,
  DagResponse,
  LaneReviewReceiptView,
  OrcaEnvironmentView,
  OrcaReadiness,
  OrcaRepoView,
  OrcaRun,
  OrcaWorktreeView,
  PlacementSpec,
  ProviderSessionBindingView,
  ProviderSessionObservationView,
  RequestDetailResponse,
  RequestLedgerRowView,
  RunHealthView,
  RemovedWorkPageView,
  RunsPageView,
  RunStatus,
  StopResultEntry,
  TaskMessageReceipt,
  ViewerConfig,
  WorkerControlReceiptView,
  WorkerDetailView,
  WorkerOutputView,
  WorkerRowView,
  WorkerTerminalReceiptView,
  WorktreeLaneSpec,
  WorktreeLanesResponse,
  WorktreeRemovalReceiptView,
  RuntimeCapabilitiesResponse,
  RetryWorkerResult,
} from "./types";

interface LaunchPreviewTask {
  taskId: string;
  status: string;
  harness: string;
  model: string | null;
  effort: string | null;
  placement: {
    environment: string | null;
    laneId: string | null;
    kind: string;
    selector: string | null;
  };
  route: string;
  reason: string;
  reasonCode: string;
  limitations: string[];
}

export interface LaunchPreviewResponse {
  runId: string;
  tasks: LaunchPreviewTask[];
  caveat: string;
}

export interface LaunchPlanRequest {
  runId: string;
  harnessByTask: Record<string, string>;
  defaultHarness: string;
  maxConcurrency: number;
  modelByTask: Record<string, string>;
  effortByTask: Record<string, string>;
  retainByTask: Record<string, boolean>;
  environmentByTask: Record<string, string>;
  placementByTask: Record<string, PlacementSpec>;
  worktreeLanes: Record<string, WorktreeLaneSpec>;
  laneByTask: Record<string, string>;
  defaultOpenCodeUi: ViewerConfig["defaultOpenCodeUi"];
  openCodeUiByTask: ViewerConfig["openCodeUiByTask"];
}

/** An /api error that carries Orca's machine-readable error code. */
export class ApiError extends Error {
  readonly code: string | null;
  readonly status: number;
  constructor(message: string, code: string | null = null, status = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

// --- session: the per-process mutation token --------------------------------
//
// The server mints a 256-bit token at startup and requires it (header
// X-Orca-Dag-Token) on every POST/PUT. We fetch it once from /api/session —
// same-origin only, since the server sets no CORS — and echo it back on every
// mutation. Until that fetch has happened the client refuses to mutate at all
// (a synthetic 503) rather than firing requests that can only come back 403.

interface SessionInfo {
  token: string;
  allowCustomCommands: boolean;
  platform?: string;
}

let session: SessionInfo | null = null;
let sessionPromise: Promise<SessionInfo> | null = null;

/** Fetch and retain the mutation token once. Safe to call repeatedly. */
export function initSession(): Promise<SessionInfo> {
  if (!sessionPromise) {
    sessionPromise = get<SessionInfo>("/api/session").then((s) => {
      session = s;
      return s;
    });
  }
  return sessionPromise;
}

/** Token gate for mutations: never send one before the session is known. */
function requireToken(): string {
  if (!session) {
    throw new ApiError(
      "Session not initialized yet — the viewer hasn't fetched its mutation token. Reload the page.",
      "session_not_initialized",
      503,
    );
  }
  return session.token;
}

async function mutate<T = unknown>(
  method: "POST" | "PUT",
  url: string,
  body?: unknown,
): Promise<T> {
  if (isOrcaPluginFrame()) {
    const res = await pluginApiRequest(method, url, body);
    const json = res.body ?? {};
    if (!res.ok) {
      throw new ApiError(
        `${String(json.error ?? `HTTP ${res.status}`)}${typeof json.requestId === "string" ? ` (requestId: ${json.requestId})` : ""}`,
        typeof json.code === "string" ? json.code : null,
        res.status,
      );
    }
    return json as T;
  }

  const send = (token: string): Promise<T> =>
    fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Orca-Dag-Token": token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (res) => {
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new ApiError(
          `${String(json.error ?? `HTTP ${res.status}`)}${typeof json.requestId === "string" ? ` (requestId: ${json.requestId})` : ""}`,
          typeof json.code === "string" ? json.code : null,
          res.status,
        );
      }
      return json as T;
    });

  // The token is per-process: if the viewer server restarted since this page
  // loaded, our copy is stale and the mutation comes back 403 invalid_token.
  // Re-fetch the session once and retry — a genuine rejection (it can't be
  // stale twice in a row) still surfaces to the caller.
  try {
    return await send(requireToken());
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 403 || err.code !== "invalid_token") throw err;
    sessionPromise = null;
    session = null;
    return send((await initSession()).token);
  }
}

const post = mutate.bind(null, "POST") as <T = unknown>(url: string, body?: unknown) => Promise<T>;
const put = mutate.bind(null, "PUT") as <T = unknown>(url: string, body?: unknown) => Promise<T>;

async function get<T>(url: string): Promise<T> {
  if (isOrcaPluginFrame()) {
    const res = await pluginApiRequest("GET", url);
    const json = res.body ?? {};
    if (!res.ok) {
      throw new ApiError(
        String(json.error ?? `HTTP ${res.status}`),
        typeof json.code === "string" ? json.code : null,
        res.status,
      );
    }
    return json as T;
  }

  const res = await fetch(url);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      String(json.error ?? `HTTP ${res.status}`),
      typeof json.code === "string" ? json.code : null,
      res.status,
    );
  }
  return json as T;
}

/**
 * One cursor page of Run discovery (Phase 7). `cursor` is the opaque token
 * the previous page returned; `nextCursor: null` means the history is
 * exhausted. Workspace ownership is preserved server-side — a Run from
 * another workspace never appears here, no matter how it was addressed.
 */
export async function fetchRunsPage(opts: { cursor?: string; limit?: number } = {}): Promise<RunsPageView> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const page = await get<Partial<RunsPageView>>(`/api/runs/page${qs ? `?${qs}` : ""}`);
  return { runs: page.runs ?? [], nextCursor: page.nextCursor ?? null };
}

/** Exact lookup returns workspace evidence separately from the Run itself. */
export async function fetchRunById(runId: string): Promise<{ run: OrcaRun; workspace: { owned: boolean; evidence: string } }> {
  const result = await get<{ run: OrcaRun | null; workspace: { owned: boolean; evidence: string } }>(`/api/runs/${encodeURIComponent(runId)}`);
  if (!result.run) {
    throw new ApiError(`Run ${runId} was not found.`, "run_not_found", 404);
  }
  return { run: result.run, workspace: result.workspace };
}

/** The DAG of one Run. */
export async function fetchDag(runId: string): Promise<DagResponse> {
  return get<DagResponse>(`/api/dag?run=${encodeURIComponent(runId)}`);
}

export async function fetchRunStatus(): Promise<RunStatus> {
  return get<RunStatus>("/api/run-status");
}

/** Readable, strictly Run-scoped coordinator/worker history. */
export async function fetchActivity(runId: string): Promise<ActivitySnapshot> {
  return get<ActivitySnapshot>(`/api/activity?run=${encodeURIComponent(runId)}`);
}

/**
 * Durable worker accounting for one Run — the fully paginated, remote-inclusive
 * `worker-list` inventory. Every returned Task id is evidence that the Task
 * has started at least once, regardless of liveness or outcome, and the rows
 * render historical workers even when this viewer is not coordinating.
 */
export async function fetchWorkers(runId: string): Promise<{ workers: WorkerRowView[]; partialHostErrors: unknown[] }> {
  const result = await get<{ workers: WorkerRowView[]; partialHostErrors: unknown[] }>(
    `/api/workers?run=${encodeURIComponent(runId)}`,
  );
  return { workers: result.workers ?? [], partialHostErrors: result.partialHostErrors ?? [] };
}

/** Exact Run-scoped provider-session bindings; reading this does not probe them. */
export async function fetchProviderSessionBindings(runId: string): Promise<ProviderSessionBindingView[]> {
  const { bindings } = await get<{ bindings: ProviderSessionBindingView[] }>(
    `/api/session-bindings?run=${encodeURIComponent(runId)}`,
  );
  return bindings ?? [];
}

/** Save a provider session ID against one exact Run/Task/Dispatch identity. */
export async function saveProviderSessionBinding(
  dispatchId: string,
  binding: Pick<ProviderSessionBindingView, "runId" | "taskId" | "harness" | "sessionId">,
): Promise<ProviderSessionBindingView> {
  const { binding: saved } = await put<{ binding: ProviderSessionBindingView }>(
    `/api/session-bindings/${encodeURIComponent(dispatchId)}`,
    binding,
  );
  return saved;
}

/** Probe one explicitly bound provider session on operator request. */
export async function probeProviderSession(
  dispatchId: string,
  runId: string,
): Promise<ProviderSessionObservationView> {
  const { observation } = await post<{ observation: ProviderSessionObservationView }>(
    `/api/session-bindings/${encodeURIComponent(dispatchId)}/probe`,
    { runId },
  );
  return observation;
}

/**
 * Run-scoped detail for ONE worker (Phase 2): the durable row plus
 * `worker-show` evidence — observation, agent-wait, terminal facts, launch
 * and provider identity, and the qualified liveness presentation. Works
 * whether or not this viewer coordinates the Run.
 */
export async function fetchWorkerDetail(runId: string, dispatchId: string): Promise<WorkerDetailView> {
  const { detail } = await get<{ detail: WorkerDetailView }>(
    `/api/workers/${encodeURIComponent(dispatchId)}?run=${encodeURIComponent(runId)}`,
  );
  return detail;
}

/**
 * Resolved CLI plus selected runtime execution readiness. The CLI identity is
 * fixed at startup; the server briefly caches status probes and rechecks them
 * at mutation boundaries. The UI loads its initial verdict with the page.
 */
export async function fetchReadiness(): Promise<OrcaReadiness> {
  return get<OrcaReadiness>("/api/readiness");
}

/**
 * Read-only canonical capability projection from the local runtime's
 * `status --json` advertisement. Missing fields remain unadvertised; support
 * is never inferred from the version. Fetched once per page load like readiness.
 */
export async function fetchCapabilities(): Promise<RuntimeCapabilitiesResponse> {
  return get<RuntimeCapabilitiesResponse>("/api/capabilities");
}

/**
 * Ownership + health of ONE Run: who is bound (from Orca's Run record, not a
 * local terminal guess), the task/message/worker/gate counts, and evidence-
 * backed warnings. Counts are null when their read failed — unknown, not zero.
 */
export async function fetchRunHealth(runId: string): Promise<RunHealthView> {
  const { health } = await get<{ health: RunHealthView }>(
    `/api/run-health?run=${encodeURIComponent(runId)}`,
  );
  return health;
}

/** Read one cursor page of removed history, on demand and Run-scoped. */
export async function fetchRemovedWork(runId: string, cursor?: string): Promise<RemovedWorkPageView> {
  const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  const { page } = await get<{ page: RemovedWorkPageView }>(
    `/api/runs/${encodeURIComponent(runId)}/removed-work${query}`,
  );
  return page;
}

/** Read-only launch-plan route preview, protected by the session token. */
export async function fetchLaunchPreview(plan: LaunchPlanRequest): Promise<LaunchPreviewResponse> {
  return mutate<LaunchPreviewResponse>("POST", "/api/launch-preview", plan);
}

/**
 * Start the self-driven coordinator on `runId`. It binds an Orca terminal as
 * the Run's coordinator — fencing any agent terminal currently coordinating it.
 */
export async function startRun(
  runId: string,
  harnessByTask: Record<string, string>,
  defaultHarness: string,
  maxConcurrency: number,
  modelByTask: Record<string, string>,
  effortByTask: Record<string, string> = {},
  retainByTask: Record<string, boolean> = {},
  environmentByTask: Record<string, string> = {},
  placementByTask: Record<string, PlacementSpec> = {},
  worktreeLanes: Record<string, WorktreeLaneSpec> = {},
  laneByTask: Record<string, string> = {},
  resumeBlocked?: { dispatchId: string; allowUnknownProvider: boolean },
  openCodeUi?: Pick<ViewerConfig, "defaultOpenCodeUi" | "openCodeUiByTask">,
): Promise<RunStatus> {
  return post(`/api/run`, {
    runId,
    harnessByTask,
    defaultHarness,
    maxConcurrency,
    modelByTask,
    effortByTask,
    retainByTask,
    environmentByTask,
    placementByTask,
    // Phase 7: the lane plan rides along explicitly (same reason as
    // placement — avoids the 250ms config-write debounce racing the run).
    worktreeLanes,
    laneByTask,
    resumeBlocked,
    ...openCodeUi,
  });
}

export type CoordinatorControl = { confirmed: true; coordinatorHandle: string | null; consumerGeneration: number | null };

/** Fetch current binding evidence before asking for explicit coordinator control. */
export async function fetchCoordinatorControl(runId: string): Promise<CoordinatorControl> {
  const { run } = await get<{ run: { id: string; coordinator_handle: unknown; consumer_generation: unknown } }>(`/api/runs/${encodeURIComponent(runId)}`);
  if (!run || run.id !== runId ||
      !(run.coordinator_handle === null || typeof run.coordinator_handle === "string") ||
      !(run.consumer_generation === null || typeof run.consumer_generation === "number")) {
    throw new ApiError("Coordinator binding evidence is unavailable.", "coordinator_control_unknown", 409);
  }
  return { confirmed: true, coordinatorHandle: run.coordinator_handle, consumerGeneration: run.consumer_generation };
}

/** Record a reviewed result on a blocked Task whose Dispatch cannot report. */
export async function resolveBlockedWorker(
  dispatchId: string,
  runId: string,
  result: string,
  coordinatorControl?: CoordinatorControl,
): Promise<void> {
  await post(`/api/workers/${encodeURIComponent(dispatchId)}/resolve-blocked`, {
    runId,
    result,
    coordinatorControl,
    acknowledgeUnknownProvider: true,
  });
}

export async function stopRun(): Promise<{ clean: boolean; results: StopResultEntry[] }> {
  return post(`/api/run-stop`);
}

/** Reply to a worker question/escalation (the run's inbox). */
export async function replyToMessage(id: string, body: string, runId: string, coordinatorControl?: CoordinatorControl): Promise<Record<string, unknown>> {
  return post(`/api/messages/${encodeURIComponent(id)}/reply`, { body, runId, coordinatorControl });
}
export async function acknowledgeStopEvent(runId: string, messageId: string, dispatchId: string): Promise<void> {
  await post(`/api/messages/${encodeURIComponent(messageId)}/acknowledge-stop-event`, { runId, dispatchId });
}


/** The returned identity may be a follow-up if the target settled during send. */
export async function sendTaskMessage(taskId: string, body: string, runId: string): Promise<TaskMessageReceipt> {
  const value = await post<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/messages`, { body, runId });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError("task_message_response_invalid", "task_message_response_invalid", 502);
  }
  const receipt = value as Record<string, unknown>;
  if (receipt.ok !== true || (receipt.kind !== "enqueued" && receipt.kind !== "follow_up" && receipt.kind !== "recipient_run_bound_redirect") ||
      receipt.runId !== runId || receipt.requestedTaskId !== taskId ||
      ![receipt.runId, receipt.taskId, receipt.dispatchId, receipt.requestedTaskId, receipt.requestedDispatchId]
        .every((field) => typeof field === "string" && field.length > 0) ||
      !(receipt.followUpOf === null || typeof receipt.followUpOf === "string") ||
      !(receipt.destinationRunId === null || typeof receipt.destinationRunId === "string") ||
      !(receipt.requestId === null || typeof receipt.requestId === "string")) {
    throw new ApiError("task_message_response_invalid", "task_message_response_invalid", 502);
  }
  return value as TaskMessageReceipt;
}


/** Explicitly release a settled worker terminal (resolves cleanup debt). */
export async function releaseWorker(runId: string, dispatchId: string): Promise<WorkerTerminalReceiptView> {
  const { receipt } = await post<{ receipt: WorkerTerminalReceiptView }>(
    `/api/workers/${encodeURIComponent(dispatchId)}/release`,
    { runId },
  );
  return receipt;
}

/**
 * One bounded page of a worker's output (Phase 5). `cursor` continues a
 * previous page; `source` pins auto/terminal/transcript. If the cursor pinned
 * to a replaced source, the server restarts the read and says so via
 * `sourceChanged` + warnings.
 */
export async function fetchWorkerOutput(
  runId: string,
  dispatchId: string,
  opts: { source?: string; cursor?: string; limit?: number } = {},
): Promise<WorkerOutputView> {
  const params = new URLSearchParams();
  params.set("run", runId);
  if (opts.source) params.set("source", opts.source);
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const { output } = await get<{ output: WorkerOutputView }>(
    `/api/workers/${encodeURIComponent(dispatchId)}/output${qs ? `?${qs}` : ""}`,
  );
  return output;
}

/** Explicit debug retention — keep a settled worker's terminal live. */
export async function retainWorker(runId: string, dispatchId: string): Promise<WorkerTerminalReceiptView> {
  const { receipt } = await post<{ receipt: WorkerTerminalReceiptView }>(
    `/api/workers/${encodeURIComponent(dispatchId)}/retain`,
    { runId },
  );
  return receipt;
}

type RetryWorkerResponse = RetryWorkerResult & { ok: true };

function isRetryWorkerResponse(value: unknown): value is RetryWorkerResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return (
    response.ok === true &&
    typeof response.taskId === "string" && response.taskId.trim().length > 0 &&
    typeof response.dispatchId === "string" && response.dispatchId.trim().length > 0 &&
    (response.retriedFrom === null ||
      (typeof response.retriedFrom === "string" && response.retriedFrom.trim().length > 0))
  );
}

/**
 * Explicit safe retry (Phase 4): this promise resolves only for a started
 * worker whose new Dispatch is present in the response. Rejections, failed
 * starts, and unresolved starts remain on the normal ApiError path.
 */
export async function retryWorker(id: string): Promise<RetryWorkerResult> {
  const value = await post<unknown>(`/api/workers/${encodeURIComponent(id)}/retry`, {});
  if (!isRetryWorkerResponse(value)) {
    throw new ApiError("retry_response_invalid", "retry_response_invalid", 502);
  }
  return {
    taskId: value.taskId,
    dispatchId: value.dispatchId,
    retriedFrom: value.retriedFrom,
  };
}

export async function resolveGate(id: string, resolution: string, runId: string, coordinatorControl?: CoordinatorControl): Promise<void> {
  await post(`/api/gates/${encodeURIComponent(id)}/resolve`, { resolution, runId, coordinatorControl });
}
export async function createGate(runId: string, taskId: string, question: string, coordinatorControl?: CoordinatorControl): Promise<{ requestId: string; receipt: unknown }> {
  return post("/api/gates", { runId, taskId, question, coordinatorControl });
}


/** Load the persisted viewer config (harness choices, concurrency, layout, Run). */
export async function fetchConfig(): Promise<Partial<ViewerConfig>> {
  return get<Partial<ViewerConfig>>("/api/config");
}

/** Merge a patch into the persisted viewer config. */
export async function saveConfig(patch: Partial<ViewerConfig>): Promise<void> {
  await put("/api/config", patch);
}

export interface ModelDiscoveryResult {
  status: "available" | "unavailable";
  models: string[];
  diagnostic: string | null;
  scope: "local-workspace";
}

/** Discover advisory models in the local viewer workspace. */
export async function fetchModels(harness: string): Promise<ModelDiscoveryResult> {
  const result = await get<{ harness: string } & ModelDiscoveryResult>(
    `/api/models/${encodeURIComponent(harness)}`,
  );
  return result;
}

// --- Phase 5: mutation-request audit (read-only) ------------------------------
//
// The durable ledger of viewer-originated mutation requests, plus a live
// `request-show` inspection. Both are strictly read-only — nothing here can
// replay a mutation, and an `absent` receipt never proves one did not happen.

/**
 * Bounded, Run-scoped audit list from the workspace ledger. Rows whose
 * operation supplied no Run scope are included everywhere, labeled unscoped.
 */
export async function fetchRequests(runId: string): Promise<{ requests: RequestLedgerRowView[]; otherRunCount: number }> {
  return get<{ requests: RequestLedgerRowView[]; otherRunCount: number }>(
    `/api/requests?run=${encodeURIComponent(runId)}`,
  );
}

/**
 * One request's ledger row plus a fresh Orca receipt (completed / pending /
 * absent / unknown), with Orca's own interpretation verbatim.
 */
export async function fetchRequestDetail(runId: string, requestId: string): Promise<RequestDetailResponse> {
  return get<RequestDetailResponse>(
    `/api/requests/${encodeURIComponent(requestId)}?run=${encodeURIComponent(runId)}`,
  );
}

// --- Phase 6: saved-environment discovery ------------------------------------
//
// The UI never invents a remote target: environment pickers, exact-workspace
// lists, and repo selectors are populated exclusively from these endpoints,
// which wrap `orca environment list` / `worktree list --environment` /
// `repo list --environment`. `fetchEnvironments` caches for 30s — the panel
// re-renders on every config keystroke and the list is runtime-owned state.

let envCache: { at: number; environments: OrcaEnvironmentView[] } | null = null;
const ENV_CACHE_MS = 30_000;

export async function fetchEnvironments(force = false): Promise<OrcaEnvironmentView[]> {
  if (!force && envCache && Date.now() - envCache.at < ENV_CACHE_MS) return envCache.environments;
  const { environments } = await get<{ environments: OrcaEnvironmentView[] }>("/api/environments");
  envCache = { at: Date.now(), environments: environments ?? [] };
  return envCache.environments;
}

/** Exact workspaces on one environment (full `id:<repo>::<path>` selectors). */
export async function fetchEnvironmentWorktrees(
  envId: string,
  repo?: string,
): Promise<OrcaWorktreeView[]> {
  const params = new URLSearchParams();
  if (repo) params.set("repo", repo);
  const qs = params.toString();
  const { worktrees } = await get<{ worktrees: OrcaWorktreeView[] }>(
    `/api/environments/${encodeURIComponent(envId)}/worktrees${qs ? `?${qs}` : ""}`,
  );
  return worktrees ?? [];
}

/** Repos registered on one environment (for the new-top-level repo picker). */
export async function fetchEnvironmentRepos(envId: string): Promise<OrcaRepoView[]> {
  const { repos } = await get<{ repos: OrcaRepoView[] }>(
    `/api/environments/${encodeURIComponent(envId)}/repos`,
  );
  return repos ?? [];
}

// --- Phase 7: local placement discovery + workspace lanes --------------------
//
// The LOCAL placement editor is populated exclusively from these endpoints —
// the exact same discovery Orca's own IDE shows. The viewer never invents a
// workspace or repo, never shortens a selector, and never turns a folder into
// a git-worktree target (folders are valid exact-existing targets only).
// Cached for 30s like the environment lists: the editors re-render per
// keystroke and discovery is runtime-owned state.

let localWorkspaceCache: { at: number; workspaces: OrcaWorktreeView[] } | null = null;
let localRepoCache: { at: number; repos: OrcaRepoView[] } | null = null;
const LOCAL_CACHE_MS = 30_000;

/** Orca-discovered LOCAL workspaces (exact selectors included). */
export async function fetchLocalWorkspaces(force = false): Promise<OrcaWorktreeView[]> {
  if (!force && localWorkspaceCache && Date.now() - localWorkspaceCache.at < LOCAL_CACHE_MS) {
    return localWorkspaceCache.workspaces;
  }
  const { worktrees } = await get<{ worktrees: OrcaWorktreeView[] }>("/api/worktrees");
  const workspaces = worktrees ?? [];
  localWorkspaceCache = { at: Date.now(), workspaces };
  return workspaces;
}
export async function removeCleanupWorktree(runId: string, worktree: string, deleteBranch: boolean): Promise<{ requestId: string; receipt: { worktree: string; archiveHookOverride: unknown; preservedBranch: unknown; raw: unknown } }> {
  return post("/api/worktrees/remove", { runId, worktree, deleteBranch });
}


/** Orca-discovered LOCAL repositories (for the new-top-level repo picker). */
export async function fetchLocalRepos(force = false): Promise<OrcaRepoView[]> {
  if (!force && localRepoCache && Date.now() - localRepoCache.at < LOCAL_CACHE_MS) {
    return localRepoCache.repos;
  }
  const { repos } = await get<{ repos: OrcaRepoView[] }>("/api/repos");
  const reposList = repos ?? [];
  localRepoCache = { at: Date.now(), repos: reposList };
  return reposList;
}

/**
 * The coordinator's runtime projection of every workspace lane on a Run.
 * Pure read: null fields mean "not positively known yet", and an
 * `unverifiable` lane is surfaced, never reconstructed or acted on.
 */
export async function fetchWorktreeLanes(runId: string): Promise<WorktreeLanesResponse> {
  return get<WorktreeLanesResponse>(`/api/worktree-lanes?run=${encodeURIComponent(runId)}`);
}

/**
 * Open the lane workspace's changed files through Orca (`mode: "files"`), or
 * its diff (`mode: "diff"`). Orca opens them in the PROVEN workspace — the
 * server refuses when the lane's workspace identity is not positively known.
 */
export async function openLaneChanges(
  laneId: string,
  mode: "files" | "diff",
): Promise<LaneReviewReceiptView> {
  const { receipt } = await post<{ receipt: LaneReviewReceiptView }>(
    `/api/worktree-lanes/${encodeURIComponent(laneId)}/open-changed`,
    { mode },
  );
  return receipt;
}

/**
 * Remove the lane's Orca worktree — explicit, ownership-checked, and only
 * ever executed as `orca worktree rm`. `confirm` is the literal token the
 * operator typed (the worktree id/name); the server compares it before it
 * acts, and `settled` ownership is a precondition, not a UI courtesy.
 */
export async function removeLaneWorktree(
  laneId: string,
  confirm: string,
): Promise<WorktreeRemovalReceiptView> {
  const { receipt } = await post<{ receipt: WorktreeRemovalReceiptView }>(
    `/api/worktree-lanes/${encodeURIComponent(laneId)}/remove`,
    { confirm },
  );
  return receipt;
}

// --- Phase 7: per-Dispatch intervention ---------------------------------------
//
// Each action is evidence-gated SERVER-side; these wrappers exist so the UI
// can show Orca's verdict verbatim. A 409 with a reason (missing/stale/
// unverifiable evidence) is surfaced, never retried blindly.
//
// The wire carries `{ requestId, receipt }` where `receipt` is the adapter's
// VERBATIM Orca receipt (`{dispatchId, state, alreadySettled, processAction,
// warning}`) — the viewer projection fields the panel renders (`action`,
// `reason`, `detail`, `requestId`) are mapped HERE, at the single boundary,
// so neither side has to guess about the other's shape.

/**
 * One worker-control action's body → the panel's receipt view. `warning` is
 * Orca's verbatim verdict note, surfaced as `detail` (with `reason` falling
 * back to it) so nothing the runtime said is dropped.
 */
function controlReceiptView(
  action: WorkerControlReceiptView["action"],
  body: { requestId?: unknown; receipt?: Record<string, unknown> | null },
): WorkerControlReceiptView {
  const receipt = body.receipt ?? {};
  const warning = typeof receipt.warning === "string" && receipt.warning ? receipt.warning : null;
  return {
    dispatchId: typeof receipt.dispatchId === "string" ? receipt.dispatchId : "",
    action,
    state: typeof receipt.state === "string" ? receipt.state : null,
    reason: typeof receipt.reason === "string" && receipt.reason ? receipt.reason : warning,
    detail: typeof receipt.detail === "string" && receipt.detail ? receipt.detail : warning,
    requestId: typeof body.requestId === "string" ? body.requestId : null,
  };
}

/** Stop one positively-identified ACTIVE Dispatch (Run-scoped evidence re-read). */
export async function stopWorker(dispatchId: string, runId: string): Promise<WorkerControlReceiptView> {
  const body = await post<{ requestId?: unknown; receipt?: Record<string, unknown> | null }>(
    `/api/workers/${encodeURIComponent(dispatchId)}/stop`,
    { runId },
  );
  return controlReceiptView("stop", body);
}

/** Abandon one positively-exited (or Orca-prescribed outcome-unknown) Dispatch. */
export async function abandonWorker(dispatchId: string, runId: string): Promise<WorkerControlReceiptView> {
  const body = await post<{ requestId?: unknown; receipt?: Record<string, unknown> | null }>(
    `/api/workers/${encodeURIComponent(dispatchId)}/abandon`,
    { runId },
  );
  return controlReceiptView("abandon", body);
}

/** Focus one local worker terminal with positive fresh `agentWait` evidence. */
export async function focusWorker(dispatchId: string, runId: string): Promise<WorkerControlReceiptView> {
  const body = await post<{ requestId?: unknown; receipt?: Record<string, unknown> | null }>(
    `/api/workers/${encodeURIComponent(dispatchId)}/focus`,
    { runId },
  );
  return controlReceiptView("focus", body);
}
