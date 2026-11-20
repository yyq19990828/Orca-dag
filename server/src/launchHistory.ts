import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareWorkspaceStateFile, workspaceStateReadPath, WORKSPACE_STATE_FILES } from "./workspaceState";

/**
 * A Dispatch's launch choice is historical execution evidence, not a mutable
 * Task preference. Orca 1.4.207 omits launch/provider details from settled
 * worker-list rows, and a legacy tracking Dispatch (notably opencode) has no
 * worker-start options at all. Keep only bounded identity & workspace fields
 * needed to label past launches; preambles, capabilities, commands, and
 * provider session IDs never go here.
 */
export const LAUNCHES_FILE = WORKSPACE_STATE_FILES.launches;

export interface LaunchRecord {
  runId: string;
  taskId: string;
  dispatchId: string;
  harness: string;
  model?: string | null;
  effort?: string | null;
  worktree?: string | null;
  worktreeName?: string | null;
  branch?: string | null;
  source: "viewer-launch" | "worker-show";
}

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_BYTES = 3 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HARNESS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const queues = new Map<string, Promise<void>>();

function validOptionalText(value: unknown, maxLength: number): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > maxLength) return false;
  return !/[\x00-\x1f\x7f]/.test(value);
}

function normalizeOptionalText(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\x00-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed;
}

function valid(value: unknown): value is LaunchRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<LaunchRecord>;
  return typeof row.runId === "string" && ID.test(row.runId) &&
    typeof row.taskId === "string" && ID.test(row.taskId) &&
    typeof row.dispatchId === "string" && ID.test(row.dispatchId) &&
    typeof row.harness === "string" && HARNESS.test(row.harness) &&
    validOptionalText(row.model, 512) &&
    validOptionalText(row.effort, 64) &&
    validOptionalText(row.worktree, 1024) &&
    validOptionalText(row.worktreeName, 256) &&
    validOptionalText(row.branch, 256) &&
    (row.source === "viewer-launch" || row.source === "worker-show");
}

function mergeRecord(previous: LaunchRecord | undefined, next: LaunchRecord): LaunchRecord {
  const normalizedNext: LaunchRecord = {
    runId: next.runId,
    taskId: next.taskId,
    dispatchId: next.dispatchId,
    harness: next.harness,
    model: normalizeOptionalText(next.model, 512),
    effort: normalizeOptionalText(next.effort, 64),
    worktree: normalizeOptionalText(next.worktree, 1024),
    worktreeName: normalizeOptionalText(next.worktreeName, 256),
    branch: normalizeOptionalText(next.branch, 256),
    source: next.source,
  };
  if (!previous) return normalizedNext;
  const authoritativeNext = previous.source !== "worker-show" || normalizedNext.source === "worker-show";
  const pick = <K extends "model" | "effort" | "worktree" | "worktreeName" | "branch">(field: K): string | null =>
    authoritativeNext
      ? (normalizedNext[field] ?? previous[field] ?? null)
      : (previous[field] ?? normalizedNext[field] ?? null);
  return {
    runId: normalizedNext.runId,
    taskId: authoritativeNext ? normalizedNext.taskId : previous.taskId,
    dispatchId: normalizedNext.dispatchId,
    harness: authoritativeNext ? normalizedNext.harness : previous.harness,
    model: pick("model"),
    effort: pick("effort"),
    worktree: pick("worktree"),
    worktreeName: pick("worktreeName"),
    branch: pick("branch"),
    source: previous.source === "worker-show" ? "worker-show" : normalizedNext.source,
  };
}

export class LaunchHistory {
  private readonly path: string;

  constructor(private readonly workspaceDir: string) {
    this.path = join(workspaceDir, LAUNCHES_FILE);
  }

  /** Append one positively identified launch. Repeated observations are safe. */
  async record(row: LaunchRecord): Promise<void> {
    if (!valid(row)) return;
    const previous = queues.get(this.path) ?? Promise.resolve();
    const write = previous.then(async () => {
      prepareWorkspaceStateFile(this.workspaceDir, LAUNCHES_FILE, true);
      await this.rotateIfNeeded();
      await appendFile(this.path, `${JSON.stringify(row)}\n`, "utf8");
    });
    queues.set(this.path, write.catch(() => {}));
    await write;
  }

  /** Last valid observation per Dispatch, scoped to exactly one Run. */
  async list(runId: string): Promise<Map<string, LaunchRecord>> {
    if (!ID.test(runId)) return new Map();
    let content: string;
    try {
      content = await readFile(workspaceStateReadPath(this.workspaceDir, LAUNCHES_FILE), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw err;
    }
    const records = new Map<string, LaunchRecord>();
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const row: unknown = JSON.parse(line);
        if (valid(row) && row.runId === runId) {
          // A runtime observation can improve a viewer launch receipt, never
          // let a weaker later append replace the exact worker-show choice.
          records.set(row.dispatchId, mergeRecord(records.get(row.dispatchId), row));
        }
      } catch {
        // A crash can tear the last JSONL line; earlier evidence survives.
      }
    }
    return new Map([...records].slice(-MAX_RECORDS));
  }

  private async rotateIfNeeded(): Promise<void> {
    let bytes: number;
    try {
      bytes = (await stat(this.path)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (bytes < MAX_BYTES) return;
    const content = await readFile(this.path);
    const from = Math.max(0, content.length - KEEP_BYTES);
    const newline = content.indexOf(0x0a, from);
    await writeFile(this.path, content.subarray(newline < 0 ? from : newline + 1));
  }
}
