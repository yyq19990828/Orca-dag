// `orca-dag uninstall` — undo everything `orca-dag` put on this machine.
//
// The mirror image of skill.ts: because startup silently writes into agent
// skill directories, there has to be one obvious command that takes it all
// back. It removes what the viewer created and *reports* what it deliberately
// won't touch, rather than quietly leaving debris behind:
//
//   removed   the orca-dag skill from every agent directory
//   removed   leftover "orca-dag coordinator" Orca terminals
//   removed   exact managed .orca-dag/ (and legacy .orca/) .gitignore blocks
//   removed   .orca-dag/ state files and legacy root equivalents (--purge only)
//   kept      current and legacy planning docs, even with --purge (real user work)
//   reported  the npm/global install and the npx cache — a running process
//             cannot delete its own program, so we print the command instead
//
// Nothing here throws: uninstalling must not fail halfway and strand the user
// in a half-removed state.

import { existsSync, lstatSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_SKILL_DIRS, SKILL_NAME } from "./skill";
import { COORDINATOR_TITLE, closeTerminal, listTerminals, parseCoordinatorTitle } from "./orca";
import { stageGitStoreDir } from "./stageGit";
import { LEGACY_PLANNING_DIR, PLANNING_DIR, removePlanningIgnore } from "./planning";
import { assertWorkspaceStateDirectory, legacyWorkspaceStatePath, WORKSPACE_STATE_FILES } from "./workspaceState";

export interface UninstallOptions {
  /** Print what would happen, change nothing. */
  dryRun: boolean;
  /** Also delete workspace-owned viewer config and activity history. */
  purge: boolean;
  /** Workspace whose managed ignore rule and viewer history are targeted. */
  workspace: string;
}

const tilde = (p: string) => p.replace(homedir(), "~");
/** Fixed-width action column so the report reads as a table, not a paragraph. */
const act = (verb: string) => `  ${verb.padEnd(13)}`;

/** Remove the installed skill from every agent directory. */
function removeSkills(dryRun: boolean, log: (line: string) => void): number {
  let removed = 0;
  for (const { agent, skills } of AGENT_SKILL_DIRS) {
    const dir = join(homedir(), skills, SKILL_NAME);
    if (!existsSync(dir) && !isBrokenLink(dir)) continue;
    try {
      // A symlink is the `ln -s "$PWD/skill"` recipe. Unlinking removes only
      // the link — the checkout it points at is untouched — but say so, because
      // "removed" next to a path inside their repo would read as data loss.
      const link = lstatSync(dir).isSymbolicLink();
      const note = link ? " (symlink only — your checkout is untouched)" : "";
      if (!dryRun) {
        if (link) unlinkSync(dir);
        else rmSync(dir, { recursive: true, force: true });
      }
      log(`${act(dryRun ? "would remove" : "removed")}${agent}: ${tilde(dir)}${note}`);
      removed++;
    } catch (err) {
      log(`${act("failed")}${tilde(dir)}: ${String((err as Error)?.message ?? err)}`);
    }
  }
  return removed;
}

