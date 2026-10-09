// Viewer configuration store: per-node harness, default harness, concurrency
// cap, and layout choice. Persisted server-side in `.orca-dag/config.json`
// (workspace root) via /api/config — Orca's task has no harness/metadata
// field, and browser localStorage was lost on browser/profile changes.
// Legacy localStorage keys are read once as a migration source and mirrored
// on every write (harmless fallback when running against an older backend).

import { useSyncExternalStore } from "react";
import { fetchConfig, fetchReadiness, initSession, saveConfig } from "./api";
import {
  BASE_BRANCH_PATTERN,
  COMMENT_MAX,
  DISPLAY_NAME_MAX,
  PLACEMENT_NAME_PATTERN,
  boundedText,
} from "./placement";
import type {
  CreationOptions,
  LayoutKind,
  OrcaReadiness,
  PlacementSpec,
  SetupPolicy,
  ViewerConfig,
  WorktreeLaneSpec,
} from "./types";
import { SETUP_POLICIES } from "./types";

const NODE_PREFIX = "orca-dag:harness:";
const MODEL_PREFIX = "orca-dag:model:";
const DEFAULT_KEY = "orca-dag:default-harness";
const LAYOUT_KEY = "orca-dag:layout";
const RUN_KEY = "orca-dag:run-id";

const DEFAULTS: ViewerConfig = {
  defaultHarness: "claude",
  harnessByTask: {},
  modelByTask: {},
  effortByTask: {},
  retainByTask: {},
  environmentByTask: {},
  placementByTask: {},
  worktreeLanes: {},
  laneByTask: {},
  leadTaskByRun: {},
  maxConcurrency: 4,
  layout: "",
  runId: "",
};

let config: ViewerConfig = { ...DEFAULTS };
const listeners = new Set<() => void>();
let configRefreshTimer: number | null = null;

// Server-side policy flags, from GET /api/session (see api.ts). Not config —
// the server owns them — but the UI needs them reactively, and this store is
// the natural place to expose them alongside the harness choices they gate.
let flags = { customCommandsAllowed: false };

// Readiness probe (GET /api/readiness): null until the first fetch resolves.
// Like the flags, this is server-owned state the UI only renders; execution
// controls across the app (Run button, gate resolutions) disable themselves
// off `executionEnabled` so an old runtime reads as view-only
// instead of failing confusingly mid-DAG.
let readiness: OrcaReadiness | null = null;

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot(): ViewerConfig {
  return config;
}

/** Reactive access to the whole config (re-renders on load and on change). */
export function useConfig(): ViewerConfig {
  return useSyncExternalStore(subscribe, getSnapshot);
}

function getFlags(): { customCommandsAllowed: boolean } {
  return flags;
}

/** Reactive access to server policy flags (custom harness commands allowed?). */
export function useFlags(): { customCommandsAllowed: boolean } {
  return useSyncExternalStore(subscribe, getFlags);
}

function getReadiness(): OrcaReadiness | null {
  return readiness;
}

/**
 * Reactive access to the readiness probe. Null until the server answers —
 * treat null as "unknown", and only hard-disable controls once the server
 * actually said `executionEnabled: false` (a transient fetch failure should
 * not brick the UI; the server still re-checks on every mutation).
 */
export function useReadiness(): OrcaReadiness | null {
  return useSyncExternalStore(subscribe, getReadiness);
}

/**
 * Hydrate the store from the server once at startup. Missing fields fall back
 * to legacy localStorage values. Only fields actually migrated are written
 * back: a full write here could erase settings another Viewer just saved.
 */
