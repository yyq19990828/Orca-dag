import type {
  ActivitySnapshot,
  DagResponse,
  OrcaEnvironmentView,
  OrcaReadiness,
  OrcaRepoView,
  OrcaRun,
  OrcaWorktreeView,
  PlacementSpec,
  RunStatus,
  StopResultEntry,
  ViewerConfig,
  WorkerAccountingView,
  WorkerOutputView,
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
 * Durable worker accounting for one Run. Every returned Task id is evidence
 * that the Task has started at least once, regardless of liveness or outcome.
 */
export async function fetchWorkers(runId: string): Promise<WorkerAccountingView[]> {
  const { workers } = await get<{ workers: WorkerAccountingView[] }>(
    `/api/workers?run=${encodeURIComponent(runId)}`,
  );
  return workers ?? [];
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

/** Explicitly release a settled worker terminal (resolves cleanup debt). */
export async function releaseWorker(dispatchId: string): Promise<void> {
  await post(`/api/workers/${encodeURIComponent(dispatchId)}/release`, {});
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
export async function retainWorker(dispatchId: string): Promise<void> {
  await post(`/api/workers/${encodeURIComponent(dispatchId)}/retain`, {});
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

/**
 * Clear tasks. `orca orchestration reset` has no `--run` scope: it wipes every
 * Run's tasks in the local orchestration database, so the caller must opt in.
 */
export async function resetTasks(): Promise<void> {
  await post("/api/reset", { confirmAllRuns: true });
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