/** lstat succeeds on a dangling symlink where existsSync (which follows) fails. */
function isBrokenLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Close Orca terminals this viewer created.
 *
 * Both the coordinator loop's terminal and its one-shot `adhoc` helpers carry
 * the same `orca-dag coordinator` title prefix (the stable contract — Phase 2
 * appended workspace hash + instance id after it, older versions had nothing).
 * A crashed viewer leaves them connected and still bound to a Run, which
 * fences the user's own agent — so cleaning them up is the part of uninstall
 * that actually unblocks someone.
 *
 * Each terminal is reported with the WORKSPACE it was coordinating (from the
 * worktree it lives in, plus the title's hash segment) before it closes, so a
 * multi-workspace user can see exactly whose coordinators went away.
 *
 * Exported (not private) because this sweep is uninstall's only surface that
 * talks to a *live* runtime: its workspace-scoped discovery contract — close
 * ours by title prefix, report each workspace, never touch foreign terminals —
 * is exercised against the fake-CLI suite in `orca.test.ts`.
 */
export async function closeCoordinatorTerminals(dryRun: boolean, log: (line: string) => void): Promise<number> {
  let terminals;
  try {
    terminals = await listTerminals();
  } catch {
    // Orca not running or not reachable — nothing we can do, and nothing that
    // needs saying: without a runtime there are no live terminals either.
    return 0;
  }
  const ours = terminals.filter((t) => t.title.startsWith(COORDINATOR_TITLE));
  for (const t of ours) {
    const info = parseCoordinatorTitle(t.title);
    const scope =
      info === null
        ? "unrecognized title — closing anyway (prefix matched)"
        : info.kind === "legacy"
          ? "pre-workspace-scoped orca-dag"
          : `workspace ${info.hash} (${t.worktreePath || "unknown path"})`;
    if (!dryRun) await closeTerminal(t.handle);
    log(`${act(dryRun ? "would close" : "closed")}Orca terminal "${t.title}" (${t.handle}) — ${scope}`);
  }
  return ours.length;
}

export async function runUninstall(opts: UninstallOptions): Promise<void> {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  console.log(opts.dryRun ? "orca-dag uninstall (dry run — nothing will change)\n" : "orca-dag uninstall\n");

  const skills = removeSkills(opts.dryRun, log);
  const terminals = await closeCoordinatorTerminals(opts.dryRun, log);
  const ignore = removePlanningIgnore(opts.workspace, opts.dryRun);
  if (ignore.reason) {
    log(`${act("skipped")}${ignore.path} — ${ignore.reason}`);
  } else if (ignore.removed) {
    log(`${act(opts.dryRun ? "would remove" : "removed")}${ignore.path} — managed planning ignore block(s) only`);
  }
  for (const name of [PLANNING_DIR, LEGACY_PLANNING_DIR]) {
    const planningDir = join(opts.workspace, name);
    if (existsSync(planningDir) || isBrokenLink(planningDir)) {
      // Planning docs are authored requirements/designs, not disposable viewer
      // history. --purge must never become permission to erase those documents,
      // including the old location used before the planning directory rename.
      log(`${act("kept")}${planningDir} — planning documents (even with --purge); add ${name}/ to .gitignore yourself to keep them ignored`);
    }
  }

  let workspaceFiles = 0;
  const labels = {
    config: "harness/model/layout choices",
    activity: "viewer activity history",
    requests: "mutation-request audit ledger",
    sessions: "bound harness session identities",
    launches: "historical Dispatch launch identities",
  };
  let safeStateDir = true;
  try { assertWorkspaceStateDirectory(opts.workspace); }
  catch (err) {
    safeStateDir = false;
    log(`${act("skipped")}${String((err as Error).message ?? err)}`);
  }
  // Enumerate both layouts without invoking migration: --dry-run and ordinary
  // uninstall must never move user data. Purge only known files, not the shared
  // directory (which also holds timestamped PRDs, designs and other user work).
  const persisted = Object.entries(WORKSPACE_STATE_FILES).flatMap(([key, file]) => [
    ...(safeStateDir ? [{ path: join(opts.workspace, file), label: labels[key as keyof typeof labels] }] : []),
    { path: legacyWorkspaceStatePath(opts.workspace, file), label: `${labels[key as keyof typeof labels]} (legacy location)` },
  ]);
  for (const item of persisted) {
    if (!existsSync(item.path) && !isBrokenLink(item.path)) continue;
    try {
      const info = lstatSync(item.path);
      if (!info.isFile() && !info.isSymbolicLink()) {
        log(`${act("skipped")}${item.path} — not a state file; left untouched`);
        continue;
      }
      if (opts.purge) {
        if (!opts.dryRun) rmSync(item.path);
        log(`${act(opts.dryRun ? "would remove" : "removed")}${item.path}`);
        workspaceFiles++;
      } else {
        // These files are one workspace's real user state. Deleting them by
        // default would turn uninstall into an unexpected history eraser.
        log(`${act("kept")}${item.path} — ${item.label} (delete with --purge)`);
      }
    } catch (err) {
      log(`${act("failed")}${item.path}: ${String((err as Error)?.message ?? err)}`);
    }
  }
  // Committed-Stage snapshots live in Git metadata (shared by this repo's
  // worktrees), so they cannot accidentally make a Stage dirty or be committed
  // as source. They are still viewer-owned state: report/keep them normally
  // and remove them under the same explicit --purge contract as the ledger.
  try {
    const dir = stageGitStoreDir(opts.workspace);
    if (existsSync(dir)) {
      if (opts.purge) {
        if (!opts.dryRun) rmSync(dir, { recursive: true, force: true });
        log(`${act(opts.dryRun ? "would remove" : "removed")}${dir}`);
        workspaceFiles++;
      } else {
        log(`${act("kept")}${dir} — committed Stage evidence (delete with --purge)`);
      }
    }
  } catch {
    // A folder workspace or removed Git repo never had committed-Stage state.
  }

  if (lines.length === 0) console.log("  Nothing to remove — orca-dag left no traces on this machine.");
  else for (const line of lines) console.log(line);

  console.log(
    `\n${opts.dryRun ? "Would remove" : "Removed"}: ${skills} skill install(s), ${terminals} Orca terminal(s)` +
      (ignore.removed ? `, ${ignore.removed} managed ignore block(s)` : "") +
      (workspaceFiles ? `, ${workspaceFiles} workspace file(s)` : "") + ".",
  );

  // A process cannot delete the program it is running from, so the last step is
  // always the user's. Which command it is depends on how they got here.
  console.log("\nThe program itself is not removed by this command:");
  // The npm package is this fork's `orca-orchestration-launcher`; the command
  // (bin) itself is still `orca-dag`, hence the binary hint below.
  console.log("  installed with npm i -g   →  npm rm -g orca-orchestration-launcher");
  console.log("  run through npx           →  npx clear-npx-cache   (or just let the cache expire)");
  console.log("  downloaded binary         →  rm $(which orca-dag)");
}
