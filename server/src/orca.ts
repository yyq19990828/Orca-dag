import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { openCodeSessionTitle } from "./providerSessions";
// The audience allowlist is a security-boundary concept, so the adapter
// consumes it from security.ts (which never imports this module — no cycle).
import { KNOWN_HARNESSES, WORKTREE_AUDIENCE_PREFIX } from "./security";
// The creation-metadata grammar lives in config.ts next to the stored
// placement shape; the adapter re-checks it as the LAST gate before Orca.
import {
  BASE_BRANCH_PATTERN,
  COMMENT_MAX,
  DISPLAY_NAME_MAX,
  PLACEMENT_NAME_PATTERN,
  SETUP_POLICIES,
} from "./config";

const pExecFile = promisify(execFile);

/**
 * Thin wrapper over the `orca` CLI (Orca >= 1.4.160, orchestration contract v1).
 *
 * ## The Run / Task / Dispatch model
 *
 * Orca 1.4.160 (PR #9925, shipped 2026-07-29) replaced the old flat "one global
 * task pool" with three layers:
 *
 *   Run      — durable namespace + coordinator inbox. Owns a single bound
 *              coordinator terminal (fenced by `consumer_generation`).
 *   Task     — the work item. Carries `deps` (the DAG edges) and `run_id`.
 *   Dispatch — ONE attempt of a task on one terminal (`ctx_*` ids, despite the
 *              field being called `dispatch_id`). Retries create a new Dispatch.
 *
 * `orchestration run`, `run-stop`, `coordinator-start` and `coordinator-stop`
 * are retired: they apply no effects and just return a "go read the skill"
 * payload. Orca deliberately ships no scheduler — picking placement and
 * concurrency is the caller's job, which is why this viewer still drives its
 * own dispatch loop.
 *
 * ## Authority (this is the part that shapes the whole server)
 *
 * Every orchestration RPC funnels through `resolveRunScope`:
 *
 *   - READS (`task-list`, `gate-list`) with an explicit `--run <id>` skip the
 *     consumer check entirely — any process can read any Run. The viewer's
 *     polling path needs nothing else.
 *   - MUTATIONS (`dispatch`, `gate-resolve`, `task-create`, `task-update`) and
 *     `worker-start` require the CALLER to be the live Orca terminal currently
 *     bound to that Run. The check resolves `--from <handle>` to a pane key and
 *     compares it against the Run's binding.
 *
 * A plain `execFile("orca", ...)` from this server has no terminal identity, so
 * every mutation would fail `run_required`. The escape hatch is `--from`: we
 * keep our own Orca terminal (see `ensureCoordinatorTerminal`), bind it to the
 * Run, and pass its handle on every mutating call.
 *
 * Binding fences whichever terminal was bound before — so starting a run here
 * takes coordination of that Run away from the user's agent terminal. The
 * agent can always take it back with `orca orchestration run-use --id <run>`.
 */

// --- CLI + workspace resolution (Phase 2) ----------------------------------
//
// Every Orca call this process ever makes goes through ONE resolved command
// spec and ONE resolved workspace, computed once and then treated as
// immutable. Determinism is the whole point: a viewer that resolves `orca`
// differently between its read loop and its dispatch loop would happily split
// a Run across two runtimes.

/**
 * A resolved way to invoke the Orca CLI. `prefixArgs` carries any leading
 * arguments from `ORCA_CLI_COMMAND` (e.g. `--project /path`); they are
 * prepended to every subcommand. Nothing here is ever re-parsed by a shell —
 * see `runOrca`, which spawns with `shell: false`.
 */
export interface OrcaCommand {
  executable: string;
  prefixArgs: string[];
}

/**
 * Split an `ORCA_CLI_COMMAND`-style command line into argv — POSIX-style
 * quoting only, and deliberately NOTHING else:
 *
 *  - single and double quotes group whitespace into one argument (paths with
 *    spaces are the common case: `"/opt/My Tools/orca"`);
 *  - no variable, glob, or command substitution. With `shell: false` a `$HOME`
 *    in argv would reach Orca literally, which surprises anyone who wrote it
 *    expecting expansion — so unquoted `$`, backticks, and `$(…)` are rejected
 *    outright instead of silently doing the wrong thing;
 *  - shell operators (`| ; & < > ( )`, newlines) are rejected even though a
 *    no-shell spawn would treat them as inert text: a spec that needs them was
 *    written for a shell, and running it unexpanded would misbehave in ways
 *    nobody would trace back to this parser. Inside quotes they are literal
 *    data and accepted.
 *
 * Backslashes are plain characters (no escape processing) — that keeps Windows
 * paths like `"C:\Program Files\Orca\orca.exe"` intact, and quoting already
 * covers the escaping jobs a backslash would otherwise do.
 */
export function parseCliCommand(spec: string): OrcaCommand {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error("ORCA_CLI_COMMAND is empty — name the Orca CLI to run, e.g. \"/opt/orca/orca-ide\"");

  const argv: string[] = [];
  let cur = "";
  let hasWord = false;
  let quote: '"' | "'" | null = null;
  const operators = new Set(["|", ";", "&", "<", ">", "(", ")", "`", "$"]);

  const flush = () => {
    if (hasWord) argv.push(cur);
    cur = "";
    hasWord = false;
  };

  for (const ch of trimmed) {
    if (ch === "\n" || ch === "\r") {
      throw new Error(`ORCA_CLI_COMMAND must be a single line (got ${JSON.stringify(spec.slice(0, 64))})`);
    }
    if (quote) {
      if (ch === quote) quote = null;
      else {
        cur += ch;
        hasWord = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasWord = true; // `""` is a real empty argument, like in a shell
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      continue;
    }
    if (operators.has(ch)) {
      throw new Error(
        `ORCA_CLI_COMMAND must be a plain executable and arguments, not a shell line — ` +
          `the character ${JSON.stringify(ch)} (pipes, redirection, substitution, …) is not supported. ` +
          `Got ${JSON.stringify(spec.slice(0, 64))}`,
      );
    }
    cur += ch;
    hasWord = true;
  }
  if (quote) throw new Error(`ORCA_CLI_COMMAND has an unclosed ${quote} quote: ${JSON.stringify(spec.slice(0, 64))}`);
  flush();
  if (argv.length === 0) throw new Error("ORCA_CLI_COMMAND names no executable");

  const [executable, ...prefixArgs] = argv;
  return { executable: executable as string, prefixArgs };
}

/**
 * True when this process runs inside an Orca-managed terminal. Orca stamps its
 * terminals with `ORCA_TERMINAL_HANDLE` (the pane's own identity) — the one
 * env var that says "the runtime set this environment up" rather than "a
 * human happened to export something". It matters on Linux: outside Orca,
 * bare `orca` on PATH is GNOME's screen reader (`/usr/bin/orca`), not the IDE
 * CLI — see `resolveOrcaCommand`.
 */
export function isInsideManagedOrcaTerminal(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ORCA_TERMINAL_HANDLE?.trim());
}

/**
 * Resolve the Orca command ONCE, in a fixed order (first match wins):
 *
 *   1. `ORCA_CLI_COMMAND` — explicit override, parsed by `parseCliCommand`;
 *   2. `orca-dev` when `ORCA_DEV_REPO_ROOT` is set — an Orca dev checkout
 *      always wants its own build, not whatever is installed system-wide;
 *   3. `orca-ide` on Linux OUTSIDE a managed Orca terminal — inside Orca the
 *      runtime prepends its own CLI shim to PATH so plain `orca` is right;
 *      outside, plain `orca` collides with the GNOME screen reader at
 *      /usr/bin/orca (v42, says "screen reader version 42.0"), so the
 *      unambiguous `orca-ide` binary is used instead;
 *   4. otherwise plain `orca` (macOS, Windows, or Linux inside Orca).
 */
export function resolveOrcaCommand(
  env: NodeJS.ProcessEnv,
  ctx: { platform: NodeJS.Platform; insideManagedTerminal: boolean },
): OrcaCommand {
  const override = env.ORCA_CLI_COMMAND?.trim();
  if (override) return parseCliCommand(override);

  if (env.ORCA_DEV_REPO_ROOT?.trim()) return { executable: "orca-dev", prefixArgs: [] };

  if (ctx.platform === "linux" && !ctx.insideManagedTerminal) {
    return { executable: "orca-ide", prefixArgs: [] };
  }
  return { executable: "orca", prefixArgs: [] };
}

/** The workspace identity every CLI call and coordinator title is scoped to. */
export interface OrcaWorkspace {
  /** Absolute, symlink-free directory — every CLI process runs with this cwd. */
  dir: string;
  /** sha256(dir), first 8 hex chars — the workspace's name in terminal titles. */
  hash: string;
  /** Random per-process id (8 hex chars) — tells same-workspace viewers apart. */
  instanceId: string;
}

/** First 8 hex chars of sha256(path). Stable across processes and platforms. */
export function workspaceHash(dir: string): string {
  return createHash("sha256").update(dir).digest("hex").slice(0, 8);
}

/**
 * Resolve the workspace to an EXISTING real path. `realpathSync` collapses
 * symlinks and relative segments, so two viewers started via different spellings
 * of the same directory (`/x`, `/x/`, a symlinked path) agree on one identity —
 * which is exactly what the coordinator-title scoping keys off.
 *
 * Throws with an actionable message when the directory is missing: WORKSPACE_DIR
 * is operator input, and a typo should stop startup, not misplace a coordinator.
 */
