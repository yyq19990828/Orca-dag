import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Viewer-side configuration (per-node harness, default harness, concurrency,
 * layout) persisted next to the workspace as `.orca-dag.config.json`.
 *
 * Orca itself has no metadata field on tasks (task-create only takes
 * spec/title/display-name/deps/parent), so this file is the viewer's own
 * store — it survives browser restarts and localStorage wipes, and travels
 * with the project directory.
 */
export interface ViewerConfig {
  defaultHarness?: string;
  harnessByTask?: Record<string, string>;
  /** Per-task model override. Only set for tasks whose harness supports one;
   * otherwise the agent's default model is used. */
  modelByTask?: Record<string, string>;
  /**
   * Per-task reasoning effort (Phase 5). Only meaningful when the same task
   * has a model AND the harness supports effort (`worker-start --effort`
   * requires `--model`); the coordinator drops it otherwise.
   */
  effortByTask?: Record<string, string>;
  /**
   * Per-task saved-environment selector (Phase 6): which connected Orca server
   * executes this node's worker. Absent/empty = the LOCAL server — placement
   * stays zero-configuration unless the user opts a node into a remote host.
   * Only a selector discovered through `orca environment list` belongs here;
   * the viewer never invents one (no synthetic local fallback).
   */
  environmentByTask?: Record<string, string>;
  /**
   * Per-task exact placement. Absent = `current` — the coordinator's
   * workspace, exactly as every pre-Phase-6 run behaved. The full local
   * matrix is expressible here: `current`, an exact existing workspace
   * selector (as discovered through Orca — `id:<repoId>::<path>` for a git
   * worktree, `path:<dir>` for a registered folder workspace), `new-child`
   * (a stacked worktree Orca creates), and `new-top-level` (an independent
   * worktree created from an exact repo selector). The remote-restricted
   * shapes are enforced at the VALIDATION layer, not by omitting kinds from
   * this type: `current` and `new-child` never combine with a saved
   * environment, and `assertEnvironmentPlacementCompatibility` (security.ts)
   * plus the adapter's last gate re-check the raw strings before Orca runs.
   */
  placementByTask?: Record<string, PlacementSpec>;
  /**
   * Durable workspace lanes (worktree-lanes epic): a lane is ONE workspace
   * shared by a dependency-ordered task chain. The lane's `placement` is its
   * seed — exact existing, `new-child`, or `new-top-level` — and never
   * `current` (a lane that stays on the coordinator workspace is not a lane,
   * it is the default). Runtime worktree ids, paths, and terminal handles
   * NEVER live here: lanes are launch intent, and positive Orca receipts are
   * the only source of the exact selector a later lane task reuses.
   */
  worktreeLanes?: Record<string, WorktreeLaneSpec>;
  /**
   * Task → lane membership (`laneByTask[taskId] = laneId`). A task in a lane
   * takes its placement from `worktreeLanes[laneId]` — it must therefore not
   * ALSO carry a direct `placementByTask` entry (`assertLanePlacementDisjoint`
   * in security.ts refuses the combination; ambiguity across the two maps
   * would make "where does this worker run" unanswerable).
   */
  laneByTask?: Record<string, string>;
  maxConcurrency?: number;
  layout?: string;
  /** Last Run the user was looking at — tasks are Run-scoped since Orca 1.4.160. */
  runId?: string;
  /**
   * Explicit semantic lead stage for each Run. This is viewer-only metadata:
   * it highlights the Task that represents the main-agent phase, but it does
   * not grant coordinator authority or change the DAG. Never infer this role
   * from graph order or creator handles — those describe different concepts.
   */
  leadTaskByRun?: Record<string, string>;
  /** Per-task opt-out from automatic release (plan §7.3); absence = release. */
  retainByTask?: Record<string, boolean>;
}

const FILE_NAME = ".orca-dag.config.json";

// --- Placement grammar (shared with security.ts / the adapter) --------------
//
// The charset rules for creation metadata live HERE, next to the stored shape
// they describe; security.ts imports them for strict HTTP validation and
// config sanitization reuses them for tolerant loading. One grammar, two
// enforcement postures — they cannot drift apart.

/**
 * Setup policy for Orca repo-defined setup hooks on NEW worktrees
 * (`worker-start --setup <run|skip|inherit>`). "run" is Orca's own default;
 * "skip" and "inherit" are explicit advanced choices. Current/existing
 * worktrees never rerun setup — the policy is a creation-only field.
 */
