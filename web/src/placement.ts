/**
 * Shared placement + lane grammar for the UI (Phase 7).
 *
 * One module owns the client-side half of the placement contract so the
 * editor, the Run preflight, and the lanes panel can never drift apart.
 * Every bound here MIRRORS server/src/config.ts (the charset grammar lives
 * next to the stored shape on the server); the server re-validates everything
 * at the HTTP boundary and again as the last gate before Orca runs — these
 * checks exist so the UI can explain a refusal before it happens, not so it
 * can become a second authority.
 */

import type { DagEdge, LaneSeedPlacement, PlacementSpec, WorktreeLaneSpec } from "./types";

/** Explicit worktree names (`--name`): a short single token, not a path. */
export const PLACEMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Base branch/ref: git ref path, no leading dash / `..` / trailing `/` or `.`. */
export const BASE_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** Bounds for the free-text creation fields (`--display-name`, `--comment`). */
export const DISPLAY_NAME_MAX = 120;
export const COMMENT_MAX = 500;

/** Narrowing guard: true for the two worktree-creating kinds. */
export function isCreationKind(
  p: PlacementSpec,
): p is Extract<PlacementSpec, { kind: "new-child" | "new-top-level" }> {
  return p.kind === "new-child" || p.kind === "new-top-level";
}

/** Human one-liner for a placement (node panel summaries, lane labels). */
export function placementLabel(p: PlacementSpec | null): string {
  if (!p) return "Current workspace";
  switch (p.kind) {
    case "current":
      return "Current workspace";
    case "existing":
      return `Existing workspace (${p.selector})`;
    case "new-child":
      return `New child worktree${p.name ? ` “${p.name}”` : " (derived name)"}`;
    case "new-top-level":
      return `New top-level worktree in ${p.repo}${p.name ? ` · “${p.name}”` : ""}`;
  }
}

/** Short mode label without the payload (mode pickers, badges). */
export function placementKindLabel(kind: PlacementSpec["kind"]): string {
  switch (kind) {
    case "current":
      return "Current";
    case "existing":
      return "Existing";
    case "new-child":
      return "New child";
    case "new-top-level":
      return "New top-level";
  }
}

/**
 * Field-level problems with a creation spec's free-text fields — the same
 * shapes the server sanitizer would strip. An empty array means every field
 * is within bounds; problems are shown as hints, and the fields stay
 * editable (stripping-as-you-type would fight the keyboard).
 */
export function creationFieldProblems(p: PlacementSpec): string[] {
  if (!isCreationKind(p)) return [];
  const problems: string[] = [];
  if (p.name !== undefined && !PLACEMENT_NAME_PATTERN.test(p.name)) {
    problems.push("Name must be a short token: letters/digits, then . _ - allowed (max 64).");
  }
  if (p.baseBranch !== undefined) {
    const b = p.baseBranch;
    if (!BASE_BRANCH_PATTERN.test(b) || b.includes("..") || b.endsWith("/") || b.endsWith(".")) {
      problems.push("Base branch must look like a git ref (no leading dash, “..”, or trailing “/”/“.”).");
    }
  }
  if (p.displayName !== undefined && p.displayName.length > DISPLAY_NAME_MAX) {
    problems.push(`Display name is limited to ${DISPLAY_NAME_MAX} characters.`);
  }
  if (p.comment !== undefined && p.comment.length > COMMENT_MAX) {
    problems.push(`Comment is limited to ${COMMENT_MAX} characters.`);
  }
  return problems;
}

/**
 * Coerce a free-text creation field into its bounded stored form, or drop it.
 * Used on every keystroke commit so the config store only ever holds shapes
 * the server would persist.
 */
export function boundedText(value: string, maxLen: number): string | undefined {
  const t = value.trim();
  if (!t || t.length > maxLen) return undefined;
  // eslint-disable-next-line no-control-regex — exactly what we are screening for
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(t)) return undefined;
  return t;
}

/**
 * Client-side preflight for the lane plan, run before the Run button mutates
 * anything (PRD: "the viewer validates the whole DAG and placement plan
 * before mutation" — the server is the authority, this is the fast honest
 * feedback).
 *
 * Rules enforced here, mirroring the server's lane validation:
 *  - every lane seed exists (a member pointing at a deleted lane is a bug);
 *  - tasks in one lane are totally ordered by dependency reachability —
 *    unordered tasks cannot share a lane because a lane is a serial queue;
 *  - a task never carries both a lane membership and a direct placement /
 *    saved-environment entry (the store clears the others, so finding both
 *    means stale config from an older viewer).
 */
export function lanePlanProblems(
  laneByTask: Record<string, string>,
  worktreeLanes: Record<string, WorktreeLaneSpec>,
  placementByTask: Record<string, PlacementSpec>,
  environmentByTask: Record<string, string>,
  edges: DagEdge[],
): string[] {
  const problems: string[] = [];
  const members = new Map<string, string[]>();
  for (const [taskId, laneId] of Object.entries(laneByTask)) {
    if (!laneId) continue;
    if (!worktreeLanes[laneId]) {
      problems.push(`Task ${taskId} references lane ${laneId}, which no longer exists.`);
      continue;
    }
    if (placementByTask[taskId]) {
      problems.push(`Task ${taskId} is in lane ${laneId} and also carries a direct placement — remove one.`);
    }
    if (environmentByTask[taskId]) {
      problems.push(`Task ${taskId} is in a local lane and also pinned to a saved environment — remove one.`);
    }
    const list = members.get(laneId) ?? [];
    list.push(taskId);
    members.set(laneId, list);
  }

  // Reachability closure over the dependency edges (small graphs; the direct
  // adjacency plus a transitive walk per member pair is plenty).
  const reachable = new Map<string, Set<string>>();
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source) ?? [];
    list.push(e.target);
    adj.set(e.source, list);
  }
  function canReach(from: string, to: string): boolean {
    const cached = reachable.get(from);
    if (cached) return cached.has(to);
    const seen = new Set<string>([from]);
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const next of adj.get(cur) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    reachable.set(from, seen);
    return seen.has(to);
  }

  for (const [laneId, taskIds] of members) {
    for (let i = 0; i < taskIds.length; i++) {
      for (let j = i + 1; j < taskIds.length; j++) {
        const a = taskIds[i];
        const b = taskIds[j];
        const aBeforeB = canReach(a, b);
        const bBeforeA = canReach(b, a);
        if (!aBeforeB && !bBeforeA) {
          problems.push(
            `Lane ${laneId}: ${a} and ${b} share a workspace but no dependency orders them — ` +
              `add a dependency between them or move one out of the lane.`,
          );
        } else if (aBeforeB && bBeforeA) {
          problems.push(`Lane ${laneId}: ${a} and ${b} depend on each other in a cycle.`);
        }
      }
    }
  }
  return problems;
}

/** The lane seed of `spec`, summarized for pickers and chips. */
export function laneLabel(spec: WorktreeLaneSpec): string {
  return placementLabel(spec.placement as PlacementSpec);
}

/** True when a lane seed may legally be re-used for a task chain (never `current`). */
export function isLaneSeed(p: LaneSeedPlacement | PlacementSpec): p is LaneSeedPlacement {
  return p.kind !== "current";
}
