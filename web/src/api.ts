import type {
  ActivitySnapshot,
  AudiencePreviewResponse,
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
  RunsPageView,
  RunStatus,
  StopResultEntry,
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
} from "./types";

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
          String(json.error ?? `HTTP ${res.status}`),
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

/** Runs available to view. Tasks are Run-scoped since Orca 1.4.160. */
export async function fetchRuns(): Promise<OrcaRun[]> {
  const { runs } = await get<{ runs: OrcaRun[] }>("/api/runs");
  return runs ?? [];
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
  const page = await get<Partial<RunsPageView>>(`/api/runs${qs ? `?${qs}` : ""}`);
  return { runs: page.runs ?? [], nextCursor: page.nextCursor ?? null };
}

/**
 * Exact Run ID lookup (Phase 7). Lets the operator open one Run by its full
 * id even when pagination has not reached it. A 404 means "no such Run in
 * this workspace" — never an invitation to search Orca globally.
 */
export async function fetchRunById(runId: string): Promise<OrcaRun> {
  const { run } = await get<{ run: OrcaRun | null }>(`/api/runs/${encodeURIComponent(runId)}`);
  if (!run) {
    throw new ApiError(`Run ${runId} was not found in this workspace.`, "run_not_found", 404);
  }
  return run;
}

export async function createRun(objective: string): Promise<OrcaRun> {
  const { run } = await post<{ run: OrcaRun }>("/api/runs", { objective });
  return run;
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
export async function fetchWorkers(runId: string): Promise<WorkerRowView[]> {
  const { workers } = await get<{ workers: WorkerRowView[] }>(
    `/api/workers?run=${encodeURIComponent(runId)}`,
  );
  return workers ?? [];
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
 * Resolved Orca CLI + version + whether execution is allowed. The server
 * resolves both once at startup, so this is fetched once per page load — a
 * runtime upgrade needs a viewer restart anyway.
 */
export async function fetchReadiness(): Promise<OrcaReadiness> {
  return get<OrcaReadiness>("/api/readiness");
}

/**
 * Read-only canonical capability projection for the connected runtime. The
 * local CLI exposes no capability advertisement yet, so `advertised` is null
 * and every canonical capability renders "not advertised" — an honest matrix,
 * never an inferred one. Fetched once per page load like readiness.
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
  });
}

/** Record a reviewed result on a blocked Task whose Dispatch cannot report. */
export async function resolveBlockedWorker(
  dispatchId: string,
  runId: string,
  result: string,
): Promise<void> {
  await post(`/api/workers/${encodeURIComponent(dispatchId)}/resolve-blocked`, {
    runId,
    result,
    acknowledgeUnknownProvider: true,
  });
}

export async function stopRun(): Promise<{ clean: boolean; results: StopResultEntry[] }> {
  return post(`/api/run-stop`);
}

/** Reply to a worker question/escalation (the run's inbox). */
export async function replyToMessage(id: string, body: string, runId: string): Promise<void> {
  await post(`/api/messages/${encodeURIComponent(id)}/reply`, { body, runId });
}

/** Send durable coordinator guidance to the Task's current active Dispatch. */
export async function sendTaskMessage(taskId: string, body: string, runId: string): Promise<void> {
  await post(`/api/tasks/${encodeURIComponent(taskId)}/messages`, { body, runId });
}

// --- Phase 6: safe group messaging --------------------------------------------
//
// The composer only ever echoes an address the server's audience preview
// offered (`@all`, `@idle`, a harness group, or an exact discovered
// `@worktree:<id>`); subject/type/priority are optional metadata the server
// validates against its own allowlists.

/** Audience preview for the Run-control composer (read-only). */
export async function fetchAudiencePreview(runId: string): Promise<AudiencePreviewResponse> {
  return get<AudiencePreviewResponse>(`/api/audiences?run=${encodeURIComponent(runId)}`);
}

/**
 * Send one Run-level group message from the live coordinator. The server
 * re-checks the audience allowlist, worktree discovery, lifecycle-type
 * forbidden list, and live-coordinator authority; a success receipt means
 * Orca durably ENQUEUED the message — never that any worker read it.
 */
export async function sendGroupMessage(payload: {
  runId: string;
  audience: string;
  subject?: string;
  body: string;
  type?: "status" | "question";
  priority?: "low" | "normal" | "high" | "urgent" | null;
}): Promise<void> {
  await post("/api/messages/group", payload);
}

/** Explicitly release a settled worker terminal (resolves cleanup debt). */
export async function releaseWorker(dispatchId: string): Promise<WorkerTerminalReceiptView> {
  const { receipt } = await post<{ receipt: WorkerTerminalReceiptView }>(
    `/api/workers/${encodeURIComponent(dispatchId)}/release`,
    {},
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
  dispatchId: string,
  opts: { source?: string; cursor?: string; limit?: number } = {},
): Promise<WorkerOutputView> {
  const params = new URLSearchParams();
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
export async function retainWorker(dispatchId: string): Promise<WorkerTerminalReceiptView> {
  const { receipt } = await post<{ receipt: WorkerTerminalReceiptView }>(
    `/api/workers/${encodeURIComponent(dispatchId)}/retain`,
    {},
  );
  return receipt;
}

/**
 * Explicit safe retry (Phase 4): re-place ONE attempt that positively failed —
 * a failed-before-ready start (receipt on file) or a Dispatch Orca reports
 * failed/stopped. The server refuses anything ambiguous with 409
 * retry_not_allowed; the harness/model/placement choice is repeated verbatim.
 */
export async function retryWorker(id: string): Promise<{ taskId: string; dispatchId: string | null; retriedFrom: string | null }> {
  return post(`/api/workers/${encodeURIComponent(id)}/retry`, {});
}

export async function resolveGate(id: string, resolution: string, runId: string): Promise<void> {
  await post(`/api/gates/${encodeURIComponent(id)}/resolve`, { resolution, runId });
}

/** Load the persisted viewer config (harness choices, concurrency, layout, Run). */
export async function fetchConfig(): Promise<Partial<ViewerConfig>> {
  return get<Partial<ViewerConfig>>("/api/config");
}

/** Merge a patch into the persisted viewer config. */
export async function saveConfig(patch: Partial<ViewerConfig>): Promise<void> {
  await put("/api/config", patch);
}

/**
 * Models available for a harness. Only opencode returns a list (`opencode
 * models`); claude/codex/cursor return an empty array — the UI falls back to
 * free-text input for those.
 */
export async function fetchModels(harness: string): Promise<string[]> {
  const { models } = await get<{ models: string[] }>(`/api/models/${encodeURIComponent(harness)}`);
  return models ?? [];
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
