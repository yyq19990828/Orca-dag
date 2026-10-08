import { closeSync, constants, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PLANNING_DIR = ".orca";
const BEGIN = "# >>> orca-dag planning artifacts (managed)";
const END = "# <<< orca-dag planning artifacts (managed)";
const RULE = `${PLANNING_DIR}/`;

export interface PlanningSetupResult {
  status: "added" | "present" | "disabled" | "skipped";
  path: string;
  reason?: string;
}

/** Never follow a user's symlinked .gitignore, including a dangling link. */
function readIgnore(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(".gitignore is not a regular file; left untouched");
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return readFileSync(fd, "utf8"); }
    finally { closeSync(fd); }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function writeIgnore(path: string, text: string): void {
  // O_NOFOLLOW also protects the write if the file becomes a symlink after the
  // read. Preserve the existing file's permissions; don't replace it by rename.
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW);
  try { writeFileSync(fd, text); }
  finally { closeSync(fd); }
}

/**
 * Startup initializes the workspace's ignore rule, not a planning session.
 * The skill creates a timestamp directory only when a requirement is planned,
 * so merely reopening the viewer doesn't leave empty plan directories behind.
 * A marked block makes uninstall reversible without claiming user-owned rules.
 */
export function setupPlanningWorkspace(workspace: string, enabled = true): PlanningSetupResult {
  const path = join(workspace, ".gitignore");
  if (!enabled) return { status: "disabled", path };
  try {
    const text = readIgnore(path) ?? "";
    const lines = text.split(/\r?\n/);
    const rules = new Set([RULE, `/${RULE}`, PLANNING_DIR, `/${PLANNING_DIR}`, `${RULE}**`, `/${RULE}**`]);
    let lastRule = -1;
    lines.forEach((line, i) => { if (rules.has(line.trimEnd())) lastRule = i; });
    // A later negation might expose the documents again. In that case append
    // our default at the end, leaving the original rules intact for uninstall.
    if (lastRule >= 0 && !lines.slice(lastRule + 1).some((line) => line.startsWith("!"))) {
      return { status: "present", path };
    }
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const separator = text && !text.endsWith("\n") ? eol : "";
    writeIgnore(path, `${text}${separator}${BEGIN}${eol}${RULE}${eol}${END}${eol}`);
    return { status: "added", path };
  } catch (err) {
    // Like skill installation, a read-only workspace must not prevent viewing
    // a DAG. The startup report makes the missing ignore protection explicit.
    return { status: "skipped", path, reason: String((err as Error).message ?? err) };
  }
}

export function describePlanningSetup(result: PlanningSetupResult): string {
  const location = `Planning docs: ${PLANNING_DIR}/<UTC timestamp>/{PRD.md,TECH_SPEC.md} (one directory per plan).`;
  if (result.status === "added") return `${location} Added ${RULE} to ${result.path} (managed; uninstall removes it).`;
  if (result.status === "present") return `${location} ${RULE} is already listed in ${result.path}.`;
  if (result.status === "disabled") return `${location} Workspace initialization disabled; add ${RULE} to .gitignore yourself.`;
  return `${location} WARNING: could not initialize ${result.path}: ${result.reason}. Add ${RULE} manually before planning.`;
}

export interface PlanningIgnoreRemoval {
  path: string;
  removed: number;
  reason?: string;
}

/** Remove only exact blocks we wrote; edited blocks and user rules stay intact. */
export function removePlanningIgnore(workspace: string, dryRun: boolean): PlanningIgnoreRemoval {
  const path = join(workspace, ".gitignore");
  try {
    const text = readIgnore(path);
    if (text === null) return { path, removed: 0 };
    // Keep line endings and all unrelated bytes, including mixed LF/CRLF files.
    const lines = text.split(/(?<=\n)/);
    const value = (line: string | undefined) => line?.replace(/\r?\n$/, "");
    const kept: string[] = [];
    let removed = 0;
    for (let i = 0; i < lines.length; i++) {
      if (value(lines[i]) === BEGIN && value(lines[i + 1]) === RULE && value(lines[i + 2]) === END) {
        removed++;
        i += 2;
      } else {
        kept.push(lines[i]);
      }
    }
    if (removed && !dryRun) writeIgnore(path, kept.join(""));
    return { path, removed };
  } catch (err) {
    return { path, removed: 0, reason: String((err as Error).message ?? err) };
  }
}
