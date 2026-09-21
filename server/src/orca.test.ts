import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import {
  assertValidWorkerStart,
  buildWorkerStartArgv,
  CANONICAL_RUNTIME_CAPABILITIES,
  COORDINATOR_TITLE,
  MIN_EXECUTION_VERSION,
  MIN_VIEW_VERSION,
  OrcaCliError,
  canonicalCapabilitySupported,
  checkReadiness,
  compareVersions,
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
  listRunMessages,
  listWorkspaceRuns,
  listWorkers,
  listWorktrees,
  normalizeLiveness,
  parseAdvertisedCapabilities,
  parseCliCommand,
  parseCoordinatorTitle,
  parseEnvironmentRow,
  parsePeerCapabilities,
  parseWorkerStartReceipt,
  presentWorkerLiveness,
  readWorkerOutput,
  resolveOrcaCommand,
  resolveWorktreeSelector,
  resolveWorkspace,
  runOrca,
  sendCoordinatorMessage,
  showEnvironment,
  showWorkerDetail,
  startSupervisedWorker,
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
if (args[0] === "worktree" && args[1] === "list") out.result = { worktrees: conf.worktrees ?? [] };
if (args[0] === "project" && args[1] === "list") out.result = { projects: conf.projects ?? [] };
if (args[0] === "orchestration" && args[1] === "run-list") out.result = { runs: conf.runs ?? [] };
if (args[0] === "orchestration" && args[1] === "run-show") {
  const id = args[args.indexOf("--id") + 1];
  out.result = { run: conf.runsById?.[id] };
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
    // The terminal parks with its title (OSC-0 + sleep) instead of running an
    // interactive shell that would immediately overwrite the title.
    const ci = create.argv.indexOf("--command");
    const cmd = create.argv[ci + 1];
    assert.match(cmd, /printf .*sleep infinity$/);
    assert.ok(cmd.includes(create.argv[ti + 1]), "the parked title matches the terminal title");
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
      assert.match(err.message, /orca-dag uninstall/);
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

  it("gates Run creation, gate resolution and reset after their own validation", async () => {
    const noObjective = await call("POST", "/api/runs", {}, policy.token);
    assert.equal(noObjective.status, 400); // validation first
    const create = await call("POST", "/api/runs", { objective: "x" }, policy.token);
    assert.equal(create.status, 503);
    assert.equal(create.json.code, "execution_disabled");

    const noIds = await call("POST", "/api/gates/gate_1/resolve", {}, policy.token);
    assert.equal(noIds.status, 400); // validation first
    const gate = await call("POST", "/api/gates/gate_1/resolve", { runId: "run_x", resolution: "approved" }, policy.token);
    assert.equal(gate.status, 503);

    const noConfirm = await call("POST", "/api/reset", {}, policy.token);
    assert.equal(noConfirm.status, 400); // confirm-first contract unchanged
    const reset = await call("POST", "/api/reset", { confirmAllRuns: true }, policy.token);
    assert.equal(reset.status, 503);
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
    });
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