export function resolveWorkspace(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): OrcaWorkspace {
  const raw = env.WORKSPACE_DIR?.trim() || cwd;
  let dir: string;
  try {
    dir = realpathSync(raw);
  } catch {
    throw new Error(
      `Workspace directory does not exist: ${raw}` +
        (env.WORKSPACE_DIR ? " (from WORKSPACE_DIR)" : " (the current directory)") +
        ". Create it, cd into it, or fix WORKSPACE_DIR.",
    );
  }
  if (!statSync(dir).isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${dir}`);
  }
  return { dir, hash: workspaceHash(dir), instanceId: randomBytes(4).toString("hex") };
}

/**
 * The Orca worktree selector for new terminals. An explicit `ORCA_WORKTREE`
 * still wins (advanced operators pin a named worktree); the default is the
 * EXACT workspace as a `path:` selector instead of the old ambiguous `active`,
 * which resolves to "whatever worktree happens to be checked out" and breaks
 * when `WORKSPACE_DIR` points somewhere else.
 */
export function resolveWorktreeSelector(env: NodeJS.ProcessEnv, ws: OrcaWorkspace): string {
  const explicit = env.ORCA_WORKTREE?.trim();
  return explicit || `path:${ws.dir}`;
}

// --- Process-wide runtime (resolved once, then read-only) -------------------

interface OrcaRuntime {
  command: OrcaCommand;
  workspace: OrcaWorkspace;
  /** Worktree selector for coordinator/worker terminals. */
  worktree: string;
}

let runtime: OrcaRuntime | null = null;

/**
 * Resolve command + workspace once for the whole process. Called by index.ts
 * at startup; `getRuntime()` lazily falls back to ambient process values so
 * tests and tooling that never call this still get a coherent spec.
 */
export function initOrcaRuntime(opts: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): OrcaRuntime {
  const env = opts.env ?? process.env;
  const workspace = resolveWorkspace(env, opts.cwd);
  runtime = {
    command: resolveOrcaCommand(env, {
      platform: process.platform,
      insideManagedTerminal: isInsideManagedOrcaTerminal(env),
    }),
    workspace,
    worktree: resolveWorktreeSelector(env, workspace),
  };
  return runtime;
}

/** The resolved runtime, initializing lazily from ambient env when needed. */
export function getOrcaRuntime(): OrcaRuntime {
  return runtime ?? initOrcaRuntime();
}

/** The resolved workspace identity (used for coordinator titles). */
function currentWorkspace(): OrcaWorkspace {
  return getOrcaRuntime().workspace;
}

/** Human-readable form of the resolved command, for logs and error messages. */
export function formatCommand(cmd: OrcaCommand): string {
  return [cmd.executable, ...cmd.prefixArgs].join(" ");
}

export type TaskStatus =
  | "pending"
  | "ready"
  | "dispatched"
  | "completed"
  | "failed"
  | "blocked";

/**
 * An `orca ... --json` failure, carrying Orca's machine-readable error code and,
 * when the runtime offers one, the exact command that unblocks it (e.g. an
 * adopted Run answers `consumer_fenced` with a `run-use --takeover-legacy`).
 *
 * `payload` (Phase 4) holds the parsed JSON envelope when one was read — a
 * failed mutation often carries a full receipt (stage, effects, residual
 * resources, recovery commands) that must be preserved, not flattened into a
 * message string.
 */
export class OrcaCliError extends Error {
  readonly code: string | null;
  readonly recoveryCommand: string | null;
  readonly payload: unknown;
  constructor(
    message: string,
    code: string | null = null,
    recoveryCommand: string | null = null,
    payload: unknown = undefined,
  ) {
    super(message);
    this.name = "OrcaCliError";
    this.code = code;
    this.recoveryCommand = recoveryCommand;
    this.payload = payload;
  }
}

/**
 * A mutation whose outcome we could NOT observe: the process was killed by a
 * timeout, or its stdout was lost/garbled after it may already have acted.
 * This is the one failure class where the caller must ask Orca whether the
 * mutation landed (`request-show` + `--retry-request`) instead of deciding
 * anything locally — see `resolveAmbiguousMutation` and plan Phase 4 item 3.
 */
export const RESPONSE_LOST = "response_lost";

/**
 * A task row from `orchestration task-list --run <id> --json`.
 *
 * `deps` is a JSON-encoded *string* of task ids, not an array. `assignee_handle`
 * and `dispatch_id` are only present while `status === "dispatched"` — the
 * runtime strips them from every other row.
 */
export interface OrcaTask {
  id: string;
  parent_id: string | null;
  created_by_terminal_handle: string | null;
  /**
   * Runtime identity of the process that created the Task. Orca embeds the
   * exact worktree identity here (`<repo>::<realpath>@@<incarnation>`), which
   * is the only durable workspace evidence available to a lightweight Run:
   * Run records themselves deliberately carry no repo/worktree field.
   */
  created_by_process_incarnation?: string | null;
  spec: string;
  status: TaskStatus;
  deps: string;
  result: string | null;
  created_at: string;
  completed_at: string | null;
  task_title: string | null;
  display_name: string | null;
  run_id: string;
  assignee_handle?: string | null;
  dispatch_id?: string | null;
}

/** A lightweight orchestration Run: namespace + coordinator inbox. */
export interface OrcaRun {
  id: string;
  objective: string;
  coordinator_handle: string | null;
  consumer_generation: number;
  /** 1 for the inspect-only `run_legacy_local` audit tombstone. */
  legacy: number;
  created_at: string;
  updated_at: string;
}

/** One attempt of a task, as returned by `dispatch-show` / `worker-show`. */
export interface OrcaDispatch {
  id: string;
  task_id: string;
  run_id: string;
  status: string;
  assignee_handle: string | null;
  /** Circuit breaker: Orca fails the task after 3 consecutive attempt failures. */
  failure_count: number;
  last_failure: string | null;
  last_heartbeat_at: string | null;
  dispatched_at: string | null;
  completed_at: string | null;
}

export interface DagNode {
  id: string;
  label: string;
  status: TaskStatus;
  spec: string;
  result: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Live attempt, present only while dispatched. */
  dispatchId: string | null;
  assigneeHandle: string | null;
  /**
   * Orca Task `parent_id`, preserved verbatim (Phase 4 of the operations epic).
   * Ownership structure, NOT a dependency: a parent may still be running while
   * its child is ready, and no scheduling order may be inferred from it. The
   * renderable links live in `DagResponse.hierarchy`; a parent id whose Task
   * is not in this Run stays here but produces no link.
   */
  parentId: string | null;
}

export interface DagEdge {
  id: string;
  source: string;
  target: string;
}

/**
 * One parent → child ownership link (Phase 4). Deliberately a SEPARATE
 * structure from `DagEdge`: `edges` are dependency arrows (scheduling
 * semantics, layout input), hierarchy links are bookkeeping (visual grouping
 * only, never fed to the layouter and never a reason to wait).
 */
export interface DagHierarchyLink {
  id: string;
  parent: string;
  child: string;
}

/**
 * Why one Task is or is not runnable right now (operations epic O5). Every
 * reason is derived ONLY from Run-scoped task/gate/coordinator facts — never
 * invented, and never an ordering among equally ready Tasks.
 */
export type DagBlockCode =
  | "unmet_dependencies"
  | "pending_gate"
  | "waiting_for_capacity"
  | "in_flight"
  | "already_finished"
  | "unknown";

export interface DagNodeReadiness {
  /** True only for Orca-status-`ready` Tasks (deps met, no open gate). */
  runnable: boolean;
  /** Machine-readable reason codes, deterministic order, empty when runnable-and-dispatchable. */
  codes: DagBlockCode[];
  /** One human sentence per code, same order — the evidence-backed explanation. */
  reasons: string[];
  /** Evidence: dep Task ids (this Run) whose Task is not `completed`. */
  unmetDependencyIds: string[];
  /** Evidence: ids of open gates bound to this Task. */
  pendingGateIds: string[];
}

/** The current ready wave (operations epic O5). */
export interface ReadyWaveView {
  /**
   * Task ids whose Orca status is `ready`, sorted by id. Array order carries
   * NO scheduling precedence — equally ready Tasks are equally dispatchable.
   */
  taskIds: string[];
  /**
   * Free viewer-coordinator worker slots when this projection was computed;
   * `null` when this viewer's coordinator is not running this Run (another
   * coordinator, or none — capacity is then simply unknown, never zero).
   */
  freeSlots: number | null;
}

/** Viewer-coordinator occupancy fact, injected by the HTTP layer. */
export interface SchedulerOccupancy {
  /** Unsettled attempts the viewer coordinator currently holds. */
  busy: number;
  /** The Run's configured worker-slot budget. */
  maxConcurrency: number;
}

export interface Gate {
  id: string;
  taskId: string | null;
  question: string;
  options: string[];
  status: string;
  resolution: string | null;
  raw: Record<string, unknown>;
}

/**
 * Run `orca <args...> --json` and return the unwrapped `result` payload.
 * Throws an `OrcaCliError` carrying `error.code` when the runtime reports
 * `ok: false`, so callers can branch on `run_required` / `consumer_fenced`.
 *
 * Every call goes through the process-wide resolved command spec
 * (`getOrcaRuntime()`) and runs with `shell: false` — argv is passed to the
 * executable verbatim, so no value here can ever grow shell syntax. The cwd is
 * the resolved workspace, so Orca resolves relative/ambient state (repo
 * discovery, worktree resolution) against the workspace the viewer was
 * pointed at, not wherever the server happened to start.
 */
export async function runOrca<T = unknown>(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const { command, workspace } = getOrcaRuntime();
  const fullArgs = args.includes("--json") ? args : [...args, "--json"];
  let stdout: string;
  try {
    const res = await pExecFile(command.executable, [...command.prefixArgs, ...fullArgs], {
      cwd: workspace.dir,
      // The whole point of the resolved argv spec: nothing is ever re-parsed
      // or expanded by a shell. execFile defaults to this; spelled out so a
      // future "convenient" refactor doesn't flip it.
      shell: false,
      maxBuffer: 32 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 180_000,
    });
    stdout = res.stdout;
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: string | number;
      killed?: boolean;
    };
    // worker-start exits non-zero on a failed/unknown start but still emits the
    // JSON receipt, so parse stdout before giving up.
    if (e.stdout && e.stdout.trim().startsWith("{")) {
      stdout = e.stdout;
    } else if (e.killed) {
      // The spawn timeout fired and the child was killed mid-flight. It may
      // have already mutated Orca state — the outcome is UNKNOWABLE from here.
      // Phase 4: callers with a retry-request id resolve this via request-show
      // instead of guessing (never blindly retry, never blindly give up).
      throw new OrcaCliError(
        `orca ${fullArgs.join(" ")} timed out before its response was read — ` +
          `whether it took effect is unknown (resolve with request-show / --retry-request).`,
        RESPONSE_LOST,
      );
    } else if (typeof e.code === "number") {
      // The command RAN and exited non-zero. With a JSON receipt that failure
      // is definite (handled above); with anything else on stdout — garbage,
      // a truncated line, nothing — it may still have mutated state first, so
      // the outcome stays unknown.
      throw new OrcaCliError(
        `orca ${fullArgs.join(" ")} exited ${e.code} without a readable JSON receipt: ` +
          `${(e.stderr || e.message || e.stdout || "no output").slice(0, 300)}`,
        RESPONSE_LOST,
      );
    } else {
      const detail = e.stderr || e.message || "unknown error";
      const hint =
        e.code === "ENOENT"
          ? ` — the resolved Orca CLI "${formatCommand(command)}" is not on PATH. ` +
            `Install Orca, adjust PATH, or set ORCA_CLI_COMMAND.`
          : "";
      // String-errno spawn failures (ENOENT, EACCES, …) mean the command
      // NEVER RAN — the opposite of ambiguous — so they keep a distinct code
      // and are never fed through the request-show recovery path.
      throw new OrcaCliError(
        `orca ${fullArgs.join(" ")} failed: ${detail}${hint}`,
        e.code === "ENOENT" ? "cli_not_found" : e.code ? `spawn_${e.code}` : "spawn_failed",
      );
    }
  }

  let parsed: {
    ok: boolean;
    result?: T;
    error?: { code?: string; message?: string; data?: { recoveryCommand?: string } };
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // The process exited but its answer is unreadable. Same ambiguity class as
    // a timeout: it may have acted before speaking, or spoken garbage after
    // acting. Never treat as a definite failure.
    throw new OrcaCliError(
      `orca ${fullArgs.join(" ")} returned non-JSON: ${stdout.slice(0, 500)}`,
      RESPONSE_LOST,
    );
  }
  if (!parsed.ok) {
    const code = parsed.error?.code ?? null;
    const message = parsed.error?.message ?? JSON.stringify(parsed.error ?? parsed);
    const recovery = parsed.error?.data?.recoveryCommand ?? null;
    throw new OrcaCliError(
      `orca ${args[0]} ${args[1] ?? ""}: ${message}`.trim(),
      code,
      recovery,
      parsed, // full envelope — failed mutations carry receipts in here
    );
  }
  return parsed.result as T;
}

function parseDeps(deps: string | null | undefined): string[] {
  if (!deps) return [];
  try {
    const arr = JSON.parse(deps);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// --- Runs ------------------------------------------------------------------

/**
 * List Runs, newest first. Read-only: needs no coordinator terminal.
 *
 * `run-list` pages past its per-receipt cap through a top-level `nextCursor`
 * (verified against 1.4.206: the last page carries `nextCursor: null`, and
 * unlike worker-list there is no `page.hasMore` boolean — a non-empty cursor
 * IS the "more pages" signal). The opaque cursor is followed byte-for-byte
 * until the snapshot ends: returning only the first page would silently hide
 * older Runs from the picker, so every page is concatenated while the
 * historical flat-array contract is preserved for every caller.
 */
export async function listRuns(): Promise<OrcaRun[]> {
  const runs: OrcaRun[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  /** Fail closed: a truncated history must never look complete. */
  const invalidReceipt = (message: string): never => {
    throw new OrcaCliError(`run-list returned an invalid receipt: ${message}`, "invalid_pagination");
  };

  for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
    // 100 is the runtime's documented --limit ceiling (1.4.206 rejects
    // anything larger with invalid_argument), so page at exactly that cap.
    const args = ["orchestration", "run-list", "--limit", "100"];
    if (cursor) args.push("--cursor", cursor);

    const result = await runOrca<unknown>(args);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      invalidReceipt("result must be an object");
    }
    const receipt = result as Record<string, unknown>;
    if (!Array.isArray(receipt.runs)) {
      invalidReceipt("runs must be an array");
    }
    runs.push(...(receipt.runs as OrcaRun[]));

    // No hasMore boolean on this command: absent/null/empty cursor is the
    // terminal page; anything else is opaque bytes to pass back verbatim.
    const rawNext = receipt.nextCursor;
    if (rawNext !== undefined && rawNext !== null && typeof rawNext !== "string") {
      invalidReceipt("nextCursor must be a string or null");
    }
    const nextCursor = typeof rawNext === "string" && rawNext.length > 0 ? rawNext : null;
    if (nextCursor === null) break;
    if (seenCursors.has(nextCursor)) {
      throw new OrcaCliError(
        "run-list repeated nextCursor; refusing an infinite pagination loop.",
        "invalid_pagination",
      );
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return runs
    .filter((r) => r.legacy !== 1) // the audit tombstone is inspect-only and always empty
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/**
 * List only Runs that belong to this viewer's exact workspace.
 *
 * Orca's Run registry is intentionally process-global: `run-list` has no
 * workspace selector and a Run record contains no placement metadata. Tasks
 * do retain their creator process identity, including the real worktree path,
 * so the viewer derives scope from that durable evidence instead of leaking
 * unrelated projects into the picker. `includeRunIds` covers the two honest
 * empty-Run cases, where no Task exists yet: the workspace's persisted current
 * Run and Runs just created by this viewer process.
 *
 * `--brief` keeps the discovery read bounded without dropping creator fields.
 * The small worker pool avoids spawning up to 50 Orca processes at once.
 */
export async function listWorkspaceRuns(
  workspaceDir: string,
  includeRunIds: Iterable<string> = [],
): Promise<OrcaRun[]> {
  const runs = await listRuns();
  const included = new Set([...includeRunIds].filter(Boolean));
  const belongs = new Set<string>(included);
  const marker = `::${workspaceDir}@@`;
  let nextIndex = 0;

  const inspect = async (): Promise<void> => {
    while (nextIndex < runs.length) {
      const run = runs[nextIndex++];
      if (included.has(run.id)) continue;
      try {
        const tasks = await listTasks(run.id, { brief: true });
        if (
          tasks.some(
            (task) =>
              typeof task.created_by_process_incarnation === "string" &&
              task.created_by_process_incarnation.includes(marker),
          )
        ) {
          belongs.add(run.id);
        }
      } catch {
        // A Run may disappear between run-list and task-list, or a connected
        // server may be transiently unavailable. Unknown scope fails closed:
        // never show a possibly foreign Run in this workspace's picker.
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(8, runs.length) }, () => inspect()),
  );
  return runs.filter((run) => belongs.has(run.id));
}

/**
 * Create a Run and bind it to `from`. `run-create` requires a live Orca
 * terminal (it derives the coordinator pane from `--from`).
 */
export async function createRun(objective: string, from: string): Promise<OrcaRun> {
  const result = await runOrca<{ run: OrcaRun }>([
    "orchestration",
    "run-create",
    "--objective",
    objective,
    "--from",
    from,
  ]);
  return result.run;
}

/**
 * Bind `from` to an existing Run. This FENCES whatever terminal was bound
 * before — the previous coordinator's mutations start failing `consumer_fenced`.
 */
export async function bindRun(runId: string, from: string): Promise<OrcaRun> {
  const result = await runOrca<{ run: OrcaRun }>([
    "orchestration",
    "run-use",
    "--id",
    runId,
    "--from",
    from,
  ]);
  return result.run;
}

/**
 * Inspect ONE Run by its exact id (read-only): its record names the bound
 * coordinator handle. Returns `null` only when Orca itself answers
 * `run_not_found` — a definite absence. Every other failure (timeout, contact
 * loss, garbage output) throws with its evidence: a lost response must never
 * masquerade as "no such Run", because callers treat null as an ownership
 * dead-end while contact loss is merely unverifiable.
 */
export async function showRun(runId: string): Promise<OrcaRun | null> {
  let result: { run?: OrcaRun };
  try {
    result = await runOrca<{ run?: OrcaRun }>(["orchestration", "run-show", "--id", runId]);
  } catch (err) {
    if (err instanceof OrcaCliError && err.code === "run_not_found") return null;
    throw err;
  }
  return result.run ?? null;
}

// --- Read paths (no coordinator terminal needed) ---------------------------

/** Fetch a Run's tasks. Requires `--run`: an unscoped call fails `run_required`. */
export async function listTasks(
  runId: string,
  opts: { brief?: boolean } = {},
): Promise<OrcaTask[]> {
  const args = [
    "orchestration",
    "task-list",
    "--run",
    runId,
  ];
  if (opts.brief) args.push("--brief");
  const result = await runOrca<{ tasks: OrcaTask[] }>(args);
  return result.tasks ?? [];
}

/** Fetch a Run's decision gates, normalized for the UI. */
export async function listGates(runId: string): Promise<Gate[]> {
  const result = await runOrca<{ gates?: unknown[] }>([
    "orchestration",
    "gate-list",
    "--run",
    runId,
  ]);
  const raw = (result.gates ?? []) as Record<string, unknown>[];
  return raw.map((g) => normalizeGate(g));
}

function normalizeGate(g: Record<string, unknown>): Gate {
  let options: string[] = [];
  const rawOptions = g.options;
  if (Array.isArray(rawOptions)) {
    options = rawOptions.map(String);
  } else if (typeof rawOptions === "string") {
    try {
      const parsed = JSON.parse(rawOptions);
      if (Array.isArray(parsed)) options = parsed.map(String);
    } catch {
      options = rawOptions ? [rawOptions] : [];
    }
  }
  return {
    id: String(g.id ?? g.gate_id ?? ""),
    taskId: (g.task_id as string) ?? (g.taskId as string) ?? null,
    question: String(g.question ?? ""),
    options: options.length ? options : ["approved", "rejected"],
    status: String(g.status ?? "pending"),
    resolution: (g.resolution as string) ?? null,
    raw: g,
  };
}

/** Inspect one attempt. Read-only. */
export async function showDispatch(dispatchId: string): Promise<OrcaDispatch | null> {
  try {
    const result = await runOrca<{ worker?: OrcaDispatch; dispatch?: OrcaDispatch }>([
      "orchestration",
      "worker-show",
      "--dispatch",
      dispatchId,
    ]);
    return result.worker ?? result.dispatch ?? null;
  } catch {
    // A dispatch created by the low-level path may not be a supervised worker.
    return null;
  }
}

// --- Mutations (all need `--from <coordinator handle>`) --------------------

/**
 * Resolve a decision gate. Mutating: needs the bound coordinator terminal.
 *
 * `gate-resolve` takes NO `--run` flag — unlike the READS (`task-list`,
 * `gate-list`), mutations resolve their Run scope from the bound `--from`
 * terminal, not from `--run`. The gate id (`--id`) is globally unique. Passing
 * `--run` here used to be rejected with `Unknown flag --run`, which broke every
 * human approval. The Run binding itself is established upstream by
 * `asCoordinator` → `bindRun(runId, handle)` before this is called.
 */
export async function resolveGate(
  gateId: string,
  resolution: string,
  from: string,
): Promise<void> {
  await runOrca([
    "orchestration",
    "gate-resolve",
    "--id",
    gateId,
    "--resolution",
    resolution,
    "--from",
    from,
  ]);
}

/**
 * Update a task's status (and, optionally, its result JSON). Mutating: needs
 * the bound coordinator terminal (`--from`).
 *
 * This exists for the one transition Orca does NOT drive itself: a task left
 * `blocked` after its entry gate was approved. `gate-resolve` records the
 * approval but does not flip the gated task out of `blocked` — and an approval
 * done through the viewer's throwaway coordinator terminal (see `asCoordinator`
 * in index.ts) closes that terminal before any unblock side-effect can land on
 * a live consumer, so the task stays `blocked` and the dispatch loop sees zero
 * `ready` tasks. The bound coordinator (which is alive for the whole run) has
 * to nudge it to `ready` itself. A `rejected` gate is left alone here — that's
 * a task-failure decision the caller should make explicitly.
 *
 * `--run` IS a valid flag for `task-update` (unlike `gate-resolve`), so we pass
 * it for explicit scope alongside the `--from` authority.
 */
export async function taskUpdate(
  taskId: string,
  status: TaskStatus,
  runId: string,
  from: string,
  result?: string,
): Promise<void> {
  const args = [
    "orchestration",
    "task-update",
    "--id",
    taskId,
    "--status",
    status,
    "--run",
    runId,
    "--from",
    from,
  ];
  if (result !== undefined) args.push("--result", result);
  await runOrca(args);
}

// --- Terminals -------------------------------------------------------------

/** A live Orca-managed terminal. */
export interface OrcaTerminal {
  handle: string;
  worktreePath: string;
  worktreeId: string;
  branch: string;
  title: string;
  connected: boolean;
  writable: boolean;
}

export async function listTerminals(): Promise<OrcaTerminal[]> {
  const result = await runOrca<{ terminals?: Record<string, unknown>[] }>(["terminal", "list"]);
  return (result.terminals ?? []).map((t) => ({
    handle: String(t.handle ?? ""),
    worktreePath: String(t.worktreePath ?? ""),
    worktreeId: String(t.worktreeId ?? ""),
    branch: String(t.branch ?? "").replace(/^refs\/heads\//, ""),
    title: String(t.title ?? "").trim(),
    connected: Boolean(t.connected),
    writable: Boolean(t.writable),
  }));
}

/**
 * Stable title prefix stamped on our own coordinator terminals so uninstall can
 * still find every version of them. Phase 2 appends a workspace hash and an
 * instance id (see `coordinatorTitle`) — the prefix is the contract, the
 * suffixes are scope.
 */
export const COORDINATOR_TITLE = "orca-dag coordinator";

/** The ` · ` separator between title segments (matches the old adhoc style). */
const TITLE_SEP = " · ";

/** Full title for THIS viewer's main coordinator terminal. */
export function coordinatorTitle(ws: OrcaWorkspace): string {
  return `${COORDINATOR_TITLE}${TITLE_SEP}${ws.hash}${TITLE_SEP}${ws.instanceId}`;
}

/** Everything before the instance-id segment — keyed by workspace hash. */
export function coordinatorTitlePrefix(hash: string): string {
  return `${COORDINATOR_TITLE}${TITLE_SEP}${hash}${TITLE_SEP}`;
}

/**
 * A parsed coordinator title. `main` is a live viewer's long-lived coordinator;
 * `adhoc` is its short-lived one-shot (created and closed inside a single API
 * request); `legacy` is the pre-Phase-2 unscoped title.
 */
export type CoordinatorTitleInfo =
  | { kind: "legacy" }
  | { kind: "main" | "adhoc"; hash: string; instanceId: string };

const HASH_RE = /^[0-9a-f]{8}$/;

/**
 * Startup command for a coordinator terminal: print OUR title as an OSC-0
 * sequence, then park.
 *
 * Why this exists: a terminal's listed title is whatever wrote to it LAST.
 * The `--title` flag only seeds it — an interactive shell immediately
 * overwrites the title with its own (zsh emits `cwd`), so a coordinator
 * created as a plain shell becomes undiscoverable a second after creation,
 * and so do its leftovers for uninstall. Our coordinator is a pure identity
 * pane — nothing ever types into it, it only exists so mutating RPCs have a
 * live `--from` handle — so instead of a shell we run a command that (a)
 * sets the title to exactly `coordinatorTitle(ws)` and (b) `exec`s a process
 * that never exits. With nothing else writing, the title sticks for the
 * terminal's whole life, which is what title-based reuse, conflict detection
 * and uninstall cleanup all key off.
 */
export function coordinatorTerminalCommand(
  title: string,
  backendPid: number = process.pid,
): string {
  // Single-quoted printf argument: the title's charset is ours ([a-z0-9 ·-]),
  // so quoting is only about robustness. `exec` replaces the shell so nothing
  // can rewrite the title afterward.
  //
  // The exec'd watcher ties the pane's lifetime to THIS backend process: the
  // old `exec sleep infinity` parked the pane forever, so a crashed or killed
  // viewer left its coordinator terminal behind — still connected, holding
  // the workspace's coordinator slot and (once bound) fencing the Run —
  // until a manual `npx orca-orchestration-launcher uninstall`. The watcher is deliberately
  // plain POSIX (sh + `kill -0` + `sleep`; no GNU `tail --pid`, no procfs)
  // so the same command works wherever Orca does. `kill -0` never signals:
  // it is the documented existence probe, so the loop is a silent 2-second
  // heartbeat. When this process exits — clean stop, crash, kill -9 — the
  // next probe fails and the pane's process exits with it, closing the
  // terminal. The watcher must run as the same user as the backend (it
  // always does: the backend spawns the CLI that creates the pane); a
  // recycled PID could in principle outlive us, which merely defers the
  // cleanup to uninstall — it never keeps a dead viewer's pane alive past a
  // reboot.
  return `printf '\\033]0;%s\\007' '${title}' && exec sh -c 'while kill -0 ${backendPid} 2>/dev/null; do sleep 2; done'`;
}

/** Decompose a terminal title into our coordinator identity, or null. */
export function parseCoordinatorTitle(title: string): CoordinatorTitleInfo | null {
  if (!title.startsWith(COORDINATOR_TITLE)) return null;
  const rest = title.slice(COORDINATOR_TITLE.length);
  if (rest === "") return { kind: "legacy" };
  if (!rest.startsWith(TITLE_SEP)) return null;
  const parts = rest.slice(TITLE_SEP.length).split(TITLE_SEP);
  if (parts.length === 2 && HASH_RE.test(parts[0]) && HASH_RE.test(parts[1])) {
    return { kind: "main", hash: parts[0], instanceId: parts[1] };
  }
  if (
    parts.length === 3 &&
    HASH_RE.test(parts[0]) &&
    HASH_RE.test(parts[1]) &&
    /^adhoc-\d+$/.test(parts[2])
  ) {
    return { kind: "adhoc", hash: parts[0], instanceId: parts[1] };
  }
  // Carries our prefix but an unrecognized shape — not ours to interpret.
  return null;
}

/**
 * Get (or create) the plain shell terminal this viewer uses as its coordinator
 * identity. It runs no agent — it exists purely so mutating RPCs have a live
 * pane to attribute `--from` to.
 *
 * Scoping (Phase 2): the title pins the workspace hash, so two viewers on
 * DIFFERENT workspaces each get their own coordinator and can never adopt each
 * other's terminal. A connected main coordinator for the SAME workspace but a
 * DIFFERENT instance id is another live viewer — reusing it would file our Run
 * bindings under its pane, and closing it would fence a working viewer, so
 * neither happens: we fail with `coordinator_conflict` and leave it alone.
 * Only this process's own terminal (same hash + same instance id) is reused.
 *
 * Note `worker-start --worktree current` resolves "current" against THIS
 * terminal's worktree, not the server's cwd, so the coordinator has to live in
 * the worktree the workers should run in.
 */
export async function ensureCoordinatorTerminal(
  worktree?: string,
  ws: OrcaWorkspace = currentWorkspace(),
): Promise<string> {
  const title = coordinatorTitle(ws);
  const connected = (await listTerminals()).filter((t) => t.connected);

  const parsed = connected
    .map((t) => ({ terminal: t, info: parseCoordinatorTitle(t.title) }))
    .filter((x): x is { terminal: OrcaTerminal; info: CoordinatorTitleInfo } => x.info !== null);

  // Our own terminal from earlier in this process — the cheap restart of a
  // repeated call.
  if (parsed.some((x) => x.info.kind === "main" && x.info.hash === ws.hash && x.info.instanceId === ws.instanceId)) {
    const mine = connected.find((t) => t.title === title);
    if (mine) return mine.handle;
  }

  // Another live viewer coordinating this exact workspace. Report it and stop:
  // "who is coordinating workspace X" must have exactly one answer.
  const foreign = parsed.find(
    (x) => x.info.kind === "main" && x.info.hash === ws.hash && x.info.instanceId !== ws.instanceId,
  );
  if (foreign) {
    const otherInstance = (foreign.info as { instanceId: string }).instanceId;
    throw new OrcaCliError(
      `Another orca-dag viewer (instance ${otherInstance}) is already coordinating this workspace ` +
        `(${ws.dir}) — its coordinator terminal is "${foreign.terminal.title}" (${foreign.terminal.handle}). ` +
        `Close that viewer first, or start this one against a different workspace.`,
      "coordinator_conflict",
    );
  }

  // A pre-Phase-2 viewer (or its crashed leftover) with the old unscoped title.
  // It may or may not be on this workspace — the title can't say — so refuse
  // rather than guess, and point at the cleanup command.
  const legacy = parsed.find((x) => x.info.kind === "legacy");
  if (legacy) {
    throw new OrcaCliError(
      `An unscoped "orca-dag coordinator" terminal from an older orca-dag is still connected ` +
        `(${legacy.terminal.handle}). It predates workspace scoping, so this viewer can't tell whether ` +
        `it belongs to this workspace. Close it (or run \`npx orca-orchestration-launcher uninstall\` to clean up leftover ` +
        `coordinators) and start again.`,
      "coordinator_conflict",
    );
  }

  const created = await runOrca<{ terminal?: { handle?: string } }>([
    "terminal",
    "create",
    "--worktree",
    worktree ?? getOrcaRuntime().worktree,
    "--title",
    title,
    // Park with our title instead of an interactive shell — see
    // coordinatorTerminalCommand for why the title has to defend itself.
    "--command",
    coordinatorTerminalCommand(title),
  ]);
  const handle = created.terminal?.handle;
  if (!handle) throw new OrcaCliError("orca terminal create returned no coordinator handle");
  return handle;
}

/**
 * A single-use coordinator terminal for one ad-hoc mutation (gate resolve,
 * run-create). Unique title on purpose: `ensureCoordinatorTerminal` dedupes by
 * exact title, and reusing — or worse, closing — the loop's own terminal from
 * an ad-hoc path would fence and then kill a running coordinator. The title
 * carries the same workspace hash + instance id so attribution stays possible,
 * but the `adhoc-N` tail keeps it out of the main-terminal reuse/conflict
 * matching entirely.
 */
let tempSeq = 0;
export async function createTempCoordinatorTerminal(
  worktree?: string,
  ws: OrcaWorkspace = currentWorkspace(),
): Promise<string> {
  const title = `${COORDINATOR_TITLE}${TITLE_SEP}${ws.hash}${TITLE_SEP}${ws.instanceId}${TITLE_SEP}adhoc-${++tempSeq}`;
  const created = await runOrca<{ terminal?: { handle?: string } }>([
    "terminal",
    "create",
    "--worktree",
    worktree ?? getOrcaRuntime().worktree,
    "--title",
    title,
    // Same parked-title trick as the main coordinator — adhoc terminals are
    // also identity-only, and if one leaks (crash mid-request) uninstall must
    // still find it by title.
    "--command",
    coordinatorTerminalCommand(title),
  ]);
  const handle = created.terminal?.handle;
  if (!handle) throw new OrcaCliError("orca terminal create returned no adhoc handle");
  return handle;
}

/** Close a terminal. Best-effort: it may already be gone. */
export async function closeTerminal(handle: string): Promise<void> {
  try {
    await runOrca(["terminal", "close", "--terminal", handle]);
  } catch {
    /* already closed */
  }
}

/**
 * Close a terminal and REPORT failures instead of swallowing them. Used only
 * where the completion boundary (plan §6.2.6) says a cleanup error must reach
 * the UI: the coordinator terminal at finalize. Everywhere else (teardown of
 * terminals that may legitimately be gone already) keeps best-effort
 * `closeTerminal`.
 */
export async function closeTerminalStrict(handle: string): Promise<void> {
  await runOrca(["terminal", "close", "--terminal", handle]);
}

/**
 * Bring one exact terminal to the foreground in the Orca UI
 * (`terminal switch --terminal <handle>`).
 *
 * UI FOCUS ONLY: this changes which terminal tab is active, nothing else. It
 * is not a lifecycle action — it never claims liveness, never settles a
 * Dispatch, and never closes anything (and closing a pane is NEVER a
 * substitute for a worker lifecycle decision — stop/abandon/release prove
 * their own outcomes through Orca receipts, `terminal close` proves nothing).
 * The handle must be the exact runtime-issued string (from `terminal list`,
 * a worker row, or a receipt); the adapter never constructs or "fixes" one.
 */
export interface TerminalFocusReceipt {
  /** Echo of the exact handle that was focused. */
  handle: string;
  /** The runtime's verbatim result. */
  raw: Record<string, unknown>;
}

export async function focusTerminal(handle: string): Promise<TerminalFocusReceipt> {
  if (!handle.trim()) {
    // An empty handle would let the CLI resolve some ambient target — exactly
    // the "focus whatever happens to be there" behavior the exact-selector
    // contract forbids. Fail here, before anything is spawned.
    throw new OrcaCliError(
      "terminal switch requires the exact runtime-issued terminal handle",
      "invalid_argument",
    );
  }
  const result = await runOrca<Record<string, unknown>>(["terminal", "switch", "--terminal", handle]);
  return { handle, raw: asRecord(result) };
}

// --- Readiness (Phase 2) ----------------------------------------------------
//
// The viewer can only *execute* a DAG against the Orca 1.4.205 supervised-
// worker contract. Anything older that still speaks the 1.4.160 Run/Task/
// Dispatch model can keep rendering Runs, tasks and gates — view-only — while
// every mutation surface (Run start, gate resolution, reset) disables itself
// with an actionable reason. Detecting this beats failing confusingly later:
// on an old runtime, `worker-start` would reject flags it doesn't know, and
// the failure would surface mid-DAG instead of at startup.

