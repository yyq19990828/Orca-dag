import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import {
  abandonWorkerReceipt,
  assertValidWorkerStart,
  buildWorkerStartArgv,
  CANONICAL_RUNTIME_CAPABILITIES,
  COORDINATOR_TITLE,
  computerSupports,
  deriveWorktreeName,
  fetchComputerCapabilities,
  focusTerminal,
  isArchiveHookFailure,
  listRuns,
  MIN_EXECUTION_VERSION,
  MIN_VIEW_VERSION,
  openWorkspaceChangedFiles,
  openWorkspaceFile,
  openWorkspaceFileDiff,
  OrcaCliError,
  canonicalCapabilitySupported,
  checkReadiness,
  compareVersions,
  coordinatorTerminalCommand,
  coordinatorTitle,
  coordinatorTitlePrefix,
  describeRuntimeCapabilities,
  ensureCoordinatorTerminal,
  evaluateReadiness,
  formatCommand,
  initOrcaRuntime,
  getOrcaRuntime,
  isInsideManagedOrcaTerminal,
  listEnvironments,
  listProjects,
  listRepos,
  ORCHESTRATION_INBOX_LIMIT,
  listRunMessages,
  listRunMessagePage,
  listWorkspaceRuns,
  listWorkers,
  listWorktrees,
  normalizeLiveness,
  parseAdvertisedCapabilities,
  parseCliCommand,
  parseComputerCapabilities,
  parseCoordinatorTitle,
  parseEnvironmentRow,
  parsePeerCapabilities,
  parseWorkerStartReceipt,
  previewRunAudiences,
  presentWorkerLiveness,
  readWorkerOutput,
  removeWorktree,
  RESPONSE_LOST,
  resolveOrcaCommand,
  resolveWorktreeSelector,
  resolveWorkspace,
  runOrca,
  sendCoordinatorGroupMessage,
  sendCoordinatorMessage,
  showEnvironment,
  showRepo,
  showRun,
  showWorkerDetail,
  showWorktree,
  startSupervisedWorker,
  withDerivedCreationDefaults,
  type ComputerUseCapabilities,
  type OrcaRepoRow,
  type OrcaWorktreeRow,
  type OrcaWorkerRow,
  type WorkerStartRequest,
  type WorkspaceChangedMode,
} from "./orca";
import { closeCoordinatorTerminals } from "./uninstall";
import { createApp, listenLoopback } from "./app";
import { createSecurityPolicy, type SecurityPolicy } from "./security";
import type { OrcaReadiness } from "./orca";

/**
 * Phase 2 acceptance coverage: deterministic CLI + workspace resolution.
 *
 * Pure functions (parsing, resolution order, version bands, title grammar) are
 * tested directly; the CLI-spawning paths run against a tiny fake `orca`
 * executable (see `fakeOrcaFixture`) that answers scripted JSON and records
 * every argv + cwd it was invoked with — so `shell: false` semantics, prefix
 * args, worktree selectors and coordinator-conflict behavior are all exercised
 * without a real runtime. The HTTP execution gate is tested over real
 * loopback HTTP with an injected readiness probe.
 */

// --- fake orca fixture ------------------------------------------------------

let root: string;
let fixturePath: string;
let scriptPath: string;
let logPath: string;

/** One recorded invocation of the fake CLI. */
interface FakeCall {
  argv: string[];
  cwd: string;
}

/** Parse the fake CLI's append-only call log (one JSON object per line). */
function readLog(): FakeCall[] {
  try {
    const content = readFileSync(logPath, "utf8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line) as FakeCall);
  } catch {
    return [];
  }
}

function writeScript(
  conf: {
    version?: string;
    terminals?: unknown[];
    newHandle?: string;
    /** Phase 5: scripted worker-read page + optional source_changed refusal. */
    workerRead?: {
      cursorFailCode?: string;
      cursorFailMessage?: string;
      result?: Record<string, unknown>;
    };
    /** Phase 5: worker-start receipt body (argv itself is asserted from the log). */
    workerStart?: Record<string, unknown>;
    /** Phase 2: dispatch-keyed `worker-show` result payloads served verbatim. */
    workerShow?: Record<string, Record<string, unknown>>;
    /** Phase 6: discovery + fleet rows served verbatim by the fake. */
    environments?: unknown[];
    repos?: unknown[];
    worktrees?: unknown[];
    projects?: unknown[];
    /** Workspace-scope discovery: global Runs + per-Run Task creator rows. */
    runs?: unknown[];
    runsById?: Record<string, unknown>;
    inboxMessages?: unknown[];
    tasksByRun?: Record<string, unknown[]>;
    workers?: unknown[];
    /** Cursor-keyed worker-list receipts; `__first__` is the no-cursor page. */
    workerPages?: Record<
      string,
      { workers?: unknown[]; page?: { hasMore?: boolean; nextCursor?: string | null } }
    >;
    /** Cursor-keyed run-list receipts (top-level nextCursor); `__first__` = no cursor. */
    runPages?: Record<string, { runs?: unknown[]; nextCursor?: string | null }>;
    /** run-show raw-output fault injection (response-loss evidence tests). */
    runShow?: { rawError?: string; exitCode?: number };
    /** worker-abandon receipt body, or a raw-output fault for lost-response tests. */
    workerAbandon?: { rawError?: string; exitCode?: number; result?: Record<string, unknown> };
    /** terminal switch result served verbatim. */
    terminalSwitch?: Record<string, unknown>;
    /** file open/diff/open-changed result served verbatim. */
    fileResult?: Record<string, unknown>;
    /** worktree rm success result or typed failure (archive-hook semantics). */
    worktreeRm?: { fail?: boolean; error?: Record<string, unknown>; result?: Record<string, unknown> };
    /** computer capabilities receipt, or a raw-output fault for lost-response tests. */
    computerCapabilities?: { rawError?: string; exitCode?: number; result?: Record<string, unknown> };
  },
): void {
  writeFileSync(scriptPath, JSON.stringify(conf));
}

/**
 * A stand-in `orca` binary: records each call, answers `--version` in plain
 * text (like the real CLI) and everything else with the JSON envelope the
 * viewer unwraps. Scripted via a JSON file so tests can change terminal lists
 * between scenarios without rewriting the executable.
 */
function writeFakeOrca(): void {
  const src = `#!/usr/bin/env node
// Minimal Orca CLI double for orca.test.ts — records argv+cwd, plays a script.
import { appendFileSync, readFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_ORCA_LOG) {
  appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify({ argv: args, cwd: process.cwd() }) + "\\n");
}
let conf = {};
const f = process.env.FAKE_ORCA_SCRIPT;
if (f && existsSync(f)) { try { conf = JSON.parse(readFileSync(f, "utf8")); } catch {} }
if (args[0] === "--version") {
  process.stdout.write((conf.version ?? "1.4.205") + "\\n");
  process.exit(0);
}
const out = { ok: true, result: {} };
if (args[0] === "terminal" && args[1] === "list") out.result = { terminals: conf.terminals ?? [] };
if (args[0] === "terminal" && args[1] === "create") out.result = { terminal: { handle: conf.newHandle ?? "term_fake_new" } };
// Phase 6 discovery surface: scripted rows from conf, plus the exact-selector
// semantics of "environment show" (unknown selector = invalid_argument).
if (args[0] === "environment" && args[1] === "list") out.result = { environments: conf.environments ?? [] };
if (args[0] === "environment" && args[1] === "show") {
  const id = args[args.indexOf("--environment") + 1];
  const env = (conf.environments ?? []).find((e) => e && e.id === id);
  if (!env) {
    out.ok = false;
    out.error = { code: "invalid_argument", message: "Unknown environment: " + id };
  } else {
    out.result = { environment: env };
  }
}
if (args[0] === "repo" && args[1] === "list") out.result = { repos: conf.repos ?? [] };
// Placement-foundation revalidation surface: exact-selector show, with the
// real runtime's not-found codes (selector_not_found / repo_not_found).
if (args[0] === "worktree" && args[1] === "show") {
  const sel = args[args.indexOf("--worktree") + 1];
  const row = (conf.worktrees ?? []).find((w) => w && (w.id === sel || w.path === sel));
  if (!row) {
    out.ok = false;
    out.error = { code: "selector_not_found", message: "No Orca workspace matched the worktree selector " + sel };
  } else {
    out.result = { worktree: row };
  }
}
if (args[0] === "repo" && args[1] === "show") {
  const sel = args[args.indexOf("--repo") + 1];
  // Real repo ids are bare; the id:<id> selector form prefixes them — match both.
  const bare = sel.startsWith("id:") ? sel.slice(3) : sel;
  const row = (conf.repos ?? []).find((r) => r && (r.id === sel || r.id === bare || r.path === sel));
  if (!row) {
    out.ok = false;
    out.error = { code: "repo_not_found", message: "repo_not_found" };
  } else {
    out.result = { repo: row };
  }
}
if (args[0] === "worktree" && args[1] === "list") out.result = { worktrees: conf.worktrees ?? [] };
if (args[0] === "project" && args[1] === "list") out.result = { projects: conf.projects ?? [] };
if (args[0] === "orchestration" && args[1] === "run-list") {
  const cursorAt = args.indexOf("--cursor");
  const cursor = cursorAt >= 0 ? args[cursorAt + 1] : "__first__";
  const page = conf.runPages && conf.runPages[cursor];
  // Live receipt shape (1.4.206): top-level nextCursor, null on the last page.
  out.result = page ?? { runs: conf.runs ?? [], nextCursor: null };
}
if (args[0] === "orchestration" && args[1] === "run-show") {
  const rs = conf.runShow;
  if (rs && rs.rawError) {
    process.stdout.write(rs.rawError);
    process.exit(rs.exitCode ?? 1);
  }
  const id = args[args.indexOf("--id") + 1];
  const run = conf.runsById && conf.runsById[id];
  if (run) {
    out.result = { run };
  } else {
    // The real runtime's definite-absence answer for an unknown exact id.
    out.ok = false;
    out.error = { code: "run_not_found", message: "Run " + id + " was not found." };
  }
}
if (args[0] === "orchestration" && args[1] === "worker-abandon") {
  const ab = conf.workerAbandon;
  if (ab && ab.rawError) {
    process.stdout.write(ab.rawError);
    process.exit(ab.exitCode ?? 1);
  }
  out.result = (ab && ab.result) ?? {};
}
if (args[0] === "orchestration" && args[1] === "inbox") {
  const limitAt = args.indexOf("--limit");
  const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : 100;
  const messages = conf.inboxMessages ?? [];
  out.result = { messages: messages.slice(0, limit), count: Math.min(messages.length, limit) };
}
if (args[0] === "orchestration" && args[1] === "task-list") {
  const runAt = args.indexOf("--run");
  const runId = runAt >= 0 ? args[runAt + 1] : "";
  out.result = { tasks: conf.tasksByRun?.[runId] ?? [] };
}
if (args[0] === "orchestration" && args[1] === "worker-list") {
  const cursorAt = args.indexOf("--cursor");
  const cursor = cursorAt >= 0 ? args[cursorAt + 1] : "__first__";
  out.result = (conf.workerPages && conf.workerPages[cursor]) ?? {
    workers: conf.workers ?? [],
    page: { hasMore: false, nextCursor: null },
  };
}
if (args[0] === "orchestration" && args[1] === "worker-start") out.result = conf.workerStart ?? {};
// Phase 2: dispatch-keyed worker-show receipts. Each entry is the "result"
// payload served verbatim; an unlisted dispatch answers dispatch_not_found so
// detail-null behavior is testable without a second fixture.
if (args[0] === "orchestration" && args[1] === "worker-show") {
  const id = args[args.indexOf("--dispatch") + 1];
  const receipt = conf.workerShow && conf.workerShow[id];
  if (receipt) {
    out.result = receipt;
  } else {
    out.ok = false;
    out.error = { code: "dispatch_not_found", message: "Worker Dispatch " + id + " was not found." };
  }
}
if (args[0] === "orchestration" && args[1] === "worker-read") {
  const wr = conf.workerRead;
  // Scripted source_changed: refuse the FIRST cursor read so
  // readWorkerOutput's restart can be tested without cross-test state — the
  // retry is a later cursor read and succeeds. The log is appended at STARTUP
  // (see the appendFileSync above), so the count here INCLUDES this very
  // invocation: 1 cursor-read line = this IS the first one.
  if (wr && wr.cursorFailCode && args.includes("--cursor")) {
    let cursorReads = 0;
    try {
      const log = readFileSync(process.env.FAKE_ORCA_LOG, "utf8").trim();
      cursorReads = log ? log.split("\\n").filter((l) => l.includes("worker-read") && l.includes("--cursor")).length : 0;
    } catch {}
    if (cursorReads <= 1) {
      process.stdout.write(JSON.stringify({ ok: false, error: { code: wr.cursorFailCode, message: wr.cursorFailMessage ?? "source changed" } }));
      process.exit(1);
    }
  }
  out.result = (wr && wr.result) ?? {};
}
if (args[0] === "terminal" && args[1] === "switch") out.result = conf.terminalSwitch ?? { switched: true };
if (args[0] === "file") out.result = conf.fileResult ?? {};
if (args[0] === "worktree" && args[1] === "rm") {
  const wr = conf.worktreeRm;
  if (wr && wr.fail) {
    // Mirror the real runtime: a blocking archive hook answers ok:false WITH
    // the typed code AND exits non-zero.
    out.ok = false;
    out.error = wr.error ?? { code: "worktree_archive_hook_failed", message: "archive hook failed" };
    process.stdout.write(JSON.stringify(out));
    process.exit(1);
  }
  out.result = (wr && wr.result) ?? {};
}
if (args[0] === "computer" && args[1] === "capabilities") {
  const cc = conf.computerCapabilities;
  if (cc && cc.rawError) {
    process.stdout.write(cc.rawError);
    process.exit(cc.exitCode ?? 1);
  }
  out.result = (cc && cc.result) ?? {};
}
process.stdout.write(JSON.stringify(out));
`;
  writeFileSync(fixturePath, src);
  chmodSync(fixturePath, 0o755);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "orca-dag-orca-test-"));
  fixturePath = join(root, "fake-orca.mjs");
  scriptPath = join(root, "fake-orca.json");
  logPath = join(root, "calls.log");
  writeFakeOrca();
  writeScript({});
  // The fake CLI reads these; execFile children inherit this process's env.
  process.env.FAKE_ORCA_LOG = logPath;
  process.env.FAKE_ORCA_SCRIPT = scriptPath;
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  if (wsADir) rmSync(wsADir, { recursive: true, force: true });
  if (wsBDir) rmSync(wsBDir, { recursive: true, force: true });
});

/** Fresh runtime state pointing at the fake CLI and a fresh log. */
function useRuntime(opts: {
  workspace: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}): ReturnType<typeof getOrcaRuntime> {
  rmSync(logPath, { force: true });
  return initOrcaRuntime({
    env: { ORCA_CLI_COMMAND: fixturePath, WORKSPACE_DIR: opts.workspace, ...opts.env },
    cwd: opts.cwd ?? root,
  });
}

let wsADir: string | null = null;
let wsBDir: string | null = null;
/** Two memoized scratch workspaces (A and B) for the A→B placement tests. */
const wsA = () => (wsADir ??= realpathSync(mkdtempSync(join(tmpdir(), "ws-a-"))));
const wsB = () => (wsBDir ??= realpathSync(mkdtempSync(join(tmpdir(), "ws-b-"))));

// --- parseCliCommand --------------------------------------------------------

describe("parseCliCommand", () => {
  it("splits a plain executable with no prefix args", () => {
    assert.deepEqual(parseCliCommand("orca"), { executable: "orca", prefixArgs: [] });
  });

  it("keeps flags and values as separate argv entries", () => {
    assert.deepEqual(parseCliCommand("orca --project /x --flag=value"), {
      executable: "orca",
      prefixArgs: ["--project", "/x", "--flag=value"],
    });
  });

  it("parses double-quoted paths with spaces (the common Windows/macOS case)", () => {
    assert.deepEqual(parseCliCommand('"/opt/My Tools/orca" --project /x'), {
      executable: "/opt/My Tools/orca",
      prefixArgs: ["--project", "/x"],
    });
  });

  it("parses single-quoted paths and mixed quoting", () => {
    assert.deepEqual(parseCliCommand("'/opt/My Tools/orca'"), {
      executable: "/opt/My Tools/orca",
      prefixArgs: [],
    });
    assert.deepEqual(parseCliCommand(`"C:\\Program Files\\Orca\\orca.exe" serve`), {
      executable: "C:\\Program Files\\Orca\\orca.exe",
      prefixArgs: ["serve"],
    });
  });

  it("keeps an explicit empty argument from \"\"", () => {
    assert.deepEqual(parseCliCommand('orca ""'), { executable: "orca", prefixArgs: [""] });
  });

  it("accepts operator characters inside quotes as literal data", () => {
    // all the scary characters live INSIDE the quoted path — unquoted they'd
    // be shell syntax and are rejected below
    assert.deepEqual(parseCliCommand('"/opt/weird|name>orca;a;b"'), {
      executable: "/opt/weird|name>orca;a;b",
      prefixArgs: [],
    });
  });

  for (const bad of [
    "orca | tee log",
    "orca; rm -rf /",
    "orca & cleanup",
    "orca && more",
    "orca > file",
    "orca >> file",
    "orca < input",
    "orca `evil`",
    "orca $(evil)",
    "orca (subshell)",
    "orca\ntouch /tmp/x",
    "orca $HOME/bin/orca",
    "",
    "   ",
    '"unclosed',
    "  | orca",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseCliCommand(bad), /ORCA_CLI_COMMAND/);
    });
  }
});