export async function initConfig(): Promise<void> {
  // Session (mutation token + policy flags) hydrates reactively: api.ts blocks
  // mutations on it anyway (synthetic 503 until ready), and this only gates
  // the "Custom…" UI. Never fails initConfig — reads work without a session.
  initSession()
    .then((s) => {
      flags = { customCommandsAllowed: s.allowCustomCommands };
      emit();
    })
    .catch(() => {
      /* flags stay false; mutations surface the real error when used */
    });
  // Readiness hydrates the same way: null until answered, controls stay live,
  // and the server-side gate still refuses execution if the probe failed here.
  fetchReadiness()
    .then((r) => {
      readiness = r;
      emit();
    })
    .catch(() => {
      /* stays null — UI keeps working, server re-gates mutations itself */
    });
  let server: Partial<ViewerConfig> = {};
  let fetched = false;
  try {
    server = await fetchConfig();
    fetched = true;
  } catch {
    // backend unreachable — stay on defaults / localStorage mirror
  }
  config = hydratedConfig(server, true);
  const migrated: Partial<ViewerConfig> = {};
  if (fetched) {
    if (!server.defaultHarness && localStorage.getItem(DEFAULT_KEY)) migrated.defaultHarness = config.defaultHarness;
    if (!server.harnessByTask && Object.keys(config.harnessByTask).length) migrated.harnessByTask = config.harnessByTask;
    if (!server.layout && config.layout) migrated.layout = config.layout;
    if (!server.runId && config.runId) migrated.runId = config.runId;
  }
  mirrorToLocalStorage();
  emit();
  if (Object.keys(migrated).length) schedulePersist(migrated);
  // An open Viewer can receive a Run built by CLI or another tab. Keep its
  // Stage editor/card in sync instead of waiting for a full page reload.
  if (configRefreshTimer === null) {
    configRefreshTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshConfig().catch(() => {});
    }, 10_000);
    window.addEventListener("focus", () => { void refreshConfig().catch(() => {}); });
  }
}

function hydratedConfig(server: Partial<ViewerConfig>, legacy: boolean): ViewerConfig {
  return {
    defaultHarness:
      asString(server.defaultHarness) || (legacy ? localStorage.getItem(DEFAULT_KEY) : "") || DEFAULTS.defaultHarness,
    harnessByTask: asHarnessMap(server.harnessByTask) ?? (legacy ? readLegacyNodeHarnesses() : {}),
    modelByTask: asHarnessMap(server.modelByTask) ?? {},
    // Phase 5 maps: absent in pre-Phase-5 files → empty (backward-compatible
    // hydration; the server sanitizer already dropped malformed entries).
    effortByTask: asHarnessMap(server.effortByTask) ?? {},
    retainByTask: asBooleanMap(server.retainByTask) ?? {},
    // Phase 6 maps: same compatibility rule — a pre-Phase-6 file lacks both
    // keys, and hydration must NOT invent them (local/current stays default).
    environmentByTask: asHarnessMap(server.environmentByTask) ?? {},
    placementByTask: asPlacementMap(server.placementByTask) ?? {},
    // Phase 7 maps: lanes are launch intent; hydration mirrors the server's
    // sanitizer (only the three non-current seed kinds survive) and a
    // membership pointing at a dropped lane degrades to per-task placement.
    worktreeLanes: asLaneMap(server.worktreeLanes) ?? {},
    laneByTask: asLaneMembership(server.laneByTask, server.worktreeLanes) ?? {},
    // Viewer-only semantic ownership. One map entry naturally enforces at
    // most one lead Task per Run, while old config files simply hydrate empty.
    leadTaskByRun: asHarnessMap(server.leadTaskByRun) ?? {},
    maxConcurrency: asConcurrency(server.maxConcurrency) ?? DEFAULTS.maxConcurrency,
    layout: asLayout(server.layout) || (legacy ? asLayout(localStorage.getItem(LAYOUT_KEY)) : "") || "",
    runId: asString(server.runId) || (legacy ? localStorage.getItem(RUN_KEY) : "") || "",
  };
}

function update(patch: Partial<ViewerConfig>): void {
  config = { ...config, ...patch };
  revision++;
  mirrorToLocalStorage();
  emit();
  schedulePersist(patch);
}