/** Orca version that introduced the supervised Dispatch contract this viewer drives. */
export const MIN_EXECUTION_VERSION = "1.4.205";
/** Oldest Orca whose Run/Task/Dispatch model the viewer can still render. */
export const MIN_VIEW_VERSION = "1.4.160";

export interface OrcaReadiness {
  /** Resolved CLI, as it will be spawned (e.g. `orca-ide` or `/path/orca --flag`). */
  cli: string;
  workspace: string;
  worktree: string;
  /** Parsed `major.minor.patch` from `--version`; null when undetectable. */
  version: string | null;
  /** True only when the runtime supports the execution contract. */
  executionEnabled: boolean;
  /** Actionable explanation when execution is unavailable, else null. */
  reason: string | null;
  /** When the probe last ran (readiness is cached briefly server-side). */
  checkedAt?: number;
}

/** Numeric dotted-version compare: negative/0/positive like `<=>`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Pure classification of a readiness probe. Split from the spawn so every
 * branch (missing CLI, unparseable output, each version band) is testable
 * without an Orca on PATH.
 */
export function evaluateReadiness(
  version: string | null,
  probeError: string | null,
): { executionEnabled: boolean; reason: string | null } {
  if (version === null) {
    const detail = probeError
      ? `Probing it failed: ${probeError}`
      : "Its --version output was not a recognizable x.y.z.";
    return {
      executionEnabled: false,
      reason:
        `Orca CLI not usable${probeError ? "" : " (unparseable version)"}. ${detail} ` +
        `Install Orca ${MIN_EXECUTION_VERSION}+, make sure it is on PATH, or set ORCA_CLI_COMMAND ` +
        `to the exact binary. The viewer stays open in view-only mode.`,
    };
  }
  if (compareVersions(version, MIN_EXECUTION_VERSION) < 0) {
    if (compareVersions(version, MIN_VIEW_VERSION) < 0) {
      return {
        executionEnabled: false,
        reason:
          `Orca ${version} is too old for this viewer: viewing needs ${MIN_VIEW_VERSION}+ and ` +
          `execution needs ${MIN_EXECUTION_VERSION}+. Upgrade Orca to enable Run/gate/worker controls.`,
      };
    }
    return {
      executionEnabled: false,
      reason:
        `Orca ${version} is view-only here: execution needs the supervised-worker contract from ` +
        `Orca ${MIN_EXECUTION_VERSION}+. Browsing Runs, tasks and gates still works; upgrade Orca ` +
        `to enable Run/gate/worker controls.`,
    };
  }
  return { executionEnabled: true, reason: null };
}

const READINESS_TTL_MS = 30_000;
let readinessCache: OrcaReadiness | null = null;