// --- resolveOrcaCommand -----------------------------------------------------

describe("resolveOrcaCommand", () => {
  const linux = { platform: "linux" as const, insideManagedTerminal: false };
  const linuxInside = { platform: "linux" as const, insideManagedTerminal: true };
  const mac = { platform: "darwin" as const, insideManagedTerminal: false };

  it("ORCA_CLI_COMMAND wins over everything, parsed without a shell", () => {
    const cmd = resolveOrcaCommand(
      { ORCA_CLI_COMMAND: '"/opt/Orca IDE/orca" --project /x', ORCA_DEV_REPO_ROOT: "/dev/repo" },
      linuxInside,
    );
    assert.deepEqual(cmd, { executable: "/opt/Orca IDE/orca", prefixArgs: ["--project", "/x"] });
  });

  it("ORCA_DEV_REPO_ROOT selects orca-dev", () => {
    assert.deepEqual(resolveOrcaCommand({ ORCA_DEV_REPO_ROOT: "/dev/repo" }, linux), {
      executable: "orca-dev",
      prefixArgs: [],
    });
  });

  it("Linux OUTSIDE a managed Orca terminal uses orca-ide, never bare orca", () => {
    // bare `orca` outside Orca is GNOME's screen reader at /usr/bin/orca
    assert.deepEqual(resolveOrcaCommand({}, linux), { executable: "orca-ide", prefixArgs: [] });
  });

  it("Linux INSIDE a managed Orca terminal uses orca (the runtime's PATH shim)", () => {
    assert.deepEqual(resolveOrcaCommand({}, linuxInside), { executable: "orca", prefixArgs: [] });
  });

  it("macOS and Windows use plain orca regardless of terminal detection", () => {
    assert.deepEqual(resolveOrcaCommand({}, mac), { executable: "orca", prefixArgs: [] });
    assert.deepEqual(resolveOrcaCommand({}, { platform: "win32", insideManagedTerminal: false }), {
      executable: "orca",
      prefixArgs: [],
    });
  });

  it("isInsideManagedOrcaTerminal keys off ORCA_TERMINAL_HANDLE", () => {
    const inside = { ORCA_TERMINAL_HANDLE: "term_x" };
    assert.equal(isInsideManagedOrcaTerminal(inside), true);
    assert.equal(isInsideManagedOrcaTerminal({}), false);
    assert.equal(
      resolveOrcaCommand(inside, {
        platform: "linux",
        insideManagedTerminal: isInsideManagedOrcaTerminal(inside),
      }).executable,
      "orca",
    );
  });
});

// --- resolveWorkspace / resolveWorktreeSelector ------------------------------

describe("resolveWorkspace", () => {
  it("falls back to cwd when WORKSPACE_DIR is unset", () => {
    const ws = resolveWorkspace({}, root);
    assert.equal(ws.dir, realpathSync(root));
  });

  it("uses WORKSPACE_DIR when set", () => {
    const a = wsA();
    const ws = resolveWorkspace({ WORKSPACE_DIR: a }, "/somewhere/else");
    assert.equal(ws.dir, a);
  });

  it("resolves a symlinked WORKSPACE_DIR to the real path", () => {
    const a = wsA();
    const link = join(root, "link-to-a");
    rmSync(link, { force: true });
    symlinkSync(a, link);
    const ws = resolveWorkspace({ WORKSPACE_DIR: link }, "/nowhere");
    assert.equal(ws.dir, a); // same identity as the target, whatever the spelling
  });

  it("derives the same hash for the same dir and different hashes for different dirs", () => {
    const a = wsA();
    const b = wsB();
    assert.equal(resolveWorkspace({ WORKSPACE_DIR: a }, root).hash, resolveWorkspace({ WORKSPACE_DIR: a }, root).hash);
    assert.notEqual(resolveWorkspace({ WORKSPACE_DIR: a }, root).hash, resolveWorkspace({ WORKSPACE_DIR: b }, root).hash);
    assert.match(resolveWorkspace({ WORKSPACE_DIR: a }, root).hash, /^[0-9a-f]{8}$/);
  });

  it("mints a fresh instanceId per call", () => {
    const a = wsA();
    assert.notEqual(resolveWorkspace({ WORKSPACE_DIR: a }, root).instanceId, resolveWorkspace({ WORKSPACE_DIR: a }, root).instanceId);
  });

  it("refuses a missing directory with an actionable message", () => {
    assert.throws(
      () => resolveWorkspace({ WORKSPACE_DIR: "/definitely/not/here" }, root),
      /Workspace directory does not exist.*WORKSPACE_DIR/s,
    );
  });
});

describe("resolveWorktreeSelector", () => {
  it("defaults to the exact workspace as a path: selector (never ambiguous `active`)", () => {
    const a = wsA();
    const ws = resolveWorkspace({ WORKSPACE_DIR: a }, root);
    assert.equal(resolveWorktreeSelector({}, ws), `path:${a}`);
  });

  it("an explicit ORCA_WORKTREE still wins", () => {
    const a = wsA();
    const ws = resolveWorkspace({ WORKSPACE_DIR: a }, root);
    assert.equal(resolveWorktreeSelector({ ORCA_WORKTREE: "active" }, ws), "active");
    assert.equal(resolveWorktreeSelector({ ORCA_WORKTREE: "path:/other" }, ws), "path:/other");
  });
});

// --- coordinator title grammar ----------------------------------------------

describe("coordinator titles", () => {
  const ws = { dir: "/x", hash: "abcd1234", instanceId: "deadbeef" };

  it("builds `orca-dag coordinator · <hash> · <instance>` — stable prefix kept", () => {
    assert.equal(coordinatorTitle(ws), `${COORDINATOR_TITLE} · abcd1234 · deadbeef`);
    assert.equal(coordinatorTitlePrefix(ws.hash), `${COORDINATOR_TITLE} · abcd1234 · `);
    assert.ok(coordinatorTitle(ws).startsWith(COORDINATOR_TITLE));
  });

  it("parses main, adhoc and legacy titles", () => {
    assert.deepEqual(parseCoordinatorTitle(`${COORDINATOR_TITLE} · abcd1234 · deadbeef`), {
      kind: "main",
      hash: "abcd1234",
      instanceId: "deadbeef",
    });
    assert.deepEqual(parseCoordinatorTitle(`${COORDINATOR_TITLE} · abcd1234 · deadbeef · adhoc-7`), {
      kind: "adhoc",
      hash: "abcd1234",
      instanceId: "deadbeef",
    });
    assert.deepEqual(parseCoordinatorTitle(COORDINATOR_TITLE), { kind: "legacy" });
  });

  it("ignores foreign titles and malformed prefixes", () => {
    assert.equal(parseCoordinatorTitle("zsh"), null);
    assert.equal(parseCoordinatorTitle(`${COORDINATOR_TITLE} · not-a-hash · deadbeef`), null);
    assert.equal(parseCoordinatorTitle(`${COORDINATOR_TITLE} · abcd1234`), null);
    assert.equal(parseCoordinatorTitle(`${COORDINATOR_TITLE} · abcd1234 · deadbeef · weird`), null);
  });
});

// --- uninstall's coordinator-terminal sweep ----------------------------------

describe("uninstall coordinator sweep", () => {
  // Five candidates: three carrying the `orca-dag coordinator` prefix (main,
  // adhoc, legacy) that uninstall owns, plus a user shell and a lookalike
  // prefix that must survive the sweep untouched.
  const terminals = [
    { handle: "term_main", title: `${COORDINATOR_TITLE} · abcd1234 · deadbeef`, worktreePath: "/ws/a" },
    { handle: "term_adhoc", title: `${COORDINATOR_TITLE} · abcd1234 · deadbeef · adhoc-7`, worktreePath: "/ws/a" },
    { handle: "term_legacy", title: COORDINATOR_TITLE, worktreePath: "/ws/old" },
    { handle: "term_foreign", title: "zsh", worktreePath: "/ws/personal" },
    { handle: "term_lookalike", title: "my-agent coordinator · abcd1234 · deadbeef", worktreePath: "/ws/x" },
  ];

  it("dry run reports every coordinator with its workspace but closes nothing", async () => {
    useRuntime({ workspace: root });
    writeScript({ terminals: structuredClone(terminals) });
    const lines: string[] = [];
    const closed = await closeCoordinatorTerminals(true, (l) => lines.push(l));
    assert.equal(closed, 3);
    assert.equal(readLog().filter((c) => c.argv[0] === "terminal" && c.argv[1] === "close").length, 0);
    // Per-workspace reporting is the point: a multi-workspace user reads the
    // list before letting uninstall close anything.
    assert.ok(lines.some((l) => l.includes("term_main") && l.includes("workspace abcd1234 (/ws/a)")));
    assert.ok(lines.some((l) => l.includes("term_legacy") && l.includes("pre-workspace-scoped")));
    assert.ok(!lines.some((l) => l.includes("term_foreign")), "foreign terminals are not ours to report");
  });

  it("closes ours by title prefix and never touches foreign terminals", async () => {
    useRuntime({ workspace: root });
    writeScript({ terminals: structuredClone(terminals) });
    const lines: string[] = [];
    const closed = await closeCoordinatorTerminals(false, (l) => lines.push(l));
    assert.equal(closed, 3);
    const closedHandles = readLog()
      .filter((c) => c.argv[0] === "terminal" && c.argv[1] === "close")
      .map((c) => c.argv[3]);
    assert.deepEqual(closedHandles.sort(), ["term_adhoc", "term_legacy", "term_main"]);
    // The lookalike prefix and the user's own zsh survive: uninstall's
    // discovery contract keys on our exact title prefix, nothing looser.
    assert.ok(!lines.some((l) => l.includes("term_lookalike")));
    assert.ok(!lines.some((l) => l.includes("term_foreign")));
  });
});

// --- readiness --------------------------------------------------------------

describe("evaluateReadiness", () => {
  it("reports a missing/unrunnable CLI with an actionable reason", () => {
    const r = evaluateReadiness(null, 'no executable "orca" on PATH');
    assert.equal(r.executionEnabled, false);
    assert.match(r.reason!, /ORCA_CLI_COMMAND|Install Orca/);
  });

  it("reports unparseable version output as unusable", () => {
    const r = evaluateReadiness(null, null);
    assert.equal(r.executionEnabled, false);
    assert.match(r.reason!, /unparseable/);
  });

  it(`marks < ${MIN_VIEW_VERSION} as too old even for viewing`, () => {
    const r = evaluateReadiness("1.4.159", null);
    assert.equal(r.executionEnabled, false);
    assert.match(r.reason!, /too old/);
  });

  it(`marks ${MIN_VIEW_VERSION}–1.4.204 as view-only with an upgrade pointer`, () => {
    for (const v of [MIN_VIEW_VERSION, "1.4.180", "1.4.204"]) {
      const r = evaluateReadiness(v, null);
      assert.equal(r.executionEnabled, false, v);
      assert.match(r.reason!, /view-only/);
      assert.match(r.reason!, new RegExp(MIN_EXECUTION_VERSION.replace(/\./g, "\\.")));
    }
  });

  it(`marks >= ${MIN_EXECUTION_VERSION} as execution-enabled`, () => {
    for (const v of [MIN_EXECUTION_VERSION, "1.5.0", "2.0.0"]) {
      const r = evaluateReadiness(v, null);
      assert.deepEqual(r, { executionEnabled: true, reason: null }, v);
    }
  });

  it("compares versions numerically, segment by segment", () => {
    assert.ok(compareVersions("1.4.205", "1.4.204") > 0);
    assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
    assert.equal(compareVersions("1.4.205", "1.4.205"), 0);
    assert.ok(compareVersions("1.4", "1.4.0") === 0);
    assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
  });
});

// --- spawning through the fake CLI -------------------------------------------

describe("CLI spawning through the resolved spec (fake orca)", () => {
  it("runOrca passes prefixArgs + --json and runs in the resolved workspace cwd", async () => {
    const a = wsA();
    useRuntime({ workspace: a, env: { ORCA_CLI_COMMAND: `${fixturePath} --pinned-flag` } });
    await runOrca(["orchestration", "task-list", "--run", "run_x"]);
    const calls = readLog();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ["--pinned-flag", "orchestration", "task-list", "--run", "run_x", "--json"]);
    assert.equal(calls[0].cwd, a);
  });

  it("WORKSPACE_DIR=B started from cwd A creates the coordinator in B via the path: selector", async () => {
    const a = wsA();
    const b = wsB();
    useRuntime({ workspace: b, cwd: a });
    // The runtime resolved B (from WORKSPACE_DIR), not the process cwd A…
    assert.equal(getOrcaRuntime().workspace.dir, b);
    const handle = await ensureCoordinatorTerminal();
    assert.equal(handle, "term_fake_new");
    const calls = readLog();
    const create = calls.find((c) => c.argv[0] === "terminal" && c.argv[1] === "create");
    assert.ok(create, "terminal create was invoked");
    const wt = create.argv.indexOf("--worktree");
    assert.equal(create.argv[wt + 1], `path:${b}`);
    const ti = create.argv.indexOf("--title");
    assert.match(create.argv[ti + 1], /^orca-dag coordinator · [0-9a-f]{8} · [0-9a-f]{8}$/);
    // The terminal parks with its title (OSC-0 set before exec — nothing can
    // overwrite it afterward) and then execs a watcher on THIS viewer
    // process's pid: when the backend dies the pane dies with it, instead of
    // the old `sleep infinity` that leaked the pane past a crash.
    const ci = create.argv.indexOf("--command");
    const cmd = create.argv[ci + 1];
    assert.match(
      cmd,
      /printf .*&& exec sh -c 'while kill -0 \d+ 2>\/dev\/null; do sleep 2; done'$/,
    );
    assert.ok(cmd.includes(String(process.pid)), "the watcher watches THIS backend process");
    assert.ok(cmd.includes(create.argv[ti + 1]), "the parked title matches the terminal title");
  });

  it("parks the coordinator pane on a watcher tied to the exact backend pid it is given", () => {
    // Explicit pid: the pane's lifetime IS that process's lifetime.
    const cmd = coordinatorTerminalCommand("orca-dag coordinator · abcd1234 · deadbeef", 4242);
    assert.match(cmd, /^printf '\\033\]0;%s\\007' 'orca-dag coordinator · abcd1234 · deadbeef' && exec /);
    assert.match(cmd, /exec sh -c 'while kill -0 4242 2>\/dev\/null; do sleep 2; done'$/);
    // Default: THIS orca-dag backend process.
    assert.ok(coordinatorTerminalCommand("t").includes(`kill -0 ${process.pid} `));
    // No form of the command ever parks unbounded again.
    assert.ok(!cmd.includes("sleep infinity"));
  });

  it("reuses its own instance's terminal without creating a second one", async () => {
    const a = wsA();
    const rt = useRuntime({ workspace: a });
    const title = coordinatorTitle(rt.workspace);
    writeScript({ terminals: [{ handle: "term_mine", title, worktreePath: a, connected: true }] });
    const handle = await ensureCoordinatorTerminal();
    assert.equal(handle, "term_mine");
    assert.equal(readLog().length, 1, "only terminal list ran — no create");
  });

  it("reports coordinator_conflict for another live viewer on the SAME workspace, without touching it", async () => {
    const a = wsA();
    const rt = useRuntime({ workspace: a });
    const h = rt.workspace.hash;
    writeScript({
      terminals: [
        { handle: "term_other", title: `${COORDINATOR_TITLE} · ${h} · f00dfeed`, worktreePath: a, connected: true },
      ],
    });
    await assert.rejects(ensureCoordinatorTerminal(), (err: unknown) => {
      assert.ok(err instanceof OrcaCliError);
      assert.equal(err.code, "coordinator_conflict");
      assert.match(err.message, /already coordinating this workspace/);
      assert.match(err.message, /f00dfeed/); // names the offending instance
      return true;
    });
    // The refusal performed exactly ONE call: `terminal list`. No create, and
    // crucially no `terminal close` against the foreign coordinator.
    const calls = readLog();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ["terminal", "list", "--json"]);
  });

  it("ignores coordinators of DIFFERENT workspaces and creates its own", async () => {
    const a = wsA();
    const rt = useRuntime({ workspace: a });
    writeScript({
      terminals: [
        { handle: "term_other_ws", title: `${COORDINATOR_TITLE} · 9999face · f00dfeed`, worktreePath: "/elsewhere", connected: true },
        { handle: "term_stale", title: `${COORDINATOR_TITLE} · ${rt.workspace.hash} · f00dfeed`, worktreePath: a, connected: false },
      ],
    });
    const handle = await ensureCoordinatorTerminal();
    assert.equal(handle, "term_fake_new"); // a fresh terminal was created
    assert.ok(readLog().some((c) => c.argv[0] === "terminal" && c.argv[1] === "create"));
  });

  it("does not treat another instance's adhoc one-shot as a conflict", async () => {
    const a = wsA();
    const rt = useRuntime({ workspace: a });
    writeScript({
      terminals: [
        {
          handle: "term_adhoc",
          title: `${COORDINATOR_TITLE} · ${rt.workspace.hash} · f00dfeed · adhoc-3`,
          worktreePath: a,
          connected: true,
        },
      ],
    });
    const handle = await ensureCoordinatorTerminal();
    assert.equal(handle, "term_fake_new");
  });

  it("refuses to take over a pre-Phase-2 unscoped coordinator (also a conflict)", async () => {
    const a = wsA();
    useRuntime({ workspace: a });
    writeScript({
      terminals: [{ handle: "term_legacy", title: COORDINATOR_TITLE, worktreePath: a, connected: true }],
    });
    await assert.rejects(ensureCoordinatorTerminal(), (err: unknown) => {
      assert.ok(err instanceof OrcaCliError);
      assert.equal(err.code, "coordinator_conflict");
      assert.match(err.message, /orca-orchestration-launcher uninstall/);
      return true;
    });
    assert.equal(readLog().length, 1); // list only — never silently reused or closed
  });

  it("checkReadiness parses the fake version and gates execution on it", async () => {
    const a = wsA();
    useRuntime({ workspace: a });
    writeScript({ version: "1.4.204" });
    const old = await checkReadiness(true);
    assert.equal(old.executionEnabled, false);
    assert.equal(old.version, "1.4.204");
    assert.match(old.reason!, /view-only/);
    assert.equal(old.workspace, a);

    writeScript({ version: "1.4.205" });
    const current = await checkReadiness(true);
    assert.equal(current.executionEnabled, true);
    assert.equal(current.reason, null);
    assert.match(current.cli, /fake-orca\.mjs/);
  });

  it("checkReadiness reports a missing CLI honestly (view-only, actionable)", async () => {
    const a = wsA();
    useRuntime({ workspace: a, env: { ORCA_CLI_COMMAND: join(root, "no-such-orca") } });
    const r = await checkReadiness(true);
    assert.equal(r.executionEnabled, false);
    assert.equal(r.version, null);
    assert.match(r.reason!, /not usable/);
    assert.match(formatCommand(getOrcaRuntime().command), /no-such-orca/);
  });
});