export type SetupPolicy = "run" | "skip" | "inherit";

export const SETUP_POLICIES: ReadonlySet<string> = new Set<SetupPolicy>([
  "run",
  "skip",
  "inherit",
]);

/** Explicit worktree names (`--name`): a short single token, not a path. */
export const PLACEMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Base branch/ref (`--base-branch`): a git ref path — slashes allowed
 * (`feature/x`), but no leading dash (argv-flag ambiguity), no `..` (ref
 * ambiguity), and no whitespace, quotes, or control characters. The pattern
 * is the charset half; `..` and trailing `/`/`.` are refused by the callers
 * alongside it.
 */
export const BASE_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** Bounds for the free-text creation fields (`--display-name`, `--comment`). */
export const DISPLAY_NAME_MAX = 120;
export const COMMENT_MAX = 500;

/**
 * Creation-only fields, legal ONLY on the two new-worktree placements.
 * Orca's `worker-start` rejects every one of these flags for current/existing
 * worktrees, and this viewer refuses them earlier and louder (security.ts at
 * the HTTP boundary, `assertValidWorkerStart` as the last gate).
 */
export interface CreationOptions {
  /**
   * Explicit worktree name (`--name`). Optional: when absent, the server
   * derives a deterministic bounded name from the Run and Task/lane ids
   * before calling Orca (`deriveWorktreeName` in orca.ts). A saved
   * environment (remote new-top-level) still requires an explicit name —
   * that rule lives in the validators, not in this type.
   */
  name?: string;
  /**
   * Setup-hook policy for the new worktree. Sanitization normalizes an
   * absent/invalid policy to Orca's default `"run"`, so every in-memory
   * creation spec carries an explicit policy and consumers never
   * re-implement the default.
   */
  setup: SetupPolicy;
  /** Base branch/ref to create the worktree from. */
  baseBranch?: string;
  /** Orca display-name override for the new worktree. */
  displayName?: string;
  /** Comment stored in Orca worktree metadata. */
  comment?: string;
}

/**
 * One exact placement choice (`placementByTask`). Stored verbatim after
 * sanitization: `existing.selector` is whatever full selector Orca's own
 * discovery returned — the viewer never reconstructs or "conveniently"
 * shortens it, because a bare repo id is NOT a worktree id. Creation specs
 * are rebuilt field-by-field so unknown kinds and malformed metadata are
 * DROPPED, never guessed into a shape that could create a worktree.
 */
export type PlacementSpec =
  | { kind: "current" }
  | { kind: "existing"; selector: string }
  | (CreationOptions & { kind: "new-child" })
  | (CreationOptions & { kind: "new-top-level"; repo: string });

/** A lane's seed placement — every non-current kind (`current` is no lane). */
export type LaneSeedPlacement = Exclude<PlacementSpec, { kind: "current" }>;

/** One workspace lane: the seed placement its task chain shares. */
export interface WorktreeLaneSpec {
  placement: LaneSeedPlacement;
}

/**
 * Tolerant free-text creation field: keeps bounded, control-char-free strings,
 * strips anything else (field-level tolerance — a bad comment must not erase
 * an otherwise valid placement).
 */
function sanitizeBoundedText(
  v: unknown,
  maxLen: number,
): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t || t.length > maxLen) return undefined;
  // eslint-disable-next-line no-control-regex — exactly what we are screening for
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(t)) return undefined;
  return t;
}

/**
 * Tolerant parse of the creation-only fields on a new-worktree placement.
 * Field-level tolerance with one normalization: an absent or unrecognized
 * `setup` becomes Orca's default `"run"`, so every in-memory creation spec
 * carries an explicit policy (see `CreationOptions.setup`). `name`,
 * `baseBranch`, `displayName`, and `comment` that fail their bounds are
 * STRIPPED rather than persisted — a stripped name falls back to the
 * deterministic derivation, which is always bounded.
 */
function sanitizeCreationOptions(r: Record<string, unknown>): CreationOptions {
  const out: CreationOptions = {
    setup: typeof r.setup === "string" && SETUP_POLICIES.has(r.setup) ? (r.setup as SetupPolicy) : "run",
  };
  if (typeof r.name === "string" && PLACEMENT_NAME_PATTERN.test(r.name.trim())) {
    out.name = r.name.trim();
  }
  if (typeof r.baseBranch === "string") {
    const branch = r.baseBranch.trim();
    if (BASE_BRANCH_PATTERN.test(branch) && !branch.includes("..") && !branch.endsWith("/") && !branch.endsWith(".")) {
      out.baseBranch = branch;
    }
  }
  const displayName = sanitizeBoundedText(r.displayName, DISPLAY_NAME_MAX);
  if (displayName !== undefined) out.displayName = displayName;
  const comment = sanitizeBoundedText(r.comment, COMMENT_MAX);
  if (comment !== undefined) out.comment = comment;
  return out;
}

