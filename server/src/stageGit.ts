import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { OrcaTask } from "./orca";
import type { PlacementSpec } from "./config";

const exec = promisify(execFile);
export const MERGE_PREP_MARKER = "[orca-dag:merge-prep]";
export const STAGE_GIT_DIR = "orca-dag/stage-git";
const SHA = /^[0-9a-f]{40,64}$/;

export interface StageArtifact {
  taskId: string;
  dispatchId: string;
  path: string;
  branch: string;
  sha: string;
}

interface RunRecord {
  base: string;
  commonDir: string;
  artifacts: Record<string, StageArtifact>;
}

type Records = Record<string, RunRecord>;

/** Git metadata stays outside every worktree's tracked file list. */
export function stageGitStoreDir(workspace: string): string {
  const actual = realpathSync(workspace);
  const common = execFileSync("git", ["-C", workspace, "rev-parse", "--git-common-dir"], {
    encoding: "utf8", env: gitEnv(), timeout: 15_000,
  }).trim();
  const scope = createHash("sha256").update(actual).digest("hex").slice(0, 16);
  return join(isAbsolute(common) ? common : resolve(actual, common), STAGE_GIT_DIR, scope);
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) {
    delete env[name];
  }
  return env;
}

async function git(path: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", path, ...args], {
    env: gitEnv(), timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function inspect(path: string): Promise<{ path: string; sha: string; branch: string; commonDir: string }> {
  const actual = await realpath(path);
  const top = await realpath(await git(actual, "rev-parse", "--show-toplevel"));
  if (top !== actual) throw new Error(`Stage workspace ${actual} is not the Git worktree root ${top}`);
  const dirty = await git(actual, "status", "--porcelain=v1", "--untracked-files=all");
  if (dirty) throw new Error(`Stage workspace ${actual} has uncommitted changes; commit or clean it before proceeding`);
  const common = await git(actual, "rev-parse", "--git-common-dir");
  const commonDir = await realpath(isAbsolute(common) ? common : resolve(actual, common));
  return {
    path: actual,
    sha: await git(actual, "rev-parse", "HEAD"),
    branch: await git(actual, "branch", "--show-current"),
    commonDir,
  };
}

async function ancestor(path: string, sha: string): Promise<boolean> {
  try {
    await git(path, "merge-base", "--is-ancestor", sha, "HEAD");
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 1) return false;
    throw err;
  }
}

/** Per-task placement identity. A creating placement is a new workspace for that task. */
export function stageWorkspaceKey(
  taskId: string,
  laneByTask?: Record<string, string>,
  placementByTask?: Record<string, PlacementSpec>,
): string {
  const lane = laneByTask?.[taskId];
  if (lane) return `lane:${lane}`;
  const placement = placementByTask?.[taskId];
  if (!placement || placement.kind === "current") return "current";
  if (placement.kind === "existing") return `existing:${placement.selector}`;
  return `new:${taskId}`;
}

/** A marked merge Task is the only Task allowed to consume another workspace's code. */
export function validateStagePlan(
  tasks: OrcaTask[],
  laneByTask?: Record<string, string>,
  placementByTask?: Record<string, PlacementSpec>,
  resolvedWorkspaceKeys?: Record<string, string>,
): string[] {
  if (!tasks.some((task) => task.spec?.includes(MERGE_PREP_MARKER))) return [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const deps = (task: OrcaTask): string[] => {
    try {
      const raw: unknown = JSON.parse(task.deps || "[]");
      return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
    } catch { return []; }
  };
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return deps(byId.get(from)!).some((dep) => byId.has(dep) && reaches(dep, target, seen));
  };
  const issues: string[] = [];
  const key = (id: string) => resolvedWorkspaceKeys?.[id] ?? stageWorkspaceKey(id, laneByTask, placementByTask);
  for (const task of tasks) {
    const cross = deps(task).filter((dep) =>
      key(dep) !== key(task.id),
    );
    const prep = task.spec?.includes(MERGE_PREP_MARKER) ?? false;
    if (cross.length && !prep) issues.push(`${task.id} consumes another workspace without ${MERGE_PREP_MARKER}`);
    if (prep && !cross.length) issues.push(`${task.id} is a merge-prep Task but has no cross-workspace dependency`);
    if (prep && !tasks.some((next) =>
      !next.spec?.includes(MERGE_PREP_MARKER) && deps(next).includes(task.id) && key(next.id) === key(task.id))) {
      issues.push(`${task.id} is a merge-prep Task with no dependent development Task in the same worktree`);
    }
  }
  // Git's index and HEAD are shared within one worktree. A pair of unordered
  // Tasks in that workspace cannot both make an independently attributable
  // commit, even if they edit different files.
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i], b = tasks[j];
      if (key(a.id) !== key(b.id)) continue;
      if (!reaches(a.id, b.id) && !reaches(b.id, a.id)) {
        issues.push(`${a.id} and ${b.id} share a worktree but are not dependency-ordered`);
      }
    }
  }
  return issues;
}