// --- HTTP execution gate -----------------------------------------------------

describe("execution gate over HTTP", () => {
  const policy: SecurityPolicy = createSecurityPolicy({});
  const disabledReadiness: OrcaReadiness = {
    cli: "orca-fake",
    workspace: "/x",
    worktree: "path:/x",
    version: "1.4.160",
    executionEnabled: false,
    reason: "Orca 1.4.160 is view-only here: execution needs the supervised-worker contract from Orca 1.4.205+.",
  };
  const workspace = mkdtempSync(join(tmpdir(), "orca-dag-gate-test-"));
  let server: Server;
  let base: string;

  before(async () => {
    const { app } = createApp({
      workspaceDir: workspace,
      worktree: "path:" + workspace,
      policy,
      embeddedAssets: null,
      readiness: async () => disabledReadiness,
    });
    server = await listenLoopback(app, 0);
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, { recursive: true, force: true });
  });

  async function call(method: "GET" | "POST", path: string, body?: unknown, token?: string) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token !== undefined) headers["X-Orca-Dag-Token"] = token;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  it("serves the readiness payload read-only, no token", async () => {
    const { status, json } = await call("GET", "/api/readiness");
    assert.equal(status, 200);
    assert.equal(json.executionEnabled, false);
    assert.equal(json.version, "1.4.160");
    assert.match(String(json.reason), /view-only/);
  });

  it("rejects a well-formed Run start with 503 execution_disabled + the reason", async () => {
    const { status, json } = await call("POST", "/api/run", { runId: "run_ok" }, policy.token);
    assert.equal(status, 503);
    assert.equal(json.code, "execution_disabled");
    assert.match(String(json.error), /view-only/);
  });

  it("still validates the request BEFORE the gate (Phase 1 ordering preserved)", async () => {
    const missing = await call("POST", "/api/run", {}, policy.token);
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "run_required");
    const bad = await call("POST", "/api/run", { runId: "../nope" }, policy.token);
    assert.equal(bad.status, 400);
  });

  it("gates Run creation and gate resolution after their own validation", async () => {
    const noObjective = await call("POST", "/api/runs", {}, policy.token);
    assert.equal(noObjective.status, 400); // validation first
    const create = await call("POST", "/api/runs", { objective: "x" }, policy.token);
    assert.equal(create.status, 503);
    assert.equal(create.json.code, "execution_disabled");

    const noIds = await call("POST", "/api/gates/gate_1/resolve", {}, policy.token);
    assert.equal(noIds.status, 400); // validation first
    const gate = await call("POST", "/api/gates/gate_1/resolve", { runId: "run_x", resolution: "approved" }, policy.token);
    assert.equal(gate.status, 503);
  });

  it("answers POST /api/reset with the normal unknown-route 404 (reset removed)", async () => {
    // `orca orchestration reset --tasks` wipes every local Run — the viewer
    // deliberately ships no route for it. A fresh Run is the only redraw path.
    const reset = await call("POST", "/api/reset", { confirmAllRuns: true }, policy.token);
    assert.equal(reset.status, 404);
    assert.equal(reset.json.code, "not_found");
  });

  it("leaves stopping available in view-only mode (de-escalation is safe)", async () => {
    const { status, json } = await call("POST", "/api/run-stop", {}, policy.token);
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });
});

// --- Phase 5 foundations: liveness normalization -----------------------------

describe("normalizeLiveness", () => {
  it("passes the three renderable verdicts through", () => {
    assert.equal(normalizeLiveness("live"), "live");
    assert.equal(normalizeLiveness("exited"), "exited");
    assert.equal(normalizeLiveness("unverifiable"), "unverifiable");
  });
  it("collapses unknown and absent verdicts to unverifiable — never exited", () => {
    // plan §5: a missing status must never read as process death
    assert.equal(normalizeLiveness("zombified"), "unverifiable");
    assert.equal(normalizeLiveness(""), "unverifiable");
    assert.equal(normalizeLiveness(null), "unverifiable");
    assert.equal(normalizeLiveness(undefined), "unverifiable");
  });
});

// --- Phase 5 foundations: bounded worker-read --------------------------------

describe("readWorkerOutput", () => {
  it("passes --source/--cursor/--limit through and parses the page", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerRead: {
        result: {
          dispatchId: "ctx_r1",
          source: "transcript",
          cursor: "cur_9",
          transcript: { rows: ["line a", "line b"] },
          contentComplete: false,
          warnings: ["partial page"],
          clipping: ["oldest rows dropped"],
        },
      },
    });
    const receipt = await readWorkerOutput("ctx_r1", { source: "transcript", cursor: "cur_8", limit: 25 });
    const call = readLog().find((c) => c.argv[1] === "worker-read")!;
    assert.ok(call.argv.includes("--source"), "--source must reach the CLI");
    assert.ok(call.argv.includes("transcript"));
    assert.ok(call.argv.includes("--cursor"), "the paging cursor must reach the CLI");
    assert.ok(call.argv.includes("cur_8"));
    assert.deepEqual(call.argv.slice(call.argv.indexOf("--limit") + 1, call.argv.indexOf("--limit") + 2), ["25"]);
    assert.equal(receipt.source, "transcript");
    assert.equal(receipt.cursor, "cur_9");
    assert.deepEqual(receipt.lines, ["line a", "line b"]);
    assert.equal(receipt.contentComplete, false);
    assert.equal(receipt.clipped, true, "a clipping[] answer means the page was clipped");
    assert.deepEqual(receipt.warnings, ["partial page"]);
    assert.equal(receipt.sourceChanged, false);
  });

  it("restarts once without the cursor on source_changed and labels the discontinuity", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerRead: {
        cursorFailCode: "source_changed",
        result: {
          source: "terminal",
          cursor: "cur_fresh",
          terminal: { tail: ["restart 0"], truncated: false, limited: true },
          contentComplete: true,
        },
      },
    });
    const receipt = await readWorkerOutput("ctx_r2", { cursor: "cur_stale" });
    const reads = readLog().filter((c) => c.argv[1] === "worker-read");
    assert.equal(reads.length, 2, "exactly one retry: the fresh read after source_changed");
    assert.ok(reads[0].argv.includes("--cursor"), "first read used the stale cursor");
    assert.ok(!reads[1].argv.includes("--cursor"), "restart drops the cursor");
    assert.equal(receipt.sourceChanged, true);
    assert.ok(receipt.warnings.some((w) => w.includes("source changed")));
    assert.deepEqual(receipt.lines, ["restart 0"]);
  });

  it("propagates other read failures instead of masking them as restarts", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerRead: {
        cursorFailCode: "read_failed",
        cursorFailMessage: "output source unavailable",
      },
    });
    await assert.rejects(
      // a non-source_changed failure keeps failing even with a cursor present
      readWorkerOutput("ctx_r3", { cursor: "cur_x" }),
      /output source unavailable/,
    );
  });
});

// --- Phase 5 foundations: launch-preference argv contract --------------------

describe("startSupervisedWorker launch preferences", () => {
  it("sends --model and --effort together when both are requested", async () => {
    useRuntime({ workspace: root });
    writeScript({ workerStart: { dispatchId: "ctx_m1", status: "ready" } });
    await startSupervisedWorker({
      taskId: "task_m",
      agent: "claude",
      runId: "run_t",
      from: "term_coord",
      model: "opus",
      effort: "high",
    });
    const call = readLog().find((c) => c.argv[1] === "worker-start")!;
    assert.ok(call.argv.includes("--model"));
    assert.ok(call.argv.includes("opus"));
    assert.ok(call.argv.includes("--effort"), "--effort must reach the CLI when a model is set");
    assert.ok(call.argv.includes("high"));
  });

  it("refuses effort without a model before touching the CLI", async () => {
    useRuntime({ workspace: root });
    const callsBefore = readLog().length;
    await assert.rejects(
      startSupervisedWorker({
        taskId: "task_m",
        agent: "claude",
        runId: "run_t",
        from: "term_coord",
        effort: "high",
      }),
      (err: OrcaCliError) => err.code === "invalid_argument" && /effort requires/i.test(err.message),
    );
    assert.equal(readLog().length, callsBefore, "the contract breach must not spawn a CLI call");
  });

  it("reuse sends --terminal instead of --agent and never carries model/effort", async () => {
    useRuntime({ workspace: root });
    writeScript({ workerStart: { dispatchId: "ctx_m2", status: "ready" } });
    await startSupervisedWorker({
      taskId: "task_t",
      agent: "codex",
      runId: "run_t",
      from: "term_coord",
      terminal: "term_reuse_me",
    });
    const call = readLog().find((c) => c.argv[1] === "worker-start")!;
    assert.ok(call.argv.includes("--terminal"));
    assert.ok(call.argv.includes("term_reuse_me"));
    assert.ok(!call.argv.includes("--agent"), "a reused terminal relaunches nothing");
    assert.ok(!call.argv.includes("--model") && !call.argv.includes("--effort"));
    assert.ok(call.argv.includes("--worktree"), "reuse still names the terminal's worktree");
  });

  it("refuses model/effort combined with --terminal before touching the CLI", async () => {
    useRuntime({ workspace: root });
    const callsBefore = readLog().length;
    await assert.rejects(
      startSupervisedWorker({
        taskId: "task_t",
        agent: "codex",
        runId: "run_t",
        from: "term_coord",
        terminal: "term_reuse_me",
        model: "o3",
      }),
      (err: OrcaCliError) => err.code === "invalid_argument" && /--terminal/i.test(err.message),
    );
    assert.equal(readLog().length, callsBefore);
  });
});

// --- Phase 5 foundations: receipt effective-preference echo ------------------

describe("parseWorkerStartReceipt effective launch preferences", () => {
  it("digs the runtime's echo out of top-level and nested launch shapes", () => {
    const receipt = parseWorkerStartReceipt(
      {
        dispatchId: "ctx_e1",
        status: "ready",
        agent: "claude",
        launch: { model: "opus", worktree: "current" },
        effects: { effort: "high" },
      },
      true,
    );
    assert.deepEqual(receipt.effective, {
      agent: "claude",
      model: "opus",
      effort: "high",
      worktree: "current",
      terminal: null,
      on: null,
      name: null,
      baseBranch: null,
      displayName: null,
    });
  });

  it("keeps unechoed preferences null — never claims a value was applied", () => {
    const receipt = parseWorkerStartReceipt({ dispatchId: "ctx_e2", status: "ready" }, true);
    assert.deepEqual(receipt.effective, {
      agent: null,
      model: null,
      effort: null,
      worktree: null,
      terminal: null,
      on: null,
      name: null,
      baseBranch: null,
      displayName: null,
    });
  });

  it("echoes creation metadata (name/baseBranch/displayName) when the runtime reports it", () => {
    const receipt = parseWorkerStartReceipt(
      {
        dispatchId: "ctx_e4",
        status: "ready",
        worktree: "new-child",
        launch: { name: "task_a-1a2b3c4d", baseBranch: "feature/x", displayName: "Kid lane" },
      },
      true,
    );
    assert.equal(receipt.effective.name, "task_a-1a2b3c4d");
    assert.equal(receipt.effective.baseBranch, "feature/x");
    assert.equal(receipt.effective.displayName, "Kid lane");
  });

  it("picks up the execution server the receipt echoes (Phase 6 --on)", () => {
    const receipt = parseWorkerStartReceipt(
      {
        dispatchId: "ctx_e3",
        status: "ready",
        on: "env_remote",
        launch: { worktree: "id:repoA::/srv/ws", agent: "codex" },
      },
      true,
    );
    assert.equal(receipt.effective.on, "env_remote");
    assert.equal(receipt.effective.worktree, "id:repoA::/srv/ws");
  });
});

// --- Phase 6: environments, peer capabilities, exact placement ---------------

describe("parseEnvironmentRow", () => {
  it("parses a full row: id, name, reachability, capabilities, version", () => {
    const env = parseEnvironmentRow({
      id: "env_remote",
      name: "work-laptop",
      connected: true,
      capabilities: ["fleet.snapshot", "model.effort"],
      version: "1.4.205",
    });
    assert.deepEqual(env, {
      id: "env_remote",
      name: "work-laptop",
      connected: true,
      capabilities: ["fleet.snapshot", "model.effort"],
      version: "1.4.205",
      raw: parseEnvironmentRow({
        id: "env_remote",
        name: "work-laptop",
        connected: true,
        capabilities: ["fleet.snapshot", "model.effort"],
        version: "1.4.205",
      })!.raw,
    });
  });

  it("treats a row without any capability field as 'nothing advertised' (null)", () => {
    const env = parseEnvironmentRow({ id: "env_x", name: "x" });
    assert.equal(env!.capabilities, null, "absent capability field is NOT an empty advertisement");
  });

  it("falls back through name spellings and maps status strings to reachability", () => {
    const env = parseEnvironmentRow({ environmentId: "env_y", displayName: "Y", state: "offline" });
    assert.equal(env!.id, "env_y");
    assert.equal(env!.name, "Y");
    assert.equal(env!.connected, false);
    const unknown = parseEnvironmentRow({ id: "env_z", status: "weird" });
    assert.equal(unknown!.connected, null, "an unrecognized status stays unknown");
  });

  it("accepts record-shaped capability maps (true values only) and object rows", () => {
    const boolMap = parseEnvironmentRow({ id: "a", capabilities: { fleet_snapshot: true, model: false } });
    assert.deepEqual(boolMap!.capabilities, ["fleet_snapshot"]);
    const rows = parseEnvironmentRow({ id: "b", peerCapabilities: [{ name: "fleet.snapshot" }] });
    assert.deepEqual(rows!.capabilities, ["fleet.snapshot"]);
  });

  it("returns null for a row without any id", () => {
    assert.equal(parseEnvironmentRow({ name: "no id here" }), null);
    assert.equal(parseEnvironmentRow("garbage"), null);
  });
});