/** `--version` output is plain text, not the JSON envelope runOrca unwraps. */
async function runOrcaPlain(args: string[], timeoutMs: number): Promise<string> {
  const { command, workspace } = getOrcaRuntime();
  const res = await pExecFile(command.executable, [...command.prefixArgs, ...args], {
    cwd: workspace.dir,
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return res.stdout;
}

/**
 * Probe the resolved CLI once and report whether execution may run. Result is
 * cached briefly — the UI polls this, and the resolved command/workspace are
 * fixed for the process lifetime anyway.
 */
export async function checkReadiness(force = false): Promise<OrcaReadiness> {
  if (!force && readinessCache?.checkedAt && Date.now() - readinessCache.checkedAt < READINESS_TTL_MS) {
    return readinessCache;
  }
  const { command, workspace, worktree } = getOrcaRuntime();
  let version: string | null = null;
  let probeError: string | null = null;
  try {
    const stdout = await runOrcaPlain(["--version"], 15_000);
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    version = match ? match[1] : null;
    if (!version) probeError = null;
  } catch (err) {
    version = null;
    const e = err as { message?: string; code?: string };
    probeError =
      e.code === "ENOENT"
        ? `no executable "${formatCommand(command)}" on PATH`
        : String(e.message ?? err).slice(0, 300);
  }
  const verdict = evaluateReadiness(version, probeError);
  readinessCache = {
    cli: formatCommand(command),
    workspace: workspace.dir,
    worktree,
    version,
    checkedAt: Date.now(),
    ...verdict,
  };
  return readinessCache;
}

// --- Coordinator inbox + worker lifecycle (Phase 3) -------------------------
//
// Orca 1.4.205 gives the coordinator a durable, FIFO Run inbox (Deliveries) and
// explicit worker terminal accounting. These adapters are the only place that
// knows the wire shapes; the coordinator consumes the typed results.
//
// Two contracts drive the design (verified against the 1.4.205 CLI):
//
//  - A consuming `check` returns the OLDEST unacknowledged FIFO Delivery —
//    always the whole batch, never filtered by `--types` (that flag is only the
//    wake condition for `--wait`). The same Delivery replays until
//    `check --ack <deliveryId>`, so callers must process every row before
//    acknowledging, and must tolerate seeing a batch again (`replayed: true`).
//  - `worker-release` / `worker-retain` / `worker-stop` / `worker-read` take a
//    bare `--dispatch` (no `--from`): terminal ownership follows the Dispatch,
//    not the calling terminal. Only `release_unknown` exits non-zero; every
//    other release outcome is a 0-exit receipt.

/** One inbox row from `orchestration check`. */
export interface OrcaMessage {
  id: string;
  run_id: string;
  delivery_contract: string | null;
  from_handle: string;
  to_handle: string | null;
  subject: string;
  body: string;
  /** status | dispatch | worker_done | merge_ready | escalation | handoff | decision_gate | question | heartbeat */
  type: string;
  priority: string;
  thread_id: string | null;
  /** JSON-encoded orchestration payload (worker_done carries taskId/dispatchId/outcome), or null. */
  payload: string | null;
  created_at: string;
  delivered_at: string | null;
  /**
   * Global `orchestration inbox` includes this durable read marker. It is not
   * present on every older runtime/check receipt, so consumers must treat an
   * absent value as unknown rather than unread. The Activity projection uses
   * only a positive marker to reconstruct externally-consumed coordinator
   * checks; it never infers a check from absence.
   */
  read?: 0 | 1 | boolean;
}

/** A FIFO Delivery: the unit the coordinator processes and acknowledges. */
export interface OrcaDelivery {
  runId: string;
  /** Present when the consuming terminal itself is a Dispatch mailbox. */
  dispatchId?: string | null;
  /** Null when nothing was pending (or only an ack ran). */
  deliveryId: string | null;
  messages: OrcaMessage[];
  count: number;
  /** True when this is the same unacknowledged batch as a previous check. */
  replayed: boolean;
  /** Set when this call acknowledged a prior batch. */
  acknowledged: string | null;
  timedOut: boolean;
  cancelled: boolean;
  connectionLost: boolean;
}

/**
 * `worker_done` payload, as the runtime serializes `send --type worker_done
 * --task-id --dispatch-id --outcome`. Keys are camelCase (verified: a rejected
 * worker_done is reflected to its sender with exactly this shape). Anything
 * absent is treated as unknown — never inferred.
 */
export interface WorkerDonePayload {
  taskId?: string;
  dispatchId?: string;
  outcome?: string;
  phase?: string;
  filesModified?: string[];
  reportPath?: string;
  /** Set when the runtime itself refused to settle this worker_done. */
  _orcaLifecycleRejection?: { code: string; reason: string };
}

export function parseWorkerDonePayload(message: OrcaMessage): WorkerDonePayload | null {
  if (!message.payload) return null;
  try {
    const parsed = JSON.parse(message.payload) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as WorkerDonePayload;
  } catch {
    return null;
  }
}

export interface CheckInboxOpts {
  /** The coordinator terminal handle (`--terminal`); its mailbox = bound Run inbox. */
  from: string;
  /** Wake filter for `--wait` (never filters the returned batch). */
  types?: string[];
  /** Block up to this long for a matching message; 0/undefined = return immediately. */
  waitMs?: number;
  /** Acknowledge this delivery id first (the "process, then ack" second half). */
  ack?: string;
}

export const ORCHESTRATION_INBOX_LIMIT = 5_000;

/**
 * Evidence about the bounded global `orchestration inbox` window a history
 * read came from (Phase 3). Orca's inbox command has no Run selector and no
 * pagination, so this viewer can only observe a window — and must say so:
 * a saturated window means older messages may exist that no read can reach,
 * which is exactly the case where "history looks complete" would be a lie.
 */
export interface OrcaInboxWindow {
  /** The window size this viewer requested (the CLI applies the same cap). */
  limit: number;
  /** Rows the global window returned BEFORE Run filtering. */
  observed: number;
  /**
   * True when the global window came back full. The selected Run may still
   * have few rows in it — saturation is a property of the global stream, and
   * it is the only honest trigger for an "older history may be missing"
   * warning. A window below the limit proves nothing beyond "everything the
   * runtime currently returns fits", which is why completeness is claimed
   * only within the observed window.
   */
  saturated: boolean;
}

/** One Run-scoped history read plus the window evidence it was observed in. */
export interface OrcaMessagePage {
  /** Strictly this Run's rows, filtered by exact `run_id` comparison. */
  messages: OrcaMessage[];
  window: OrcaInboxWindow;
}

/**
 * Read the durable, bidirectional message history for one Run without
 * consuming a Delivery, together with the global-window metadata the UI needs
 * to disclose history completeness (Phase 3 / epic A6).
 *
 * `check --all` only reads the selected recipient's mailbox, which means a
 * coordinator mailbox contains worker -> coordinator messages but cannot show
 * coordinator -> Dispatch messages sent by `reply` or `send`. Orca's global
 * `orchestration inbox` surface includes both directions and survives closed
 * terminals, so it is the correct transcript source for Chat. The command has
 * no Run selector or pagination; request a deliberately generous bounded
 * window, count the rows BEFORE Run filtering (foreign rows occupy the window
 * too — a saturated window is global evidence, not a per-Run one), then treat
 * the exact `run_id` comparison as a security and correctness boundary. A
 * mixed-workspace row must never appear in this Run.
 */
export async function listRunMessagePage(
  runId: string,
  opts?: { limit?: number },
): Promise<OrcaMessagePage> {
  const limit = opts?.limit ?? ORCHESTRATION_INBOX_LIMIT;
  const result = await runOrca<{ messages?: unknown[] }>([
    "orchestration",
    "inbox",
    "--limit",
    String(limit),
  ]);
  if (!Array.isArray(result.messages)) {
    throw new OrcaCliError("inbox returned an invalid messages receipt", "invalid_message_history");
  }
  // Counted before filtering: another Run's traffic filling the window hides
  // THIS Run's older rows exactly as much as this Run's own traffic would.
  const observed = result.messages.length;
  const messages = result.messages.filter(
    (row): row is OrcaMessage =>
      Boolean(row) &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      (row as { run_id?: unknown }).run_id === runId,
  );
  return { messages, window: { limit, observed, saturated: observed >= limit } };
}

/**
 * Message rows only — the page for callers (reply identity, health counts)
 * that do not render history completeness. Kept as a thin wrapper so the
 * window evidence lives in exactly one place.
 */
export async function listRunMessages(runId: string): Promise<OrcaMessage[]> {
  return (await listRunMessagePage(runId)).messages;
}

/**
 * Consume (or acknowledge-then-consume) the coordinator's FIFO inbox.
 *
 * `--wait` needs an execFile timeout ABOVE the requested wait — the CLI also
 * emits stderr keepalives every 15s, which execFile buffers and discards. The
 * wait itself is bounded by the CLI's own `--timeout-ms`; the spawn cap just
 * has to stay out of its way.
 */
export function checkInbox(opts: CheckInboxOpts): Promise<OrcaDelivery> {
  const args = ["orchestration", "check", "--terminal", opts.from];
  if (opts.ack) args.push("--ack", opts.ack);
  if (opts.waitMs && opts.waitMs > 0) {
    args.push("--wait", "--timeout-ms", String(Math.round(opts.waitMs)));
  }
  if (opts.types?.length) args.push("--types", opts.types.join(","));
  return runOrca<OrcaDelivery>(args, { timeoutMs: (opts.waitMs ?? 0) + 60_000 });
}

/** Reply to a question/escalation from the coordinator (marks it handled). */
export async function replyToMessage(messageId: string, body: string, from: string): Promise<void> {
  await runOrca(["orchestration", "reply", "--id", messageId, "--body", body, "--from", from]);
}

/**
 * Send durable, attempt-specific guidance from the live coordinator.
 *
 * A terminal handle is intentionally not accepted as the destination. Orca's
 * stable address is the Dispatch: remote execution may move the process while
 * `dispatch:<id>` continues to route to the authoritative attempt. A successful
 * receipt proves enqueue only; it never proves that the worker read the note.
 */
export async function sendCoordinatorMessage(opts: {
  runId: string;
  taskId: string;
  dispatchId: string;
  subject: string;
  body: string;
  from: string;
  threadId?: string;
}): Promise<Record<string, unknown>> {
  const args = [
    "orchestration",
    "send",
    "--to",
    `dispatch:${opts.dispatchId}`,
    "--run",
    opts.runId,
    "--from",
    opts.from,
    "--subject",
    opts.subject,
    "--body",
    opts.body,
    "--type",
    "status",
    "--task-id",
    opts.taskId,
    "--dispatch-id",
    opts.dispatchId,
  ];
  if (opts.threadId) args.push("--thread-id", opts.threadId);
  return runOrca<Record<string, unknown>>(args);
}

/**
 * Send one deliberate GROUP message from the live coordinator.
 *
 * Recipient safety is structural: `audience` arrives already allowlisted by
 * `validateGroupAudience` (Run groups, harness groups, or an exact discovered
 * `@worktree:<id>`), and this adapter is the only place a `--to` group value
 * is ever composed — never from raw client text. Orca scopes group mail to
 * the sender's own Run (the `--run` flag repeats that scope for the receipt),
 * and per the 1.4.206 contract a successful receipt proves the message was
 * durably ENQUEUED for the group — never that any worker read or acted on it.
 * `--task-id`/`--dispatch-id` are deliberately absent: a group message has no
 * single attempt, and threading one in would misattribute Run-level guidance
 * to one Task.
 */
export async function sendCoordinatorGroupMessage(opts: {
  runId: string;
  /** Allowlisted group address (`@all`, `@idle`, `@<harness>`, `@worktree:<id>`). */
  audience: string;
  subject: string;
  body: string;
  /** `status` | `question` — lifecycle types never reach this adapter. */
  type: string;
  priority?: string | null;
  from: string;
}): Promise<Record<string, unknown>> {
  const args = [
    "orchestration",
    "send",
    "--to",
    opts.audience,
    "--run",
    opts.runId,
    "--from",
    opts.from,
    "--subject",
    opts.subject,
    "--body",
    opts.body,
    "--type",
    opts.type,
  ];
  if (opts.priority) args.push("--priority", opts.priority);
  return runOrca<Record<string, unknown>>(args);
}

/** One estimated recipient behind a group audience, from current Run facts. */
export interface AudienceRecipientEstimate {
  taskId: string;
  dispatchId: string | null;
  label: string | null;
  harness: string | null;
}

/** One offered audience with the Run's own estimate of who it would reach. */
export interface AudienceOption {
  /** The exact group address (the only string the client may ever send back). */
  address: string;
  kind: "run" | "harness" | "worktree";
  label: string;
  estimatedRecipients: AudienceRecipientEstimate[];
  /**
   * Always false today: Orca exposes no read API for group membership, so
   * every count is derived from worker-list facts and MUST render as an
   * estimate. If a future runtime proves exact recipients, flip this per
   * audience — never default it to true.
   */
  exact: false;
}

/** The worker facts an audience estimate is built from (already Run-scoped). */
function recipientOf(worker: OrcaWorkerRow): AudienceRecipientEstimate {
  return {
    taskId: worker.taskId,
    dispatchId: worker.dispatchId,
    label:
      worker.projection?.launch?.worktree?.trim() ||
      worker.projection?.workspace?.trim() ||
      worker.projection?.provider?.id?.trim() ||
      null,
    harness: worker.projection?.launch?.agent ?? worker.projection?.provider?.id ?? null,
  };
}

/**
 * Estimate who each supported group audience would reach, from the current
 * Run's worker facts. Orca documents that group addresses reach "the live
 * Dispatches of your own Run" (and that `@worktree:<id>` additionally includes
 * workspace coordinators), but exposes no membership read — so these counts
 * are honest estimates, labeled `exact: false`, and the harness/worktree
 * breakdown uses only what the fleet rows themselves report.
 */
export function previewRunAudiences(input: {
  workers: OrcaWorkerRow[];
  worktrees: OrcaWorktreeRow[];
}): AudienceOption[] {
  // Group mail reaches live Dispatches: a settled or fenced row is not a
  // recipient, no matter how recently it dispatched.
  const active = input.workers.filter((worker) => worker.dispatchStatus === "dispatched");
  const all = active.map(recipientOf);

  // "@idle" targets workers parked waiting rather than working. Fleet rows
  // only hint at this (stage activity/attention), so the subset is an even
  // softer estimate — never a claimed exact idle list.
  const idleSignal = (worker: OrcaWorkerRow): boolean => {
    const activity = `${worker.projection?.stage?.activity ?? ""} ${worker.projection?.stage?.detail ?? ""}`.toLowerCase();
    const waiting = worker.projection?.attention?.categories?.includes("input") ?? false;
    return waiting || /\bidle\b|\bwaiting\b/.test(activity);
  };
  const idle = active.filter(idleSignal).map(recipientOf);

  const byHarness = (harness: string): AudienceRecipientEstimate[] =>
    active
      .filter(
        (worker) =>
          (worker.projection?.launch?.agent ?? worker.projection?.provider?.id ?? null) === harness,
      )
      .map(recipientOf);

  const byWorktree = (id: string): AudienceRecipientEstimate[] =>
    active
      .filter(
        (worker) =>
          worker.projection?.workspace === id || worker.projection?.launch?.worktree === id,
      )
      .map(recipientOf);

  const options: AudienceOption[] = [
    {
      address: "@all",
      kind: "run",
      label: "All active workers",
      estimatedRecipients: all,
      exact: false,
    },
    {
      address: "@idle",
      kind: "run",
      label: "Idle workers",
      estimatedRecipients: idle,
      exact: false,
    },
  ];
  // Harness groups are offered from the same allowlist the server validates
  // against — but only those with at least one active worker, so the picker
  // never offers a group that provably reaches nobody in THIS Run.
  for (const harness of KNOWN_HARNESSES) {
    const recipients = byHarness(harness);
    if (recipients.length === 0) continue;
    options.push({
      address: `@${harness}`,
      kind: "harness",
      label: `${harness} workers`,
      estimatedRecipients: recipients,
      exact: false,
    });
  }
  // Worktree audiences come ONLY from exact discovered identities. The id is
  // the opaque worktree identity Orca itself reported — never a path or a
  // display name reassembled by the client.
  for (const worktree of input.worktrees) {
    options.push({
      address: `${WORKTREE_AUDIENCE_PREFIX}${worktree.id}`,
      kind: "worktree",
      label: worktree.displayName || worktree.id,
      estimatedRecipients: byWorktree(worktree.id),
      exact: false,
    });
  }
  return options;
}

/** Terminal accounting state of one worker, from `worker-list`. */
export type TerminalState =
  | "active"
  | "reclaimable"
  | "retained"
  | "release_pending"
  | "release_unknown"
  | "released";

/** One row of `orchestration worker-list` (fleet-level worker accounting). */
export interface OrcaWorkerRow {
  dispatchId: string;
  taskId: string;
  runId: string;
  /** "supervised" for worker-start attempts, "unsupervised" for tracking dispatches. */
  workerState: string;
  dispatchStatus: string;
  agentTerminalHandle: string | null;
  terminalState: TerminalState | string;
  /** Terminal resource the row still holds (Phase 2); absent = unknown. */
  resource?: { state: string; reason: string | null } | null;
  projection: {
    id?: string | null;
    /** "worker" | "lead" | ... — presentation hint, absent on older runtimes. */
    role?: string | null;
    parent?: string | null;
    workspace?: string | null;
    outcome: string | null;
    liveness: { verdict: string; reason: string | null } | null;
    /**
     * How the fleet itself grounds this row (1.4.206). `liveStatus:
     * "unavailable"` on a durable row is exactly the capability-gap evidence
     * the Phase 2 presentation merge is allowed to react to — verbatim, never
     * interpreted.
     */
    evidence?: {
      durable?: boolean | null;
      liveStatus?: string | null;
      lastObservedAt?: string | null;
    } | null;
    /** Fleet-recorded resource accounting for this row (absent = unknown). */
    resource?: { state: string; reason: string | null } | null;
    /**
     * Agent-wait evidence (Phase 5): what stage the worker/dispatch is in,
     * what the agent is doing. Optional per row — absent means "unknown",
     * never "dead".
     */
    stage: { worker: string; dispatch: string; detail: string | null; activity: string } | null;
    nextAction: { kind: string; argv: string[] } | null;
    attention: { categories: string[]; requiresAction: boolean } | null;
    /**
     * Execution host that owns this worker's process/filesystem/transcript
     * facts (Phase 6). `local` rows say `{ kind: "local", id: "local" }`; a
     * connected-server row names its environment. Optional per row — absent
     * means unknown, which the UI renders as unverifiable placement, never as
     * a synthesized local row.
     */
    host?: { kind: string; id: string } | null;
    /**
     * Launch preferences as the runtime actually applied them (Phase 5), when
     * the row carries them. Absent → we do NOT claim the requested values
     * were honored; the UI shows "unknown" instead of a guess.
     */
    launch?: {
      agent?: string | null;
      model?: string | null;
      effort?: string | null;
      worktree?: string | null;
      terminal?: string | null;
      /** Execution server the row reports (Phase 6); absent = unknown. */
      on?: string | null;
    } | null;
    /**
     * Current Orca builds also expose provider identity independently of the
     * optional launch echo. This matters for externally-started workers: the
     * viewer has no saved harness preference for them, but can still display
     * the runtime-observed agent/model without guessing from its defaults.
     */
    provider?: { id?: string | null; model?: string | null } | null;
  } | null;
}

/**
 * The three liveness verdicts the plan lets the UI render (hard constraint).
 * Anything else a runtime reports — new strings, localized variants, null —
 * collapses to `unverifiable`: absence of a known-live verdict is never
 * allowed to read as `exited` (plan §5: never infer exit from missing status).
 */
export type LivenessVerdict = "live" | "unverifiable" | "exited";

export function normalizeLiveness(verdict: string | null | undefined): LivenessVerdict {
  return verdict === "live" || verdict === "exited" ? verdict : "unverifiable";
}

// --- Phase 2: durable worker operations (worker-show detail) -----------------
//
// `worker-show --dispatch` is the exact-worker inspection surface: one
// Dispatch's durable accounting row, its Dispatch/Worker records, the PTY
// terminal facts, and an `observation` object with agent-wait evidence.
// Verified against the 1.4.206 CLI (receipt keys: dispatch, worker,
// projection, terminal, observation, terminalResource). Everything below
// parses tolerantly — an older runtime simply reports fewer layers, and every
// absent layer renders as "unknown", never as a synthesized negative.

/**
 * The runtime-documented fleet capability gaps that allow merging a
 * `worker-show` observation into the presentation. These are the only reasons
 * under which a positive PTY observation may QUALIFY the display — never the
 * fleet verdict itself (hard plan constraint: no promotion of PTY liveness
 * into supervised fleet liveness).
 */
export const FLEET_CAPABILITY_GAP_REASONS: ReadonlySet<string> = new Set([
  "missing_status",
  "capability_unsupported",
]);

/** The `worker-show` observation layer (exact execution-host evidence). */
export interface WorkerObservation {
  /** The observation verdict for this worker's terminal, verbatim. */
  status: string | null;
  /**
   * True when the receipt provably observed THIS dispatch's terminal (not a
   * shared or reused pane). Absent/null = NOT proven exact, and only a proven
   * exact observation may ever qualify the presentation.
   */
  exactWorker: boolean | null;
  /**
   * Agent-wait evidence, tri-state per the CLI contract:
   *  - object → the worker is parked on a prompt only a human can answer;
   *  - null   → Orca looked and found no wait (healthy);
   *  - absent (key missing) → this host never looked — UNKNOWN, and never
   *    "not waiting" (a waiting worker is healthy, not failed).
   */
  agentWait?: WorkerAgentWait | null;
}

/** Human-readable agent-wait evidence, parsed tolerantly from the receipt. */
export interface WorkerAgentWait {
  /** Provenance kind the runtime reported (hook | prompt-text | title | …). */
  kind: string | null;
  /** The human-readable explanation, when the receipt carries one. */
  detail: string | null;
  /** Everything else the receipt carried, verbatim (diagnostics section). */
  raw: Record<string, unknown>;
}

/** PTY-level terminal facts from `worker-show` (distinct from fleet liveness). */
export interface WorkerTerminalFacts {
  handle: string | null;
  title: string | null;
  connected: boolean | null;
  orphaned: boolean | null;
  worktreePath: string | null;
  branch: string | null;
  executionHostId: string | null;
  /** The runtime-observed agent identity (e.g. "opencode"), verbatim. */
  agentIdentity: string | null;
  lastOutputAt: number | null;
  /** Bounded PTY tail from the receipt — a hint, never a transcript source. */
  preview: string | null;
}

/**
 * Presentation-only merge of fleet liveness with the exact observation.
 *
 * Invariants (plan §Scope):
 *  - `verdict` is ALWAYS the normalized fleet verdict — never upgraded to
 *    "live" from PTY evidence;
 *  - `qualifiedWorking` is true only when (a) the fleet's own reason for not
 *    deciding is one of the documented capability gaps, (b) the observation
 *    positively says "live", and (c) `exactWorker` is positively true — an
 *    absent exactWorker flag means the observation cannot be pinned to this
 *    dispatch and must not qualify;
 *  - both evidence layers stay visible: the UI renders the qualified label
 *    alongside the fleet reason, so nothing is silently replaced.
 */
export interface WorkerLivenessPresentation {
  verdict: LivenessVerdict;
  fleetReason: string | null;
  qualifiedWorking: boolean;
  qualifiedReason: string | null;
  observationStatus: string | null;
}

export function presentWorkerLiveness(input: {
  fleetVerdict?: string | null;
  fleetReason?: string | null;
  observation?: { status?: unknown; exactWorker?: unknown } | null;
}): WorkerLivenessPresentation {
  const verdict = normalizeLiveness(input.fleetVerdict);
  const fleetReason = typeof input.fleetReason === "string" ? input.fleetReason : null;
  const observationStatus =
    typeof input.observation?.status === "string" ? input.observation.status : null;
  const base: WorkerLivenessPresentation = {
    verdict,
    fleetReason,
    qualifiedWorking: false,
    qualifiedReason: null,
    observationStatus,
  };
  if (!fleetReason || !FLEET_CAPABILITY_GAP_REASONS.has(fleetReason)) return base;
  if (observationStatus !== "live") return base;
  // exactWorker must be POSITIVELY true; absent/false both fail closed.
  if (input.observation?.exactWorker !== true) return base;
  return { ...base, qualifiedWorking: true, qualifiedReason: fleetReason };
}

/** One `orchestration worker-show` receipt, normalized for the detail view. */
export interface WorkerDetailView {
  dispatchId: string;
  runId: string | null;
  taskId: string | null;
  /** Exact worker-start options, when Orca retained them for this Dispatch. */
  launch: {
    agent: string;
    model: string | null;
    effort: string | null;
    /** Orca's resolved identity, never the relative `current` launch input. */
    resolvedWorktreeId: string | null;
  } | null;
  /** Durable accounting row — the same shape `worker-list` emits for this Dispatch. */
  fleet: OrcaWorkerRow | null;
  /** Dispatch record facts (attempt bookkeeping). */
  dispatch: {
    status: string | null;
    failureCount: number | null;
    lastFailure: string | null;
    terminationReason: string | null;
    dispatchedAt: string | null;
    completedAt: string | null;
    lastHeartbeatAt: string | null;
    retryOfDispatchId: string | null;
    depth: number | null;
  } | null;
  /** Supervised-worker record facts. */
  worker: {
    state: string | null;
    stage: string | null;
    setupState: string | null;
    lastError: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  } | null;
  /** PTY terminal facts — the observation layer, never fleet liveness. */
  terminal: WorkerTerminalFacts | null;
  /** Exact-worker observation incl. agent-wait evidence (tri-state agentWait). */
  observation: WorkerObservation | null;
  /** The Phase 2 presentation merge (fleet verdict + qualified observation). */
  liveness: WorkerLivenessPresentation;
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Parse `observation.agentWait` tolerantly; preserves the tri-state contract. */
function parseAgentWait(raw: unknown): WorkerAgentWait | null | undefined {
  if (raw === undefined) return undefined; // host never looked — unknown
  if (raw === null) return null; // looked, no wait found — healthy
  const record = asRecordOrNull(raw);
  if (!record) return null; // malformed → treat as "no wait evidence", never invented
  return {
    kind:
      stringOrNull(record.kind) ??
      stringOrNull(record.evidence) ??
      stringOrNull(record.source) ??
      stringOrNull(record.via),
    detail:
      stringOrNull(record.detail) ??
      stringOrNull(record.message) ??
      stringOrNull(record.promptText) ??
      stringOrNull(record.reason) ??
      stringOrNull(record.title),
    raw: record,
  };
}

/**
 * Inspect ONE worker in depth (`orchestration worker-show --dispatch`) and
 * normalize the receipt into the Phase 2 detail view. Returns null only when
 * the runtime reports the Dispatch unknown — an infrastructure failure keeps
 * its OrcaCliError so the UI can distinguish "no such worker" from "Orca is
 * unreachable". Read-only: safe to call for history, and safe whether or not
 * this viewer coordinates the Run.
 */
export async function showWorkerDetail(dispatchId: string): Promise<WorkerDetailView | null> {
  let result: Record<string, unknown>;
  try {
    result = await runOrca<Record<string, unknown>>([
      "orchestration",
      "worker-show",
      "--dispatch",
      dispatchId,
    ]);
  } catch (err) {
    const e = err as OrcaCliError;
    // A runtime refusal naming THIS dispatch unknown means "no such worker" —
    // an honest null. Codes are matched exactly so infrastructure failures
    // (cli_not_found, timeouts, garbled output) keep surfacing as errors the
    // UI can distinguish from "worker does not exist".
    if (e instanceof OrcaCliError) {
      if (e.code === "dispatch_not_found" || e.code === "worker_not_found") return null;
      if (e.code === null && /not found/i.test(e.message)) return null;
    }
    throw e;
  }
  const dispatch = asRecordOrNull(result.dispatch) ?? {};
  const worker = asRecordOrNull(result.worker) ?? {};
  const startOptions = asRecordOrNull(worker.startOptions);
  const launchOptions = asRecordOrNull(startOptions?.launch);
  const effectiveLaunch = asRecordOrNull(launchOptions?.effective);
  const launchAgent = stringOrNull(effectiveLaunch?.agent) ?? stringOrNull(startOptions?.agent);
  const terminal = asRecordOrNull(result.terminal);
  const observationRaw = asRecordOrNull(result.observation);
  const fleet = asRecordOrNull(result.projection);
  const observation: WorkerObservation | null = observationRaw
    ? {
        status: stringOrNull(observationRaw.status),
        exactWorker: booleanOrNull(observationRaw.exactWorker),
        // Preserve the tri-state ON the object: an absent key must stay absent
        // (undefined assigned explicitly would still own the property).
        ...(observationRaw.agentWait === undefined
          ? {}
          : { agentWait: parseAgentWait(observationRaw.agentWait) }),
      }
    : null;
  const normalizedFleet: OrcaWorkerRow | null = fleet
    ? {
        dispatchId: stringOrNull(fleet.dispatchId) ?? dispatchId,
        taskId: stringOrNull(fleet.taskId) ?? stringOrNull(dispatch.task_id) ?? "",
        runId: stringOrNull(fleet.runId) ?? "",
        workerState: stringOrNull(fleet.role) ?? stringOrNull(worker.state) ?? "unknown",
        dispatchStatus: stringOrNull(dispatch.status) ?? "unknown",
        agentTerminalHandle:
          stringOrNull(fleet.agentTerminalHandle) ??
          stringOrNull(worker.agentTerminalHandle) ??
          stringOrNull(terminal?.handle) ??
          null,
        terminalState: stringOrNull(fleet.terminalState) ?? "unknown",
        projection: fleet as unknown as OrcaWorkerRow["projection"],
      }
    : null;
  const liveness = presentWorkerLiveness({
    fleetVerdict: stringOrNull(asRecordOrNull(fleet?.liveness)?.verdict),
    fleetReason: stringOrNull(asRecordOrNull(fleet?.liveness)?.reason),
    observation,
  });
  return {
    dispatchId,
    runId: stringOrNull(fleet?.runId) ?? stringOrNull(dispatch.runId),
    taskId: stringOrNull(fleet?.taskId) ?? stringOrNull(dispatch.task_id),
    launch: launchAgent
      ? {
          agent: launchAgent,
          model: stringOrNull(effectiveLaunch?.model),
          effort: stringOrNull(effectiveLaunch?.effort),
          resolvedWorktreeId: stringOrNull(startOptions?.resolvedWorktreeId),
        }
      : null,
    fleet: normalizedFleet,
    dispatch: {
      status: stringOrNull(dispatch.status),
      failureCount: numberOrNull(dispatch.failureCount),
      lastFailure: stringOrNull(dispatch.lastFailure),
      terminationReason: stringOrNull(dispatch.terminationReason),
      dispatchedAt: stringOrNull(dispatch.dispatchedAt),
      completedAt: stringOrNull(dispatch.completedAt),
      lastHeartbeatAt: stringOrNull(dispatch.lastHeartbeatAt),
      retryOfDispatchId: stringOrNull(dispatch.retryOfDispatchId),
      depth: numberOrNull(dispatch.depth),
    },
    worker: {
      state: stringOrNull(worker.state),
      stage: stringOrNull(worker.stage),
      setupState: stringOrNull(worker.setupState),
      lastError: stringOrNull(worker.lastError),
      createdAt: stringOrNull(worker.createdAt),
      updatedAt: stringOrNull(worker.updatedAt),
    },
    terminal: terminal
      ? {
          handle: stringOrNull(terminal.handle),
          title: stringOrNull(terminal.title),
          connected: booleanOrNull(terminal.connected),
          orphaned: booleanOrNull(terminal.orphaned),
          worktreePath: stringOrNull(terminal.worktreePath),
          branch: stringOrNull(terminal.branch),
          executionHostId: stringOrNull(terminal.executionHostId),
          agentIdentity: stringOrNull(terminal.agentIdentity),
          lastOutputAt: numberOrNull(terminal.lastOutputAt),
          preview: stringOrNull(terminal.preview),
        }
      : null,
    observation,
    liveness,
  };
}

export async function listWorkers(
  runId: string,
  opts: { terminalState?: string; includeRemote?: boolean } = {},
): Promise<OrcaWorkerRow[]> {
  const workers: OrcaWorkerRow[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  /** Fail closed: an incomplete receipt must never look like empty history. */
  const invalidReceipt = (message: string): never => {
    throw new OrcaCliError(`worker-list returned an invalid receipt: ${message}`, "invalid_pagination");
  };

  // worker-list is capped at 100 rows per receipt. That cap matters for more
  // than fleet dashboards: a row is the durable proof that a Task has ever
  // dispatched, so returning only the newest page could make an older Task's
  // launch controls editable after a viewer restart. Preserve the historical
  // array contract for every caller while following Orca's opaque cursor
  // byte-for-byte until the snapshot is exhausted.
  for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
    const args = ["orchestration", "worker-list", "--run", runId];
    if (opts.terminalState) args.push("--terminal-state", opts.terminalState);
    // Phase 6: local fleet state is all worker-list reads by default; remote
    // workers (started with --on) are only visible with --include-remote, and
    // every remote row the host cannot observe reads unverifiable — never a
    // synthetic exit. The coordinator reconciles WITH this flag so a remote
    // Dispatch stays owned by its execution host through disconnect/reconnect.
    if (opts.includeRemote) args.push("--include-remote");
    args.push("--limit", "100");
    if (cursor) args.push("--cursor", cursor);

    const result = await runOrca<unknown>(args);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      invalidReceipt("result must be an object");
    }
    const receipt = result as Record<string, unknown>;
    if (!Array.isArray(receipt.workers)) {
      invalidReceipt("workers must be an array");
    }
    const page = receipt.page;
    if (!page || typeof page !== "object" || Array.isArray(page)) {
      invalidReceipt("page must be an object");
    }
    const pageObject = page as Record<string, unknown>;
    if (typeof pageObject.hasMore !== "boolean") {
      invalidReceipt("page.hasMore must be a boolean");
    }
    if (!Object.prototype.hasOwnProperty.call(pageObject, "nextCursor")) {
      invalidReceipt("page.nextCursor is required");
    }
    const hasMore = pageObject.hasMore as boolean;
    const rawNext = pageObject.nextCursor;
    if (rawNext !== null && typeof rawNext !== "string") {
      invalidReceipt("page.nextCursor must be a string or null");
    }
    const nextCursor = typeof rawNext === "string" && rawNext.length > 0 ? rawNext : null;
    if (hasMore && !nextCursor) {
      invalidReceipt(
        "page.hasMore=true reported more pages without a usable page.nextCursor; refusing to return truncated accounting.",
      );
    }
    if (!hasMore && rawNext !== null) {
      invalidReceipt("page.hasMore=false with a nextCursor is inconsistent; refusing to return an ambiguous page.");
    }

    const workerRows = receipt.workers as unknown[];
    for (const [index, rawWorker] of workerRows.entries()) {
      if (!rawWorker || typeof rawWorker !== "object" || Array.isArray(rawWorker)) {
        invalidReceipt(`workers[${index}] must be an object`);
      }
      const worker = rawWorker as Record<string, unknown>;
      for (const field of ["dispatchId", "taskId", "runId"] as const) {
        if (typeof worker[field] !== "string" || worker[field].trim().length === 0) {
          invalidReceipt(`workers[${index}].${field} must be a non-empty string`);
        }
      }
      // The --run flag is the authoritative scope, but keep the adapter's
      // returned contract honest even if a mixed-version/connected-server CLI
      // accidentally leaks a row from another Run. Rejecting (rather than
      // silently dropping) the row is important: otherwise the caller could
      // mistake partial history for complete accounting and unlock a Task.
      if (worker.runId !== runId) {
        invalidReceipt(`workers[${index}].runId ${JSON.stringify(worker.runId)} does not match ${JSON.stringify(runId)}`);
      }
      workers.push(worker as unknown as OrcaWorkerRow);
    }

    if (!hasMore) {
      return workers;
    }
    if (nextCursor === null) {
      // This is also checked above so the receipt is rejected before any
      // cursor is followed; the explicit branch narrows the opaque cursor for
      // TypeScript and keeps the invariant obvious to future edits.
      invalidReceipt(
        "page.hasMore=true reported more pages without a usable page.nextCursor; refusing to return truncated accounting.",
      );
    }
    // `invalidReceipt` above is `never`, but the value is derived from an
    // unknown JSON envelope and TypeScript cannot carry that refinement across
    // the closure; the cast records the checked invariant without changing
    // the opaque cursor bytes.
    const pageCursor = nextCursor as string;
    if (seenCursors.has(pageCursor)) {
      throw new OrcaCliError(
        "worker-list repeated page.nextCursor; refusing an infinite pagination loop.",
        "invalid_pagination",
      );
    }
    seenCursors.add(pageCursor);
    cursor = pageCursor;
  }

  throw new OrcaCliError(
    "worker-list exceeded the defensive 10,000-page limit; refusing to return truncated accounting.",
    "invalid_pagination",
  );
}

/** Receipt shape shared by worker-release / worker-retain. */
export interface WorkerTerminalReceipt {
  dispatchId: string;
  /** released | already_released | retained | release_pending | release_unknown */
  state: string;
  reason: string | null;
  processAction: string | null;
  warning: string | null;
  archive: Record<string, unknown> | null;
  /** The durable retry-request id this mutation ran under (Phase 4). */
  requestId: string | null;
}

/** Typed, transport-independent normalization of one terminal-mutation receipt. */
export function normalizeTerminalReceipt(
  result: Record<string, unknown>,
  requestId: string | null,
): WorkerTerminalReceipt {
  return {
    dispatchId: String(result.dispatchId ?? ""),
    state: String(result.state ?? "release_unknown"),
    reason: (result.reason as string | undefined) ?? null,
    processAction: (result.processAction as string | undefined) ?? null,
    warning: (result.warning as string | undefined) ?? null,
    archive: (result.archive as Record<string, unknown> | undefined) ?? null,
    requestId,
  };
}

/**
 * Run one of the terminal-ownership mutations and normalize its receipt.
 *
 * The CLI documents that ONLY `release_unknown` exits non-zero; a non-zero
 * exit can arrive with the JSON envelope already parsed as ok:false, so the
 * throw from runOrca is folded into a `release_unknown` receipt instead of
 * surfacing as an infrastructure error — the state machine needs the state,
 * not an exception. Genuine infrastructure failures (ENOENT, malformed
 * output) keep their OrcaCliError code and rethrow.
 *
 * Phase 4: every call runs under a durable `--retry-request` id, and a LOST
 * response is resolved through `request-show` + one same-id replay before it
 * is allowed to degrade into `release_unknown` — an ambiguous release that
 * Orca can confirm is strictly better information than an unknown.
 */
async function runTerminalMutation(
  args: string[],
  requestId: string,
  unknownState: string,
): Promise<WorkerTerminalReceipt> {
  const normalize = (result: Record<string, unknown>): WorkerTerminalReceipt => ({
    ...normalizeTerminalReceipt(result, requestId),
    state: String(result.state ?? unknownState),
  });
  try {
    return normalize(await runOrca<Partial<WorkerTerminalReceipt>>(args));
  } catch (err) {
    const e = err as OrcaCliError;
    // Missing CLI is an infrastructure failure, not a terminal-state answer.
    if (e instanceof OrcaCliError && e.code === "cli_not_found") throw e;
    // Lost response: ask Orca whether the mutation landed and replay once with
    // the same id (recorded outcome, no second mutation). Anything still
    // unresolvable degrades to the typed unknown receipt.
    if (e instanceof OrcaCliError && e.code === RESPONSE_LOST) {
      const probe = await showRequest(requestId);
      if (probe && (probe.state === "completed" || probe.state === "pending")) {
        try {
          return normalize(await runOrca<Partial<WorkerTerminalReceipt>>(args));
        } catch (retryErr) {
          const r = retryErr as OrcaCliError;
          if (r instanceof OrcaCliError && r.code === RESPONSE_LOST) {
            // fall through to the unknown receipt below
          } else if (r instanceof OrcaCliError && r.code === "cli_not_found") {
            throw r;
          } else {
            return normalize({});
          }
        }
      }
    }
    return {
      dispatchId: "",
      state: unknownState,
      reason: String(e.message ?? err),
      processAction: null,
      warning: null,
      archive: null,
      requestId,
    };
  }
}

/** Release a settled worker's terminal. Default post-settlement decision. */
export function releaseWorker(
  dispatchId: string,
  opts: { retryRequestId?: string } = {},
): Promise<WorkerTerminalReceipt> {
  const requestId = opts.retryRequestId ?? newRequestId();
  return runTerminalMutation(
    [
      "orchestration",
      "worker-release",
      "--dispatch",
      dispatchId,
      "--retry-request",
      requestId,
    ],
    requestId,
    "release_unknown",
  );
}

/** Explicit debug retention — the user's opt-out from automatic release. */
export function retainWorker(
  dispatchId: string,
  opts: { retryRequestId?: string } = {},
): Promise<WorkerTerminalReceipt> {
  const requestId = opts.retryRequestId ?? newRequestId();
  return runTerminalMutation(
    [
      "orchestration",
      "worker-retain",
      "--dispatch",
      dispatchId,
      "--retry-request",
      requestId,
    ],
    requestId,
    "release_unknown",
  );
}

/** Bounded output read (evidence preserved before/after release). */
export interface WorkerOutputReceipt {
  dispatchId: string;
  /** Which source answered — "auto", "terminal", or "transcript" (labeled). */
  source: string;
  /** Opaque paging cursor; pass back to continue AFTER these rows. */
  cursor: string | null;
  /** Labeled terminal tail / transcript rows, however the source labeled them. */
  lines: string[];
  contentComplete: boolean;
  clipped: boolean;
  /** The runtime's own warnings for this page, verbatim (Phase 5). */
  warnings: string[];
  /**
   * True when the requested cursor was pinned to a source that has since been
   * replaced — the read was restarted from the beginning of the (new) source.
   * Phase 5: surfaced so the UI can explain why the output jumped back to the
   * start instead of silently pretending the page was continuous.
   */
  sourceChanged: boolean;
}

/**
 * Read a bounded page of one worker's output (`orchestration worker-read`).
 *
 * Phase 5: `--source` (auto | terminal | transcript) and `--cursor` are passed
 * through verbatim, the receipt keeps the source label, the paging cursor, and
 * the runtime's warnings, and a `source_changed` answer is handled HERE rather
 * than by every caller: a cursor pinned to a replaced source restarts the read
 * once from the top of the (new) source and says so via `sourceChanged`. The
 * retry is safe because worker-read is a read — replaying it cannot mutate
 * anything; the flag is the only honest way to report the discontinuity.
 */
export async function readWorkerOutput(
  dispatchId: string,
  opts: { limit?: number; source?: string; cursor?: string } = {},
): Promise<WorkerOutputReceipt> {
  const buildArgs = (cursor?: string): string[] => {
    const args = ["orchestration", "worker-read", "--dispatch", dispatchId];
    if (opts.source) args.push("--source", opts.source);
    if (cursor) args.push("--cursor", cursor);
    if (opts.limit) args.push("--limit", String(opts.limit));
    return args;
  };
  const parse = (result: {
    dispatchId?: string;
    source?: string;
    cursor?: string;
    terminal?: { tail?: string[]; truncated?: boolean; limited?: boolean };
    transcript?: { rows?: string[] };
    contentComplete?: boolean;
    warnings?: string[];
    clipping?: string[];
  }): WorkerOutputReceipt => {
    const lines = result.terminal?.tail ?? result.transcript?.rows ?? [];
    return {
      dispatchId: String(result.dispatchId ?? dispatchId),
      source: String(result.source ?? "auto"),
      cursor: result.cursor ?? null,
      lines: lines.map(String),
      contentComplete: Boolean(result.contentComplete),
      clipped:
        Boolean(result.terminal?.truncated || result.terminal?.limited) ||
        (result.clipping ?? []).length > 0,
      warnings: (result.warnings ?? []).map(String),
      sourceChanged: false,
    };
  };
  try {
    return parse(await runOrca(buildArgs(opts.cursor)));
  } catch (err) {
    const e = err as OrcaCliError;
    if (e?.code !== "source_changed") throw err;
    // The cursor was pinned to a source that no longer exists (the terminal
    // was released and the archive took over, or vice versa). One fresh read
    // without the cursor — then label the discontinuity.
    const receipt = parse(await runOrca(buildArgs(undefined)));
    receipt.sourceChanged = true;
    receipt.warnings = [
      ...receipt.warnings,
      "output source changed; the read restarted from the beginning of the new source",
    ];
    return receipt;
  }
}

/** Typed `worker-stop` receipt — Stop reports outcomes, never swallows them. */
export interface WorkerStopReceipt {
  dispatchId: string;
  state: string;
  alreadySettled: boolean;
  processAction: string | null;
  warning: string | null;
}

/**
 * Stop one supervised worker. Unlike the pre-hardening version (which swallowed
 * every failure into a void), this returns the receipt or rethrows — the caller
 * decides how an uncertain stop is reported. "stopped" in Orca's accounting
 * settles the Dispatch without deleting anything.
 */
export async function stopWorkerReceipt(
  dispatchId: string,
  opts: { retryRequestId?: string } = {},
): Promise<WorkerStopReceipt> {
  const requestId = opts.retryRequestId ?? newRequestId();
  const result = await runOrca<Partial<WorkerStopReceipt>>([
    "orchestration",
    "worker-stop",
    "--dispatch",
    dispatchId,
    "--retry-request",
    requestId,
  ]);
  return {
    dispatchId: String(result.dispatchId ?? dispatchId),
    state: String(result.state ?? "unknown"),
    alreadySettled: Boolean(result.alreadySettled),
    processAction: result.processAction ?? null,
    warning: result.warning ?? null,
  };
}

/** Typed `worker-abandon` receipt — the same contract as stop: outcomes, never swallows. */
export interface WorkerAbandonReceipt {
  dispatchId: string;
  state: string;
  alreadySettled: boolean;
  /** Abandon performs no process action BY CONTRACT; kept verbatim if a runtime echoes one. */
  processAction: string | null;
  warning: string | null;
  /** Echo of the durable `--retry-request` id this abandon ran under (Phase 4). */
  requestId: string;
  /** The runtime's verbatim receipt — lifecycle evidence outlives the call. */
  raw: Record<string, unknown>;
}

/**
 * Abandon one supervised Dispatch (`orchestration worker-abandon`).
 *
 * The outcome_unknown tool for when stop is NOT right: abandon FENCES the
 * worker from orchestration (its mutations stop counting) while explicitly
 * NOT claiming its process stopped — the runtime retains all possibly-live
 * resources and performs no remote, process, or filesystem action (1.4.206).
 * This mirrors the existing worker-stop adapter exactly: same durable
 * `--retry-request` id, same receipt-or-rethrow contract — a lost response
 * surfaces as `RESPONSE_LOST` carrying the full argv so the caller resolves
 * it through `request-show` with the SAME id instead of replaying blind.
 * Never substituted by `terminal close`: closing a pane proves nothing about
 * a Dispatch and only orphans its lifecycle row.
 */
export async function abandonWorkerReceipt(
  dispatchId: string,
  opts: { retryRequestId?: string } = {},
): Promise<WorkerAbandonReceipt> {
  const requestId = opts.retryRequestId ?? newRequestId();
  const result = await runOrca<Partial<WorkerAbandonReceipt>>([
    "orchestration",
    "worker-abandon",
    "--dispatch",
    dispatchId,
    "--retry-request",
    requestId,
  ]);
  return {
    dispatchId: String(result.dispatchId ?? dispatchId),
    state: String(result.state ?? "unknown"),
    alreadySettled: Boolean(result.alreadySettled),
    processAction: result.processAction ?? null,
    warning: result.warning ?? null,
    requestId,
    raw: asRecord(result),
  };
}

// --- Literal nextAction (Phase 4 item 6) ------------------------------------
//
// worker-list projections can carry `nextAction: { kind, argv }` — Orca's own
// prescribed follow-up (e.g. the exact `worker-release` argv for a
// release_pending worker). We follow it ONLY when it literally contains argv:
// a `none`/null/empty nextAction means "no action prescribed" and we never
// invent one. The argv is executed verbatim through the resolved command spec,
// after a defensive verb allowlist (a runtime bug must not turn into an
// arbitrary command execution from our coordinator terminal).

/** Verbs we will ever follow out of a nextAction projection. */
const FOLLOWABLE_VERBS = new Set([
  "worker-release",
  "worker-retain",
  "worker-abandon",
  "worker-read",
  "request-show",
  "worker-list",
]);

/** True when this nextAction literally prescribes a followable command. */
export function followableNextAction(
  nextAction: { kind: string; argv: string[] } | null | undefined,
): string[] | null {
  if (!nextAction || !Array.isArray(nextAction.argv)) return null;
  if (nextAction.argv.length === 0) return null; // "none" — never invent an action
  const [ns, verb] = nextAction.argv;
  if (ns !== "orchestration" || typeof verb !== "string" || !FOLLOWABLE_VERBS.has(verb)) {
    return null;
  }
  return nextAction.argv.map(String);
}

/**
 * Execute a literal nextAction argv (already validated by
 * `followableNextAction`). Returns null when the argv wasn't followable — the
 * caller treats that as "no prescribed action", not as an error.
 */
export function runNextAction(argv: string[]): Promise<unknown> {
  if (!followableNextAction({ kind: "nextAction", argv })) {
    return Promise.resolve(null);
  }
  return runOrca(argv);
}

// --- Idempotent mutations (Phase 4) -----------------------------------------
//
// Every mutating call gets a durable retry-request id (a uuid minted HERE,
// before the call) passed as `--retry-request`. Orca records the outcome under
// that id, so a LOST response is recoverable: `request-show` reports whether
// the mutation landed, and replaying the same command with the SAME id returns
// the recorded outcome instead of acting twice. The id is retained by the
// caller until the outcome is known — that's what makes the recovery chain
// idempotent end to end.

/** A fresh durable retry-request id for one mutation attempt. */
export function newRequestId(): string {
  return randomUUID();
}

/** The recorded state of one mutation request, from `orchestration request-show`. */
export interface OrcaRequestReceipt {
  requestId: string;
  /** completed | pending | absent — tolerant string so new states surface verbatim. */
  state: string;
  /** The runtime's plain-language interpretation (verbatim, for the UI). */
  interpretation: string | null;
  /** The recorded outcome payload when `completed`. */
  outcome: unknown;
  raw: Record<string, unknown>;
}

/**
 * Ask whether one mutation already took effect. READ-ONLY by contract — it
 * never starts, retries, or settles anything, so it is safe after any lost
 * response. Returns null when the probe itself fails (transport trouble while
 * probing is its own ambiguity; callers keep the mutation unresolved).
 */
export async function showRequest(requestId: string): Promise<OrcaRequestReceipt | null> {
  let result: Record<string, unknown>;
  try {
    result = await runOrca<Record<string, unknown>>([
      "orchestration",
      "request-show",
      "--request",
      requestId,
    ]);
  } catch {
    return null;
  }
  return {
    requestId: String(result.requestId ?? requestId),
    state: String(result.state ?? "absent"),
    interpretation: typeof result.interpretation === "string" ? result.interpretation : null,
    outcome: result.outcome ?? null,
    raw: result,
  };
}

/**
 * Full worker-start receipt (plan Phase 4 item 1): the stage machine the start
 * walked, where it failed, what it set up, what it created, what it left
 * behind, which Dispatch/attempt it produced, which request id it ran under,
 * and Orca's own prescribed recovery commands. Parsed tolerantly from success
 * results AND failure envelopes (field spellings vary between wire versions;
 * anything absent stays null instead of being invented).
 */
export interface WorkerStartReceipt {
  /** Whether the start reached `ready`. */
  ok: boolean;
  taskId: string | null;
  dispatchId: string | null;
  /** Echo of the `--retry-request` id the call ran under. */
  requestId: string | null;
  /** Terminal stage on success (typically "ready"). */
  status: string | null;
  /** The stage the start reached (or was in when it failed). */
  stage: string | null;
  /** The stage that failed, on a failed start. */
  failedStage: string | null;
  /** Setup-hook outcome when the runtime reports one. */
  setup: string | null;
  /** Resources the start created (terminals, dispatch, worktree…), verbatim. */
  effects: unknown;
  /** Resources left behind by a failed start, verbatim. */
  residualResources: unknown;
  /** Orca's own prescribed recovery commands, verbatim. */
  recoveryCommands: string[];
  /**
   * Launch preferences the runtime reports as EFFECTIVE for this worker
   * (Phase 5) — its receipt's echo of agent/model/effort/worktree/terminal.
   * Every field is optional; a field the receipt doesn't mention stays null
   * and the UI reports it as "unknown" rather than assuming the requested
   * value was applied (never claim a preference without receipt evidence).
   */
  effective: {
    agent: string | null;
    model: string | null;
    effort: string | null;
    worktree: string | null;
    terminal: string | null;
    /**
     * Execution server the receipt names for this worker (Phase 6). Absent
     * (`null`) = the receipt did not echo one — the UI reports placement as
     * unknown rather than assuming local or remote.
     */
    on: string | null;
    /**
     * Effective worktree name/branch/display name for a creating start.
     * Echoed by the runtime only when it applied them; `null` = unconfirmed,
     * never assumed (the "requested vs effective" rule above).
     */
    name: string | null;
    baseBranch: string | null;
    displayName: string | null;
  };
  /** The complete receipt as received — the UI shows this on demand. */
  raw: Record<string, unknown>;
}

/** Read the first present, non-empty string among differently-spelled keys. */
function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Coerce unknown into a plain record (or an empty one) for tolerant digging. */
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Digest whatever `worker-start` returned — a success `result`, or the parsed
 * `ok:false` envelope (receipts hide in `error.data`, `worker`, or at top
 * level) — into a typed receipt. Never throws: a receipt we cannot fully
 * parse is preserved in `raw` with the fields we did recognize.
 */
export function parseWorkerStartReceipt(payload: unknown, ok: boolean): WorkerStartReceipt {
  const raw: Record<string, unknown> =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  // Failure envelopes nest the real receipt under error.data (sometimes
  // error.data.receipt); success results put it at the top level.
  const errDataRecord = asRecord(asRecord(raw.error).data);
  const nested: Record<string, unknown> = {
    ...errDataRecord,
    ...asRecord(errDataRecord.receipt),
    ...asRecord(raw.receipt),
    ...asRecord(raw.worker),
    ...asRecord(raw.dispatch),
    ...raw,
  };
  const recovery = nested.recoveryCommands ?? nested.recovery_commands ?? nested.recovery;
  // Effective launch preferences (Phase 5): dig tolerantly — the runtime may
  // echo them at the top level, inside a `launch` object, or inside `effects`.
  // Only a present, non-empty string counts; absence stays null (the UI's
  // "unknown"), because an unechoed preference was never confirmed applied.
  const launchRecord: Record<string, unknown> = {
    ...asRecord(nested.effects),
    ...asRecord(nested.launch),
    ...nested,
  };
  return {
    ok,
    taskId: pickString(nested, "taskId", "task_id"),
    dispatchId: readDispatchId(nested),
    requestId: pickString(nested, "requestId", "request_id", "retryRequestId", "retry_request"),
    status: pickString(nested, "status", "workerStatus"),
    stage: pickString(nested, "stage", "workerStage"),
    failedStage: pickString(nested, "failedStage", "failed_stage"),
    setup: pickString(nested, "setup", "setupResult", "setup_result"),
    effects: nested.effects ?? null,
    residualResources: nested.residualResources ?? nested.residual_resources ?? null,
    recoveryCommands: Array.isArray(recovery) ? recovery.map(String) : [],
    effective: {
      agent: pickString(launchRecord, "agent", "agentId", "agent_id"),
      model: pickString(launchRecord, "model"),
      effort: pickString(launchRecord, "effort"),
      worktree: pickString(launchRecord, "worktree", "worktreeSelector", "worktree_selector"),
      terminal: pickString(launchRecord, "terminal", "terminalHandle", "terminal_handle"),
      // Phase 6: which execution server the receipt names ("on", an
      // environment id, or the runtime's server label). A local start usually
      // leaves this unechoed — null, i.e. "unknown", never assumed local.
      on: pickString(
        launchRecord,
        "on",
        "environment",
        "environmentId",
        "environment_id",
        "serverName",
        "server_name",
      ),
      // Creation metadata the receipt echoes back for a creating start.
      // Same rule as every effective field: only a present, non-empty echo
      // counts; absence stays null and the UI reports "unknown".
      name: pickString(launchRecord, "name", "worktreeName", "worktree_name"),
      baseBranch: pickString(launchRecord, "baseBranch", "base_branch", "baseRef"),
      displayName: pickString(launchRecord, "displayName", "display_name"),
    },
    raw,
  };
}

/**
 * A worker-start that definitely did NOT reach ready, carrying the receipt the
 * coordinator must retain (plan Phase 4 item 8: failed-before-ready starts are
 * never deleted — their receipt is the release/retry evidence).
 */
export class WorkerStartError extends OrcaCliError {
  readonly receipt: WorkerStartReceipt;
  constructor(receipt: WorkerStartReceipt, message: string, code: string | null) {
    super(message, code);
    this.name = "WorkerStartError";
    this.receipt = receipt;
  }
}

// --- Phase 6: environments, peer capabilities, exact placement ---------------
//
// A node can run on a SAVED Orca environment (a connected remote runtime)
// while the Run, its gates, and this coordinator stay authoritative on the
// local server. The contract that shapes everything below:
//
//   * `orca environment list` / `environment show` are the ONLY discovery
//     source for remote targets — the viewer never invents an environment.
//   * `--on <environment>` appears on `worker-start` ONLY. Every later
//     operation (reads, messages, stop, release) addresses the Dispatch ID;
//     the execution host owns the process, filesystem, transcript, stop, and
//     cleanup facts, so substituting a remote terminal handle is forbidden.
//   * Remote placement is exact-workspace-selector or new-top-level ONLY.
//     `current` and `new-child` are ambiguous across servers — refused HERE,
//     before any Orca mutation, because they can never be made unambiguous
//     after the fact.
//   * Clients and servers update independently: optional fields may be
//     absent, unknown capability names may be silently unsupported, and a
//     capability that is not advertised is treated as ABSENT (gated off) —
//     never guessed into existence. There is no synthetic local fallback.

/** One saved Orca runtime environment (`orca environment list`). */
export interface OrcaEnvironment {
  /** Stable environment selector (`--environment` / `--on` value). */
  id: string;
  /** Human label; falls back to the id when the row carries no name. */
  name: string;
  /**
   * Peer reachability as the runtime reports it. `null` = the row does not
   * say — which renders as unverifiable, never as "disconnected" and never
   * as a reason to act.
   */
  connected: boolean | null;
  /**
   * Capability names the peer advertised, verbatim. `null` = nothing
   * advertised (or the row shape carried no capability field) — the gating
   * rule treats this as "none proven", not as "all supported".
   */
  capabilities: string[] | null;
  /** Peer protocol/runtime version string when the row carries one. */
  version: string | null;
  /** The complete row as received (UI shows it on demand). */
  raw: Record<string, unknown>;
}

/**
 * Collect capability names out of whatever shape a runtime used:
 * a string array, an array of `{name|capability|id}` rows, or a record whose
 * keys name capabilities (boolean-valued → only the true ones count;
 * object-valued → every key, `false` explicitly excluded). Anything else, an
 * empty list, or unparsable junk returns `[]` — the caller distinguishes
 * "field absent" (null) from "advertised nothing" ([]) via the return of
 * `parseAdvertisedCapabilities` below.
 */
function collectCapabilityNames(input: unknown, out: string[]): void {
  if (typeof input === "string") {
    if (input.trim()) out.push(input.trim());
    return;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        if (item.trim()) out.push(item.trim());
        continue;
      }
      const rec = asRecord(item);
      const name = pickString(rec, "name", "capability", "id", "kind");
      if (name) out.push(name);
    }
    return;
  }
  const rec = asRecord(input);
  for (const [key, value] of Object.entries(rec)) {
    if (value === false) continue;
    if (value === true) {
      out.push(key);
      continue;
    }
    if (value && typeof value === "object") out.push(key);
    // Non-boolean scalars (strings, numbers) are values, not capability
    // names — ignored rather than guessed into the advertised set.
  }
}

