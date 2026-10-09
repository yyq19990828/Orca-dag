import { linkSync, lstatSync, mkdirSync, unlinkSync, type Stats } from "node:fs";
import { basename, join } from "node:path";

export const WORKSPACE_DATA_DIR = ".orca-dag";
export const WORKSPACE_STATE_FILES = {
  config: ".orca-dag/config.json",
  activity: ".orca-dag/activity.jsonl",
  launches: ".orca-dag/launches.jsonl",
  requests: ".orca-dag/requests.jsonl",
  sessions: ".orca-dag/sessions.json",
} as const;
export type WorkspaceStateFile = typeof WORKSPACE_STATE_FILES[keyof typeof WORKSPACE_STATE_FILES];

export function legacyWorkspaceStatePath(workspace: string, file: WorkspaceStateFile): string {
  return join(workspace, `${WORKSPACE_DATA_DIR}.${basename(file)}`);
}

function info(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Also used by uninstall: never traverse a symlink to delete external data. */
export function assertWorkspaceStateDirectory(workspace: string): void {
  const dir = join(workspace, WORKSPACE_DATA_DIR);
  const stat = info(dir);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`${dir} must be a real directory; left untouched`);
  }
}

function ensureDirectory(workspace: string): void {
  assertWorkspaceStateDirectory(workspace);
  const dir = join(workspace, WORKSPACE_DATA_DIR);
  if (!info(dir)) {
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  }
  assertWorkspaceStateDirectory(workspace);
}

export interface WorkspaceStateResult {
  path: string;
  legacyPath: string;
  status: "missing" | "present" | "migrated" | "conflict";
}

/**
 * One location contract for every store and uninstall. Reads migrate old files
 * byte-for-byte when safe; fresh reads create nothing. Writes create only the
 * shared data directory, never a timestamp planning directory.
 *
 * link + unlink is a no-clobber move within one workspace/filesystem: rename
 * would overwrite a destination created after our existence check. If both
 * versions exist, the new file wins and the old one is retained for manual
 * reconciliation — silently merging config or append-only audit trails would
 * invent history. Stop old viewer processes before upgrading: they otherwise
 * keep writing the old paths independently of this process.
 */
export function prepareWorkspaceStateFile(
  workspace: string,
  file: WorkspaceStateFile,
  forWrite = false,
): WorkspaceStateResult {
  assertWorkspaceStateDirectory(workspace);
  const path = join(workspace, file);
  const legacyPath = legacyWorkspaceStatePath(workspace, file);
  const current = info(path);
  const legacy = info(legacyPath);
  if (current) {
    if (!current.isFile() || current.isSymbolicLink()) throw new Error(`${path} must be a regular file; left untouched`);
    return { path, legacyPath, status: legacy ? "conflict" : "present" };
  }
  if (legacy) {
    if (!legacy.isFile() || legacy.isSymbolicLink()) throw new Error(`${legacyPath} must be a regular file; left untouched`);
    ensureDirectory(workspace);
    try { linkSync(legacyPath, path); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Another process created the destination. Revalidate rather than ever
      // replacing it; the source stays intact regardless of the winner.
      return prepareWorkspaceStateFile(workspace, file, forWrite);
    }
    unlinkSync(legacyPath);
    return { path, legacyPath, status: "migrated" };
  }
  if (forWrite) ensureDirectory(workspace);
  return { path, legacyPath, status: "missing" };
}

/** Keep history readable in read-only workspaces; never write the old layout. */
export function workspaceStateReadPath(workspace: string, file: WorkspaceStateFile): string {
  try { return prepareWorkspaceStateFile(workspace, file).path; }
  catch (err) {
    const legacyPath = legacyWorkspaceStatePath(workspace, file);
    const legacy = info(legacyPath);
    if (legacy?.isFile() && !legacy.isSymbolicLink()) return legacyPath;
    throw err;
  }
}

/** Best-effort startup summary; invoked only AFTER the HTTP port is acquired. */
export function initializeWorkspaceState(workspace: string): string[] {
  const report = [`Workspace state: ${WORKSPACE_DATA_DIR}/{config.json,activity.jsonl,launches.jsonl,requests.jsonl,sessions.json}.`];
  for (const file of Object.values(WORKSPACE_STATE_FILES)) {
    try {
      const result = prepareWorkspaceStateFile(workspace, file);
      if (result.status === "migrated") report.push(`Moved workspace state: ${result.legacyPath} → ${result.path}.`);
      else if (result.status === "conflict") {
        report.push(`WARNING: both ${result.path} and ${result.legacyPath} exist; using the new location and retaining the legacy file. Reconcile manually after stopping old viewers.`);
      }
    } catch (err) {
      report.push(`WARNING: workspace state ${file}: ${String((err as Error).message ?? err)}.`);
    }
  }
  return report;
}