describe("parsePeerCapabilities", () => {
  it("gates every operation OFF when nothing was advertised (null)", () => {
    const caps = parsePeerCapabilities(null);
    assert.deepEqual(
      [caps.modelEffort, caps.transcriptRead, caps.fleetSnapshot],
      [false, false, false],
      "unproven capabilities are absent, never assumed",
    );
    assert.equal(caps.raw, null);
  });

  it("turns only the advertised gates ON, folding case and separators", () => {
    const caps = parsePeerCapabilities(["FLEET-SNAPSHOT", "model_effort"]);
    assert.equal(caps.modelEffort, true);
    assert.equal(caps.fleetSnapshot, true);
    assert.equal(caps.transcriptRead, false);
    assert.deepEqual(caps.raw, ["FLEET-SNAPSHOT", "model_effort"]);
  });

  it("keeps gates OFF for a vocabulary this viewer does not recognize", () => {
    const caps = parsePeerCapabilities(["time.travel", "hyper.render"]);
    assert.deepEqual([caps.modelEffort, caps.transcriptRead, caps.fleetSnapshot], [false, false, false]);
  });

  it("parses alternative advertisement shapes (structured read, dotted names)", () => {
    assert.equal(parsePeerCapabilities(parseAdvertisedCapabilities("transcript.read")).transcriptRead, true);
    assert.equal(parsePeerCapabilities(parseAdvertisedCapabilities(["worker.list.remote"])).fleetSnapshot, true);
    // A field that is absent stays null; an explicit empty list is empty.
    assert.equal(parseAdvertisedCapabilities(undefined), null);
    assert.deepEqual(parseAdvertisedCapabilities([]), []);
  });
});

describe("describeRuntimeCapabilities (canonical Orca 1.4.206 ids)", () => {
  it("exposes exactly the seven canonical identifiers from the epic", () => {
    assert.deepEqual(
      CANONICAL_RUNTIME_CAPABILITIES.map((c) => c.canonicalId),
      [
        "orchestration.worker-launch-preferences.v1",
        "orchestration.federation-structured-read.v1",
        "orchestration.federation-fleet-snapshot.v1",
        "orchestration.federation-control-mail.v1",
        "orchestration.federation-lifecycle-settlement.v1",
        "orchestration.federation-release-archive.v1",
        "orchestration.worker-stop-verdict.v1",
      ],
    );
  });

  it("marks every canonical capability supported when advertised verbatim", () => {
    const ids = CANONICAL_RUNTIME_CAPABILITIES.map((c) => c.canonicalId);
    const { capabilities, unknownAdvertised } = describeRuntimeCapabilities(ids);
    for (const view of capabilities) {
      assert.equal(view.supported, true, view.id);
      assert.equal(view.state, "supported", view.id);
      assert.equal(view.matchedName, view.id);
    }
    assert.deepEqual(unknownAdvertised, []);
  });

  it("matches documented legacy aliases and labels them as such", () => {
    const { capabilities } = describeRuntimeCapabilities([
      "transcript.read",
      "fleet.snapshot",
      "launch.model.effort",
    ]);
    const byId = new Map(capabilities.map((v) => [v.id, v]));
    assert.equal(byId.get("orchestration.federation-structured-read.v1")?.supported, true);
    assert.equal(byId.get("orchestration.federation-structured-read.v1")?.state, "alias");
    assert.equal(byId.get("orchestration.federation-structured-read.v1")?.matchedName, "transcript.read");
    assert.equal(byId.get("orchestration.federation-fleet-snapshot.v1")?.state, "alias");
    assert.equal(byId.get("orchestration.worker-launch-preferences.v1")?.state, "alias");
    // capabilities with no alias table stay off under an unrelated advertisement
    assert.equal(byId.get("orchestration.worker-stop-verdict.v1")?.supported, false);
    assert.equal(byId.get("orchestration.worker-stop-verdict.v1")?.state, "absent");
  });

  it("folds case and separators in canonical ids and aliases", () => {
    assert.equal(
      canonicalCapabilitySupported(
        // version-suffix near-misses must not match: folding is case/separator
        // only, never "close enough" on the name itself
        ["orchestration.worker-stop-verdict.v2", "orchestration.worker-stop-verdict"],
        "orchestration.worker-stop-verdict.v1",
      ),
      false,
      "a wrong name must never match",
    );
    assert.equal(
      canonicalCapabilitySupported(
        ["Orchestration.Worker_Stop-Verdict.V1"],
        "orchestration.worker-stop-verdict.v1",
      ),
      true,
    );
    assert.equal(
      canonicalCapabilitySupported(
        ["ORCHESTRATION.FEDERATION_FLEET-SNAPSHOT.V1"],
        "orchestration.federation-fleet-snapshot.v1",
      ),
      true,
    );
  });

  it("gates everything off when nothing is advertised (null) or an empty set arrives", () => {
    for (const advertised of [null, []]) {
      const { capabilities, unknownAdvertised } = describeRuntimeCapabilities(advertised);
      assert.equal(capabilities.length, CANONICAL_RUNTIME_CAPABILITIES.length);
      for (const view of capabilities) {
        assert.equal(view.supported, false, `${view.id} must stay off for ${JSON.stringify(advertised)}`);
        assert.equal(view.state, "absent");
        assert.equal(view.matchedName, null);
      }
      assert.deepEqual(unknownAdvertised, []);
    }
  });

  it("keeps unknown capabilities unsupported and reports them verbatim", () => {
    const { capabilities, unknownAdvertised } = describeRuntimeCapabilities([
      "time.travel",
      "hyper.render",
      "orchestration.federation-structured-read.v1",
    ]);
    for (const view of capabilities) {
      assert.equal(
        view.supported,
        view.id === "orchestration.federation-structured-read.v1",
        `${view.id} must not be enabled by an unfamiliar vocabulary`,
      );
    }
    assert.deepEqual(unknownAdvertised, ["time.travel", "hyper.render"]);
  });

  it("derives the remote peer gates from the same canonical table (no drift)", () => {
    // canonical advertisement alone must unlock the exact remote gates
    const caps = parsePeerCapabilities([
      "orchestration.worker-launch-preferences.v1",
      "orchestration.federation-structured-read.v1",
      "orchestration.federation-fleet-snapshot.v1",
    ]);
    assert.deepEqual([caps.modelEffort, caps.transcriptRead, caps.fleetSnapshot], [true, true, true]);
    // and a capability with no remote gate never flips one on
    const only = parsePeerCapabilities(["orchestration.worker-stop-verdict.v1"]);
    assert.deepEqual([only.modelEffort, only.transcriptRead, only.fleetSnapshot], [false, false, false]);
  });
});

describe("assertValidWorkerStart placement gates (Phase 6)", () => {
  const base = { taskId: "task_p", agent: "claude", runId: "run_p", from: "term_c" };

  function rejectsWith(opts: Parameters<typeof assertValidWorkerStart>[0], re: RegExp): void {
    assert.throws(() => assertValidWorkerStart(opts), (err: OrcaCliError) => {
      assert.equal(err.code, "invalid_argument");
      assert.match(err.message, re);
      return true;
    });
  }

  it("refuses remote current/active before any Orca mutation", () => {
    rejectsWith({ ...base, on: "env_r", worktree: "current" }, /"current" is ambiguous/i);
    // worktree defaults to current when absent — same refusal.
    rejectsWith({ ...base, on: "env_r" }, /"current" is ambiguous/i);
    rejectsWith({ ...base, on: "env_r", worktree: "active" }, /"current" is ambiguous/i);
  });

  it("refuses remote new-child before any Orca mutation", () => {
    rejectsWith({ ...base, on: "env_r", worktree: "new-child", name: "kid" }, /new-child.*invalid/i);
  });

  it("requires exact repo + explicit name for remote new-top-level", () => {
    rejectsWith({ ...base, on: "env_r", worktree: "new-top-level" }, /--repo selector/i);
    rejectsWith({ ...base, on: "env_r", worktree: "new-top-level", repo: "id:repoA" }, /--name/i);
  });

  it("refuses --on combined with --terminal (remote workers are addressed by Dispatch ID)", () => {
    rejectsWith({ ...base, on: "env_r", worktree: "id:repoA::/srv/ws", terminal: "term_x" }, /--terminal/i);
  });

  it("keeps local behavior legal: current, exact-existing, and local new-top-level", () => {
    assert.doesNotThrow(() => assertValidWorkerStart({ ...base }));
    assert.doesNotThrow(() => assertValidWorkerStart({ ...base, worktree: "path:/srv/ws" }));
    assert.doesNotThrow(() => assertValidWorkerStart({ ...base, worktree: "new-top-level", name: "wt" }));
  });

  it("refuses creation flags outside new worktrees and nameless local creation", () => {
    rejectsWith({ ...base, worktree: "current", repo: "id:repoA" }, /creation flags/i);
    rejectsWith({ ...base, worktree: "new-top-level" }, /--name/i);
  });
});

describe("buildWorkerStartArgv wire contract (Phase 6)", () => {
  it("remote new-top-level carries --on, --worktree new-top-level, --repo, --name", () => {
    const argv = buildWorkerStartArgv(
      {
        taskId: "task_a",
        agent: "codex",
        runId: "run_a",
        from: "term_c",
        on: "env_remote",
        worktree: "new-top-level",
        repo: "id:repoA",
        name: "phase6-wt",
      },
      "req_1",
    );
    assert.deepEqual(argv, [
      "orchestration",
      "worker-start",
      "--task",
      "task_a",
      "--agent",
      "codex",
      "--worktree",
      "new-top-level",
      "--run",
      "run_a",
      "--from",
      "term_c",
      "--retry-request",
      "req_1",
      "--on",
      "env_remote",
      "--repo",
      "id:repoA",
      "--name",
      "phase6-wt",
    ]);
  });

  it("remote exact-existing passes the full selector verbatim and only --on extra", () => {
    const argv = buildWorkerStartArgv(
      {
        taskId: "task_a",
        agent: "claude",
        runId: "run_a",
        from: "term_c",
        on: "env_remote",
        worktree: "id:repoA::/srv/existing",
      },
      "req_2",
    );
    assert.ok(argv.includes("--worktree") && argv.includes("id:repoA::/srv/existing"));
    assert.equal(argv.filter((a) => a === "--on").length, 1);
    assert.ok(!argv.includes("--repo") && !argv.includes("--name"));
  });

  it("local placement is byte-identical to the pre-Phase-6 wire shape", () => {
    const argv = buildWorkerStartArgv(
      { taskId: "task_a", agent: "claude", runId: "run_a", from: "term_c", model: "opus", effort: "high" },
      "req_3",
    );
    assert.deepEqual(argv, [
      "orchestration",
      "worker-start",
      "--task",
      "task_a",
      "--agent",
      "claude",
      "--worktree",
      "current",
      "--run",
      "run_a",
      "--from",
      "term_c",
      "--retry-request",
      "req_3",
      "--model",
      "opus",
      "--effort",
      "high",
    ]);
  });
});

describe("startSupervisedWorker remote starts (Phase 6, fake CLI)", () => {
  it("sends --on/--repo/--name and reports the receipt's effective server", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerStart: {
        dispatchId: "ctx_r1",
        status: "ready",
        on: "env_remote",
        worktree: "new-top-level",
        agent: "codex",
      },
    });
    const started = await startSupervisedWorker({
      taskId: "task_r",
      agent: "codex",
      runId: "run_r",
      from: "term_c",
      on: "env_remote",
      worktree: "new-top-level",
      repo: "id:repoA",
      name: "phase6-wt",
    });
    const call = readLog().find((c) => c.argv[1] === "worker-start")!;
    assert.ok(call.argv.includes("--on") && call.argv.includes("env_remote"));
    assert.ok(call.argv.includes("--repo") && call.argv.includes("id:repoA"));
    assert.ok(call.argv.includes("--name") && call.argv.includes("phase6-wt"));
    assert.equal(started.receipt?.effective.on, "env_remote");
    assert.equal(started.dispatchId, "ctx_r1");
  });

  it("refuses remote current WITHOUT spawning the CLI", async () => {
    useRuntime({ workspace: root });
    const callsBefore = readLog().length;
    await assert.rejects(
      startSupervisedWorker({
        taskId: "task_r",
        agent: "claude",
        runId: "run_r",
        from: "term_c",
        on: "env_remote",
      }),
      (err: OrcaCliError) => err.code === "invalid_argument" && /ambiguous across servers/i.test(err.message),
    );
    assert.equal(readLog().length, callsBefore, "no Orca mutation may be attempted");
  });

  it("refuses remote new-child WITHOUT spawning the CLI", async () => {
    useRuntime({ workspace: root });
    const callsBefore = readLog().length;
    await assert.rejects(
      startSupervisedWorker({
        taskId: "task_r",
        agent: "claude",
        runId: "run_r",
        from: "term_c",
        on: "env_remote",
        worktree: "new-child",
        name: "kid",
      }),
      (err: OrcaCliError) => err.code === "invalid_argument" && /new-child/i.test(err.message),
    );
    assert.equal(readLog().length, callsBefore);
  });
});

describe("environment discovery (Phase 6, fake CLI)", () => {
  it("lists saved environments through `environment list --json`", async () => {
    useRuntime({ workspace: root });
    writeScript({
      environments: [
        { id: "env_a", name: "work-laptop", connected: true, capabilities: ["fleet.snapshot"] },
        { id: "env_b" },
        { broken: true },
      ],
    });
    const envs = await listEnvironments();
    assert.deepEqual(
      envs.map((e) => [e.id, e.name, e.connected]),
      [
        ["env_a", "work-laptop", true],
        ["env_b", "env_b", null],
      ],
    );
    assert.deepEqual(envs[0].capabilities, ["fleet.snapshot"]);
  });

  it("showEnvironment parses a found environment and nulls an unknown selector", async () => {
    useRuntime({ workspace: root });
    writeScript({
      environments: [{ id: "env_a", name: "work-laptop", capabilities: ["model.effort"] }],
    });
    const env = await showEnvironment("env_a");
    assert.equal(env!.id, "env_a");
    assert.deepEqual(env!.capabilities, ["model.effort"]);
    assert.equal(await showEnvironment("nope"), null, "unknown selector → null, not a thrown transport error");
  });

  it("scopes repo/worktree/project discovery with --environment and parses rows tolerantly", async () => {
    useRuntime({ workspace: root });
    writeScript({
      repos: [{ id: "repoA", path: "/srv/repo", displayName: "repo-a", kind: "git", executionHostId: "ssh:h1" }],
      worktrees: [
        {
          id: "repoA::/srv/ws",
          repoId: "repoA",
          path: "/srv/ws",
          displayName: "ws",
          branch: "refs/heads/main",
          hostId: "ssh:h1",
          parentWorktreeId: null,
          isMainWorktree: true,
        },
        { nope: true },
      ],
      projects: [{ id: "proj1", displayName: "Project", kind: "git", sourceRepoIds: ["repoA"] }],
    });
    const [repos, worktrees, projects] = await Promise.all([
      listRepos("env_a"),
      listWorktrees("env_a", { repo: "id:repoA" }),
      listProjects("env_a"),
    ]);
    assert.equal(repos.length, 1);
    assert.deepEqual(repos[0], {
      id: "repoA",
      path: "/srv/repo",
      displayName: "repo-a",
      kind: "git",
      hostId: "ssh:h1",
    });
    assert.equal(worktrees.length, 1, "unparsable rows are dropped, not guessed");
    assert.equal(worktrees[0].id, "repoA::/srv/ws");
    assert.equal(projects[0].repoIds[0], "repoA");
    const calls = readLog();
    assert.ok(
      calls.some((c) => c.argv[0] === "repo" && c.argv.includes("--environment") && c.argv.includes("env_a")),
      "repo discovery names the environment",
    );
    assert.ok(
      calls.some(
        (c) => c.argv[0] === "worktree" && c.argv.includes("--environment") && c.argv.includes("--repo"),
      ),
      "worktree discovery names the environment and the exact repo",
    );
    assert.ok(calls.some((c) => c.argv[0] === "project" && c.argv.includes("--environment")));
  });
});