/** Tolerant parse of one `environment list` row; null = unusable row. */
export function parseEnvironmentRow(raw: unknown): OrcaEnvironment | null {
  const r = asRecord(raw);
  const id = pickString(r, "id", "environmentId", "environment_id");
  if (!id) return null;
  let connected: boolean | null = null;
  for (const key of ["connected", "online", "reachable"]) {
    if (typeof r[key] === "boolean") {
      connected = r[key] as boolean;
      break;
    }
  }
  if (connected === null) {
    // Status-string spellings map to the three states we can honestly render;
    // anything else stays null (unknown).
    const status = pickString(r, "state", "status", "connection");
    if (status === "connected" || status === "online" || status === "ready") connected = true;
    else if (status === "disconnected" || status === "offline") connected = false;
  }
  const caps: string[] = [];
  let capsPresent = false;
  for (const key of ["capabilities", "peerCapabilities", "serverCapabilities"]) {
    if (r[key] !== undefined) {
      capsPresent = true;
      collectCapabilityNames(r[key], caps);
      break; // first present capability field wins — don't merge spellings
    }
  }
  return {
    id,
    name: pickString(r, "name", "displayName", "display_name", "label") ?? id,
    connected,
    // null = the row carries no capability field at all (mixed-version peer
    // or older runtime): gate everything off. [] = advertised nothing.
    capabilities: capsPresent ? caps : null,
    version: pickString(r, "version", "protocolVersion", "runtimeVersion"),
    raw: r,
  };
}

/**
 * Parse one `environment show` / `environment list` result into the
 * advertised-capability set this viewer reasons about. Returns `null` for
 * "no capability field at all" — the mixed-version floor's gating-off case —
 * vs `[]` for "the peer advertised an empty set" (equivalent in effect, kept
 * distinct so evidence stays honest in the UI).
 */
export function parseAdvertisedCapabilities(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  const caps: string[] = [];
  collectCapabilityNames(raw, caps);
  return caps;
}

/**
 * Read the local runtime's actual capability advertisement from `status`.
 * `--version` only establishes the execution floor; it says nothing about
 * individual capabilities. The status receipt nests the list under
 * `result.runtime.capabilities` (runOrca already unwraps `result`). Missing
 * fields stay null, so older or mixed-version runtimes never gain support by
 * inference. This uses the same resolved CLI and workspace as every other
 * Orca call, rather than probing whichever `orca` happens to be on PATH.
 */
export async function readLocalRuntimeCapabilities(): Promise<string[] | null> {
  const status = asRecord(await runOrca<unknown>(["status"]));
  return parseAdvertisedCapabilities(asRecord(status.runtime).capabilities);
}

/** The three remote operations Phase 6 gates on peer advertisement. */
export interface PeerCapabilities {
  /** Forward `--model`/`--effort` through a remote `worker-start`. */
  modelEffort: boolean;
  /** Structured transcript reads (`worker-read --source transcript`). */
  transcriptRead: boolean;
  /** Fleet snapshot via `worker-list --include-remote` observations. */
  fleetSnapshot: boolean;
  /** Exactly what the peer advertised, verbatim (null = nothing/unknown). */
  raw: string[] | null;
}

// --- Canonical runtime capability negotiation (operations epic O1/A3) --------
//
// Orca 1.4.206 introduced canonical orchestration capability identifiers. The
// viewer reasons about EXACTLY this table: a feature lights up only when the
// runtime positively advertised its canonical id (or a documented older
// alias), everything else — unknown names, missing capability fields, older
// runtimes — stays gated off. There is deliberately no "probably supported"
// state: an unfamiliar name never enables a feature.

/** One capability this viewer understands, with its compatibility story. */
export interface RuntimeCapabilitySpec {
  /** The canonical Orca 1.4.206 identifier, verbatim. */
  canonicalId: string;
  /** Readable name for the UI matrix. */
  label: string;
  /** Where the advertisement is expected: the local CLI or a peer runtime. */
  scope: "runtime" | "peer";
  /** What supporting it lets the viewer do (rendered as the explanation). */
  explanation: string;
  /**
   * Documented older spellings accepted as compatibility inputs. Kept to the
   * short names this viewer matched before canonical ids existed; anything
   * outside canonical + aliases stays unsupported.
   */
  aliases: string[];
  /** Existing remote gates this capability feeds (see `parsePeerCapabilities`). */
  gates?: Array<keyof Omit<PeerCapabilities, "raw">>;
}

/**
 * The canonical Orca 1.4.206 orchestration capability identifiers (epic A3),
 * each with the older local spellings that remain accepted as aliases.
 */