let persistTimer: number | null = null;
let pendingPatch: Partial<ViewerConfig> = {};
let persistInFlight: Promise<void> | null = null;
let revision = 0;

/** Debounced, field-scoped write-through. Run selection cannot overwrite maps. */
function schedulePersist(patch: Partial<ViewerConfig>): void {
  pendingPatch = { ...pendingPatch, ...patch };
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    flushConfigChanges().catch(() => {
      /* keep the in-memory state; next change retries */
    });
  }, 250);
}

async function flushConfigChanges(): Promise<void> {
  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (persistInFlight) {
    await persistInFlight;
    return flushConfigChanges();
  }
  if (!Object.keys(pendingPatch).length) return;
  const patch = pendingPatch;
  pendingPatch = {};
  persistInFlight = saveConfig(patch).catch((error: unknown) => {
    pendingPatch = { ...patch, ...pendingPatch };
    throw error;
  });
  try {
    await persistInFlight;
  } finally {
    persistInFlight = null;
  }
  return flushConfigChanges();
}

/** Refresh the exact plan used by Run, after all local edits have reached disk. */
export async function refreshConfig(): Promise<ViewerConfig> {
  for (;;) {
    await flushConfigChanges();
    const before = revision;
    const server = await fetchConfig();
    // An edit while GET was in flight must be saved before that snapshot is
    // allowed to replace the store or become a launch plan.
    if (revision !== before) continue;
    const refreshed = hydratedConfig(server, false);
    if (JSON.stringify(refreshed) !== JSON.stringify(config)) {
      config = refreshed;
      mirrorToLocalStorage();
      emit();
    }
    return config;
  }
}

function mirrorToLocalStorage(): void {
  try {
    localStorage.setItem(DEFAULT_KEY, config.defaultHarness);
    if (config.layout) localStorage.setItem(LAYOUT_KEY, config.layout);
    if (config.runId) localStorage.setItem(RUN_KEY, config.runId);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(NODE_PREFIX) || key.startsWith(MODEL_PREFIX)) localStorage.removeItem(key);
    }
    for (const [id, h] of Object.entries(config.harnessByTask)) {
      localStorage.setItem(NODE_PREFIX + id, h);
    }
    for (const [id, m] of Object.entries(config.modelByTask)) {
      localStorage.setItem(MODEL_PREFIX + id, m);
    }
  } catch {
    /* private mode etc. — the server file is the source of truth anyway */
  }
}

function readLegacyNodeHarnesses(): Record<string, string> {
  const map: Record<string, string> = {};
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(NODE_PREFIX)) continue;
      const v = localStorage.getItem(key);
      if (v) map[key.slice(NODE_PREFIX.length)] = v;
    }
  } catch {
    /* ignore */
  }
  return map;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function asHarnessMap(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const map: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" && val.trim()) map[k] = val.trim();
  }
  return map;
}
function asConcurrency(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(16, Math.round(v))) : null;
}
function asBooleanMap(v: unknown): Record<string, boolean> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const map: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "boolean") map[k] = val;
  }
  return map;
}
function asLayout(v: unknown): LayoutKind | "" {
  return v === "layered-lr" || v === "layered-tb" || v === "force" ? v : "";
}

/**
 * Tolerant placement-map hydration (Phase 6/7): mirrors the server's
 * sanitizer — only the four known kinds with their required fields survive;
 * anything else is dropped so a malformed entry degrades to local/current
 * rather than to a guessed creation shape. Creation fields are kept
 * field-level tolerant (a bad comment must not erase an otherwise valid
 * placement), exactly like the server's sanitizePlacementSpec.
 */
function asPlacementMap(v: unknown): Record<string, PlacementSpec> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const map: Record<string, PlacementSpec> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const parsed = asPlacementSpec(raw);
    if (parsed) map[k] = parsed;
  }
  return map;
}