describe("workspace-scoped Run discovery", () => {
  it("keeps exact-workspace Runs and explicit empty Runs, excluding other directories", async () => {
    useRuntime({ workspace: root });
    let timestamp = 10;
    const run = (id: string, legacy = 0) => ({
      id,
      objective: id,
      coordinator_handle: null,
      consumer_generation: 1,
      legacy,
      created_at: `2026-09-21T00:00:${String(timestamp--).padStart(2, "0")}Z`,
      updated_at: "2026-09-21T00:00:00Z",
    });
    writeScript({
      runs: [
        run("run_here"),
        run("run_foreign"),
        run("run_prefix_trap"),
        run("run_empty_here"),
        run("run_unknown"),
        run("run_legacy_local", 1),
      ],
      tasksByRun: {
        run_here: [
          { created_by_process_incarnation: `repo_local::${root}@@branch:incarnation` },
        ],
        run_foreign: [
          { created_by_process_incarnation: "repo_remote::/srv/other-project@@main:incarnation" },
        ],
        // A sibling whose path merely starts with this workspace must not pass
        // the exact `::<realpath>@@` boundary check.
        run_prefix_trap: [
          { created_by_process_incarnation: `repo_other::${root}-copy@@main:incarnation` },
        ],
        run_unknown: [{ created_by_process_incarnation: null }],
      },
    });

    const scoped = await listWorkspaceRuns(root, ["run_empty_here"]);
    assert.deepEqual(scoped.map((item) => item.id), ["run_here", "run_empty_here"]);

    const taskCalls = readLog().filter((call) => call.argv[1] === "task-list");
    assert.ok(taskCalls.length >= 4);
    assert.ok(taskCalls.every((call) => call.argv.includes("--brief")));
    assert.ok(
      !taskCalls.some((call) => call.argv.includes("run_empty_here")),
      "explicit empty Runs need no Task probe",
    );
    assert.ok(
      !taskCalls.some((call) => call.argv.includes("run_legacy_local")),
      "legacy tombstone is filtered before workspace probing",
    );
  });
});

describe("Run-scoped message history", () => {
  const message = (id: string, runId: string) => ({
    id,
    run_id: runId,
    delivery_contract: "at_least_once",
    from_handle: "term_worker",
    to_handle: "term_coordinator",
    subject: "Progress",
    body: "Still working.",
    type: "status",
    priority: "normal",
    thread_id: null,
    payload: null,
    created_at: "2026-09-21T00:00:00Z",
    delivered_at: null,
  });

  it("reads the global bidirectional inbox without rebinding and filters mixed Run rows", async () => {
    useRuntime({ workspace: root });
    writeScript({
      inboxMessages: [
        message("msg_a", "run_a"),
        { ...message("msg_out", "run_a"), from_handle: "run:run_a", to_handle: "dispatch:ctx_a" },
        message("msg_b", "run_b"),
        null,
      ],
    });

    const rows = await listRunMessages("run_a");
    assert.deepEqual(rows.map((row) => row.id), ["msg_a", "msg_out"]);
    const calls = readLog();
    const inbox = calls.find((call) => call.argv[1] === "inbox");
    assert.ok(inbox);
    assert.ok(inbox.argv.includes("--limit"));
    assert.ok(!calls.some((call) => call.argv[1] === "run-use"), "history reads never fence a coordinator");
  });

  it("reports the global window with saturation judged BEFORE Run filtering", async () => {
    useRuntime({ workspace: root });
    writeScript({
      inboxMessages: [
        message("msg_a1", "run_a"),
        message("msg_a2", "run_a"),
        message("msg_b1", "run_b"),
      ],
    });

    // Three global rows fill a 3-row window: the Run has only its 2 rows, but
    // OLDER rows (any Run's) may exist past the window — the honest trigger
    // for a completeness warning. Foreign rows are counted, never leaked.
    const saturated = await listRunMessagePage("run_a", { limit: 3 });
    assert.deepEqual(saturated.messages.map((row) => row.id), ["msg_a1", "msg_a2"]);
    assert.deepEqual(saturated.window, { limit: 3, observed: 3, saturated: true });

    // The same window with room to spare proves nothing is being truncated.
    const page = await listRunMessagePage("run_a", { limit: 4 });
    assert.deepEqual(page.window, { limit: 4, observed: 3, saturated: false });

    const calls = readLog().filter((call) => call.argv[1] === "inbox");
    assert.ok(calls.every((call) => call.argv.includes("--limit")), "the window is always explicitly bounded");
    assert.ok(calls.some((call) => call.argv.includes("3")), "the requested limit reaches the CLI");
  });

  it("uses the full configured window by default and still filters exactly by Run", async () => {
    useRuntime({ workspace: root });
    writeScript({ inboxMessages: [message("msg_a", "run_a"), message("msg_b", "run_b")] });

    const page = await listRunMessagePage("run_a");
    assert.equal(page.messages.length, 1);
    assert.deepEqual(page.window, {
      limit: ORCHESTRATION_INBOX_LIMIT,
      observed: 2,
      saturated: false,
    });
  });

  it("reads an empty Run even when it has no coordinator mailbox", async () => {
    useRuntime({ workspace: root });
    writeScript({
      inboxMessages: [message("msg_other", "run_other")],
    });

    assert.deepEqual(await listRunMessages("run_empty"), []);
    assert.ok(readLog().some((call) => call.argv[1] === "inbox"));
  });
});

describe("coordinator follow-up messaging", () => {
  it("addresses the authoritative Dispatch and preserves message identity without a shell", async () => {
    useRuntime({ workspace: root });
    writeScript({});

    await sendCoordinatorMessage({
      runId: "run_a",
      taskId: "task_a",
      dispatchId: "ctx_a",
      from: "term_coordinator",
      subject: "Coordinator guidance",
      body: "Please run the focused regression test; do not widen scope.",
    });

    const call = readLog().find((entry) => entry.argv[1] === "send");
    assert.ok(call, "send call missing");
    assert.deepEqual(call.argv, [
      "orchestration",
      "send",
      "--to",
      "dispatch:ctx_a",
      "--run",
      "run_a",
      "--from",
      "term_coordinator",
      "--subject",
      "Coordinator guidance",
      "--body",
      "Please run the focused regression test; do not widen scope.",
      "--type",
      "status",
      "--task-id",
      "task_a",
      "--dispatch-id",
      "ctx_a",
      "--json",
    ]);
  });
});

describe("coordinator group messaging (Phase 6)", () => {
  it("sends an allowlisted group address with Run scope, no attempt identity, one argv per value", async () => {
    useRuntime({ workspace: root });
    writeScript({});

    await sendCoordinatorGroupMessage({
      runId: "run_a",
      audience: "@all",
      subject: "Sprint check-in",
      body: "Please post a one-line status; do not start new work.",
      type: "status",
      priority: null,
      from: "term_coordinator",
    });

    const call = readLog().find((entry) => entry.argv[1] === "send");
    assert.ok(call, "send call missing");
    assert.deepEqual(call.argv, [
      "orchestration",
      "send",
      "--to",
      "@all",
      "--run",
      "run_a",
      "--from",
      "term_coordinator",
      "--subject",
      "Sprint check-in",
      "--body",
      "Please post a one-line status; do not start new work.",
      "--type",
      "status",
      "--json",
    ]);
    // A group message has no single attempt: threading a task/dispatch id in
    // would misattribute Run-level guidance to one Task.
    assert.ok(!call.argv.includes("--task-id"));
    assert.ok(!call.argv.includes("--dispatch-id"));
  });

  it("threads the optional priority through as its own argv value", async () => {
    useRuntime({ workspace: root });
    writeScript({});

    await sendCoordinatorGroupMessage({
      runId: "run_a",
      audience: "@worktree:wt_exact::/repo/x",
      subject: "Question",
      body: "Which stage is blocked?",
      type: "question",
      priority: "urgent",
      from: "term_coordinator",
    });

    const call = readLog().find((entry) => entry.argv[1] === "send")!;
    const priorityAt = call.argv.indexOf("--priority");
    assert.ok(priorityAt >= 0, "priority flag missing");
    assert.deepEqual(call.argv.slice(priorityAt, priorityAt + 2), ["--priority", "urgent"]);
    // The exact discovered address is passed as ONE argv element (shell:false).
    assert.ok(call.argv.includes("@worktree:wt_exact::/repo/x"));
  });
});

describe("audience preview (Phase 6)", () => {
  const worker = (over: Record<string, unknown>): OrcaWorkerRow =>
    ({
      dispatchId: "ctx_a",
      taskId: "task_a",
      runId: "run_a",
      workerState: "supervised",
      dispatchStatus: "dispatched",
      agentTerminalHandle: null,
      terminalState: "active",
      projection: null,
      ...over,
    }) as OrcaWorkerRow;

  it("estimates recipients from dispatched rows and labels every option an estimate", () => {
    const options = previewRunAudiences({
      workers: [
        worker({
          dispatchId: "ctx_1",
          taskId: "task_1",
          projection: {
            launch: { agent: "codex", model: null, effort: null, worktree: null, terminal: null, on: null },
            provider: null,
            stage: { worker: "supervised", dispatch: "dispatched", detail: null, activity: "working" },
            attention: null,
          },
        }),
        worker({
          dispatchId: "ctx_2",
          taskId: "task_2",
          projection: {
            launch: { agent: "claude", model: null, effort: null, worktree: null, terminal: null, on: null },
            provider: null,
            stage: { worker: "supervised", dispatch: "dispatched", detail: null, activity: "idle" },
            attention: null,
          },
        }),
        // A settled row is not a recipient: group mail reaches live Dispatches.
        worker({ dispatchId: "ctx_3", taskId: "task_3", dispatchStatus: "completed" }),
      ],
      worktrees: [],
    });

    const all = options.find((o) => o.address === "@all")!;
    assert.ok(all, "@all must always be offered");
    assert.deepEqual(
      all.estimatedRecipients.map((r) => r.taskId),
      ["task_1", "task_2"],
    );
    assert.equal(all.exact, false, "every estimate must stay labeled an estimate");
    assert.ok(options.every((o) => o.exact === false));
    const idle = options.find((o) => o.address === "@idle")!;
    assert.deepEqual(idle.estimatedRecipients.map((r) => r.taskId), ["task_2"]);
  });

  it("offers harness groups only for active matches and worktree groups only from discovered ids", () => {
    const options = previewRunAudiences({
      workers: [
        worker({
          dispatchId: "ctx_1",
          taskId: "task_1",
          projection: {
            provider: { id: "opencode", model: null },
            workspace: "wt_exact::/repo/x",
            launch: null,
            stage: { worker: "supervised", dispatch: "dispatched", detail: null, activity: "working" },
            attention: { categories: ["input"], requiresAction: true },
          },
        }),
      ],
      worktrees: [
        {
          id: "wt_exact::/repo/x",
          repoId: null,
          path: "/repo/x",
          displayName: "Feature work",
          branch: null,
          hostId: null,
          parentWorktreeId: null,
          isMainWorktree: null,
        },
        {
          // Discovered but with no active worker: still offered (Orca would
          // include workspace coordinators), just with an empty estimate.
          id: "wt_other::/repo/y",
          repoId: null,
          path: "/repo/y",
          displayName: null,
          branch: null,
          hostId: null,
          parentWorktreeId: null,
          isMainWorktree: null,
        },
      ],
    });

    // @opencode matches via provider.id; @claude has no active worker and is
    // NOT offered — the picker never lists a provably empty harness group.
    assert.ok(options.some((o) => o.address === "@opencode"));
    assert.ok(!options.some((o) => o.address === "@claude"));
    const worktree = options.find((o) => o.address === "@worktree:wt_exact::/repo/x")!;
    assert.ok(worktree, "discovered worktree audiences are offered by exact id");
    assert.equal(worktree.kind, "worktree");
    assert.deepEqual(worktree.estimatedRecipients.map((r) => r.taskId), ["task_1"]);
    assert.ok(
      options.some((o) => o.address === "@worktree:wt_other::/repo/y"),
      "discovered identities are offered even before workers appear",
    );
    assert.ok(!options.some((o) => o.address.includes("invented")));
  });
});

describe("listWorkers --include-remote (Phase 6, fake CLI)", () => {
  it("passes --include-remote and preserves the row's execution host", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workers: [
        {
          dispatchId: "ctx_rem",
          taskId: "task_1",
          runId: "run_x",
          workerState: "supervised",
          dispatchStatus: "dispatched",
          agentTerminalHandle: null,
          terminalState: "active",
          projection: {
            host: { kind: "environment", id: "env_remote" },
            outcome: null,
            liveness: { verdict: "unverifiable", reason: "fleet contact lost" },
            stage: null,
            nextAction: { kind: "none", argv: [] },
            attention: null,
          },
        },
      ],
    });
    const rows = await listWorkers("run_x", { includeRemote: true });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].projection?.host, { kind: "environment", id: "env_remote" });
    assert.equal(rows[0].projection?.liveness?.verdict, "unverifiable");
    const call = readLog().find((c) => c.argv[1] === "worker-list")!;
    assert.ok(call.argv.includes("--include-remote"));
  });

  it("follows opaque cursors across empty pages and preserves legacy + remote rows", async () => {
    useRuntime({ workspace: root });
    const cursor1 = "opaque+/= cursor one";
    const cursor2 = "eyJzbmFwc2hvdCI6Mn0=";
    writeScript({
      workerPages: {
        __first__: {
          workers: [
            {
              dispatchId: "ctx_legacy",
              taskId: "task_legacy",
              runId: "run_pages",
              workerState: "unsupervised",
              dispatchStatus: "completed",
              agentTerminalHandle: null,
              terminalState: "retained",
              projection: { host: { kind: "local", id: "local" } },
            },
          ],
          page: { hasMore: true, nextCursor: cursor1 },
        },
        [cursor1]: {
          workers: [],
          page: { hasMore: true, nextCursor: cursor2 },
        },
        [cursor2]: {
          workers: [
            {
              dispatchId: "ctx_remote",
              taskId: "task_remote",
              runId: "run_pages",
              workerState: "supervised",
              dispatchStatus: "dispatched",
              agentTerminalHandle: null,
              terminalState: "active",
              projection: {
                host: { kind: "environment", id: "env_remote" },
                liveness: { verdict: "unverifiable", reason: "fleet contact lost" },
              },
            },
          ],
          page: { hasMore: false, nextCursor: null },
        },
      },
    });

    const rows = await listWorkers("run_pages", { includeRemote: true });
    assert.deepEqual(
      rows.map((row) => [row.dispatchId, row.taskId, row.workerState]),
      [
        ["ctx_legacy", "task_legacy", "unsupervised"],
        ["ctx_remote", "task_remote", "supervised"],
      ],
    );
    assert.equal(rows[1].projection?.liveness?.verdict, "unverifiable");

    const calls = readLog().filter((call) => call.argv[1] === "worker-list");
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.ok(call.argv.includes("--include-remote"));
      assert.deepEqual(call.argv.slice(call.argv.indexOf("--limit"), call.argv.indexOf("--limit") + 2), [
        "--limit",
        "100",
      ]);
    }
    assert.equal(calls[1].argv[calls[1].argv.indexOf("--cursor") + 1], cursor1);
    assert.equal(calls[2].argv[calls[2].argv.indexOf("--cursor") + 1], cursor2);
  });

  it("rejects a receipt missing the workers array", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerPages: {
        __first__: { page: { hasMore: false, nextCursor: null } },
      },
    });
    await assert.rejects(listWorkers("run_missing_workers"), (err: unknown) => {
      assert.ok(err instanceof OrcaCliError);
      assert.equal(err.code, "invalid_pagination");
      assert.match(err.message, /workers must be an array/);
      return true;
    });
  });

  it("rejects a receipt missing the page envelope", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerPages: {
        __first__: { workers: [] },
      },
    });
    await assert.rejects(listWorkers("run_missing_page"), (err: unknown) => {
      assert.ok(err instanceof OrcaCliError);
      assert.equal(err.code, "invalid_pagination");
      assert.match(err.message, /page must be an object/);
      return true;
    });
  });

  it("rejects a worker row whose durable identity fields are malformed", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerPages: {
        __first__: {
          workers: [{ dispatchId: "", taskId: "task_malformed", runId: "run_malformed" }],
          page: { hasMore: false, nextCursor: null },
        },
      },
    });
    await assert.rejects(listWorkers("run_malformed"), (err: unknown) => {
      assert.ok(err instanceof OrcaCliError);
      assert.equal(err.code, "invalid_pagination");
      assert.match(err.message, /workers\[0\]\.dispatchId must be a non-empty string/);
      return true;
    });
  });

  it("rejects a worker row that leaks from another Run", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workers: [
        {
          dispatchId: "ctx_in_scope",
          taskId: "task_in_scope",
          runId: "run_scope",
          workerState: "supervised",
          dispatchStatus: "dispatched",
          agentTerminalHandle: null,
          terminalState: "active",
          projection: null,
        },
        {
          dispatchId: "ctx_other_run",
          taskId: "task_other_run",
          runId: "run_other",
          workerState: "supervised",
          dispatchStatus: "dispatched",
          agentTerminalHandle: null,
          terminalState: "active",
          projection: null,
        },
      ],
    });

    await assert.rejects(listWorkers("run_scope", { includeRemote: true }), (err: unknown) => {
      assert.ok(err instanceof OrcaCliError);
      assert.equal(err.code, "invalid_pagination");
      assert.match(err.message, /workers\[1\]\.runId/);
      assert.match(err.message, /run_other/);
      return true;
    });
  });

  it("refuses a pagination receipt that claims more rows without a cursor", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerPages: {
        __first__: { workers: [], page: { hasMore: true, nextCursor: null } },
      },
    });
    await assert.rejects(listWorkers("run_broken"), (err: unknown) => {
      assert.ok(err instanceof OrcaCliError);
      assert.equal(err.code, "invalid_pagination");
      assert.match(err.message, /without a usable page\.nextCursor/);
      return true;
    });
  });

  it("refuses a contradictory terminal page instead of silently dropping its cursor", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerPages: {
        __first__: { workers: [], page: { hasMore: false, nextCursor: "stale-cursor" } },
      },
    });
    await assert.rejects(listWorkers("run_broken"), (err: unknown) => {
      assert.ok(err instanceof OrcaCliError);
      assert.equal(err.code, "invalid_pagination");
      assert.match(err.message, /hasMore=false with a nextCursor/);
      return true;
    });
  });

  it("requires a boolean hasMore and an explicit terminal null cursor", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerPages: {
        __first__: {
          workers: [],
          page: { hasMore: "false" as unknown as boolean, nextCursor: null },
        },
      },
    });
    await assert.rejects(listWorkers("run_bad_has_more"), (err: unknown) => {
      assert.ok(err instanceof OrcaCliError);
      assert.equal(err.code, "invalid_pagination");
      assert.match(err.message, /page\.hasMore must be a boolean/);
      return true;
    });

    writeScript({
      workerPages: {
        __first__: { workers: [], page: { hasMore: false } },
      },
    });
    await assert.rejects(listWorkers("run_missing_cursor"), (err: unknown) => {
      assert.ok(err instanceof OrcaCliError);
      assert.equal(err.code, "invalid_pagination");
      assert.match(err.message, /page\.nextCursor is required/);
      return true;
    });
  });

  it("serves complete, remote-inclusive accounting from /api/workers", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerPages: {
        __first__: {
          workers: [
            {
              dispatchId: "ctx_local",
              taskId: "task_local",
              runId: "run_api",
              workerState: "unsupervised",
              dispatchStatus: "completed",
              agentTerminalHandle: null,
              terminalState: "retained",
              projection: null,
            },
          ],
          page: { hasMore: true, nextCursor: "api-next" },
        },
        "api-next": {
          workers: [
            {
              dispatchId: "ctx_remote_api",
              taskId: "task_remote",
              runId: "run_api",
              workerState: "supervised",
              dispatchStatus: "dispatched",
              agentTerminalHandle: null,
              terminalState: "active",
              projection: { host: { kind: "environment", id: "env_remote" } },
            },
          ],
          page: { hasMore: false, nextCursor: null },
        },
      },
    });
    const policy = createSecurityPolicy({});
    const { app } = createApp({
      workspaceDir: root,
      worktree: `path:${root}`,
      policy,
      embeddedAssets: null,
    });
    const apiServer = await listenLoopback(app, 0);
    try {
      const addr = apiServer.address();
      assert.ok(addr && typeof addr === "object");
      const response = await fetch(`http://127.0.0.1:${addr.port}/api/workers?run=run_api`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { workers: Array<{ taskId: string }> };
      assert.deepEqual(body.workers.map((row) => row.taskId), ["task_local", "task_remote"]);
    } finally {
      apiServer.closeAllConnections();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }

    const calls = readLog().filter((call) => call.argv[1] === "worker-list");
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.argv.includes("--include-remote")));
    assert.ok(calls.every((call) => call.argv.includes("run_api")), "every page stays scoped to the Run");
  });
});

