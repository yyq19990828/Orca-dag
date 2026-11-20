import type { Gate, WorkerRowView } from "./types";

type Workspace = NonNullable<WorkerRowView["projection"]>["workspace"];

const RESERVED_MODES = new Set(["current", "new-child", "new-top-level", "active"]);

/** Return renderable Orca workspace identity across old and current receipts. */
export function workerWorkspaceLabel(workspace: Workspace): string | null {
  if (typeof workspace === "string") return workspace || null;
  if (workspace && typeof workspace === "object" && typeof workspace.id === "string") {
    return workspace.id || null;
  }
  return null;
}

/** Return the compact model identifier portion (after optional provider/). */
export function shortModelName(model: string | null | undefined): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf("/");
  if (idx > 0 && idx < trimmed.length - 1) return trimmed.slice(idx + 1);
  return trimmed;
}

/** Extract a concise worktree folder/name from a path or `id:repo::path` selector. */
export function shortWorktreeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || RESERVED_MODES.has(trimmed)) return null;
  const withoutPrefix = trimmed.startsWith("path:") ? trimmed.slice(5) : trimmed;
  const tail = withoutPrefix.split("::").at(-1) ?? withoutPrefix;
  const clean = tail.replace(/\/+$/, "");
  if (!clean) return null;
  return clean.split("/").filter(Boolean).at(-1) ?? clean;
}

export function resolveWorkerWorkspaceInfo(row: WorkerRowView | null | undefined): {
  name: string | null;
  branch: string | null;
  full: string | null;
} {
  if (!row) return { name: null, branch: null, full: null };
  const rawLaunchWt = row.projection?.launch?.worktree;
  const nonModeLaunchWt = rawLaunchWt && !RESERVED_MODES.has(rawLaunchWt) ? rawLaunchWt : null;
  const full =
    row.launchEvidence?.worktree ??
    workerWorkspaceLabel(row.projection?.workspace) ??
    nonModeLaunchWt ??
    row.resource?.worktreeId ??
    null;
  const name = row.launchEvidence?.worktreeName ?? shortWorktreeName(full);
  const branch = row.launchEvidence?.branch ?? null;
  return { name, branch, full };
}

function parseTimestampMs(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return null;
}

/** Format compact elapsed execution duration such as `42s`, `3m 12s`, `1h 05m`. */
export function formatElapsedDuration(
  startMsOrIso: number | string | null | undefined,
  endMsOrIso?: number | string | null | undefined,
): string | null {
  const start = parseTimestampMs(startMsOrIso);
  const end = parseTimestampMs(endMsOrIso);
  if (start === null || end === null || end < start) return null;
  const totalSeconds = Math.floor((end - start) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (totalMinutes < 60) return secs > 0 ? `${totalMinutes}m ${secs}s` : `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours}h ${String(mins).padStart(2, "0")}m` : `${hours}h`;
}

export function isGateRejected(gate: Pick<Gate, "resolution">): boolean {
  return /reject|deny|no|cancel|abort/i.test(gate.resolution ?? "");
}