/**
 * Tolerant parse of one stored placement entry; null = drop (malformed).
 *
 * Field-level tolerance for CREATION fields (strip the field, keep the
 * placement), entry-level tolerance for STRUCTURE (an unparsable kind,
 * selector, or repo is dropped so the task degrades to the local/current
 * default — never to a guessed creation shape). Creation fields found on a
 * current/existing placement are stripped: they are meaningless there (Orca
 * refuses the flags), and keeping the entry preserves the SAFE part of the
 * intent — an exact workspace selector — instead of silently reverting the
 * task to the coordinator workspace.
 */
export function sanitizePlacementSpec(v: unknown): PlacementSpec | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const kind = typeof r.kind === "string" ? r.kind : null;
  if (kind === "current") return { kind: "current" };
  if (kind === "existing" && typeof r.selector === "string" && r.selector.trim()) {
    return { kind: "existing", selector: r.selector.trim() };
  }
  if (kind === "new-child") {
    // A child anchors on the current workspace's repo — a `repo` selection is
    // a conflicting field and is never even read here, let alone persisted.
    const creation = sanitizeCreationOptions(r);
    return { kind: "new-child", ...creation };
  }
  if (
    kind === "new-top-level" &&
    typeof r.repo === "string" &&
    r.repo.trim()
  ) {
    const creation = sanitizeCreationOptions(r);
    return { kind: "new-top-level", repo: r.repo.trim(), ...creation };
  }
  return null;
}

/**
 * Tolerant parse of one stored lane entry; null = drop (malformed). A lane
 * seeded by `current` is dropped: lanes exist to place a task chain on ONE
 * shared non-current workspace, and a "current lane" would silently recreate
 * the serial-vs-parallel ambiguity lanes are defined to avoid.
 */
export function sanitizeWorktreeLaneSpec(v: unknown): WorktreeLaneSpec | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const placement = sanitizePlacementSpec(r.placement);
  if (!placement || placement.kind === "current") return null;
  return { placement };
}

function configPath(workspaceDir: string): string {
  return join(workspaceDir, FILE_NAME);
}

/** Read the stored config; any failure (missing file, bad JSON) means "empty". */
export async function loadConfig(workspaceDir: string): Promise<ViewerConfig> {
  try {
    const raw = JSON.parse(await readFile(configPath(workspaceDir), "utf8")) as unknown;
    return sanitize(raw);
  } catch {
    return {};
  }
}

/** Merge a patch into the stored config and write it back (tmp + rename). */
export async function saveConfig(workspaceDir: string, patch: unknown): Promise<ViewerConfig> {
  const next = { ...(await loadConfig(workspaceDir)), ...sanitize(patch) };
  const file = configPath(workspaceDir);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  await rename(tmp, file);
  return next;
}

/**
 * Keep only known, well-typed keys so a hand-edited or malicious file can't poison us.
 *
 * Phase 4 invariant: this file persists VIEWER PREFERENCES ONLY — harness,
 * model, concurrency, layout, last Run, retain flags. It must NEVER hold
 * transient authority state: coordinator terminal handles, mutation tokens,
 * Dispatch ids, retry-request ids, or capability grants. Those live and die
 * with the coordinator process (Orca owns the durable side of them). The
 * sanitizer's allowlist is the enforcement — unknown keys (including anything
 * credential-shaped a future contributor might add) are dropped here.
 */