// --- Phase 2: durable worker operations --------------------------------------

/**
 * A `worker-show` result payload shaped like the verified 1.4.206 receipt:
 * durable projection row + dispatch/worker records + PTY terminal facts +
 * the exact-worker observation. Tests override the layers they care about.
 */
function workerShowReceipt(overrides: {
  dispatchId?: string;
  runId?: string;
  taskId?: string;
  liveness?: { verdict: string; reason: string | null } | null;
  dispatchStatus?: string;
  observation?: Record<string, unknown> | null;
  omitObservation?: boolean;
  terminal?: Record<string, unknown> | null;
  workerState?: string | null;
  workerStage?: string | null;
} = {}): Record<string, unknown> {
  const dispatchId = overrides.dispatchId ?? "ctx_show";
  const runId = overrides.runId ?? "run_show";
  const taskId = overrides.taskId ?? "task_show";
  return {
    dispatch: {
      id: dispatchId,
      runId,
      taskId,
      task_id: taskId,
      status: overrides.dispatchStatus ?? "dispatched",
      failureCount: 0,
      lastFailure: null,
      terminationReason: null,
      dispatchedAt: "2026-09-21 10:25:47",
      completedAt: null,
      lastHeartbeatAt: "2026-09-21T10:26:04Z",
      retryOfDispatchId: null,
      depth: 1,
    },
    worker: {
      dispatchId,
      state: overrides.workerState ?? "supervised",
      stage: overrides.workerStage ?? "running",
      setupState: "complete",
      agentTerminalHandle: "term_agent",
      lastError: null,
    },
    projection: {
      id: dispatchId,
      dispatchId,
      taskId,
      runId,
      role: "worker",
      host: { kind: "local", id: "local" },
      stage: { worker: "supervised", dispatch: "dispatched", detail: null, activity: "working" },
      outcome: "in_progress",
      liveness:
        overrides.liveness === undefined
          ? { verdict: "live", reason: null }
          : overrides.liveness,
      nextAction: { kind: "none", argv: [] },
      attention: { categories: [], requiresAction: false },
    },
    terminal: {
      handle: "term_agent",
      title: "opencode",
      connected: true,
      orphaned: false,
      worktreePath: "/ws",
      branch: "refs/heads/main",
      executionHostId: "local",
      agentIdentity: "opencode",
      lastOutputAt: 1789986567208,
      preview: "…",
      agentWait: null,
      ...(overrides.terminal ?? {}),
    },
    ...(overrides.omitObservation
      ? {}
      : { observation: overrides.observation ?? { status: "live", exactWorker: true, agentWait: null } }),
  };
}

describe("presentWorkerLiveness (Phase 2)", () => {
  it("keeps the fleet verdict authoritative — even against a live observation", () => {
    for (const verdict of ["live", "exited"]) {
      const p = presentWorkerLiveness({
        fleetVerdict: verdict,
        fleetReason: null,
        observation: { status: "live", exactWorker: true },
      });
      assert.equal(p.verdict, verdict);
      assert.equal(p.qualifiedWorking, false);
      assert.equal(p.qualifiedReason, null);
    }
  });

  it("qualifies a missing_status gap when the exact observation proves live", () => {
    const p = presentWorkerLiveness({
      fleetVerdict: "unverifiable",
      fleetReason: "missing_status",
      observation: { status: "live", exactWorker: true },
    });
    assert.equal(p.verdict, "unverifiable", "the fleet verdict itself is never promoted");
    assert.equal(p.qualifiedWorking, true);
    assert.equal(p.qualifiedReason, "missing_status");
    assert.equal(p.observationStatus, "live");
  });

  it("qualifies a capability_unsupported gap the same way", () => {
    const p = presentWorkerLiveness({
      fleetVerdict: "unverifiable",
      fleetReason: "capability_unsupported",
      observation: { status: "live", exactWorker: true },
    });
    assert.equal(p.qualifiedWorking, true);
    assert.equal(p.qualifiedReason, "capability_unsupported");
  });

  it("refuses to qualify without a positively exact observation", () => {
    for (const exactWorker of [false, null, undefined]) {
      const p = presentWorkerLiveness({
        fleetVerdict: "unverifiable",
        fleetReason: "missing_status",
        observation: { status: "live", exactWorker },
      });
      assert.equal(p.qualifiedWorking, false, `exactWorker=${String(exactWorker)} must not qualify`);
    }
  });

  it("refuses to qualify unless the observation itself says live", () => {
    for (const status of ["closed", "unreadable", null, undefined]) {
      const p = presentWorkerLiveness({
        fleetVerdict: "unverifiable",
        fleetReason: "missing_status",
        observation: { status, exactWorker: true },
      });
      assert.equal(p.qualifiedWorking, false, `observation.status=${String(status)} must not qualify`);
    }
  });

  it("refuses to qualify for reasons outside the documented capability gaps", () => {
    const p = presentWorkerLiveness({
      fleetVerdict: "unverifiable",
      fleetReason: "unsupervised_settled",
      observation: { status: "live", exactWorker: true },
    });
    assert.equal(p.qualifiedWorking, false);
  });

  it("stays unverifiable (never exited) when nothing was observed", () => {
    const p = presentWorkerLiveness({ fleetVerdict: null, fleetReason: null, observation: null });
    assert.equal(p.verdict, "unverifiable");
    assert.equal(p.qualifiedWorking, false);
    assert.equal(p.observationStatus, null);
  });
});

describe("showWorkerDetail (Phase 2, fake CLI)", () => {
  it("parses the receipt into the detail view and flags the qualified merge", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerShow: {
        ctx_show: workerShowReceipt({
          liveness: { verdict: "unverifiable", reason: "missing_status" },
          observation: { status: "live", exactWorker: true, agentWait: null },
        }),
      },
    });
    const detail = await showWorkerDetail("ctx_show");
    assert.ok(detail);
    assert.equal(detail.dispatchId, "ctx_show");
    assert.equal(detail.runId, "run_show");
    assert.equal(detail.taskId, "task_show");
    assert.equal(detail.fleet?.taskId, "task_show");
    assert.equal(detail.dispatch?.status, "dispatched");
    assert.equal(detail.worker?.stage, "running");
    assert.equal(detail.terminal?.connected, true);
    assert.equal(detail.terminal?.agentIdentity, "opencode");
    assert.equal(detail.observation?.status, "live");
    assert.equal(detail.observation?.exactWorker, true);
    assert.equal(detail.liveness.verdict, "unverifiable");
    assert.equal(detail.liveness.qualifiedWorking, true);
    const call = readLog().find((c) => c.argv[1] === "worker-show")!;
    assert.deepEqual(call.argv.slice(0, 4), ["orchestration", "worker-show", "--dispatch", "ctx_show"]);
  });

  it("keeps agent-wait tri-state: present object, explicit null, absent = unknown", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerShow: {
        // present: parked on a human prompt, with the evidence that proved it
        ctx_wait: workerShowReceipt({
          dispatchId: "ctx_wait",
          observation: { status: "live", exactWorker: true, agentWait: { kind: "hook", detail: "permission prompt", extra: 1 } },
        }),
        // explicit null: Orca looked and found no wait (healthy)
        ctx_nowait: workerShowReceipt({
          dispatchId: "ctx_nowait",
          observation: { status: "live", exactWorker: true, agentWait: null },
        }),
        // absent: this host never looked — must stay undefined (unknown)
        ctx_neverlooked: workerShowReceipt({
          dispatchId: "ctx_neverlooked",
          observation: { status: "live", exactWorker: true },
        }),
      },
    });
    const waited = await showWorkerDetail("ctx_wait");
    assert.equal(waited?.observation?.agentWait?.kind, "hook");
    assert.equal(waited.observation?.agentWait?.detail, "permission prompt");
    assert.deepEqual(waited.observation?.agentWait?.raw, { kind: "hook", detail: "permission prompt", extra: 1 });

    const noWait = await showWorkerDetail("ctx_nowait");
    assert.equal(noWait?.observation?.hasOwnProperty("agentWait"), true);
    assert.equal(noWait?.observation?.agentWait, null);

    const neverLooked = await showWorkerDetail("ctx_neverlooked");
    assert.equal(neverLooked?.observation?.hasOwnProperty("agentWait"), false);
    assert.equal(neverLooked?.observation?.agentWait, undefined);
  });

  it("returns null when the runtime reports the dispatch unknown", async () => {
    useRuntime({ workspace: root });
    writeScript({ workerShow: {} });
    assert.equal(await showWorkerDetail("ctx_missing"), null);
  });

  it("rethrows infrastructure failures instead of calling the worker unknown", async () => {
    useRuntime({ workspace: root, env: { ORCA_CLI_COMMAND: join(root, "no-such-orca") } });
    await assert.rejects(showWorkerDetail("ctx_x"), (err: unknown) => {
      assert.ok(err instanceof OrcaCliError);
      assert.equal(err.code, "cli_not_found");
      return true;
    });
  });

  it("tolerates a receipt with no observation or projection layers", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerShow: {
        ctx_thin: {
          dispatch: { id: "ctx_thin", runId: "run_thin", status: "dispatched" },
        },
      },
    });
    const detail = await showWorkerDetail("ctx_thin");
    assert.ok(detail);
    assert.equal(detail.observation, null);
    assert.equal(detail.fleet, null);
    assert.equal(detail.terminal, null);
    assert.equal(detail.runId, "run_thin");
    assert.equal(detail.liveness.verdict, "unverifiable");
    assert.equal(detail.liveness.qualifiedWorking, false);
  });
});

