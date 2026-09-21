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
   * Per-task exact placement (Phase 6). Absent = `current` — the coordinator's
   * workspace, exactly as every pre-Phase-6 run behaved. The remote-safe forms
   * are deliberately the ONLY two shapes that can be stored: an exact existing
   * workspace selector (as discovered on the target environment) or a
   * new-top-level worktree with an exact repo selector plus an explicit name.
   * Remote `current` and `new-child` are not expressible at this type level —
   * ambiguity across servers must be impossible to persist, and the adapter
   * re-checks the raw strings as the last gate before Orca is invoked.
   */
  placementByTask?: Record<string, PlacementSpec>;
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

/**
 * One exact placement choice (plan §7.3 `placementByTask`). Stored verbatim
 * after sanitization: `existing.selector` is whatever full selector Orca's own
 * discovery returned (`id:<repoId>::<path>` for a git worktree, `path:<dir>`
 * for a registered folder workspace) — the viewer never reconstructs or
 * "conveniently" shortens it, because a bare repo id is NOT a worktree id.
 */
export type PlacementSpec =
  | { kind: "current" }
  | { kind: "existing"; selector: string }
  | { kind: "new-top-level"; repo: string; name: string };

/** Tolerant parse of one stored placement entry; null = drop (malformed). */
export function sanitizePlacementSpec(v: unknown): PlacementSpec | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const kind = typeof r.kind === "string" ? r.kind : null;
  if (kind === "current") return { kind: "current" };
  if (kind === "existing" && typeof r.selector === "string" && r.selector.trim()) {
    return { kind: "existing", selector: r.selector.trim() };
  }
  if (
    kind === "new-top-level" &&
    typeof r.repo === "string" &&
    r.repo.trim() &&
    typeof r.name === "string" &&
    r.name.trim()
  ) {
    return { kind: "new-top-level", repo: r.repo.trim(), name: r.name.trim() };
  }
  return null;
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
  // Phase 6: exact placement specs. Each entry is rebuilt field-by-field (not
  // spread) so an unknown `kind` or a missing selector/repo/name is DROPPED
  // rather than persisted — an unparsable placement must degrade to the
  // local/current default, never to a guessed remote shape.
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