export const CANONICAL_RUNTIME_CAPABILITIES: readonly RuntimeCapabilitySpec[] = [
  {
    canonicalId: "orchestration.worker-launch-preferences.v1",
    label: "Worker launch preferences",
    scope: "peer",
    explanation: "Forwards per-worker --model/--effort launch preferences through a remote worker-start.",
    aliases: ["model.effort", "model", "launch.model.effort", "launch.model", "launch"],
    gates: ["modelEffort"],
  },
  {
    canonicalId: "orchestration.federation-structured-read.v1",
    label: "Structured worker reads",
    scope: "peer",
    explanation: "Serves structured transcript reads (`worker-read --source transcript`) from a connected runtime.",
    aliases: ["worker.read.transcript", "transcript.read", "transcript", "structured.read", "worker.read"],
    gates: ["transcriptRead"],
  },
  {
    canonicalId: "orchestration.federation-fleet-snapshot.v1",
    label: "Fleet snapshot",
    scope: "peer",
    explanation: "Includes remote workers in `worker-list --include-remote` fleet accounting.",
    aliases: ["fleet.snapshot", "fleet", "worker.list.remote", "include.remote"],
    gates: ["fleetSnapshot"],
  },
  {
    canonicalId: "orchestration.federation-control-mail.v1",
    label: "Federation control mail",
    scope: "peer",
    explanation: "Routes coordinator control mail (guidance, questions) to workers on a connected runtime.",
    aliases: [],
  },
  {
    canonicalId: "orchestration.federation-lifecycle-settlement.v1",
    label: "Lifecycle settlement",
    scope: "peer",
    explanation: "Settles worker_done / task completion through the connected runtime's lifecycle contract.",
    aliases: [],
  },
  {
    canonicalId: "orchestration.federation-release-archive.v1",
    label: "Release archive",
    scope: "peer",
    explanation: "Archives worker terminal ownership decisions (release/retain) on the connected runtime.",
    aliases: [],
  },
  {
    canonicalId: "orchestration.worker-stop-verdict.v1",
    label: "Worker stop verdict",
    scope: "runtime",
    explanation: "worker-stop receipts carry an explicit per-worker verdict instead of an ambiguous exit.",
    aliases: [],
  },
] as const;

function normalizeCapabilityName(name: string): string {
  return name.toLowerCase().replace(/[._-]+/g, ".");
}

/**
 * Project an advertised-capability set against the canonical table.
 *
 * Returns one row per canonical capability — `state: "supported"` when the
 * canonical id was advertised verbatim (up to case/separator folding),
 * `"alias"` when only an older spelling matched (still `supported: true`),
 * and `"absent"` otherwise. Names that matched NOTHING come back in
 * `unknownAdvertised`, verbatim, so the UI can show what a newer runtime
 * advertises that this viewer does not understand — without treating any of
 * it as support. `advertised: null` (no capability field at all) gates every
 * row off: absence is never evidence of support.
 */
export interface RuntimeCapabilityProjection {
  capabilities: RuntimeCapabilityView[];
  /** Advertised names that matched no canonical id and no alias, verbatim. */
  unknownAdvertised: string[];
}

export interface RuntimeCapabilityView {
  /** Canonical id, verbatim from the table. */
  id: string;
  label: string;
  scope: string;
  state: "supported" | "alias" | "absent";
  /** True ONLY on a positively advertised canonical id or documented alias. */
  supported: boolean;
  /** The verbatim advertised name that matched (null = nothing did). */
  matchedName: string | null;
  explanation: string;
}

export function describeRuntimeCapabilities(advertised: string[] | null): RuntimeCapabilityProjection {
  const have = new Map<string, string>();
  for (const name of advertised ?? []) {
    have.set(normalizeCapabilityName(name), name);
  }
  const known = new Set<string>();
  const capabilities = CANONICAL_RUNTIME_CAPABILITIES.map((spec) => {
    const canonicalKey = normalizeCapabilityName(spec.canonicalId);
    known.add(canonicalKey);
    for (const alias of spec.aliases) known.add(normalizeCapabilityName(alias));
    if (have.has(canonicalKey)) {
      return {
        id: spec.canonicalId,
        label: spec.label,
        scope: spec.scope,
        state: "supported" as const,
        supported: true,
        matchedName: have.get(canonicalKey) ?? spec.canonicalId,
        explanation: spec.explanation,
      };
    }
    const aliasHit = spec.aliases.find((alias) => have.has(normalizeCapabilityName(alias)));
    if (aliasHit) {
      return {
        id: spec.canonicalId,
        label: spec.label,
        scope: spec.scope,
        state: "alias" as const,
        supported: true,
        matchedName: have.get(normalizeCapabilityName(aliasHit)) ?? aliasHit,
        explanation: spec.explanation,
      };
    }
    return {
      id: spec.canonicalId,
      label: spec.label,
      scope: spec.scope,
      state: "absent" as const,
      supported: false,
      matchedName: null,
      explanation: spec.explanation,
    };
  });
  const unknownAdvertised = (advertised ?? []).filter((name) => !known.has(normalizeCapabilityName(name)));
  return { capabilities, unknownAdvertised };
}

/** Positive-only gate: does the advertised set prove this canonical capability? */
export function canonicalCapabilitySupported(advertised: string[] | null, canonicalId: string): boolean {
  return describeRuntimeCapabilities(advertised).capabilities.some(
    (view) => view.id === canonicalId && view.supported,
  );
}

/**
 * Capability name spellings accepted per remote gate, derived from the
 * canonical table above so the two can never drift: a gate accepts its
 * capability's canonical id plus its documented aliases. EVERYTHING ELSE
 * STAYS GATED OFF — a peer advertising a vocabulary we do not recognize
 * degrades to the documented older behavior (controls hidden), never to
 * forwarded calls it may silently drop.
 */
const CAPABILITY_LOOKUPS: Record<keyof Omit<PeerCapabilities, "raw">, string[]> = (() => {
  const lookups: Record<keyof Omit<PeerCapabilities, "raw">, string[]> = {
    modelEffort: [],
    transcriptRead: [],
    fleetSnapshot: [],
  };
  for (const spec of CANONICAL_RUNTIME_CAPABILITIES) {
    for (const gate of spec.gates ?? []) {
      lookups[gate].push(spec.canonicalId, ...spec.aliases);
    }
  }
  return lookups;
})();

export function parsePeerCapabilities(advertised: string[] | null): PeerCapabilities {
  const have = new Set((advertised ?? []).map(normalizeCapabilityName));
  const matches = (names: string[]): boolean => names.some((n) => have.has(normalizeCapabilityName(n)));
  return {
    modelEffort: advertised !== null && matches(CAPABILITY_LOOKUPS.modelEffort),
    transcriptRead: advertised !== null && matches(CAPABILITY_LOOKUPS.transcriptRead),
    fleetSnapshot: advertised !== null && matches(CAPABILITY_LOOKUPS.fleetSnapshot),
    raw: advertised,
  };
}

// --- Informational umbrella capabilities (`computer capabilities`) ----------
//
// One command (`orca computer capabilities`) reports the computer-use
// provider's whole capability surface as an umbrella `supports` tree of
// boolean leaves grouped by area (`windows.focus`, `actions.click`, …).
// INFORMATIONAL: it is a read-only display/inspection surface — it gates no
// mutation by itself. Parsing still fails closed: only a positively `true`
// boolean leaf counts as support (missing, false, and non-boolean shapes are
// all "not proven"), a receipt without a `supports` map advertises nothing,
// and unknown groups/leaves stay visible in `raw` so a newer provider's new
// knobs can be inspected instead of silently dropped.

/** One flattened leaf of the `supports` umbrella. */
export interface ComputerCapabilityLeaf {
  /** Group as the provider names it ("windows", "actions", …), verbatim. */
  group: string;
  /** Leaf name inside the group ("focus", "click", …), verbatim. */
  name: string;
  /** True ONLY on a positively `true` boolean leaf. */
  supported: boolean;
}

export interface ComputerUseCapabilities {
  platform: string | null;
  provider: string | null;
  providerVersion: string | null;
  protocolVersion: number | null;
  /** True when the receipt carried a `supports` map at all. */
  advertised: boolean;
  /** Every boolean leaf of the umbrella, flattened. */
  capabilities: ComputerCapabilityLeaf[];
  /** The verbatim `supports` map — unknown newer knobs stay inspectable. */
  raw: Record<string, unknown>;
}

export function parseComputerCapabilities(result: unknown): ComputerUseCapabilities {
  const body = asRecord(result);
  const supports = body.supports;
  const advertised = Boolean(supports && typeof supports === "object" && !Array.isArray(supports));
  const capabilities: ComputerCapabilityLeaf[] = [];
  if (advertised) {
    for (const [group, leaves] of Object.entries(supports as Record<string, unknown>)) {
      // A group body must be an object of leaves; anything else (a scalar, a
      // list) carries no boolean claims and is skipped — never guessed.
      const leafRecord = asRecord(leaves);
      for (const [name, value] of Object.entries(leafRecord)) {
        if (typeof value === "boolean") {
          capabilities.push({ group, name, supported: value });
        }
      }
    }
  }
  return {
    platform: pickString(body, "platform"),
    provider: pickString(body, "provider"),
    providerVersion: pickString(body, "providerVersion", "provider_version"),
    protocolVersion: typeof body.protocolVersion === "number" ? body.protocolVersion : null,
    advertised,
    capabilities,
    raw: asRecord(supports),
  };
}

/** Positive-only lookup: exactly the advertised group+leaf pair, no guessing. */
export function computerSupports(cap: ComputerUseCapabilities, group: string, name: string): boolean {
  return cap.capabilities.some((leaf) => leaf.group === group && leaf.name === name && leaf.supported);
}

/**
 * Read the provider's umbrella capability statement through the resolved CLI
 * (`computer capabilities` — informational and read-only). Failures propagate
 * with their evidence: an unreadable response must never flatten into "the
 * provider supports nothing", which would look like a definite answer.
 */
export async function fetchComputerCapabilities(environmentId?: string): Promise<ComputerUseCapabilities> {
  return parseComputerCapabilities(
    await runOrca<unknown>(["computer", "capabilities", ...environmentArgs(environmentId)]),
  );
}

/** List saved Orca runtime environments. Read-only: needs no coordinator. */
export async function listEnvironments(): Promise<OrcaEnvironment[]> {
  const result = await runOrca<{ environments?: unknown[] }>(["environment", "list"]);
  return (result.environments ?? [])
    .map(parseEnvironmentRow)
    .filter((e): e is OrcaEnvironment => e !== null);
}

/**
 * Inspect ONE saved environment (plan Phase 6 item 1). Returns `null` only
 * when Orca itself says the environment does not exist (invalid_argument /
 * not_found) — a transport failure throws, so an unreachable host is never
 * misrepresented as "no such environment".
 */
export async function showEnvironment(environmentId: string): Promise<OrcaEnvironment | null> {
  let result: Record<string, unknown>;
  try {
    result = await runOrca<Record<string, unknown>>([
      "environment",
      "show",
      "--environment",
      environmentId,
    ]);
  } catch (err) {
    const e = err as OrcaCliError;
    if (e instanceof OrcaCliError && (e.code === "invalid_argument" || e.code === "not_found")) {
      return null;
    }
    throw err;
  }
  // The detail may sit at the top level or under `environment`; the row's own
  // id wins, but a show-shaped body without one keeps the requested selector.
  const body = asRecord(result.environment ?? result);
  return parseEnvironmentRow({ ...body, id: pickString(body, "id", "environmentId") ?? environmentId });
}

/** One `repo list` row (exact repository registered on a server). */
export interface OrcaRepoRow {
  id: string;
  path: string | null;
  displayName: string | null;
  /** "git" | "folder" | ... — folder workspaces are first-class (no Git). */
  kind: string | null;
  /** The execution host that owns this repo's workspaces, when reported. */
  hostId: string | null;
}

/** One `worktree list` row — `id` is the EXACT `id:<repoId>::<path>` selector. */
export interface OrcaWorktreeRow {
  id: string;
  repoId: string | null;
  path: string | null;
  displayName: string | null;
  branch: string | null;
  hostId: string | null;
  parentWorktreeId: string | null;
  isMainWorktree: boolean | null;
}

/** One `project list` row (durable project grouping repos across hosts). */
export interface OrcaProjectRow {
  id: string;
  displayName: string | null;
  kind: string | null;
  repoIds: string[];
}

function environmentArgs(environmentId: string | undefined): string[] {
  // Discovery on a SAVED environment scopes through the global --environment
  // flag; without one these list the local server (which is exactly the
  // zero-configuration default placement the viewer keeps).
  return environmentId ? ["--environment", environmentId] : [];
}

export async function listRepos(environmentId?: string): Promise<OrcaRepoRow[]> {
  const result = await runOrca<{ repos?: unknown[] }>(["repo", "list", ...environmentArgs(environmentId)]);
  return (result.repos ?? []).map(parseRepoRow).filter((r): r is OrcaRepoRow => r !== null);
}

/** Tolerant `repo list`/`repo show` row parser — a row without an id is dropped, never guessed. */
function parseRepoRow(raw: unknown): OrcaRepoRow | null {
  const r = asRecord(raw);
  const id = pickString(r, "id");
  if (!id) return null;
  return {
    id,
    path: pickString(r, "path"),
    displayName: pickString(r, "displayName", "display_name", "name"),
    kind: pickString(r, "kind"),
    hostId: pickString(r, "executionHostId", "execution_host_id", "hostId", "host_id"),
  };
}

export async function listWorktrees(
  environmentId?: string,
  opts: { repo?: string; limit?: number } = {},
): Promise<OrcaWorktreeRow[]> {
  const args = [
    "worktree",
    "list",
    ...environmentArgs(environmentId),
    ...(opts.repo ? ["--repo", opts.repo] : []),
    ...(opts.limit ? ["--limit", String(opts.limit)] : []),
  ];
  const result = await runOrca<{ worktrees?: unknown[] }>(args);
  return (result.worktrees ?? []).map(parseWorktreeRow).filter((r): r is OrcaWorktreeRow => r !== null);
}

/** Tolerant `worktree list`/`worktree show` row parser (same drop rule as repos). */
function parseWorktreeRow(raw: unknown): OrcaWorktreeRow | null {
  const r = asRecord(raw);
  const id = pickString(r, "id");
  if (!id) return null;
  return {
    id,
    repoId: pickString(r, "repoId", "repo_id"),
    path: pickString(r, "path"),
    displayName: pickString(r, "displayName", "display_name", "name"),
    branch: pickString(r, "branch"),
    hostId: pickString(r, "hostId", "host_id"),
    parentWorktreeId: pickString(r, "parentWorktreeId", "parent_worktree_id"),
    isMainWorktree: typeof r.isMainWorktree === "boolean" ? r.isMainWorktree : null,
  };
}

/**
 * Inspect ONE worktree by its EXACT selector — the pre-start revalidation the
 * placement contract requires ("exact workspace identity is revalidated
 * through Orca; missing or unverifiable identity is refused rather than
 * reconstructed"). Returns `null` only when Orca itself says no workspace
 * matches (`selector_not_found`); a transport failure throws, so an
 * unreachable runtime is never misrepresented as "no such workspace" and
 * never silently reroutes a task to a different placement.
 */
export async function showWorktree(
  selector: string,
  environmentId?: string,
): Promise<OrcaWorktreeRow | null> {
  let result: Record<string, unknown>;
  try {
    result = await runOrca<Record<string, unknown>>([
      "worktree",
      "show",
      "--worktree",
      selector,
      ...environmentArgs(environmentId),
    ]);
  } catch (err) {
    if (err instanceof OrcaCliError && (err.code === "selector_not_found" || err.code === "not_found")) {
      return null;
    }
    throw err;
  }
  // The row sits under `worktree` on current runtimes; a top-level row keeps
  // working (tolerant digging, same as showEnvironment).
  const body = asRecord(result.worktree ?? result);
  return parseWorktreeRow({ ...body, id: pickString(body, "id") ?? selector });
}

/**
 * Inspect ONE registered repository by exact selector — the new-top-level
 * counterpart of `showWorktree`. `null` only on Orca's own `repo_not_found`;
 * transport failures throw for the same reason.
 */
export async function showRepo(
  repoSelector: string,
  environmentId?: string,
): Promise<OrcaRepoRow | null> {
  let result: Record<string, unknown>;
  try {
    result = await runOrca<Record<string, unknown>>([
      "repo",
      "show",
      "--repo",
      repoSelector,
      ...environmentArgs(environmentId),
    ]);
  } catch (err) {
    if (err instanceof OrcaCliError && (err.code === "repo_not_found" || err.code === "not_found")) {
      return null;
    }
    throw err;
  }
  const body = asRecord(result.repo ?? result);
  return parseRepoRow({ ...body, id: pickString(body, "id") ?? repoSelector });
}

export async function listProjects(environmentId?: string): Promise<OrcaProjectRow[]> {
  const result = await runOrca<{ projects?: unknown[] }>(["project", "list", ...environmentArgs(environmentId)]);
  return (result.projects ?? [])
    .map((raw: unknown): OrcaProjectRow | null => {
      const r = asRecord(raw);
      const id = pickString(r, "id");
      if (!id) return null;
      const repoIds = Array.isArray(r.sourceRepoIds)
        ? r.sourceRepoIds.filter((x): x is string => typeof x === "string")
        : [];
      return {
        id,
        displayName: pickString(r, "displayName", "display_name", "name"),
        kind: pickString(r, "kind"),
        repoIds,
      };
    })
    .filter((r): r is OrcaProjectRow => r !== null);
}

// --- Orca-native file review and workspace cleanup --------------------------
//
// These adapters are the viewer's ONLY path to "open this file in the
// editor", "show me the diff", and "open what changed": each asks the Orca
// CLI to drive its own editor surface. The viewer process never invokes Git
// and never touches the worktree filesystem — even `file open-changed`'s
// changed-file discovery happens inside Orca (its docs: the list comes from
// git status for the SELECTED worktree). Paths may be worktree-relative or
// absolute-inside-the-worktree per the CLI docs; worktree selectors are
// passed through verbatim, never inferred.

/** Documented `file open-changed --mode` union (1.4.206: edit | diff | both). */
export type WorkspaceChangedMode = "edit" | "diff" | "both";

export interface WorkspaceFileReceipt {
  /** The path Orca acknowledged, when the receipt names one. */
  path: string | null;
  /** The worktree the operation resolved against, when the receipt echoes it. */
  worktree: string | null;
  /** The runtime's verbatim result — review evidence outlives the call. */
  raw: Record<string, unknown>;
}

function parseWorkspaceFileReceipt(result: unknown): WorkspaceFileReceipt {
  const body = asRecord(result);
  return {
    path: pickString(body, "path", "filePath", "file_path"),
    worktree: pickString(body, "worktree", "worktreeId", "worktree_id"),
    raw: body,
  };
}

/** Open one workspace file in the Orca editor (`file open`). */
export async function openWorkspaceFile(
  path: string,
  opts: { worktree?: string; environmentId?: string } = {},
): Promise<WorkspaceFileReceipt> {
  if (!path.trim()) {
    // Fail before spawning: an empty path would have the CLI resolve some
    // ambient target instead of the exact file the user pointed at.
    throw new OrcaCliError("file open requires a non-empty path", "invalid_argument");
  }
  const result = await runOrca<unknown>([
    "file",
    "open",
    path,
    ...(opts.worktree ? ["--worktree", opts.worktree] : []),
    ...environmentArgs(opts.environmentId),
  ]);
  return parseWorkspaceFileReceipt(result);
}

/**
 * Open one file's source-control diff in the Orca editor (`file diff`).
 * Diffs default to unstaged changes; `--staged` opens the staged diff.
 */
export async function openWorkspaceFileDiff(
  path: string,
  opts: { staged?: boolean; worktree?: string; environmentId?: string } = {},
): Promise<WorkspaceFileReceipt> {
  if (!path.trim()) {
    throw new OrcaCliError("file diff requires a non-empty path", "invalid_argument");
  }
  const result = await runOrca<unknown>([
    "file",
    "diff",
    path,
    ...(opts.staged ? ["--staged"] : []),
    ...(opts.worktree ? ["--worktree", opts.worktree] : []),
    ...environmentArgs(opts.environmentId),
  ]);
  return parseWorkspaceFileReceipt(result);
}

/**
 * Open every changed file of a workspace in the Orca editor
 * (`file open-changed`). The mode is a closed documented union — anything
 * outside edit|diff|both is refused HERE so a typo fails locally and never
 * travels as argv.
 */
export async function openWorkspaceChangedFiles(
  opts: { mode?: WorkspaceChangedMode; worktree?: string; environmentId?: string } = {},
): Promise<WorkspaceFileReceipt> {
  if (opts.mode && !["edit", "diff", "both"].includes(opts.mode)) {
    throw new OrcaCliError(
      `file open-changed mode must be one of edit|diff|both, got ${JSON.stringify(opts.mode)}`,
      "invalid_argument",
    );
  }
  const result = await runOrca<unknown>([
    "file",
    "open-changed",
    ...(opts.mode ? ["--mode", opts.mode] : []),
    ...(opts.worktree ? ["--worktree", opts.worktree] : []),
    ...environmentArgs(opts.environmentId),
  ]);
  return parseWorkspaceFileReceipt(result);
}

// --- Worktree removal (archive-hook semantics) ------------------------------
//
// `worktree rm` removes a worktree from Orca AND git. Its archive-hook
// contract (documented 1.4.206, pinned here because it is a safety floor):
//   - Repo-defined orca.yaml archive hooks are SKIPPED unless `--run-hooks`.
//   - With `--run-hooks`, a failed archive hook BLOCKS the removal — nothing
//     is stopped, deleted, or deregistered — and the CLI exits non-zero with
//     error code `worktree_archive_hook_failed`. `--force` does NOT waive it.
//   - `--allow-failed-archive-hook` deletes anyway after the hook has run and
//     failed; the waived failure is reported back on `result.archiveHookOverride`.
//     It REQUIRES `--run-hooks` (with no hook running there is no failure to
//     waive) and is rejected by the runtime without it.
// The adapter never adds `--allow-failed-archive-hook` on its own after a
// hook failure: waiving is an explicit caller decision, so the typed error
// propagates with the full envelope and removal state stays "nothing happened".
// The deletion itself runs inside Orca — this process never invokes git or
// touches the filesystem directly.

/** The documented 1.4.206 code for "an archive hook ran and failed". */
export const WORKTREE_ARCHIVE_HOOK_FAILED = "worktree_archive_hook_failed";

/** True when `worktree rm` was blocked by a failed archive hook (nothing was removed). */
export function isArchiveHookFailure(err: unknown): boolean {
  return err instanceof OrcaCliError && err.code === WORKTREE_ARCHIVE_HOOK_FAILED;
}

