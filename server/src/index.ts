import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { runOrca, initOrcaRuntime, getOrcaRuntime, formatCommand, checkReadiness } from "./orca";
import { loadEmbeddedAssets } from "./webAssets";
import { describeSkillInstall, installSkill } from "./skill";
import { createApp, listenLoopback } from "./app";
import { createSecurityPolicy } from "./security";
import { describePlanningSetup, setupPlanningWorkspace } from "./planning";
import { initializeWorkspaceState } from "./workspaceState";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Raw env value, used ONLY by `uninstall` to locate this workspace's files
// — uninstall must work even when the directory is gone. The serve path
// below resolves the real workspace via initOrcaRuntime().
const RAW_WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? process.cwd();

// --- Subcommands ----------------------------------------------------------
// Handled before anything else so `uninstall` and `--help` never bind a port,
// create an Orca terminal, or install the skill on their way out.
const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`orca-dag — visualize and run an Orca orchestration task DAG

Usage:
  orca-dag                 install the skill, initialize planning ignores, then serve the viewer
  orca-dag uninstall       remove the skill, managed ignore rule, and leftover Orca terminals
  orca-dag --help          show this

Options:
  --no-skill               don't touch the agent skill directories on startup
  --no-workspace-init      don't add .orca-dag/ to the workspace's .gitignore
  --purge                  (uninstall) also delete viewer history; planning docs are always kept
  --dry-run                (uninstall) report what would be removed, change nothing

Environment:
  PORT=8787                port to serve on (always bound to loopback 127.0.0.1)
  NO_OPEN=1                don't open a browser tab
  ORCA_DAG_NO_SKILL=1      same as --no-skill
  ORCA_DAG_NO_WORKSPACE_INIT=1
                            same as --no-workspace-init
  WORKSPACE_DIR=<path>     workspace to use instead of the current directory
                           (must exist; used verbatim as the Orca worktree)
  ORCA_WORKTREE=<selector> explicit Orca worktree selector; default is the
                           exact workspace as path:<WORKSPACE_DIR>
  ORCA_CLI_COMMAND="<cmd>" exact Orca CLI to run, quoted argv, no shell
                            (default: orca, or orca-ide on Linux outside Orca)
  ORCA_DAG_OPENCODE_TUI=1   experimental API-preselected full TUI for explicit
                            OpenCode models; running Orca >= 1.4.222, local
                            POSIX current/existing non-lane workspaces only
  ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1
                           allow arbitrary custom harness commands (they run as
                           shell lines inside worker terminals; the known agent
                           ids — claude, codex, opencode, … — never need this)

Planning documents:
  .orca-dag/<UTC timestamp>/PRD.md and TECH_SPEC.md (one directory per plan).
Workspace state:
  .orca-dag/{config.json,activity.jsonl,launches.jsonl,requests.jsonl,sessions.json}.
  Legacy root .orca-dag.* files move here without overwriting existing files.
  Stop old viewers before upgrading; uninstall --purge removes only state files.
  Startup adds a marked .orca-dag/ rule to .gitignore by default. Uninstall
  removes only managed rules (including legacy .orca/ blocks), never your
  planning documents or your own ignore rules.`);
  process.exit(0);
}

if (argv.includes("uninstall")) {
  const { runUninstall } = await import("./uninstall");
  await runUninstall({
    dryRun: argv.includes("--dry-run"),
    purge: argv.includes("--purge"),
    workspace: RAW_WORKSPACE_DIR,
  });
  process.exit(0);
}

// Resolve the Orca CLI + workspace identity ONCE for the whole process (Phase
// 2): the executable/argv spec, the realpath'd workspace every CLI call runs
// in, and the worktree selector derived from it. A bad WORKSPACE_DIR stops
// startup here with an actionable message instead of misplacing a coordinator.
try {
  initOrcaRuntime();
} catch (err) {
  console.error(`orca-dag: ${String((err as Error).message ?? err)}`);
  process.exit(1);
}
const runtime = getOrcaRuntime();