/** Tolerant parse of ONE stored placement entry; null = drop (malformed). */
function asPlacementSpec(raw: unknown): PlacementSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "current") return { kind: "current" };
  if (r.kind === "existing" && typeof r.selector === "string" && r.selector.trim()) {
    return { kind: "existing", selector: r.selector.trim() };
  }
  const creation = asCreationOptions(r);
  if (r.kind === "new-child") return { kind: "new-child", ...creation };
  if (r.kind === "new-top-level" && typeof r.repo === "string" && r.repo.trim()) {
    return { kind: "new-top-level", repo: r.repo.trim(), ...creation };
  }
  return null;
}

/**
 * Tolerant parse of the creation-only fields. An absent/invalid `setup`
 * normalizes to Orca's default "run" (mirrors the server, so every in-memory
 * spec carries an explicit policy); out-of-bounds free-text fields are
 * STRIPPED, never guessed into a shorter shape.
 */
function asCreationOptions(r: Record<string, unknown>): CreationOptions {
  const out: CreationOptions = {
    setup: SETUP_POLICIES.includes(r.setup as SetupPolicy) ? (r.setup as SetupPolicy) : "run",
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
  const displayName = typeof r.displayName === "string" ? boundedText(r.displayName, DISPLAY_NAME_MAX) : undefined;
  if (displayName !== undefined) out.displayName = displayName;
  const comment = typeof r.comment === "string" ? boundedText(r.comment, COMMENT_MAX) : undefined;
  if (comment !== undefined) out.comment = comment;
  return out;
}

/**
 * Tolerant lane-map hydration (Phase 7): a lane seeded by `current` is
 * dropped — lanes exist to share ONE non-current workspace, and a "current
 * lane" would silently recreate the serial-vs-parallel ambiguity lanes are
 * defined to avoid.
 */
function asLaneMap(v: unknown): Record<string, WorktreeLaneSpec> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const map: Record<string, WorktreeLaneSpec> = {};
  for (const [laneId, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const placement = asPlacementSpec((raw as Record<string, unknown>).placement);
    if (!placement || placement.kind === "current") continue;
    map[laneId] = { placement };
  }
  return map;
}

/**
 * Lane membership hydration: entries whose lane failed hydration (or was
 * dropped as `current`) are dropped with it — a member of a nonexistent lane
 * must degrade to per-task placement, never dangle.
 */
function asLaneMembership(
  v: unknown,
  laneSource: unknown,
): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const lanes = asLaneMap(laneSource) ?? {};
  const map: Record<string, string> = {};
  for (const [taskId, laneId] of Object.entries(v as Record<string, unknown>)) {
    if (typeof laneId === "string" && lanes[laneId]) map[taskId] = laneId;
  }
  return map;
}

// --- field accessors (kept compatible with the old localStorage API) -------

export function getNodeHarness(taskId: string): string | null {
  return config.harnessByTask[taskId] ?? null;
}

export function setNodeHarness(taskId: string, harness: string | null): void {
  const harnessByTask = { ...config.harnessByTask };
  if (harness) harnessByTask[taskId] = harness;
  else delete harnessByTask[taskId];
  update({ harnessByTask });
}

export function getNodeModel(taskId: string): string | null {
  return config.modelByTask[taskId] ?? null;
}

export function setNodeModel(taskId: string, model: string | null): void {
  const modelByTask = { ...config.modelByTask };
  // Effort only exists alongside a model (Phase 5): clearing the model clears
  // the effort so the stored pair can never dangle.
  const effortByTask = { ...config.effortByTask };
  if (model) modelByTask[taskId] = model;
  else {
    delete modelByTask[taskId];
    delete effortByTask[taskId];
  }
  update({ modelByTask, effortByTask });
}

export function getNodeEffort(taskId: string): string | null {
  return config.effortByTask[taskId] ?? null;
}

export function setNodeEffort(taskId: string, effort: string | null): void {
  const effortByTask = { ...config.effortByTask };
  if (effort) effortByTask[taskId] = effort;
  else delete effortByTask[taskId];
  update({ effortByTask });
}