describe("Phase 2: worker detail + durable history over HTTP", () => {
  /** Boot a throwaway viewer against the current fake-CLI script. */
  async function bootViewer(): Promise<{ server: Server; base: string }> {
    const policy = createSecurityPolicy({});
    const { app } = createApp({
      workspaceDir: root,
      worktree: `path:${root}`,
      policy,
      embeddedAssets: null,
    });
    const server = await listenLoopback(app, 0);
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    return { server, base: `http://127.0.0.1:${addr.port}` };
  }

  async function get(base: string, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(base + path);
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  it("requires the Run scope before touching Orca", async () => {
    useRuntime({ workspace: root });
    writeScript({});
    const { server, base } = await bootViewer();
    try {
      const missing = await get(base, "/api/workers/ctx_show");
      assert.equal(missing.status, 400);
      assert.equal(missing.json.code, "run_required");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("serves worker-show evidence, scoped to the requested Run", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerShow: {
        ctx_gap: workerShowReceipt({
          dispatchId: "ctx_gap",
          runId: "run_hist",
          workerState: "unsupervised",
          workerStage: "context_only",
          liveness: { verdict: "unverifiable", reason: "missing_status" },
          observation: { status: "live", exactWorker: true, agentWait: null },
        }),
      },
    });
    const { server, base } = await bootViewer();
    try {
      const ok = await get(base, "/api/workers/ctx_gap?run=run_hist");
      assert.equal(ok.status, 200);
      const detail = ok.json.detail as Record<string, any>;
      assert.equal(detail.dispatchId, "ctx_gap");
      assert.equal(detail.runId, "run_hist");
      assert.equal(detail.observation.status, "live");
      assert.equal(detail.liveness.qualifiedWorking, true);
      assert.equal(detail.liveness.fleetReason, "missing_status");

      // A worker from another Run must not leak across the scope boundary.
      const other = await get(base, "/api/workers/ctx_gap?run=run_other");
      assert.equal(other.status, 404);
      assert.equal(other.json.code, "worker_run_mismatch");

      const unknown = await get(base, "/api/workers/ctx_nothere?run=run_hist");
      assert.equal(unknown.status, 404);
      assert.equal(unknown.json.code, "worker_not_found");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps worker history with the coordinator stopped and across a viewer restart", async () => {
    // The viewer's coordinator loop is NEVER started in this test: the fleet
    // rows exist only in Orca's durable accounting, which is exactly what the
    // endpoint must serve. A second viewer process (a "restart") then reads
    // the same history through a brand-new app instance.
    useRuntime({ workspace: root });
    writeScript({
      workerPages: {
        __first__: {
          workers: [
            {
              dispatchId: "ctx_old",
              taskId: "task_old",
              runId: "run_durable",
              workerState: "unsupervised",
              dispatchStatus: "completed",
              agentTerminalHandle: "term_gone",
              terminalState: "released",
              projection: {
                outcome: "succeeded",
                liveness: { verdict: "unverifiable", reason: "unsupervised_settled" },
                stage: null,
                nextAction: { kind: "none", argv: [] },
                attention: null,
              },
            },
          ],
          page: { hasMore: false, nextCursor: null },
        },
      },
    });

    const first = await bootViewer();
    let history: Array<Record<string, unknown>> = [];
    try {
      const res = await get(first.base, "/api/workers?run=run_durable");
      assert.equal(res.status, 200);
      history = res.json.workers as Array<Record<string, unknown>>;
      assert.equal(history.length, 1);
      const status = await get(first.base, "/api/run-status");
      assert.equal(status.json.running, false, "no viewer coordinator was ever started");
    } finally {
      first.server.closeAllConnections();
      await new Promise<void>((resolve) => first.server.close(() => resolve()));
    }

    const second = await bootViewer();
    try {
      const res = await get(second.base, "/api/workers?run=run_durable");
      assert.equal(res.status, 200);
      const after = res.json.workers as Array<Record<string, unknown>>;
      assert.deepEqual(
        after.map((row) => [row.dispatchId, row.taskId, row.terminalState]),
        history.map((row) => [row.dispatchId, row.taskId, row.terminalState]),
        "history survives a viewer process restart untouched",
      );
    } finally {
      second.server.closeAllConnections();
      await new Promise<void>((resolve) => second.server.close(() => resolve()));
    }
  });

  it("carries qualified working evidence into Chat presence for capability-gap rows", async () => {
    useRuntime({ workspace: root });
    writeScript({
      tasksByRun: { run_gap: [] },
      inboxMessages: [],
      workerPages: {
        __first__: {
          workers: [
            {
              // The documented acceptance case: an unsupervised, context-only
              // OpenCode dispatch the fleet cannot verify…
              dispatchId: "ctx_gap",
              taskId: "task_gap",
              runId: "run_gap",
              workerState: "unsupervised",
              dispatchStatus: "dispatched",
              agentTerminalHandle: "term_agent",
              terminalState: "retained",
              projection: {
                outcome: "in_progress",
                liveness: { verdict: "unverifiable", reason: "missing_status" },
                stage: { worker: "unsupervised", dispatch: "dispatched", detail: null, activity: "unknown" },
                nextAction: { kind: "none", argv: [] },
                attention: { categories: ["unverifiable"], requiresAction: true },
              },
            },
            {
              // …a control row whose gap is NOT a documented capability gap…
              dispatchId: "ctx_settled",
              taskId: "task_settled",
              runId: "run_gap",
              workerState: "unsupervised",
              dispatchStatus: "completed",
              agentTerminalHandle: null,
              terminalState: "released",
              projection: {
                outcome: "succeeded",
                liveness: { verdict: "unverifiable", reason: "unsupervised_settled" },
                stage: null,
                nextAction: { kind: "none", argv: [] },
                attention: null,
              },
            },
            {
              // …and a gap row whose observation is NOT provably exact.
              dispatchId: "ctx_shared",
              taskId: "task_shared",
              runId: "run_gap",
              workerState: "unsupervised",
              dispatchStatus: "dispatched",
              agentTerminalHandle: null,
              terminalState: "active",
              projection: {
                outcome: "in_progress",
                liveness: { verdict: "unverifiable", reason: "missing_status" },
                stage: null,
                nextAction: { kind: "none", argv: [] },
                attention: null,
              },
            },
          ],
          page: { hasMore: false, nextCursor: null },
        },
      },
      workerShow: {
        ctx_gap: workerShowReceipt({
          dispatchId: "ctx_gap",
          runId: "run_gap",
          taskId: "task_gap",
          workerState: "unsupervised",
          workerStage: "context_only",
          liveness: { verdict: "unverifiable", reason: "missing_status" },
          observation: { status: "live", exactWorker: true, agentWait: null },
        }),
        // exactWorker false: a live pane, but not provably THIS worker
        ctx_shared: workerShowReceipt({
          dispatchId: "ctx_shared",
          runId: "run_gap",
          taskId: "task_shared",
          workerState: "unsupervised",
          liveness: { verdict: "unverifiable", reason: "missing_status" },
          observation: { status: "live", exactWorker: false, agentWait: null },
        }),
      },
    });
    const { server, base } = await bootViewer();
    try {
      const res = await get(base, "/api/activity?run=run_gap");
      assert.equal(res.status, 200);
      const presence = res.json.presence as Array<Record<string, any>>;
      const gap = presence.find((p) => p.dispatchId === "ctx_gap");
      assert.ok(gap, "capability-gap row present");
      assert.equal(gap.liveness, "unverifiable", "fleet verdict stays unverifiable");
      assert.equal(gap.livenessReason, "missing_status");
      assert.equal(gap.qualifiedWorking, true, "exact live observation qualifies the presentation");

      const settled = presence.find((p) => p.dispatchId === "ctx_settled");
      assert.equal(settled?.qualifiedWorking, false, "non-capability-gap reasons never qualify");

      const shared = presence.find((p) => p.dispatchId === "ctx_shared");
      assert.equal(shared?.qualifiedWorking, false, "an inexact observation never qualifies");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// --- Placement foundation: full local matrix, creation flags, revalidation --
//
// Adapter-level acceptance for the approved placement foundation: the exact
// worker-start argv for all four LOCAL modes, proof that creation flags never
// leak onto current/existing starts, deterministic name derivation, refusals
// BEFORE any Orca mutation, and exact-selector worktree/repo revalidation.

describe("placement foundation: local creation gates (assertValidWorkerStart)", () => {
  const base = { taskId: "task_f", agent: "claude", runId: "run_f", from: "term_c" };

  function rejectsWith(opts: Parameters<typeof assertValidWorkerStart>[0], re: RegExp): void {
    assert.throws(() => assertValidWorkerStart(opts), (err: OrcaCliError) => {
      assert.equal(err.code, "invalid_argument");
      assert.match(err.message, re);
      return true;
    });
  }

  it("refuses the whole creation-flag family on current and existing starts", () => {
    for (const worktree of ["current", "id:repoA::/srv/ws", "path:/srv/ws"] as const) {
      for (const field of ["repo", "name", "baseBranch", "displayName", "comment", "setup"] as const) {
        rejectsWith({ ...base, worktree, [field]: "x" }, /creation flags/);
      }
    }
  });

  it("refuses --repo on new-child (a child anchors on the current workspace's repo)", () => {
    rejectsWith({ ...base, worktree: "new-child", name: "kid", repo: "id:repoA" }, /--repo/);
  });

  it("refuses malformed creation metadata before any spawn", () => {
    rejectsWith({ ...base, worktree: "new-child", name: "bad name" }, /--name/);
    rejectsWith({ ...base, worktree: "new-top-level", repo: "id:repoA", name: "wt", setup: "yolo" }, /--setup/);
    rejectsWith(
      { ...base, worktree: "new-child", name: "kid", baseBranch: "../escape" },
      /--base-branch/,
    );
    rejectsWith(
      { ...base, worktree: "new-child", name: "kid", comment: "x".repeat(501) },
      /--comment/,
    );
    rejectsWith(
      { ...base, worktree: "new-child", name: "kid", displayName: "bad\u0000null" },
      /--display-name/,
    );
  });

  it("still requires an explicit name for remote new-top-level (no derivation there)", () => {
    rejectsWith({ ...base, on: "env_r", worktree: "new-top-level", repo: "id:repoA" }, /--name/);
  });
});

describe("placement foundation: deriveWorktreeName / withDerivedCreationDefaults", () => {
  it("derives a deterministic, bounded, grammar-safe name from Run + Task ids", () => {
    const a = deriveWorktreeName("run_abc123", "task_def456");
    const b = deriveWorktreeName("run_abc123", "task_def456");
    assert.equal(a, b, "same Run + Task → same name (replays reuse identical argv)");
    assert.notEqual(a, deriveWorktreeName("run_abc123", "task_other"), "different scope → different name");
    assert.match(a, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "always satisfies the --name grammar");
    // The suffix is the first 8 hex chars of sha256("run\u0000scope") — the
    // exact documented recipe, pinned here so it can never silently drift.
    const digest = createHash("sha256").update("run_abc123\u0000task_def456").digest("hex").slice(0, 8);
    assert.equal(a, `task_def456-${digest}`);
    // Path-flavored scope ids collapse to the bounded token form.
    const messy = deriveWorktreeName("run_x", "task/weird id");
    assert.match(messy, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    assert.equal(deriveWorktreeName("run_x", "///").slice(0, 2), "wt", "empty base falls back to wt");
  });

  it("withDerivedCreationDefaults fills only local nameless creating starts", () => {
    const seed = { taskId: "task_a", agent: "claude", runId: "run_a", from: "term_c" };
    // current/existing: untouched, no name invented.
    assert.deepEqual(withDerivedCreationDefaults({ ...seed }), seed);
    assert.deepEqual(withDerivedCreationDefaults({ ...seed, worktree: "path:/srv/ws" }), {
      ...seed,
      worktree: "path:/srv/ws",
    });
    // Local creating start without a name: derived.
    const derived: WorkerStartRequest = withDerivedCreationDefaults({
      ...seed,
      worktree: "new-child",
    });
    assert.equal(derived.name, deriveWorktreeName("run_a", "task_a"));
    // Explicit name wins.
    assert.deepEqual(withDerivedCreationDefaults({ ...seed, worktree: "new-child", name: "mine" }), {
      ...seed,
      worktree: "new-child",
      name: "mine",
    });
    // Remote creating starts keep the explicit-name contract.
    assert.deepEqual(withDerivedCreationDefaults({ ...seed, on: "env_r", worktree: "new-top-level", repo: "id:repoA" }), {
      ...seed,
      on: "env_r",
      worktree: "new-top-level",
      repo: "id:repoA",
    });
  });
});

describe("buildWorkerStartArgv wire contract (placement foundation: local modes)", () => {
  const base = { taskId: "task_a", agent: "claude", runId: "run_a", from: "term_c" };
  const CREATION_FLAGS = ["--repo", "--name", "--base-branch", "--display-name", "--comment", "--setup"];

  function assertNoCreationFlags(argv: string[], note: string): void {
    for (const flag of CREATION_FLAGS) {
      assert.ok(!argv.includes(flag), `${note}: ${flag} must never appear`);
    }
  }

  it("local current stays byte-identical to the pre-foundation shape (no creation flags)", () => {
    const argv = buildWorkerStartArgv({ ...base }, "req_c1");
    assert.deepEqual(argv, [
      "orchestration",
      "worker-start",
      "--task",
      "task_a",
      "--agent",
      "claude",
      "--worktree",
      "current",
      "--run",
      "run_a",
      "--from",
      "term_c",
      "--retry-request",
      "req_c1",
    ]);
    assertNoCreationFlags(argv, "current");
  });

  it("local exact-existing carries the full selector verbatim and no creation flags", () => {
    const argv = buildWorkerStartArgv({ ...base, worktree: "id:repoA::/srv/ws" }, "req_c2");
    assert.ok(argv.includes("--worktree") && argv.includes("id:repoA::/srv/ws"));
    assertNoCreationFlags(argv, "existing");
  });

  it("local new-child carries --name + every creation flag and never --repo", () => {
    const argv = buildWorkerStartArgv(
      {
        ...base,
        worktree: "new-child",
        name: "kid-wt",
        baseBranch: "feature/x",
        displayName: "Kid lane",
        comment: "stacked",
        setup: "inherit",
      },
      "req_c3",
    );
    assert.ok(argv.includes("--worktree") && argv.includes("new-child"));
    // Everything after --name is exactly the creation block, in order.
    assert.deepEqual(argv.slice(argv.indexOf("--name")), [
      "--name",
      "kid-wt",
      "--base-branch",
      "feature/x",
      "--display-name",
      "Kid lane",
      "--comment",
      "stacked",
      "--setup",
      "inherit",
    ]);
    assert.ok(!argv.includes("--repo"), "new-child must never carry --repo");
  });

  it("local new-top-level carries --repo + --name + creation flags", () => {
    const argv = buildWorkerStartArgv(
      {
        ...base,
        worktree: "new-top-level",
        repo: "id:repoA",
        name: "top-wt",
        baseBranch: "main",
        setup: "skip",
      },
      "req_c4",
    );
    assert.ok(argv.includes("--worktree") && argv.includes("new-top-level"));
    assert.deepEqual(
      argv.slice(argv.indexOf("--repo")),
      ["--repo", "id:repoA", "--name", "top-wt", "--base-branch", "main", "--setup", "skip"],
    );
  });

  it("absent creation fields emit absent flags (no empty --setup/--comment padding)", () => {
    const argv = buildWorkerStartArgv({ ...base, worktree: "new-child", name: "kid" }, "req_c5");
    assert.ok(argv.includes("--name") && argv.includes("kid"));
    assertNoCreationFlags(
      argv.filter((a) => a !== "--name" && a !== "kid"),
      "nameless creation fields",
    );
  });
});

describe("placement foundation: supervised starts through the fake CLI", () => {
  it("derives the worktree name for a local nameless new-child start and preserves the receipt", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerStart: {
        dispatchId: "ctx_f1",
        status: "ready",
        worktree: "new-child",
        launch: { name: deriveWorktreeName("run_f", "task_f1") },
      },
    });
    const started = await startSupervisedWorker({
      taskId: "task_f1",
      agent: "claude",
      runId: "run_f",
      from: "term_c",
      worktree: "new-child",
      setup: "inherit",
    });
    const call = readLog().find((c) => c.argv[1] === "worker-start")!;
    // runOrca appends --json, so the log's argv carries it as a trailing entry.
    const argvNoJson = call.argv.filter((a) => a !== "--json");
    assert.ok(call.argv.includes("--worktree") && call.argv.includes("new-child"));
    assert.deepEqual(
      argvNoJson.slice(argvNoJson.indexOf("--name")),
      ["--name", deriveWorktreeName("run_f", "task_f1"), "--setup", "inherit"],
      "the derived name is baked into the exact argv",
    );
    assert.ok(!call.argv.includes("--repo"), "no --repo on a child");
    assert.equal(started.dispatchId, "ctx_f1");
    assert.equal(started.receipt?.effective.name, deriveWorktreeName("run_f", "task_f1"));
  });

  it("sends the full local new-top-level creation flags and never touches Git", async () => {
    useRuntime({ workspace: root });
    writeScript({ workerStart: { dispatchId: "ctx_f2", status: "ready", worktree: "new-top-level" } });
    const started = await startSupervisedWorker({
      taskId: "task_f2",
      agent: "codex",
      runId: "run_f",
      from: "term_c",
      worktree: "new-top-level",
      repo: "id:repoA",
      name: "top-wt",
      baseBranch: "main",
      displayName: "Top lane",
      comment: "independent lane",
      setup: "skip",
    });
    const call = readLog().find((c) => c.argv[1] === "worker-start")!;
    const argvNoJson = call.argv.filter((a) => a !== "--json");
    assert.deepEqual(argvNoJson.slice(argvNoJson.indexOf("--repo")), [
      "--repo",
      "id:repoA",
      "--name",
      "top-wt",
      "--base-branch",
      "main",
      "--display-name",
      "Top lane",
      "--comment",
      "independent lane",
      "--setup",
      "skip",
    ]);
    assert.equal(started.dispatchId, "ctx_f2");
    // The adapter's contract: creation happens ONLY through worker-start —
    // no `git worktree` command is spawned, ever.
    assert.ok(readLog().every((c) => !c.argv.includes("git")), "no git invocation");
  });

  it("refuses local creation-flag misuse WITHOUT spawning the CLI", async () => {
    useRuntime({ workspace: root });
    const callsBefore = readLog().length;
    await assert.rejects(
      startSupervisedWorker({
        taskId: "task_f3",
        agent: "claude",
        runId: "run_f",
        from: "term_c",
        worktree: "current",
        name: "sneaky",
      }),
      (err: OrcaCliError) => err.code === "invalid_argument" && /creation flags/.test(err.message),
    );
    await assert.rejects(
      startSupervisedWorker({
        taskId: "task_f3",
        agent: "claude",
        runId: "run_f",
        from: "term_c",
        worktree: "new-child",
        name: "kid",
        repo: "id:repoA",
      }),
      (err: OrcaCliError) => err.code === "invalid_argument" && /--repo/.test(err.message),
    );
    assert.equal(readLog().length, callsBefore, "no Orca mutation may be attempted");
  });
});

describe("placement foundation: exact worktree/repo revalidation (fake CLI)", () => {
  it("showWorktree returns the discovered row for an exact selector", async () => {
    useRuntime({ workspace: root });
    writeScript({
      worktrees: [
        {
          id: "id:repoA::/srv/ws",
          repoId: "repoA",
          path: "/srv/ws",
          displayName: "ws",
          branch: "refs/heads/main",
          hostId: null,
          parentWorktreeId: null,
          isMainWorktree: false,
        },
      ],
    });
    const row = await showWorktree("id:repoA::/srv/ws");
    assert.equal(row?.id, "id:repoA::/srv/ws");
    assert.equal(row?.path, "/srv/ws");
    const call = readLog().find((c) => c.argv[0] === "worktree" && c.argv[1] === "show")!;
    assert.ok(call.argv.includes("--worktree") && call.argv.includes("id:repoA::/srv/ws"));
  });

  it("showWorktree nulls an unknown selector and never throws a transport error for it", async () => {
    useRuntime({ workspace: root });
    writeScript({ worktrees: [] });
    assert.equal(await showWorktree("id:ghost::/nowhere"), null);
  });

  it("showRepo returns the registered repo and nulls an unknown selector", async () => {
    useRuntime({ workspace: root });
    writeScript({
      repos: [{ id: "repoA", path: "/srv/repo", displayName: "repo-a", kind: "git", executionHostId: "ssh:h1" }],
    });
    const repo: OrcaRepoRow | null = await showRepo("id:repoA");
    assert.equal(repo?.id, "repoA");
    assert.equal(repo?.kind, "git");
    assert.equal(await showRepo("id:ghost"), null);
  });

  it("scopes revalidation through --environment when one is named", async () => {
    useRuntime({ workspace: root });
    writeScript({
      worktrees: [{ id: "id:repoA::/srv/remote", repoId: "repoA", path: "/srv/remote" }],
    });
    const row = await showWorktree("id:repoA::/srv/remote", "env_remote");
    assert.equal(row?.id, "id:repoA::/srv/remote");
    const call = readLog().find((c) => c.argv[0] === "worktree" && c.argv[1] === "show")!;
    assert.ok(call.argv.includes("--environment") && call.argv.includes("env_remote"));
  });
});

// --- Operations epic: abandon, focus, paged Runs, exact lookup, file review,
// --- worktree removal, umbrella capabilities --------------------------------

describe("abandonWorkerReceipt (fake CLI)", () => {
  it("sends worker-abandon under a durable retry-request id and parses the receipt", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerAbandon: {
        result: {
          dispatchId: "ctx_ab",
          state: "abandoned",
          alreadySettled: false,
          processAction: null,
          warning: "resources may remain live",
        },
      },
    });
    const receipt = await abandonWorkerReceipt("ctx_ab", { retryRequestId: "req_fixed" });
    assert.equal(receipt.dispatchId, "ctx_ab");
    assert.equal(receipt.state, "abandoned");
    assert.equal(receipt.alreadySettled, false);
    assert.equal(receipt.processAction, null, "abandon performs no process action");
    assert.equal(receipt.warning, "resources may remain live");
    assert.equal(receipt.requestId, "req_fixed", "the durable request id is echoed back");
    assert.equal(receipt.raw.state, "abandoned", "verbatim lifecycle evidence is preserved");
    const call = readLog().find((c) => c.argv[1] === "worker-abandon")!;
    assert.deepEqual(call.argv.slice(0, 6), [
      "orchestration",
      "worker-abandon",
      "--dispatch",
      "ctx_ab",
      "--retry-request",
      "req_fixed",
    ]);
    assert.ok(call.argv.includes("--json"));
  });

  it("preserves evidence and fails closed when the abandon response is lost", async () => {
    useRuntime({ workspace: root });
    writeScript({ workerAbandon: { rawError: "segmentation fault (core dumped)", exitCode: 2 } });
    await assert.rejects(
      abandonWorkerReceipt("ctx_lost", { retryRequestId: "req_lost" }),
      (err: unknown) => {
        assert.ok(err instanceof OrcaCliError);
        assert.equal((err as OrcaCliError).code, RESPONSE_LOST);
        assert.match((err as Error).message, /worker-abandon/, "the full argv stays in the evidence");
        return true;
      },
    );
    // No blind replay: resolving a lost mutation is request-show's job with
    // the SAME id — the adapter itself must not fire a second mutation.
    assert.equal(readLog().filter((c) => c.argv[1] === "worker-abandon").length, 1);
  });

  it("keeps the runtime's typed refusal verbatim instead of swallowing it", async () => {
    useRuntime({ workspace: root });
    writeScript({
      workerAbandon: {
        rawError: JSON.stringify({ ok: false, error: { code: "consumer_fenced", message: "fenced" } }),
        exitCode: 1,
      },
    });
    await assert.rejects(
      abandonWorkerReceipt("ctx_fenced", { retryRequestId: "req_fenced" }),
      (err: unknown) => {
        assert.ok(err instanceof OrcaCliError);
        assert.equal((err as OrcaCliError).code, "consumer_fenced");
        return true;
      },
    );
  });
});

describe("focusTerminal (fake CLI)", () => {
  it("switches to the exact runtime-issued handle and nothing else", async () => {
    useRuntime({ workspace: root });
    writeScript({ terminalSwitch: { switched: true, handle: "term_exact" } });
    const receipt = await focusTerminal("term_exact");
    assert.equal(receipt.handle, "term_exact");
    assert.equal(receipt.raw.switched, true);
    const call = readLog().find((c) => c.argv[0] === "terminal" && c.argv[1] === "switch")!;
    assert.deepEqual(call.argv.slice(0, 4), ["terminal", "switch", "--terminal", "term_exact"]);
  });

  it("refuses an empty handle locally without spawning the CLI", async () => {
    useRuntime({ workspace: root });
    await assert.rejects(
      focusTerminal("   "),
      (err: unknown) => {
        assert.ok(err instanceof OrcaCliError);
        assert.equal((err as OrcaCliError).code, "invalid_argument");
        return true;
      },
    );
    assert.equal(readLog().length, 0, "no ambient focus target may ever be resolved");
  });
});

describe("listRuns cursor pagination (fake CLI)", () => {
  const run = (id: string, created_at: string, legacy = 0) => ({
    id,
    objective: id,
    coordinator_handle: null,
    consumer_generation: 1,
    legacy,
    created_at,
    updated_at: created_at,
  });

  it("follows top-level run-list cursors and preserves the legacy filter + newest-first order", async () => {
    useRuntime({ workspace: root });
    writeScript({
      runPages: {
        __first__: {
          runs: [run("run_new", "2026-09-22T01:00:00Z"), run("run_tomb", "2026-09-22T00:59:00Z", 1)],
          nextCursor: "cur+/=1",
        },
        "cur+/=1": { runs: [], nextCursor: "cur2" },
        cur2: { runs: [run("run_old", "2026-09-21T00:00:00Z")], nextCursor: null },
      },
    });
    const runs = await listRuns();
    assert.deepEqual(
      runs.map((r) => r.id),
      ["run_new", "run_old"],
      "empty middle pages are followed and the tombstone stays filtered",
    );
    const calls = readLog().filter((c) => c.argv[1] === "run-list");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].argv.slice(0, 4), ["orchestration", "run-list", "--limit", "100"]);
    assert.ok(!calls[0].argv.includes("--cursor"), "the first page carries no cursor");
    assert.equal(calls[1].argv[calls[1].argv.indexOf("--cursor") + 1], "cur+/=1");
    assert.equal(calls[2].argv[calls[2].argv.indexOf("--cursor") + 1], "cur2");
  });

  it("refuses an endless pagination loop instead of spinning", async () => {
    useRuntime({ workspace: root });
    writeScript({
      runPages: {
        __first__: { runs: [run("run_a", "2026-09-22T00:00:00Z")], nextCursor: "same" },
        same: { runs: [], nextCursor: "same" },
      },
    });
    await assert.rejects(listRuns(), (err: unknown) => {
      assert.ok(err instanceof OrcaCliError);
      assert.equal((err as OrcaCliError).code, "invalid_pagination");
      assert.match((err as Error).message, /repeated nextCursor/);
      return true;
    });
  });
});