function sanitize(raw: unknown): ViewerConfig {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: ViewerConfig = {};
  if (typeof r.defaultHarness === "string" && r.defaultHarness.trim()) {
    out.defaultHarness = r.defaultHarness.trim();
  }
  if (r.harnessByTask && typeof r.harnessByTask === "object" && !Array.isArray(r.harnessByTask)) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.harnessByTask as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) map[k] = v.trim();
    }
    out.harnessByTask = map;
  }
  if (r.modelByTask && typeof r.modelByTask === "object" && !Array.isArray(r.modelByTask)) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.modelByTask as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) map[k] = v.trim();
    }
    out.modelByTask = map;
  }
  // Phase 5: same shape as modelByTask. A file from before this phase simply
  // lacks the key — loadConfig returns the rest untouched (backward-compatible
  // hydration is an explicit acceptance criterion).
  if (r.effortByTask && typeof r.effortByTask === "object" && !Array.isArray(r.effortByTask)) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.effortByTask as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) map[k] = v.trim();
    }
    out.effortByTask = map;
  }
  // Phase 6: saved-environment selectors (string map, modelByTask rules).
  if (
    r.environmentByTask &&
    typeof r.environmentByTask === "object" &&
    !Array.isArray(r.environmentByTask)
  ) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.environmentByTask as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) map[k] = v.trim();
    }
    out.environmentByTask = map;
  }
  // Exact placement specs. Each entry is rebuilt field-by-field (not
  // spread) so an unknown `kind` or a missing selector/repo is DROPPED
  // rather than persisted — an unparsable placement must degrade to the
  // local/current default, never to a guessed creation shape.
  if (
    r.placementByTask &&
    typeof r.placementByTask === "object" &&
    !Array.isArray(r.placementByTask)
  ) {
    const map: Record<string, PlacementSpec> = {};
    for (const [k, v] of Object.entries(r.placementByTask as Record<string, unknown>)) {
      const spec = sanitizePlacementSpec(v);
      if (spec) map[k] = spec;
    }
    out.placementByTask = map;
  }
  // Worktree lanes: lane id → seed placement (never `current`). Same
  // rebuild-field-by-field discipline — a malformed lane must not survive as
  // a half-understood shape that a coordinator could try to create.
  if (
    r.worktreeLanes &&
    typeof r.worktreeLanes === "object" &&
    !Array.isArray(r.worktreeLanes)
  ) {
    const map: Record<string, WorktreeLaneSpec> = {};
    for (const [laneId, v] of Object.entries(r.worktreeLanes as Record<string, unknown>)) {
      const lane = sanitizeWorktreeLaneSpec(v);
      if (lane && laneId.trim()) map[laneId.trim()] = lane;
    }
    out.worktreeLanes = map;
  }
  // Task → lane membership. Trimmed non-empty strings on both sides, same
  // rules as leadTaskByRun; whether a task's placement map and lane map
  // CONFLICT is a validation concern (assertLanePlacementDisjoint in
  // security.ts), not a storage concern — the loader keeps well-typed data.
  if (r.laneByTask && typeof r.laneByTask === "object" && !Array.isArray(r.laneByTask)) {
    const map: Record<string, string> = {};
    for (const [taskId, laneId] of Object.entries(r.laneByTask as Record<string, unknown>)) {
      if (taskId.trim() && typeof laneId === "string" && laneId.trim()) {
        map[taskId.trim()] = laneId.trim();
      }
    }
    out.laneByTask = map;
  }
  if (typeof r.maxConcurrency === "number" && Number.isFinite(r.maxConcurrency)) {
    out.maxConcurrency = Math.max(1, Math.min(16, Math.round(r.maxConcurrency)));
  }
  if (r.retainByTask && typeof r.retainByTask === "object" && !Array.isArray(r.retainByTask)) {
    const map: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(r.retainByTask as Record<string, unknown>)) {
      if (typeof v === "boolean") map[k] = v;
    }
    out.retainByTask = map;
  }
  if (typeof r.layout === "string" && r.layout.trim()) {
    out.layout = r.layout.trim();
  }
  if (typeof r.runId === "string" && r.runId.trim()) {
    out.runId = r.runId.trim();
  }
  // Lead-stage metadata is a Run -> Task map rather than the Task -> value
  // maps above. Rebuild it field-by-field for the same reason: config files
  // are hand-editable and old/new viewer versions share them, so malformed
  // entries are ignored without making the rest of the config unreadable.
  // Missing remains missing (and therefore means "no lead stages") so merely
  // loading an older file never invents a migration rewrite.
  if (
    r.leadTaskByRun &&
    typeof r.leadTaskByRun === "object" &&
    !Array.isArray(r.leadTaskByRun)
  ) {
    const map: Record<string, string> = {};
    for (const [runId, taskId] of Object.entries(r.leadTaskByRun as Record<string, unknown>)) {
      if (runId.trim() && typeof taskId === "string" && taskId.trim()) {
        map[runId.trim()] = taskId.trim();
      }
    }
    out.leadTaskByRun = map;
  }
  return out;
}