export function getNodeRetain(taskId: string): boolean {
  return config.retainByTask[taskId] ?? false;
}

export function setNodeRetain(taskId: string, retain: boolean): void {
  const retainByTask = { ...config.retainByTask };
  if (retain) retainByTask[taskId] = true;
  else delete retainByTask[taskId];
  update({ retainByTask });
}

// --- Phase 6: per-node environment + exact placement -------------------------

/** The saved environment a node runs on; null = local (zero-config default). */
export function getNodeEnvironment(taskId: string): string | null {
  return config.environmentByTask[taskId] ?? null;
}

export function setNodeEnvironment(taskId: string, envId: string | null): void {
  const environmentByTask = { ...config.environmentByTask };
  const placementByTask = { ...config.placementByTask };
  const laneByTask = { ...config.laneByTask };
  if (envId) environmentByTask[taskId] = envId;
  else delete environmentByTask[taskId];
  // Back to local → the exact placement loses its meaning (it was chosen
  // for the remote's discovered selectors). Clear it so the store never
  // keeps a placement an environment picker no longer shows.
  delete placementByTask[taskId];
  // Lanes are LOCAL placements: a task pinned to a saved environment can no
  // longer be a lane member, and the ambiguity must never persist.
  delete laneByTask[taskId];
  update({ environmentByTask, placementByTask, laneByTask });
}

/** The node's exact placement; null = current (coordinator workspace). */
export function getNodePlacement(taskId: string): PlacementSpec | null {
  return config.placementByTask[taskId] ?? null;
}

export function setNodePlacement(taskId: string, placement: PlacementSpec | null): void {
  const placementByTask = { ...config.placementByTask };
  const laneByTask = { ...config.laneByTask };
  if (placement) placementByTask[taskId] = placement;
  else delete placementByTask[taskId];
  // A task cannot have both a direct placement and a lane membership — the
  // lane owns its members' placement, so a direct choice evicts the task.
  delete laneByTask[taskId];
  update({ placementByTask, laneByTask });
}

// --- Phase 7: durable workspace lanes -----------------------------------------

/** All lane ids with a surviving seed, in insertion order. */
export function allLaneIds(): string[] {
  return Object.keys(config.worktreeLanes);
}

/** One lane's seed placement; null when the lane does not exist. */
export function getLaneSpec(laneId: string): WorktreeLaneSpec | null {
  return config.worktreeLanes[laneId] ?? null;
}

/**
 * Create/replace a lane's seed. Null deletes the lane AND its memberships —
 * a member of a deleted lane must degrade to per-task placement, never dangle.
 */
export function setLaneSpec(laneId: string, spec: WorktreeLaneSpec | null): void {
  const worktreeLanes = { ...config.worktreeLanes };
  const laneByTask = { ...config.laneByTask };
  if (spec) worktreeLanes[laneId] = spec;
  else {
    delete worktreeLanes[laneId];
    for (const [taskId, memberOf] of Object.entries(laneByTask)) {
      if (memberOf === laneId) delete laneByTask[taskId];
    }
  }
  update({ worktreeLanes, laneByTask });
}

/** The lane a task belongs to; null = per-task placement (or the default). */
export function getTaskLane(taskId: string): string | null {
  return config.laneByTask[taskId] ?? null;
}

/**
 * Assign/remove a task's lane membership. A lane member takes its placement
 * from the lane, so a direct placement (and a saved-environment pin — lanes
 * are local) is cleared on assignment. Removal restores per-task choice.
 */
export function setTaskLane(taskId: string, laneId: string | null): void {
  const laneByTask = { ...config.laneByTask };
  const placementByTask = { ...config.placementByTask };
  const environmentByTask = { ...config.environmentByTask };
  if (laneId && config.worktreeLanes[laneId]) {
    laneByTask[taskId] = laneId;
    delete placementByTask[taskId];
    delete environmentByTask[taskId];
  } else {
    delete laneByTask[taskId];
  }
  update({ laneByTask, placementByTask, environmentByTask });
}