export interface WorktreeRemovalReceipt {
  /** Echo of the exact selector the removal was requested with. */
  worktree: string;
  /**
   * The runtime's verbatim waived-failure report (`result.archiveHookOverride`),
   * present only when removal proceeded past an explicitly waived hook failure.
   */
  archiveHookOverride: unknown;
  /** The runtime's verbatim result. */
  raw: Record<string, unknown>;
}

/**
 * Remove an Orca-managed worktree by its EXACT selector (`worktree rm`).
 * Fail-closed by construction: the waiver flag is validated against its
 * documented `--run-hooks` precondition BEFORE any call, and every failure
 * (hook failure included) throws with its verbatim code, message, and
 * envelope — the caller decides what, if anything, to waive and retry.
 */
export async function removeWorktree(
  selector: string,
  opts: {
    runHooks?: boolean;
    allowFailedArchiveHook?: boolean;
    force?: boolean;
    environmentId?: string;
  } = {},
): Promise<WorktreeRemovalReceipt> {
  if (!selector.trim()) {
    throw new OrcaCliError(
      "worktree rm requires an exact non-empty worktree selector",
      "invalid_argument",
    );
  }
  if (opts.allowFailedArchiveHook && !opts.runHooks) {
    throw new OrcaCliError(
      "--allow-failed-archive-hook requires --run-hooks (there is no failure to waive without running hooks)",
      "invalid_argument",
    );
  }
  const result = await runOrca<Record<string, unknown>>([
    "worktree",
    "rm",
    "--worktree",
    selector,
    ...(opts.force ? ["--force"] : []),
    ...(opts.runHooks ? ["--run-hooks"] : []),
    ...(opts.allowFailedArchiveHook ? ["--allow-failed-archive-hook"] : []),
    ...environmentArgs(opts.environmentId),
  ]);
  return {
    worktree: pickString(result, "worktree", "worktreeId", "worktree_id") ?? selector,
    archiveHookOverride: result.archiveHookOverride ?? null,
    raw: result,
  };
}

// --- Starting workers ------------------------------------------------------

/**
 * Harness → launch command for the LEGACY path only (custom commands, or an
 * agent `worker-start` refuses). On the `worker-start` path Orca owns the
 * launcher, so no hand-maintained autonomous flag is needed — which is why
 * these entries only matter for harnesses Orca does not recognize.
 *
 * `claude --dangerously-skip-permissions` is verified; the rest are the bare
 * command and will stall on a permission prompt unless you add the right flag.
 */
export const HARNESS_LAUNCH: Record<string, string> = {
  claude: "claude --dangerously-skip-permissions",
};

export function harnessCommand(harness: string): string {
  return HARNESS_LAUNCH[harness] ?? harness;
}

/** Quote one argument for the local POSIX shell used by terminal create. */
function quoteLocalShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Codex can repaint its loading screen after Orca has accepted dispatch input,
 * losing the preamble before a turn begins. For local workspaces,
 * start the TUI first and hand its ready terminal to worker-start. The model
 * (and optional effort) belong on THIS command: Orca forbids --model/--effort
 * with worker-start --terminal. The returned handle is only a provisional
 * resource until worker-start transfers it to a Dispatch.
 */
export async function prepareCodexTerminal(opts: {
  worktree: string;
  model?: string;
  effort?: string;
  /** A shell just created by `worktree create`; launch Codex in that pane. */
  terminal?: string;
  onHandle: (handle: string) => void;
}): Promise<string> {
  const command = [
    "codex",
    "--dangerously-bypass-approvals-and-sandbox",
    "--no-alt-screen",
    ...(opts.model ? ["-m", quoteLocalShellArg(opts.model)] : []),
    ...(opts.effort ? ["-c", quoteLocalShellArg(`model_reasoning_effort=${JSON.stringify(opts.effort)}`)] : []),
  ].join(" ");
  const created = opts.terminal ? null : await runOrca<{ terminal?: { handle?: string } }>([
    "terminal", "create", "--worktree", opts.worktree, "--command", command,
  ]);
  const handle = opts.terminal ?? created?.terminal?.handle;
  if (!handle) throw new OrcaCliError("orca terminal create returned no Codex handle");
  opts.onHandle(handle);
  if (opts.terminal) {
    // worktree create opens a shell but exposes no handle in its receipt on
    // 1.4.209. Once that exact pane has been identified below, start Codex
    // there. Its later ready-composer check proves the command actually ran.
    await runOrca(["terminal", "send", "--terminal", handle, "--text", command, "--enter"]);
  }

  const waited = await runOrca<{ wait?: { satisfied?: boolean } }>([
    "terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "90000",
  ]);
  if (!waited.wait?.satisfied) {
    throw new OrcaCliError(`Codex terminal ${handle} did not become idle before dispatch`, "codex_not_ready");
  }
  // tui-idle alone can precede the final Codex splash repaint. Require the
  // actual composer and a loaded model on two separate rendered frames; an
  // output-stream match would mistake old scrollback for the current screen.
  let readyFrames = 0;
  for (let i = 0; i < 40; i++) {
    const read = await runOrca<{ terminal?: { source?: string; tail?: string[] } }>([
      "terminal", "read", "--terminal", handle, "--screen",
    ]);
    const screen = read.terminal;
    const lines = screen?.source === "screen" && Array.isArray(screen.tail) ? screen.tail : [];
    const composerReady = lines.some((line) => line.includes("Ask Codex to do anything"));
    const modelReady = lines.some((line) => /model:\s*\S+/i.test(line) && !/model:\s*loading\b/i.test(line));
    readyFrames = composerReady && modelReady ? readyFrames + 1 : 0;
    if (readyFrames >= 2) return handle;
    await sleep(750);
  }
  throw new OrcaCliError(`Codex terminal ${handle} never showed a stable ready composer`, "codex_not_ready");
}

/**
 * `worker-start --worktree new-child --agent codex` can report
 * `input_accepted` while its newly launched Codex TUI repaints away the
 * preamble. Create the local workspace first, then start Codex in the shell
 * Orca opens for that workspace and bind the ready pane with --terminal.
 *
 * Orca 1.4.209's worktree-create receipt names the exact worktree but omits
 * the startup shell handle. A terminal-list difference scoped to that newly
 * created worktree is the only positive handle evidence. If it is ambiguous,
 * leave the worktree in place for recovery and never guess a terminal.
 */
export async function createLocalCodexWorktree(opts: {
  kind: "new-child" | "new-top-level";
  name: string;
  repo?: string;
  parentWorktree: string;
  baseBranch?: string;
  displayName?: string;
  comment?: string;
  setup?: string;
}): Promise<{ selector: string; path: string; terminal: string }> {
  assertValidWorkerStart({
    agent: "codex", worktree: opts.kind, name: opts.name,
    repo: opts.repo, baseBranch: opts.baseBranch,
    displayName: opts.displayName, comment: opts.comment, setup: opts.setup,
  });
  const before = new Set((await listTerminals()).map((terminal) => terminal.handle));
  const result = await runOrca<{ worktree?: Record<string, unknown> }>([
    "worktree", "create", "--name", opts.name,
    ...(opts.kind === "new-child"
      ? ["--parent-worktree", opts.parentWorktree]
      : [...(opts.repo ? ["--repo", opts.repo] : []), "--no-parent"]),
    ...(opts.baseBranch ? ["--base-branch", opts.baseBranch] : []),
    ...(opts.comment ? ["--comment", opts.comment] : []),
    ...(opts.setup ? ["--setup", opts.setup] : []),
  ]);
  const id = pickString(asRecord(result.worktree), "id");
  if (!id) throw new OrcaCliError("worktree create returned no exact worktree id", "workspace_unverifiable");
  const selector = id.startsWith("id:") ? id : `id:${id}`;
  const row = await showWorktree(selector);
  if (!row || row.id !== id || !row.path) {
    throw new OrcaCliError(`Created Codex worktree ${selector} could not be verified`, "workspace_unverifiable");
  }
  if (opts.displayName) {
    await runOrca(["worktree", "set", "--worktree", selector, "--display-name", opts.displayName]);
  }
  let candidates: OrcaTerminal[] = [];
  for (let i = 0; i < 20; i++) {
    candidates = (await listTerminals()).filter((terminal) =>
      terminal.connected && terminal.worktreeId === id && !before.has(terminal.handle));
    if (candidates.length) break;
    await sleep(250);
  }
  if (candidates.length !== 1) {
    throw new OrcaCliError(
      `Created Codex worktree ${selector}, but its startup terminal is ${candidates.length ? "ambiguous" : "unreported"}; recover it through Orca`,
      "workspace_unverifiable",
    );
  }
  return { selector, path: row.path, terminal: candidates[0].handle };
}

/** How a task's worker was started — decides how we tear it down. */
export type WorkerMode = "supervised" | "legacy";

export interface StartedWorker {
  mode: WorkerMode;
  /** Supervised attempts only. */
  dispatchId: string | null;
  /** The worker terminal, when we created it ourselves. */
  handle: string | null;
  /** The full start receipt (supervised lane) — retained by the coordinator. */
  receipt: WorkerStartReceipt | null;
  /** True when the outcome was recovered via request-show + same-id replay. */
  replayed: boolean;
  /**
   * True when, after a lost response Orca could not confirm (`absent`), an
   * active Dispatch for the task was ADOPTED from worker-list instead of
   * starting a second worker.
   */
  adopted: boolean;
}

/** Dig the dispatch id out of a `worker-start` receipt, whatever its shape. */
function readDispatchId(result: unknown): string | null {
  const r = (result ?? {}) as Record<string, unknown>;
  const direct = r.dispatchId ?? r.dispatch_id;
  if (typeof direct === "string" && direct) return direct;
  for (const key of ["dispatch", "worker"]) {
    const nested = r[key] as Record<string, unknown> | undefined;
    const id = nested?.id ?? nested?.dispatchId ?? nested?.dispatch_id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/**
 * Preferred path: let Orca compose worktree + terminal + readiness + dispatch.
 * Exits 0 only when the worker is `ready`; a failed start throws a
 * `WorkerStartError` carrying the parsed receipt.
 *
 * Phase 4 idempotency:
 *  - the call always carries a `--retry-request` id (generated here when the
 *    caller didn't pin one) and optionally `--retry-of <dispatch>` lineage;
 *  - a LOST response (timeout / unreadable output) is resolved through
 *    `request-show`: completed/pending → replay the exact argv with the SAME
 *    id (Orca answers from its recorded outcome — no second Dispatch);
 *    `absent` → never replay blind. Instead, worker-list is checked for an
 *    active Dispatch on this task: adopt it if present (it is ours by
 *    timing and scope), otherwise surface a definite failed start carrying
 *    whatever receipt the runtime did record.
 */
/**
 * Validate one worker-start request BEFORE any Orca mutation (the last gate
 * in front of the CLI — the config type and HTTP layer reject earlier, but
 * this function trusts nothing upstream). Every refusal here is an
 * `invalid_argument` thrown without spawning a process.
 *
 * Placement rules (remote = `on` present):
 *   * remote `current`/`active` and `new-child` are refused outright —
 *     "whatever this server has checked out" and "stacked on the coordinator's
 *     workspace" are meaningless on a different machine;
 *   * remote `new-top-level` must name an exact repo selector AND an explicit
 *     worktree name — the execution host cannot guess either;
 *   * `--on` never combines with `--terminal`: reuse addresses an agent
 *     terminal this viewer can see, and substituting a remote terminal handle
 *     is forbidden (remote workers are addressed by Dispatch ID only);
 *   * creation flags (`--repo`, `--name`, `--base-branch`, `--display-name`,
 *     `--comment`, `--setup`) ride ONLY on the two new-worktree modes — Orca
 *     rejects them for current/existing worktrees, and this gate refuses
 *     earlier without a spawn;
 *   * `--repo` applies ONLY to `new-top-level`: a `new-child` anchors on the
 *     current workspace's own repo and cannot select another;
 *   * creation metadata is charset/bounds-checked here too (same grammar as
 *     the HTTP layer), because the coordinator passes stored-config values
 *     straight through and this function's contract is to trust nothing.
 *
 * By validation time the request MUST carry a name for a creating start —
 * `startSupervisedWorker` fills a missing local name via
 * `withDerivedCreationDefaults` BEFORE calling this gate, so a direct caller
 * skipping that step is the bug this refusal reports.
 */
/**
 * The placement-relevant slice of a worker-start request. Everything except
 * the placement fields is carried so callers can pass their FULL options
 * object straight in — validation reads presence, never identity.
 */
export interface WorkerStartRequest {
  taskId?: string;
  agent?: string;
  runId?: string;
  from?: string;
  worktree?: string;
  model?: string;
  effort?: string;
  terminal?: string;
  on?: string;
  repo?: string;
  name?: string;
  /** Base branch/ref the new worktree is created from (`--base-branch`). */
  baseBranch?: string;
  /** Orca display-name override for the new worktree (`--display-name`). */
  displayName?: string;
  /** Comment stored in Orca worktree metadata (`--comment`). */
  comment?: string;
  /** Setup-hook policy for the new worktree (`--setup run|skip|inherit`). */
  setup?: string;
}

export function assertValidWorkerStart(opts: WorkerStartRequest): void {
  if (opts.terminal && (opts.model || opts.effort)) {
    throw new OrcaCliError(
      "worker-start: --model/--effort cannot combine with --terminal (a reused terminal keeps its original launch).",
      "invalid_argument",
    );
  }
  if (opts.effort && !opts.model) {
    throw new OrcaCliError(
      "worker-start: --effort requires --model (per-task effort only applies to a selected model).",
      "invalid_argument",
    );
  }
  if (opts.on && opts.terminal) {
    throw new OrcaCliError(
      "worker-start: --on cannot combine with --terminal (a remote worker is addressed by Dispatch ID; " +
        "this viewer never substitutes a remote terminal handle).",
      "invalid_argument",
    );
  }
  const worktree = opts.worktree ?? "current";
  const creating = worktree === "new-top-level" || worktree === "new-child";
  if (opts.on) {
    if (worktree === "current" || worktree === "active") {
      throw new OrcaCliError(
        `worker-start: remote placement "current" is ambiguous across servers — choose an exact ` +
          `existing workspace selector discovered on the target environment, or new-top-level.`,
        "invalid_argument",
      );
    }
    if (worktree === "new-child") {
      throw new OrcaCliError(
        `worker-start: remote placement "new-child" is invalid — a stacked child would anchor on ` +
          `the wrong server. Use an exact existing workspace selector or new-top-level.`,
        "invalid_argument",
      );
    }
    if (worktree === "new-top-level") {
      if (!opts.repo) {
        throw new OrcaCliError(
          "worker-start: remote new-top-level requires an exact --repo selector discovered on the target environment.",
          "invalid_argument",
        );
      }
      if (!opts.name) {
        throw new OrcaCliError(
          "worker-start: remote new-top-level requires an explicit --name for the new worktree.",
          "invalid_argument",
        );
      }
    }
  }
  // Creation flags are creation-mode-only. One check for the whole family —
  // current/existing worktrees are never created and never rerun setup, so
  // ANY creation field there is a caller bug, not a preference to drop.
  if (
    !creating &&
    (opts.repo || opts.name || opts.baseBranch || opts.displayName || opts.comment || opts.setup)
  ) {
    throw new OrcaCliError(
      "worker-start: creation flags (--repo, --name, --base-branch, --display-name, --comment, --setup) " +
        "only apply to new-top-level (or new-child) worktrees.",
      "invalid_argument",
    );
  }
  if (creating && opts.repo && worktree !== "new-top-level") {
    throw new OrcaCliError(
      "worker-start: --repo only applies to new-top-level — a new-child anchors on the " +
        "current workspace's own repo.",
      "invalid_argument",
    );
  }
  // Metadata charset/bounds — the same grammar the HTTP layer enforces, re-checked
  // here because this gate's contract is to trust nothing upstream (the
  // coordinator feeds it stored-config values directly).
  if (opts.name && !PLACEMENT_NAME_PATTERN.test(opts.name)) {
    throw new OrcaCliError(
      `worker-start: --name ${JSON.stringify(opts.name.slice(0, 64))} must be a short name ` +
        "(letters, digits, . _ -).",
      "invalid_argument",
    );
  }
  if (opts.baseBranch) {
    const branch = opts.baseBranch;
    if (branch.length > 128 || !BASE_BRANCH_PATTERN.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".")) {
      throw new OrcaCliError(
        `worker-start: --base-branch ${JSON.stringify(branch.slice(0, 64))} is not a usable git ref.`,
        "invalid_argument",
      );
    }
  }
  for (const [flag, value, max] of [
    ["--display-name", opts.displayName, DISPLAY_NAME_MAX],
    ["--comment", opts.comment, COMMENT_MAX],
  ] as const) {
    if (!value) continue;
    // eslint-disable-next-line no-control-regex — exactly what we are screening for
    if (value.length > max || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) {
      throw new OrcaCliError(
        `worker-start: ${flag} must be bounded free text without control characters (max ${max}).`,
        "invalid_argument",
      );
    }
  }
  if (opts.setup && !SETUP_POLICIES.has(opts.setup)) {
    throw new OrcaCliError(
      `worker-start: --setup ${JSON.stringify(opts.setup.slice(0, 32))} must be run, skip or inherit.`,
      "invalid_argument",
    );
  }
  if (creating && !opts.name) {
    throw new OrcaCliError(
      `worker-start: ${worktree} creates a worktree and requires an explicit --name ` +
        "(local starts get one derived via withDerivedCreationDefaults before this gate).",
      "invalid_argument",
    );
  }
}

/**
 * A deterministic, bounded worktree name derived from the Run and the
 * Task/lane identity — the fallback for a creating start whose placement
 * spec carried no explicit `name`. Deterministic so a replayed start (same
 * request id, same argv) and a retry that must recreate can both reproduce
 * the SAME name; bounded so it always satisfies the `--name` grammar
 * (PLACEMENT_NAME_PATTERN) Orca accepts.
 */
export function deriveWorktreeName(runId: string, scopeId: string): string {
  const digest = createHash("sha256").update(`${runId}\u0000${scopeId}`).digest("hex").slice(0, 8);
  // Keep the human-readable prefix of the task/lane id, collapse anything
  // outside the name grammar to "-", and trim so base + "-" + 8 digest chars
  // always fit the 64-char bound with a leading alphanumeric.
  const base =
    scopeId
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 40) || "wt";
  return `${base}-${digest}`;
}

/**
 * Fill the creation-name default for a LOCAL creating start: `new-child` /
 * `new-top-level` without an explicit name get `deriveWorktreeName(runId,
 * taskId)`. Remote starts are left untouched — a saved-environment
 * new-top-level must carry an explicit name (validated next gate), and a
 * request without taskId/runId cannot derive anything and is refused rather
 * than guessed.
 */
export function withDerivedCreationDefaults<T extends WorkerStartRequest>(opts: T): T {
  const worktree = opts.worktree ?? "current";
  if (worktree !== "new-child" && worktree !== "new-top-level") return opts;
  if (opts.name || opts.on || !opts.taskId || !opts.runId) return opts;
  return { ...opts, name: deriveWorktreeName(opts.runId, opts.taskId) };
}

/**
 * The exact `orchestration worker-start` argv for one start request, shared by
 * the direct path and the request-show/idempotent replay (both must send the
 * SAME argv — a replayed start that grew different flags would not be a
 * replay). Pure so tests can pin the wire contract without spawning.
 */
export function buildWorkerStartArgv(
  opts: {
    taskId: string;
    agent: string;
    runId: string;
    from: string;
    terminal?: string;
    worktree?: string;
    model?: string;
    effort?: string;
    retryOf?: string;
    on?: string;
    repo?: string;
    name?: string;
    baseBranch?: string;
    displayName?: string;
    comment?: string;
    setup?: string;
  },
  requestId: string,
): string[] {
  const args = [
    "orchestration",
    "worker-start",
    "--task",
    opts.taskId,
    // Reuse passes the terminal handle instead of an agent id — the handle
    // IS the agent's terminal; Orca transfers it to the new Dispatch.
    ...(opts.terminal ? ["--terminal", opts.terminal] : ["--agent", opts.agent]),
    "--worktree",
    opts.worktree ?? "current",
    "--run",
    opts.runId,
    "--from",
    opts.from,
    // Durable idempotency key — see resolveAmbiguousStart below.
    "--retry-request",
    requestId,
  ];
  if (opts.retryOf) args.push("--retry-of", opts.retryOf);
  if (opts.model) args.push("--model", opts.model);
  // Only ever alongside --model (enforced in assertValidWorkerStart): the CLI
  // rejects a bare --effort, and we don't paper over that with a silent drop.
  if (opts.model && opts.effort) args.push("--effort", opts.effort);
  // Phase 6: `--on` selects ONLY the worker's execution server; the Run, this
  // command, and every later operation stay on the local server. It appears
  // here and nowhere else in the viewer's Orca surface.
  if (opts.on) args.push("--on", opts.on);
  // Creation flags ONLY on the two new-worktree modes — structurally, not
  // just via the validator: this builder also builds the REPLAYED argv after
  // a lost response, and a creation flag that leaked onto a current/existing
  // start would make the replay a different (rejected) command. `--repo` is
  // new-top-level-only even within the creation branch: a new-child anchors
  // on the current workspace's own repo and cannot select another.
  if (opts.worktree === "new-top-level" || opts.worktree === "new-child") {
    if (opts.worktree === "new-top-level" && opts.repo) args.push("--repo", opts.repo);
    if (opts.name) args.push("--name", opts.name);
    if (opts.baseBranch) args.push("--base-branch", opts.baseBranch);
    if (opts.displayName) args.push("--display-name", opts.displayName);
    if (opts.comment) args.push("--comment", opts.comment);
    if (opts.setup) args.push("--setup", opts.setup);
  }
  return args;
}