/**
 * Local, Run-scoped Git evidence. Orca owns task settlement; this store owns
 * the immutable SHA observed at settlement, since a worktree branch may move
 * before a later join and Orca does not record Git commits.
 */
export class StageGit {
  private constructor(
    private readonly file: string,
    private readonly runId: string,
    private readonly records: Records,
  ) {}

  static async open(workspace: string, runId: string, tasks: OrcaTask[]): Promise<StageGit> {
    const dir = stageGitStoreDir(workspace);
    const file = join(dir, `${createHash("sha256").update(runId).digest("hex")}.json`);
    let records: Records = {};
    try { records = JSON.parse(await readFile(file, "utf8")) as Records; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    if (!records || typeof records !== "object" || Array.isArray(records)) {
      throw new Error(`Stage Git evidence for Run ${runId} is malformed`);
    }
    const store = new StageGit(file, runId, records);
    if (!records[runId]) {
      if (tasks.some((task) => task.status === "completed" || task.status === "dispatched")) {
        throw new Error(`Stage Git evidence for Run ${runId} is missing; cannot reconstruct historical commit tips`);
      }
      const base = await inspect(workspace);
      records[runId] = { base: base.sha, commonDir: base.commonDir, artifacts: {} };
      await mkdir(dir, { recursive: true });
      await store.save();
    } else if (!SHA.test(records[runId]?.base) || !records[runId]?.commonDir ||
               !records[runId]?.artifacts || typeof records[runId].artifacts !== "object" ||
               Array.isArray(records[runId].artifacts) ||
               Object.values(records[runId].artifacts).some((artifact) =>
                 !artifact || !SHA.test(artifact.sha) || !artifact.path || !artifact.dispatchId)) {
      throw new Error(`Stage Git evidence for Run ${runId} is malformed`);
    }
    return store;
  }

  get base(): string { return this.record.base; }
  get artifactFile(): string { return this.file; }
  artifact(taskId: string): StageArtifact | undefined { return this.record.artifacts[taskId]; }
  private get record(): RunRecord { return this.records[this.runId]; }

  private async save(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.records, null, 2) + "\n", "utf8");
    await rename(tmp, this.file);
  }

  async snapshot(taskId: string, dispatchId: string, path: string): Promise<StageArtifact> {
    const old = this.artifact(taskId);
    if (old) {
      if (old.dispatchId !== dispatchId) throw new Error(`Task ${taskId} has a different recorded Dispatch`);
      return old;
    }
    const current = await inspect(path);
    if (current.commonDir !== this.record.commonDir) throw new Error(`${path} belongs to another Git repository`);
    if (!await ancestor(current.path, this.base)) throw new Error(`${path} does not descend from Run base ${this.base}`);
    const artifact = { taskId, dispatchId, path: current.path, branch: current.branch, sha: current.sha };
    this.record.artifacts[taskId] = artifact;
    await this.save();
    return artifact;
  }

  async verifyDependencies(task: OrcaTask, path: string): Promise<void> {
    const current = await inspect(path);
    if (current.commonDir !== this.record.commonDir) throw new Error(`${path} belongs to another Git repository`);
    const ids = JSON.parse(task.deps || "[]") as string[];
    for (const id of ids) {
      const dep = this.artifact(id);
      if (!dep) throw new Error(`Dependency ${id} has no recorded committed Stage artifact`);
      if (!await ancestor(current.path, dep.sha)) {
        throw new Error(`Dependency ${id} commit ${dep.sha} is not an ancestor of ${current.path} HEAD`);
      }
    }
  }

  async verifyBase(path: string): Promise<void> {
    const current = await inspect(path);
    if (current.commonDir !== this.record.commonDir || current.sha !== this.base) {
      throw new Error(`New Stage workspace ${path} must start at Run base ${this.base}`);
    }
  }

  async verifyRepository(path: string): Promise<void> {
    const current = await inspect(path);
    if (current.commonDir !== this.record.commonDir || !await ancestor(current.path, this.base)) {
      throw new Error(`Stage workspace ${path} does not descend from Run base ${this.base}`);
    }
  }

  mergeInputs(task: OrcaTask): StageArtifact[] {
    const ids = JSON.parse(task.deps || "[]") as string[];
    return ids.map((id) => {
      const artifact = this.artifact(id);
      if (!artifact) throw new Error(`Dependency ${id} has no recorded committed Stage artifact`);
      return artifact;
    });
  }
}