/** Lane membership for the tasks that have one (the map POSTed to /api/run). */
export function laneMap(taskIds: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const id of taskIds) {
    const laneId = getTaskLane(id);
    if (laneId) m[id] = laneId;
  }
  return m;
}

/** The whole lane seed map (the other half of the lane plan POSTed to /api/run). */
export function lanesSpecMap(): Record<string, WorktreeLaneSpec> {
  return { ...config.worktreeLanes };
}

/** Semantic lead stage for one Run; unrelated to live Orca coordinator authority. */
export function getLeadTask(runId: string): string | null {
  return config.leadTaskByRun[runId] ?? null;
}

/** Setting a lead replaces only this Run's prior choice; null clears it. */
export function setLeadTask(runId: string, taskId: string | null): void {
  if (!runId) return;
  const leadTaskByRun = { ...config.leadTaskByRun };
  if (taskId) leadTaskByRun[runId] = taskId;
  else delete leadTaskByRun[runId];
  update({ leadTaskByRun });
}

export function getDefaultHarness(): string {
  return config.defaultHarness;
}

export function setDefaultHarness(harness: string): void {
  update({ defaultHarness: harness });
}

export function getMaxConcurrency(): number {
  return config.maxConcurrency;
}

export function setMaxConcurrency(n: number): void {
  update({ maxConcurrency: Math.max(1, Math.min(16, Math.round(n) || 1)) });
}

export function getLayout(): LayoutKind | "" {
  return config.layout;
}

export function setLayout(layout: LayoutKind): void {
  update({ layout });
}

/** The Run whose DAG the viewer is showing. Empty until one is chosen. */
export function getRunId(): string {
  return config.runId;
}

export function setRunId(runId: string): void {
  update({ runId });
}

/** Effective harness for a node: its own override, else the global default. */
export function effectiveHarness(taskId: string): string {
  return getNodeHarness(taskId) || getDefaultHarness();
}

/** Map of {taskId: harness} for nodes with an explicit override (the rest use default). */
export function harnessMap(taskIds: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const id of taskIds) {
    const h = getNodeHarness(id);
    if (h) m[id] = h;
  }
  return m;
}

/** Map of {taskId: model} for nodes with an explicit model override. */
export function modelMap(taskIds: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const id of taskIds) {
    const md = getNodeModel(id);
    if (md) m[id] = md;
  }
  return m;
}

/**
 * Map of {taskId: effort} for nodes with BOTH a model and an explicit effort
 * (Phase 5). Effort is only ever sent alongside a model — the server rejects
 * an unpaired entry, so the pairing is enforced at the source.
 */
export function effortMap(taskIds: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const id of taskIds) {
    const e = getNodeEffort(id);
    if (e && getNodeModel(id)) m[id] = e;
  }
  return m;
}

/** Map of {taskId: true} for nodes opted into retain-for-debugging (Phase 5). */
export function retainMap(taskIds: string[]): Record<string, boolean> {
  const m: Record<string, boolean> = {};
  for (const id of taskIds) {
    if (getNodeRetain(id)) m[id] = true;
  }
  return m;
}

/**
 * Map of {taskId: envId} for nodes pinned to a saved environment (Phase 6).
 * Absent = the local server — never synthesized.
 */
export function environmentMap(taskIds: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const id of taskIds) {
    const e = getNodeEnvironment(id);
    if (e) m[id] = e;
  }
  return m;
}

/** Map of {taskId: placement} for nodes with an explicit exact placement. */
export function placementMap(taskIds: string[]): Record<string, PlacementSpec> {
  const m: Record<string, PlacementSpec> = {};
  for (const id of taskIds) {
    const p = getNodePlacement(id);
    if (p) m[id] = p;
  }
  return m;
}