describe("showRun exact lookup (fake CLI)", () => {
  it("returns the row for an exact id and nulls only Orca's own run_not_found", async () => {
    useRuntime({ workspace: root });
    writeScript({
      runsById: {
        run_known: {
          id: "run_known",
          objective: "o",
          coordinator_handle: "term_c",
          consumer_generation: 1,
          legacy: 0,
          created_at: "t",
          updated_at: "t",
        },
      },
    });
    const run = await showRun("run_known");
    assert.equal(run?.coordinator_handle, "term_c");
    const call = readLog().find((c) => c.argv[1] === "run-show")!;
    assert.deepEqual(call.argv.slice(0, 4), ["orchestration", "run-show", "--id", "run_known"]);
    assert.equal(await showRun("run_missing"), null, "a definite absence stays null");
  });

  it("never re-answers a lost response as 'no such Run' — contact loss throws", async () => {
    useRuntime({ workspace: root });
    writeScript({ runShow: { rawError: "connection reset", exitCode: 1 } });
    await assert.rejects(showRun("run_x"), (err: unknown) => {
      assert.ok(err instanceof OrcaCliError);
      assert.equal((err as OrcaCliError).code, RESPONSE_LOST);
      return true;
    });
  });
});

describe("workspace file review (fake CLI)", () => {
  it("opens one file against an exact worktree selector", async () => {
    useRuntime({ workspace: root });
    writeScript({ fileResult: { path: "src/App.tsx", worktree: "id:repo::/srv/ws" } });
    const receipt = await openWorkspaceFile("src/App.tsx", { worktree: "id:repo::/srv/ws" });
    assert.equal(receipt.path, "src/App.tsx");
    assert.equal(receipt.worktree, "id:repo::/srv/ws");
    const call = readLog().find((c) => c.argv[0] === "file")!;
    assert.deepEqual(call.argv.slice(0, 5), [
      "file",
      "open",
      "src/App.tsx",
      "--worktree",
      "id:repo::/srv/ws",
    ]);
  });

  it("diffs with --staged only when requested", async () => {
    useRuntime({ workspace: root });
    await openWorkspaceFileDiff("src/App.tsx", { staged: true });
    await openWorkspaceFileDiff("README.md");
    const calls = readLog().filter((c) => c.argv[0] === "file" && c.argv[1] === "diff");
    assert.equal(calls.length, 2);
    assert.ok(calls[0].argv.includes("--staged"));
    assert.ok(!calls[1].argv.includes("--staged"), "unstaged is the default and sends no flag");
    assert.equal(calls[1].argv[2], "README.md");
  });

  it("refuses an empty path locally without spawning the CLI", async () => {
    useRuntime({ workspace: root });
    await assert.rejects(
      openWorkspaceFile("   "),
      (err: unknown) => {
        assert.ok(err instanceof OrcaCliError);
        assert.equal((err as OrcaCliError).code, "invalid_argument");
        return true;
      },
    );
    await assert.rejects(
      openWorkspaceFileDiff(""),
      (err: unknown) => {
        assert.equal((err as OrcaCliError).code, "invalid_argument");
        return true;
      },
    );
    assert.equal(readLog().length, 0, "no ambient file target may ever be resolved");
  });

  it("passes --mode through and refuses modes outside the documented union locally", async () => {
    useRuntime({ workspace: root });
    await openWorkspaceChangedFiles({ mode: "both", worktree: "active" });
    const call = readLog().find((c) => c.argv[1] === "open-changed")!;
    assert.deepEqual(call.argv.slice(0, 6), [
      "file",
      "open-changed",
      "--mode",
      "both",
      "--worktree",
      "active",
    ]);
    await assert.rejects(
      openWorkspaceChangedFiles({ mode: "revert" as unknown as WorkspaceChangedMode }),
      (err: unknown) => {
        assert.ok(err instanceof OrcaCliError);
        assert.equal((err as OrcaCliError).code, "invalid_argument");
        return true;
      },
    );
    assert.equal(
      readLog().filter((c) => c.argv[1] === "open-changed").length,
      1,
      "the invalid mode never reached the CLI",
    );
  });
});

describe("worktree rm with archive-hook semantics (fake CLI)", () => {
  it("pins run-hooks + waiver argv and preserves archiveHookOverride verbatim", async () => {
    useRuntime({ workspace: root });
    writeScript({
      worktreeRm: {
        result: { removed: true, archiveHookOverride: { hook: "orca.yaml:archive", exitCode: 3 } },
      },
    });
    const receipt = await removeWorktree("id:repo::/srv/ws", {
      runHooks: true,
      allowFailedArchiveHook: true,
    });
    assert.equal(receipt.worktree, "id:repo::/srv/ws");
    assert.deepEqual(receipt.archiveHookOverride, { hook: "orca.yaml:archive", exitCode: 3 });
    const call = readLog().find((c) => c.argv[0] === "worktree" && c.argv[1] === "rm")!;
    assert.deepEqual(call.argv.slice(0, 4), ["worktree", "rm", "--worktree", "id:repo::/srv/ws"]);
    assert.ok(call.argv.includes("--run-hooks"));
    assert.ok(call.argv.includes("--allow-failed-archive-hook"));
    assert.ok(!call.argv.includes("--force"));
  });

  it("refuses the waiver without --run-hooks locally, never spawning the CLI", async () => {
    useRuntime({ workspace: root });
    await assert.rejects(
      removeWorktree("id:repo::/srv/ws", { allowFailedArchiveHook: true }),
      (err: unknown) => {
        assert.ok(err instanceof OrcaCliError);
        assert.equal((err as OrcaCliError).code, "invalid_argument");
        return true;
      },
    );
    assert.equal(readLog().length, 0, "the documented precondition fails before any call");
  });

  it("fails closed on a blocking archive hook: typed evidence, no auto-waiver", async () => {
    useRuntime({ workspace: root });
    writeScript({
      worktreeRm: {
        fail: true,
        error: { code: "worktree_archive_hook_failed", message: "archive hook 'archive' exited 3" },
      },
    });
    await assert.rejects(
      removeWorktree("id:repo::/srv/ws", { runHooks: true, force: true }),
      (err: unknown) => {
        // --force must NOT waive a failed archive hook (documented), so the
        // typed failure surfaces verbatim and nothing was removed.
        assert.ok(isArchiveHookFailure(err));
        assert.equal((err as OrcaCliError).code, "worktree_archive_hook_failed");
        assert.match((err as Error).message, /archive hook/);
        return true;
      },
    );
    const calls = readLog().filter((c) => c.argv[0] === "worktree" && c.argv[1] === "rm");
    assert.equal(calls.length, 1, "the adapter never retries with --allow-failed-archive-hook on its own");
    assert.ok(calls[0].argv.includes("--force"), "force is passed but cannot waive a hook failure");
  });

  it("keeps base argv minimal and skips hooks unless --run-hooks is requested", async () => {
    useRuntime({ workspace: root });
    writeScript({ worktreeRm: { result: { removed: true } } });
    const receipt = await removeWorktree("id:repo::/srv/ws");
    assert.equal(receipt.worktree, "id:repo::/srv/ws");
    assert.equal(receipt.archiveHookOverride, null);
    const call = readLog().find((c) => c.argv[0] === "worktree" && c.argv[1] === "rm")!;
    assert.deepEqual(call.argv.slice(0, 4), ["worktree", "rm", "--worktree", "id:repo::/srv/ws"]);
    assert.ok(!call.argv.includes("--run-hooks"));
    assert.ok(!call.argv.includes("--allow-failed-archive-hook"));
    assert.ok(!call.argv.includes("--force"));
  });
});

describe("computer capabilities umbrella parsing", () => {
  it("flattens the supports umbrella and gates support on positive booleans only", () => {
    const cap = parseComputerCapabilities({
      platform: "linux",
      provider: "orca-computer-use-linux",
      providerVersion: "1.0.0",
      protocolVersion: 1,
      supports: {
        windows: { list: true, focus: false },
        actions: { click: true, hotkey: false },
        meta: { revision: 7 },
        futureGroup: { nextThing: true },
      },
    });
    assert.equal(cap.platform, "linux");
    assert.equal(cap.provider, "orca-computer-use-linux");
    assert.equal(cap.providerVersion, "1.0.0");
    assert.equal(cap.protocolVersion, 1);
    assert.equal(cap.advertised, true);
    assert.equal(computerSupports(cap, "windows", "focus"), false, "a false leaf is unsupported");
    assert.equal(computerSupports(cap, "actions", "click"), true);
    assert.equal(computerSupports(cap, "actions", "hotkey"), false);
    assert.equal(computerSupports(cap, "windows", "typeText"), false, "a missing leaf is unsupported");
    assert.equal(
      computerSupports(cap, "meta", "revision"),
      false,
      "non-boolean leaves carry no capability claim",
    );
    assert.equal(
      computerSupports(cap, "futureGroup", "nextThing"),
      true,
      "unknown newer groups still parse verbatim",
    );
    assert.equal((cap.raw.futureGroup as Record<string, unknown>).nextThing, true);
  });

  it("treats a receipt without a supports map as 'nothing advertised' (fail closed)", () => {
    const cap: ComputerUseCapabilities = parseComputerCapabilities({ platform: "linux" });
    assert.equal(cap.advertised, false);
    assert.deepEqual(cap.capabilities, []);
    assert.equal(computerSupports(cap, "actions", "click"), false);
  });

  it("fetches through the resolved CLI with the exact two-verb argv", async () => {
    useRuntime({ workspace: root });
    writeScript({
      computerCapabilities: {
        result: {
          platform: "linux",
          provider: "p",
          providerVersion: "1",
          protocolVersion: 1,
          supports: { actions: { click: true } },
        },
      },
    });
    const cap = await fetchComputerCapabilities();
    assert.equal(computerSupports(cap, "actions", "click"), true);
    const call = readLog().find((c) => c.argv[0] === "computer")!;
    assert.deepEqual(call.argv, ["computer", "capabilities", "--json"]);
  });

  it("propagates response loss as an error instead of an empty capability set", async () => {
    useRuntime({ workspace: root });
    writeScript({ computerCapabilities: { rawError: "killed", exitCode: 9 } });
    await assert.rejects(fetchComputerCapabilities(), (err: unknown) => {
      assert.ok(err instanceof OrcaCliError);
      assert.equal((err as OrcaCliError).code, RESPONSE_LOST);
      return true;
    });
  });
});
