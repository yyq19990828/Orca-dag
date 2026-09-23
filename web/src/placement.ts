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
 *
 * Every user-visible string here goes through the shared translator with the
 * plain (non-reactive) `t()`: this module is not a React component, and every
 * caller is one that already subscribes to the language store via `useT()`,
 * so a language switch re-renders the caller and re-runs these builders. The
 * "kind · payload" shapes are structural — only the words are translated,
 * and selectors/names/repos are echoed exactly as discovered.
 */

import { t, type TranslationKey } from "./i18n";
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
  if (!p) return t("placement.label.current");
  switch (p.kind) {
    case "current":
      return t("placement.label.current");
    case "existing":
      return t("placement.label.existing", { selector: p.selector });
    case "new-child":
      return p.name
        ? t("placement.label.newChildNamed", { name: p.name })
        : t("placement.label.newChildDerived");
    case "new-top-level":
      // The named variant is one template, not a suffix splice: languages may
      // order the repo and the name differently.
      return p.name
        ? t("placement.label.newTopLevelNamed", { repo: p.repo, name: p.name })
        : t("placement.label.newTopLevel", { repo: p.repo });
  }
}

/** kind -> key, explicit so a new kind fails tsc instead of falling through. */
const PLACEMENT_KIND_KEY: Record<PlacementSpec["kind"], TranslationKey> = {
  current: "placement.kind.current",
  existing: "placement.kind.existing",
  "new-child": "placement.kind.newChild",
  "new-top-level": "placement.kind.newTopLevel",
};

/** Short mode label without the payload (mode pickers, badges). */
export function placementKindLabel(kind: PlacementSpec["kind"]): string {
  return t(PLACEMENT_KIND_KEY[kind]);
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
    problems.push(t("placementProblem.name"));
  }
  if (p.baseBranch !== undefined) {
    const b = p.baseBranch;
    if (!BASE_BRANCH_PATTERN.test(b) || b.includes("..") || b.endsWith("/") || b.endsWith(".")) {
      problems.push(t("placementProblem.baseBranch"));
    }
  }
  if (p.displayName !== undefined && p.displayName.length > DISPLAY_NAME_MAX) {
    problems.push(t("placementProblem.displayName", { n: DISPLAY_NAME_MAX }));
  }
  if (p.comment !== undefined && p.comment.length > COMMENT_MAX) {
    problems.push(t("placementProblem.comment", { n: COMMENT_MAX }));
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
      problems.push(t("laneProblem.missing", { task: taskId, lane: laneId }));
      continue;
    }
    if (placementByTask[taskId]) {
      problems.push(t("laneProblem.directPlacement", { task: taskId, lane: laneId }));
    }
    if (environmentByTask[taskId]) {
      problems.push(t("laneProblem.environment", { task: taskId }));
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
          problems.push(t("laneProblem.unordered", { lane: laneId, a, b }));
        } else if (aBeforeB && bBeforeA) {
          problems.push(t("laneProblem.cycle", { lane: laneId, a, b }));
        }
      }
    }
  }
  return problems;
}

/**
 * The prefix every lane-scoped problem starts with ("Lane <id>:"). Callers
 * that show only ONE lane's problems filter the preflight list by it — going
 * through this helper keeps the filter correct in every language.
 */
export function laneProblemPrefix(laneId: string): string {
  return t("laneProblem.lanePrefix", { lane: laneId });
}

/** The lane seed of `spec`, summarized for pickers and chips. */
export function laneLabel(spec: WorktreeLaneSpec): string {
  return placementLabel(spec.placement as PlacementSpec);
}

/** True when a lane seed may legally be re-used for a task chain (never `current`). */
export function isLaneSeed(p: LaneSeedPlacement | PlacementSpec): p is LaneSeedPlacement {
  return p.kind !== "current";
}