export async function startSupervisedWorker(opts: {
  taskId: string;
  agent: string;
  runId: string;
  from: string;
  worktree?: string;
  model?: string;
  /**
   * Reasoning effort for the selected model (Phase 5). Orca's contract:
   * `--effort` requires `--model`, so an effort without a model is a caller
   * bug — refused here rather than silently dropped (a silently-dropped
   * preference would make "requested" lie about what was launched).
   */
  effort?: string;
  /**
   * Reuse an existing worker terminal (Phase 5): `--terminal <handle>`
   * replaces `--agent` — the terminal already runs a specific agent TUI. The
   * CLI refuses `--model`/`--effort` alongside `--terminal` (a reused terminal
   * relaunches nothing), so both are refused here for the same reason.
   */
  terminal?: string;
  /** Durable retry-request id; generated when absent. */
  retryRequestId?: string;
  /** Lineage when this is an explicit retry of a settled Dispatch. */
  retryOf?: string;
  /**
   * Saved environment selector (Phase 6): execute this worker on the connected
   * Orca server named here while the Run stays local. Routed through
   * `assertValidWorkerStart` FIRST — a remote `current`/`new-child` never
   * reaches Orca.
   */
  on?: string;
  /** Exact repo selector for a (remote or local) new-top-level worktree. */
  repo?: string;
  /**
   * Explicit name for a new-top-level/new-child worktree. Optional on LOCAL
   * creating starts: when absent, a deterministic bounded name is derived
   * from the Run and Task ids (`withDerivedCreationDefaults`) BEFORE
   * validation, so the derived name is part of the argv any replay reuses.
   * Remote new-top-level still requires an explicit name.
   */
  name?: string;
  /** Base branch/ref the new worktree is created from (creation modes only). */
  baseBranch?: string;
  /** Orca display-name override for the new worktree (creation modes only). */
  displayName?: string;
  /** Comment stored in Orca worktree metadata (creation modes only). */
  comment?: string;
  /** Setup-hook policy for the new worktree (creation modes only). */
  setup?: string;
}): Promise<StartedWorker> {
  // Local creating starts get their derived name BEFORE the last gate, so the
  // gate's "creation requires a name" rule stays absolute and the derived
  // name is baked into the exact argv a replay must reuse.
  const request = withDerivedCreationDefaults(opts);
  // The last gate before the CLI: remote current/new-child, --on+--terminal,
  // unpaired effort, creation-flag misuse, and malformed metadata all refuse
  // WITHOUT a spawn.
  assertValidWorkerStart(request);
  const requestId = opts.retryRequestId ?? newRequestId();
  const buildArgs = (): string[] => buildWorkerStartArgv(request, requestId);

  let result: Record<string, unknown>;
  try {
    result = await runOrca<Record<string, unknown>>(buildArgs());
  } catch (err) {
    const e = err as OrcaCliError;
    // A definite failure (ok:false envelope): preserve the receipt and rethrow
    // it typed — this is the "failed-before-ready" path.
    if (e instanceof OrcaCliError && e.code !== RESPONSE_LOST && e.payload !== undefined) {
      const receipt = parseWorkerStartReceipt(e.payload, false);
      throw new WorkerStartError(receipt, e.message, e.code);
    }
    // Ambiguous: did the start land? Ask Orca before doing anything else.
    if (e instanceof OrcaCliError && e.code === RESPONSE_LOST) {
      return resolveAmbiguousStart(opts, requestId, buildArgs, e);
    }
    // cli_not_found / spawn failures: the command never ran — nothing landed,
    // nothing to resolve. Surface a receipt-less failed start.
    throw new WorkerStartError(
      parseWorkerStartReceipt(undefined, false),
      e.message,
      e.code ?? null,
    );
  }
  const receipt = parseWorkerStartReceipt(result, true);
  return {
    mode: "supervised",
    dispatchId: receipt.dispatchId ?? readDispatchId(result),
    handle: null,
    // The caller MINTED this id and sent it — it is the durable id even when a
    // runtime version forgets to echo it back in the receipt.
    receipt: { ...receipt, requestId: receipt.requestId ?? requestId },
    replayed: false,
    adopted: false,
  };
}

/**
 * Recovery for a lost worker-start response. Contract (plan Phase 4 item 3):
 * `request-show` first; replay ONLY when Orca reports `completed` (recorded
 * outcome replayed verbatim) or `pending` (replay with the same id — our
 * original process is gone), never for `absent`; and when we cannot confirm
 * either way, reconcile against worker-list and adopt an already-running
 * Dispatch for the task instead of minting a second one.
 */
async function resolveAmbiguousStart(
  opts: { taskId: string; runId: string },
  requestId: string,
  buildArgs: () => string[],
  original: OrcaCliError,
): Promise<StartedWorker> {
  let probe: OrcaRequestReceipt | null = null;
  try {
    probe = await showRequest(requestId);
  } catch {
    probe = null;
  }
  if (probe && (probe.state === "completed" || probe.state === "pending")) {
    try {
      const result = await runOrca<Record<string, unknown>>(buildArgs());
      const receipt = parseWorkerStartReceipt(result, true);
      return {
        mode: "supervised",
        dispatchId: receipt.dispatchId ?? readDispatchId(result),
        handle: null,
        // Same stamping rule as the direct path: the minted id is authoritative.
        receipt: { ...receipt, requestId: receipt.requestId ?? requestId },
        replayed: true,
        adopted: false,
      };
    } catch (err) {
      const e = err as OrcaCliError;
      // A second lost response: still ambiguous — give up WITHOUT a decision.
      if (e instanceof OrcaCliError && e.code === RESPONSE_LOST) throw original;
      if (e.payload !== undefined) {
        // Definite recorded outcome this time (often the original failure).
        const receipt = parseWorkerStartReceipt(e.payload, false);
        throw new WorkerStartError(receipt, e.message, e.code);
      }
      throw original;
    }
  }
  // `absent` (or probe failed): absent is NOT proof nothing happened, so the
  // only safe move is to look for evidence of a landed start.
  // --include-remote: a start addressed to a connected server may have landed
  // THERE — a local-only listing would misread it as unlanded and re-place it.
  try {
    const rows = await listWorkers(opts.runId, { includeRemote: true });
    const candidate = rows.find(
      (r) => r.taskId === opts.taskId && r.dispatchStatus === "dispatched",
    );
    if (candidate) {
      // Adopted: Orca's own accounting says a live Dispatch for this task
      // exists. Never start a second one on top of it.
      return {
        mode: "supervised",
        dispatchId: candidate.dispatchId,
        handle: null,
        receipt: {
          ...parseWorkerStartReceipt(undefined, true),
          dispatchId: candidate.dispatchId,
          requestId,
          status: "adopted",
        },
        replayed: false,
        adopted: true,
      };
    }
  } catch {
    // worker-list unavailable: fall through to the unresolved start failure.
  }
  // No receipt, no live Dispatch: record a failed start whose receipt says
  // exactly how unresolved it is. The coordinator parks it (never auto-retries).
  throw new WorkerStartError(
    {
      ...parseWorkerStartReceipt(undefined, false),
      ok: false,
      requestId,
      failedStage: "response_lost",
      raw: {
        interpretation:
          probe?.interpretation ??
          "worker-start response was lost and Orca holds no receipt for it; " +
            "no active Dispatch for the task was found either.",
      },
    },
    original.message,
    RESPONSE_LOST,
  );
}

/**
 * Enumerate available models for a harness.
 *
 * Only opencode exposes a real, enumerable list (`opencode models` prints
 * `provider/model` lines). claude/codex/cursor have no programmatic model list
 * from either orca or their own CLIs, so this returns nothing for them — the UI
 * falls back to free-text input. Anything else (gemini/grok/kimi/custom) is not
 * model-selectable here either.
 */
export async function listModels(harness: string): Promise<string[]> {
  if (harness !== "opencode") return [];
  try {
    const { stdout } = await pExecFile("opencode", ["models"], { timeout: 20000 });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      // Same grammar the HTTP boundary validates (security.ts): provider/model
      // plus the optional bounded `#variant` suffix, so an enumerated variant
      // id like `zai-coding-plan/glm-5.3-flash#high` survives the round-trip into the picker.
      .filter((l) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:#[A-Za-z0-9._-]{1,64})?$/.test(l));
  } catch {
    return [];
  }
}

/**
 * opencode workaround, verified end-to-end against Orca on 2026-08-10.
 *
 * `worker-start --agent opencode` opens the opencode TUI but does not reliably
 * land the injected preamble (orca #9951) — the app opens with no prompt and
 * never executes. The generic TUI-injection that `startLegacyWorker` uses is
 * the same unreliable channel, so opencode gets its own path:
 *
 *   1. create a BARE SHELL terminal (NOT the opencode TUI),
 *   2. dispatch for tracking only (no `--inject`) to mint a real dispatch_id,
 *   3. fetch the preamble — it now carries that real dispatch_id AND the
 *      worker handle as `--from`, both required for worker_done to settle,
 *   4. `exec opencode run --auto "$(cat <preamble-file>)"` in the shell.
 *
 * `exec` is load-bearing: without it, a completed/crashed opencode process
 * returns to the bare zsh. Any best-effort Orca wake-up text that was still in
 * the PTY input buffer is then interpreted as shell commands, and the terminal
 * looks live even though the agent is gone. Replacing the shell makes process
 * exit observable and prevents post-completion messages from landing in zsh.
 *
 * opencode executes the preamble's `orca orchestration send --type worker_done`
 * via its Bash tool, settling the task (`completed`), which the coordinator
 * loop picks up from task-list. `--auto` is REQUIRED: opencode's default
 * permission policy auto-rejects tool calls (e.g. writing outside the project)
 * and silently kills the task otherwise — the same class of quirk as
 * `claude --dangerously-skip-permissions` above.
 */
async function startOpencodeWorker(opts: {
  taskId: string;
  runId: string;
  from: string;
  worktree?: string;
  model?: string;
  onHandle?: (handle: string) => void;
}): Promise<StartedWorker> {
  const created = await runOrca<{ terminal?: { handle?: string } }>([
    "terminal",
    "create",
    "--worktree",
    opts.worktree ?? "active",
    "--command",
    "/bin/zsh",
  ]);
  const handle = created.terminal?.handle;
  if (!handle) throw new OrcaCliError("orca terminal create returned no worker handle (opencode)");
  opts.onHandle?.(handle);

  // Dispatch for tracking only (no --inject). This mints a real dispatch_id,
  // without which the preamble below would still carry the ctx_preview
  // placeholder and worker_done could never settle.
  const tracking = await runOrca<Record<string, unknown>>([
    "orchestration",
    "dispatch",
    "--task",
    opts.taskId,
    "--to",
    handle,
    "--run",
    opts.runId,
    "--from",
    opts.from,
  ]);
  const dispatchId = readDispatchId(tracking);
  if (!dispatchId) throw new OrcaCliError("orca dispatch returned no dispatch ID (opencode)");

  // Fetch the preamble. After the tracking dispatch it embeds the real
  // dispatch_id and the worker handle (`--from <handle>`), which the worker
  // process must echo back for worker_done to be accepted.
  const shown = await runOrca<{ preamble?: string }>([
    "orchestration",
    "dispatch-show",
    "--task",
    opts.taskId,
    "--preamble",
    "--from",
    opts.from,
  ]);
  if (!shown.preamble) throw new OrcaCliError("orca dispatch-show returned no preamble (opencode)");

  // Write the preamble to a temp file and pass it as ONE shell argument via
  // "$(cat ...)". Embedding the multiline preamble directly would put it
  // through shell quoting/escaping hell; reading it from a file keeps it byte
  // for byte intact.
  const preambleFile = join(tmpdir(), `orca-preamble-${opts.taskId}.txt`);
  await writeFile(preambleFile, shown.preamble);
  // `opencode run -m <provider/model[#variant]>` selects the model; the
  // preamble is passed as ONE shell arg read from a file. Quoting the model
  // keeps any odd provider ids safe — and the upstream validator
  // (validateModel) has already bounded it to provider/model plus an optional
  // #variant suffix, so no quote, space or shell operator can be inside.
  // `--auto` is the mandatory autonomous flag (see the docstring).
  const modelArg = opts.model ? ` -m "${opts.model}"` : "";
  // A provider-issued session ID does not exist until `opencode run` starts.
  // Its unique launch title lets the background API later correlate that ID
  // with this exact Dispatch, including after this viewer has restarted.
  const titleArg = ` --title "${openCodeSessionTitle(opts.runId, opts.taskId, dispatchId)}"`;
  // Replace the bare shell instead of leaving it behind after the one-shot
  // agent exits. Besides avoiding a stale terminal, this guarantees buffered
  // orchestration nudges can never fall through and execute as zsh commands.
  const cmd = `exec opencode run --auto${modelArg}${titleArg} "$(cat ${preambleFile})"`;
  await runOrca(["terminal", "send", "--terminal", handle, "--text", cmd, "--enter"]);

  return { mode: "legacy", dispatchId, handle, receipt: null, replayed: false, adopted: false };
}

/**
 * Fallback for harnesses Orca does not know as a configured TUI agent (custom
 * commands, or anything `worker-start` rejects with `agent_unconfigured`).
 *
 * Mirrors what `worker-start` composes, by hand: create the terminal, wait for
 * its TUI, then dispatch. `--inject` needs Orca to recognize a running agent in
 * the pane; when it doesn't, we fall back to dispatching for tracking only and
 * typing the preamble in ourselves.
 *
 * opencode is handled specially (see `startOpencodeWorker`): its TUI does not
 * accept the injected preamble, so it runs `opencode run --auto` in a bare
 * shell instead.
 */
export async function startLegacyWorker(opts: {
  taskId: string;
  harness: string;
  runId: string;
  from: string;
  worktree?: string;
  model?: string;
  /**
   * Called the moment the viewer-created terminal exists (Phase 4): a later
   * step failing must not orphan a pane we provably created — the coordinator
   * records the handle immediately and closes it on the failure path.
   */
  onHandle?: (handle: string) => void;
}): Promise<StartedWorker> {
  if (opts.harness === "opencode") {
    return startOpencodeWorker(opts);
  }
  const created = await runOrca<{ terminal?: { handle?: string } }>([
    "terminal",
    "create",
    "--worktree",
    opts.worktree ?? "active",
    "--command",
    harnessCommand(opts.harness),
  ]);
  const handle = created.terminal?.handle;
  if (!handle) throw new OrcaCliError("orca terminal create returned no worker handle");
  opts.onHandle?.(handle);
  let dispatchId: string | null = null;

  try {
    await runOrca([
      "terminal",
      "wait",
      "--terminal",
      handle,
      "--for",
      "tui-idle",
      "--timeout-ms",
      "45000",
    ]);
  } catch {
    // some harnesses never report tui-idle; try to dispatch anyway
  }

  const base = [
    "orchestration",
    "dispatch",
    "--task",
    opts.taskId,
    "--to",
    handle,
    "--run",
    opts.runId,
    "--from",
    opts.from,
  ];

  try {
    const dispatched = await runOrca<Record<string, unknown>>([...base, "--inject"]);
    dispatchId = readDispatchId(dispatched);
    // `--inject` types the preamble into the TUI but does not reliably submit
    // it — the text can sit unsent in the input box. Settle, then press Enter.
    // A stray Enter on an already-submitted input is a harmless no-op.
    await sleep(2000);
    await runOrca(["terminal", "send", "--terminal", handle, "--enter"]).catch(() => {});
  } catch (err) {
    if ((err as OrcaCliError).code !== "agent_unconfigured") throw err;
    // Bare shell: dispatch for tracking, then deliver the preamble manually.
    const dispatched = await runOrca<Record<string, unknown>>(base);
    dispatchId = readDispatchId(dispatched);
    const shown = await runOrca<{ preamble?: string }>([
      "orchestration",
      "dispatch-show",
      "--task",
      opts.taskId,
      "--preamble",
      "--from",
      opts.from,
    ]);
    if (shown.preamble) {
      await runOrca([
        "terminal",
        "send",
        "--terminal",
        handle,
        "--text",
        shown.preamble,
        "--enter",
      ]);
    }
  }

  return { mode: "legacy", dispatchId, handle, receipt: null, replayed: false, adopted: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- DAG projection --------------------------------------------------------

/**
 * Transform a Run's task list into a nodes/edges DAG for the UI.
 *
 * Phase 4: the projection now ALSO carries the parent/child structure — as a
 * separate `hierarchy` list, never folded into `edges`. A parent relation is
 * ownership, not a dependency: it must not create a dependency arrow, must not
 * gate readiness, and must not influence layout ranking.
 */
export function tasksToDag(tasks: OrcaTask[]): {
  nodes: DagNode[];
  edges: DagEdge[];
  hierarchy: DagHierarchyLink[];
} {
  const idSet = new Set(tasks.map((t) => t.id));
  const nodes: DagNode[] = tasks.map((t) => ({
    id: t.id,
    label: (t.display_name || t.task_title || t.spec || t.id).trim(),
    status: t.status,
    spec: t.spec,
    result: t.result,
    createdAt: t.created_at,
    completedAt: t.completed_at,
    dispatchId: t.dispatch_id ?? null,
    assigneeHandle: t.assignee_handle ?? null,
    // Preserved verbatim even when dangling: it is Orca's fact about the Task,
    // and the node detail can say "parent not in this Run" instead of hiding it.
    parentId: t.parent_id ?? null,
  }));

  const edges: DagEdge[] = [];
  for (const t of tasks) {
    for (const dep of parseDeps(t.deps)) {
      // Deps are Run-scoped in practice: task-list only returns this Run's rows,
      // so an id we don't know is a dangling edge and is dropped.
      if (idSet.has(dep)) {
        edges.push({ id: `${dep}__${t.id}`, source: dep, target: t.id });
      }
    }
  }

  // Hierarchy links: only between Tasks that both exist in THIS Run (a parent
  // from another Run — or a stale id — cannot be drawn). The `__hier__` infix
  // keeps link ids in a different namespace than dependency edge ids
  // (`<dep>__<task>`), so the two can never collide or be confused.
  const hierarchy: DagHierarchyLink[] = [];
  for (const t of tasks) {
    if (t.parent_id && idSet.has(t.parent_id)) {
      hierarchy.push({ id: `${t.parent_id}__hier__${t.id}`, parent: t.parent_id, child: t.id });
    }
  }
  return { nodes, edges, hierarchy };
}

/**
 * True when a gate still blocks whatever it is bound to. Matches the GatePanel
 * rule exactly (status pending/open, or no resolution recorded): the three
 * shapes Orca's tolerant gate receipts take for "not decided yet".
 */
function gateIsOpen(g: Gate): boolean {
  return g.status === "pending" || g.status === "open" || !g.resolution;
}

/**
 * Explain scheduler readiness for one Run (operations epic O5 / plan Phase 4).
 *
 * Pure projection over Run-scoped facts: `task-list` rows, `gate-list` rows,
 * and — optionally — this viewer coordinator's worker-slot occupancy. It never
 * mutates anything, never invents order among equally ready Tasks (the wave is
 * sorted by id purely for deterministic rendering), and treats capacity as
 * unknown rather than zero when no viewer coordinator is running the Run.
 *
 * Block-reason precedence for a `pending` Task: unmet dependencies first, then
 * an open gate — a Task can wait on both at once and both are reported. A
 * `pending`/`blocked` Task with NOTHING visible against it is `unknown`: Orca
 * itself flips those to `ready` (the coordinator nudges them), so a lingering
 * non-ready row is a runtime fact we must not paper over.
 */
export function explainReadiness(
  tasks: OrcaTask[],
  gates: Gate[],
  occupancy: SchedulerOccupancy | null,
): { readyWave: ReadyWaveView; readiness: Record<string, DagNodeReadiness> } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const openGatesByTask = new Map<string, Gate[]>();
  for (const g of gates) {
    if (!g.taskId || !gateIsOpen(g) || !byId.has(g.taskId)) continue;
    const list = openGatesByTask.get(g.taskId) ?? [];
    list.push(g);
    openGatesByTask.set(g.taskId, list);
  }

  const freeSlots =
    occupancy && occupancy.maxConcurrency > 0
      ? Math.max(0, occupancy.maxConcurrency - occupancy.busy)
      : occupancy
        ? 0
        : null;

  const statusWord = (id: string): string => byId.get(id)?.status ?? "missing";
  const depSentence = (ids: string[]): string =>
    ids.map((id) => `${id} (${statusWord(id)})`).join(", ");

  const readyWave: ReadyWaveView = {
    taskIds: tasks.filter((t) => t.status === "ready").map((t) => t.id).sort(),
    freeSlots,
  };

  const readiness: Record<string, DagNodeReadiness> = {};
  for (const t of tasks) {
    const unmetDeps = parseDeps(t.deps).filter((dep) => {
      const depTask = byId.get(dep);
      // A dep outside this Run can never complete — count it as unmet rather
      // than silently treating the Task as ready (same honesty rule as the
      // coordinator, which only dispatches `ready` rows Orca itself computed).
      return !depTask || depTask.status !== "completed";
    });
    const openGates = openGatesByTask.get(t.id) ?? [];
    const codes: DagBlockCode[] = [];
    const reasons: string[] = [];

    switch (t.status) {
      case "ready": {
        // Runnable by definition. Capacity only explains WHY it has not been
        // placed yet — it never makes the Task less ready.
        if (freeSlots !== null && freeSlots <= 0) {
          codes.push("waiting_for_capacity");
          reasons.push(
            `Ready now — every coordinator worker slot is busy (${occupancy?.busy ?? 0}/${occupancy?.maxConcurrency ?? 0} running); it is dispatched when a slot frees.`,
          );
        }
        break;
      }
      case "dispatched": {
        codes.push("in_flight");
        reasons.push(
          t.dispatch_id
            ? `A worker is running this task (dispatch ${t.dispatch_id}).`
            : "A worker is running this task right now.",
        );
        break;
      }
      case "completed":
      case "failed": {
        codes.push("already_finished");
        reasons.push(`This task has already ${t.status === "completed" ? "completed" : "failed"} — nothing left to schedule.`);
        break;
      }
      case "pending":
      case "blocked": {
        if (unmetDeps.length > 0) {
          codes.push("unmet_dependencies");
          reasons.push(
            `Waiting on ${unmetDeps.length} unmet ${unmetDeps.length === 1 ? "dependency" : "dependencies"}: ${depSentence(unmetDeps)}.`,
          );
        }
        if (openGates.length > 0) {
          codes.push("pending_gate");
          reasons.push(
            `Waiting on a decision gate: ${openGates.map((g) => `“${g.question || g.id}” (${g.id})`).join("; ")}.`,
          );
        }
        if (codes.length === 0) {
          // Nothing we can see explains the non-ready status. That is exactly
          // the state the viewer coordinator nudges to `ready` when it runs —
          // surface it as unknown instead of inventing a blocker.
          codes.push("unknown");
          reasons.push(
            t.status === "blocked"
              ? "Orca reports blocked, but no open gate is bound to this task in this Run — state not explainable from the current task/gate facts."
              : "No unmet dependency and no open gate is visible, but Orca still reports pending — the coordinator nudges such tasks to ready when it runs.",
          );
        }
        break;
      }
      default: {
        codes.push("unknown");
        reasons.push(
          `Orca reports an unrecognized task status (${String(t.status)}) — refresh, or check the connected runtime.`,
        );
        break;
      }
    }

    readiness[t.id] = {
      runnable: t.status === "ready",
      codes,
      reasons,
      unmetDependencyIds: unmetDeps,
      pendingGateIds: openGates.map((g) => g.id),
    };
  }

  return { readyWave, readiness };
}
