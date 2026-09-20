// Viewer configuration store: per-node harness, default harness, concurrency
// cap, and layout choice. Persisted server-side in `.orca-dag.config.json`
// (workspace root) via /api/config — Orca's task has no harness/metadata
// field, and browser localStorage was lost on browser/profile changes.
// Legacy localStorage keys are read once as a migration source and mirrored
// on every write (harmless fallback when running against an older backend).

import { useSyncExternalStore } from "react";
import { fetchConfig, fetchReadiness, initSession, saveConfig } from "./api";
import type { LayoutKind, OrcaReadiness, PlacementSpec, ViewerConfig } from "./types";

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
  maxConcurrency: 4,
  layout: "",
  runId: "",
};

let config: ViewerConfig = { ...DEFAULTS };
const listeners = new Set<() => void>();

// Server-side policy flags, from GET /api/session (see api.ts). Not config —
// the server owns them — but the UI needs them reactively, and this store is
// the natural place to expose them alongside the harness choices they gate.
let flags = { customCommandsAllowed: false };

// Readiness probe (GET /api/readiness): null until the first fetch resolves.
// Like the flags, this is server-owned state the UI only renders; execution
// controls across the app (Run button, gate resolutions, Clear tasks) disable
// themselves off `executionEnabled` so an old runtime reads as view-only
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
 * to legacy localStorage values; the merged result is written back so the
 * migration completes in one shot.
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
  try {
    server = await fetchConfig();
  } catch {
    // backend unreachable — stay on defaults / localStorage mirror
  }
  config = {
    defaultHarness:
      asString(server.defaultHarness) || localStorage.getItem(DEFAULT_KEY) || DEFAULTS.defaultHarness,
    harnessByTask: asHarnessMap(server.harnessByTask) ?? readLegacyNodeHarnesses(),
    modelByTask: asHarnessMap(server.modelByTask) ?? {},
    // Phase 5 maps: absent in pre-Phase-5 files → empty (backward-compatible
    // hydration; the server sanitizer already dropped malformed entries).
    effortByTask: asHarnessMap(server.effortByTask) ?? {},
    retainByTask: asBooleanMap(server.retainByTask) ?? {},
    // Phase 6 maps: same compatibility rule — a pre-Phase-6 file lacks both
    // keys, and hydration must NOT invent them (local/current stays default).
    environmentByTask: asHarnessMap(server.environmentByTask) ?? {},
    placementByTask: asPlacementMap(server.placementByTask) ?? {},
    maxConcurrency: asConcurrency(server.maxConcurrency) ?? DEFAULTS.maxConcurrency,
    layout: asLayout(server.layout) || asLayout(localStorage.getItem(LAYOUT_KEY)) || "",
    runId: asString(server.runId) || localStorage.getItem(RUN_KEY) || "",
  };
  emit();
  persist();
}

function update(patch: Partial<ViewerConfig>): void {
  config = { ...config, ...patch };
  mirrorToLocalStorage();
  emit();
  persist();
}

let persistTimer: number | null = null;
/** Debounced write-through to the server-side config file. */
function persist(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    saveConfig(config).catch(() => {
      /* keep the in-memory state; next change retries */
    });
  }, 250);
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
 * Tolerant placement-map hydration (Phase 6): mirrors the server's sanitizer —
 * only the three known kinds with their required fields survive; anything
 * else is dropped so a malformed entry degrades to local/current rather than
 * to a guessed remote shape.
 */
function asPlacementMap(v: unknown): Record<string, PlacementSpec> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const map: Record<string, PlacementSpec> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (r.kind === "current") map[k] = { kind: "current" };
    else if (r.kind === "existing" && typeof r.selector === "string" && r.selector.trim()) {
      map[k] = { kind: "existing", selector: r.selector.trim() };
    } else if (
      r.kind === "new-top-level" &&
      typeof r.repo === "string" &&
      r.repo.trim() &&
      typeof r.name === "string" &&
      r.name.trim()
    ) {
      map[k] = { kind: "new-top-level", repo: r.repo.trim(), name: r.name.trim() };
    }
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
  if (envId) environmentByTask[taskId] = envId;
  else {
    delete environmentByTask[taskId];
    // Back to local → the exact placement loses its meaning (it was chosen
    // for the remote's discovered selectors). Clear it so the store never
    // keeps a placement an environment picker no longer shows.
    delete placementByTask[taskId];
  }
  update({ environmentByTask, placementByTask });
}

/** The node's exact placement; null = current (coordinator workspace). */
export function getNodePlacement(taskId: string): PlacementSpec | null {
  return config.placementByTask[taskId] ?? null;
}

export function setNodePlacement(taskId: string, placement: PlacementSpec | null): void {
  const placementByTask = { ...config.placementByTask };
  if (placement) placementByTask[taskId] = placement;
  else delete placementByTask[taskId];
  update({ placementByTask });
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