// Per-process mutation token + custom-command policy. The web client fetches
// the token once from /api/session and echoes it back on every mutation; see
// security.ts for the threat model this closes and what it deliberately
// doesn't.
const policy = createSecurityPolicy();

const embedded = await loadEmbeddedAssets();
const { app, servingUI } = createApp({
  workspaceDir: runtime.workspace.dir,
  worktree: runtime.worktree,
  policy,
  embeddedAssets: embedded,
});

// `orca-dag` is meant to be the single command that makes the whole project
// work, so starting the viewer also puts the DAG-building skill in front of
// whatever agents this machine has. Best-effort and idempotent — see skill.ts.
const skillReport = describeSkillInstall(
  await installSkill(__dirname, !argv.includes("--no-skill") && process.env.ORCA_DAG_NO_SKILL !== "1"),
);
const planningReport = describePlanningSetup(setupPlanningWorkspace(
  runtime.workspace.dir,
  !argv.includes("--no-workspace-init") && process.env.ORCA_DAG_NO_WORKSPACE_INIT !== "1",
));
// Announce workspace writes before listening, even if a later port bind fails.
if (skillReport) console.log(skillReport);
console.log(planningReport);

// Loopback-only, deliberately: this API drives orchestration mutations that
// fence real agent terminals, so it must not be reachable from the LAN. The
// resolved port is read back so PORT=0 picks a free one for tests.
const server = await listenLoopback(app, Number(process.env.PORT ?? 8787));
// Do not relocate a running older viewer's files on a failed second launch:
// acquire our port first. Constructors only calculate paths; store access and
// this startup migration share the same no-clobber location contract.
for (const line of initializeWorkspaceState(runtime.workspace.dir)) console.log(line);
const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : Number(process.env.PORT ?? 8787);
const url = `http://localhost:${port}`;
console.log(`Orca DAG viewer → ${url} (bound to 127.0.0.1)`);
console.log(
  `Orca CLI: ${formatCommand(runtime.command)} · workspace: ${runtime.workspace.dir} ` +
    `(worktree: ${runtime.worktree}, id: ${runtime.workspace.hash}/${runtime.workspace.instanceId})`,
);
// Readiness is the UI's execution gate; print the verdict once at startup so
// a view-only session is explained in the terminal too. Never fatal — the
// /api/readiness route re-probes for the client.
void checkReadiness().then((r) => {
  if (r.executionEnabled) console.log(`Orca ${r.version} — execution enabled.`);
  else console.log(`View-only: ${r.reason}`);
});
if (servingUI && process.env.NO_OPEN !== "1") void openBrowser(url);

/**
 * Open the viewer URL. Prefers an Orca built-in browser tab (`orca tab create`)
 * so the DAG lives inside the Orca window next to the terminals/workers it
 * drives; falls back to the OS default browser when Orca isn't reachable (dev
 * from a non-worktree dir, Orca not yet open, tab creation refused). Best-effort:
 * never throws — the URL is already logged above.
 */
async function openBrowser(url: string): Promise<void> {
  // `tab create` resolves the current worktree from cwd, so it works wherever
  // the viewer runs inside an Orca-managed project. Fails fast if the runtime
  // isn't up — then we drop to the system browser below.
  try {
    const created = await runOrca<{ browserPageId?: string }>(["tab", "create", "--url", url]);
    // `tab create` makes the new tab the active one, but does NOT raise the
    // Orca window to the foreground. `tab switch --focus` reveals the window
    // (and the tab), so the DAG shows up in front instead of behind something.
    const pageId = created?.browserPageId;
    if (pageId) {
      try {
        await runOrca(["tab", "switch", "--page", pageId, "--focus"]);
      } catch {
        // Tab is created and active; only the window-raise failed — leave it.
      }
    }
    return;
  } catch {
    // Orca not running / not a worktree / tab refused — fall through.
  }
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // headless / no browser — the URL is already printed above
  }
}
