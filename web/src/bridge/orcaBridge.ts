/**
 * Orca Native Plugin Bridge (`orca-plugin-authoring` host API v1).
 *
 * When mounted as a standalone web page (Express + Vite or compiled binary),
 * `window.orca` is absent and the viewer uses standard loopback HTTP (`/api/*`),
 * `EventSource` SSE, and `localStorage`.
 *
 * When mounted inside an Orca sandboxed UI frame (`contributes.panels` with
 * `ui: "html"` or `contributes.customEditors`), external HTTP/SSE requests are
 * blocked by the host sandbox. Detecting `window.orca` switches transport to
 * `window.orca.plugin.request(...)` (handled by the plugin's out-of-process
 * `trusted-worker`), push events via `window.orca.plugin.on(...)` / `window.orca.on(...)`,
 * and host locale / `--orca-*` theme variables.
 */

import type { ActivitySnapshot } from "../types";

type OrcaDisposable = (() => void) | { dispose: () => void } | void;

interface OrcaPluginBridgeResponse {
  status: number;
  ok: boolean;
  body: Record<string, unknown>;
}

interface OrcaHostGlobal {
  locale?: string;
  on?: (event: string, handler: (payload: unknown) => void) => OrcaDisposable;
  plugin?: {
    request: <T = unknown>(
      name: string,
      input?: unknown,
      opts?: { signal?: AbortSignal; timeoutMs?: number },
    ) => Promise<T>;
    on?: (event: string, handler: (payload: unknown) => void) => OrcaDisposable;
  };
  storage?: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  shell?: {
    openExternal: (url: string) => Promise<{ opened: boolean; reason?: string }>;
  };
}

function disposeOf(sub: OrcaDisposable): void {
  if (!sub) return;
  if (typeof sub === "function") sub();
  else if (typeof sub === "object" && typeof sub.dispose === "function") sub.dispose();
}

function getOrcaGlobal(): OrcaHostGlobal | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { orca?: unknown }).orca;
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as OrcaHostGlobal;
}

/** True when executing inside an Orca plugin HTML panel or custom editor frame. */
export function isOrcaPluginFrame(): boolean {
  const host = getOrcaGlobal();
  return Boolean(host && host.plugin && typeof host.plugin.request === "function");
}

/**
 * True when the compact Orca right-sidebar UI should be rendered instead of
 * the full wide-canvas workbench (auto-enabled inside the Orca sidebar plugin
 * frame, or previewable in any browser via `?view=sidebar`).
 */
export function isSidebarMode(): boolean {
  if (isOrcaPluginFrame()) return true;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("view") === "sidebar";
  } catch {
    return false;
  }
}

let panelWorkspace: { id: string; signal: AbortSignal } | null = null;

/** Orca replays the current context to each subscriber; terminal-only changes keep the same workspace. */
export function watchOrcaWorkspace(onReset: (id: string | null) => void, onReady: () => void): void {
  let previous: string | null | undefined;
  let controller: AbortController | undefined;
  getOrcaGlobal()?.on?.("workspace.changed", (payload) => {
    const context = (payload as { context?: { workspaceId?: unknown } | null } | null)?.context;
    const id = typeof context?.workspaceId === "string" && context.workspaceId ? context.workspaceId : null;
    if (previous === id) return;
    previous = id;
    panelWorkspace = null;
    controller?.abort();
    controller = undefined;
    // Old effects must be torn down while no workspace can accept requests.
    onReset(id);
    if (id) {
      controller = new AbortController();
      panelWorkspace = { id, signal: controller.signal };
      onReady();
    }
  });
}

/** Read Orca's active UI locale (`en`, `zh-CN`, etc.) when inside a plugin frame. */
export function readOrcaHostLocale(): string | null {
  const host = getOrcaGlobal();
  return typeof host?.locale === "string" && host.locale.trim() ? host.locale.trim() : null;
}

/** Subscribe to Orca host theme updates (`<html class="light|dark">` + `--orca-*`). */
export function subscribeOrcaHostTheme(onChange: (payload?: unknown) => void): () => void {
  const host = getOrcaGlobal();
  if (!host?.on) return () => {};
  const sub = host.on("theme", (payload) => onChange(payload));
  return () => disposeOf(sub);
}

async function requestPlugin<T>(name: string, input: unknown, signal?: AbortSignal): Promise<T> {
  const host = getOrcaGlobal();
  if (!host?.plugin?.request) {
    throw new Error("Orca plugin bridge is unavailable.");
  }
  const raw = await host.plugin.request<T | { output: T }>(name, input, signal ? { signal } : undefined);
  signal?.throwIfAborted();
  if (raw && typeof raw === "object" && "output" in raw) return raw.output;
  return raw as T;
}

async function requestWorkspace<T>(name: string, input: object): Promise<T> {
  const workspace = panelWorkspace;
  if (!workspace) throw new Error("No active Orca workspace.");
  return requestPlugin(name, { ...input, workspaceId: workspace.id }, workspace.signal);
}

/** Invoke only after the operator confirms installing the bundled skill. */
export async function installPluginSkill(): Promise<{ installed: number; upToDate: number }> {
  const receipt = await requestPlugin<Record<string, unknown>>("orca-dag.skill.install", { confirmed: true });
  if (receipt?.ok !== true || typeof receipt.installed !== "number" || typeof receipt.upToDate !== "number") {
    throw new Error("The Orca plugin could not install its bundled skill.");
  }
  return { installed: receipt.installed, upToDate: receipt.upToDate };
}

/**
 * Route an API call through `window.orca.plugin.request("orca-dag.api", ...)`
 * when running inside a native Orca plugin frame.
 */
export async function pluginApiRequest(
  method: "GET" | "POST" | "PUT",
  url: string,
  body?: unknown,
): Promise<OrcaPluginBridgeResponse> {
  return requestWorkspace("orca-dag.api", body === undefined ? { method, url } : { method, url, body });
}

let streamSeq = 0;

/**
 * Subscribe to a worker's centralized OutputTail stream through the plugin
 * worker (`orca-dag.output.subscribe` + `orca-dag.output` panel posts).
 */
export function openPluginOutputStream(
  runId: string,
  dispatchId: string,
  source: "auto" | "terminal" | "transcript",
  handlers: {
    onEvent: (event: string, data: unknown) => void;
    onError: (message: string) => void;
  },
): () => void {
  const host = getOrcaGlobal();
  if (!host?.plugin?.request || !host.plugin.on) {
    handlers.onError("Orca plugin output bridge is unavailable.");
    return () => {};
  }
  const subId = `out_${++streamSeq}`;
  const signal = panelWorkspace?.signal;
  let closed = false;
  const sub = host.plugin.on("orca-dag.output", (raw) => {
    if (closed || signal?.aborted || !raw || typeof raw !== "object") return;
    const msg = raw as { subId?: unknown; event?: unknown; data?: unknown };
    if (msg.subId !== subId || typeof msg.event !== "string") return;
    handlers.onEvent(msg.event, msg.data);
  });
  void requestWorkspace<{ ok: boolean }>("orca-dag.output.subscribe", { subId, runId, dispatchId, source })
    .then(({ ok }) => {
      if (!ok && !closed) handlers.onError("No viewer is connected for this workspace.");
    })
    .catch((err) => {
      if (!closed && !signal?.aborted) handlers.onError(String((err as Error)?.message ?? err));
    });
  return () => {
    closed = true;
    disposeOf(sub);
    void host.plugin?.request("orca-dag.output.unsubscribe", { subId }).catch(() => {});
  };
}

// A bad object or a frame for another Run must not replace the last snapshot.
function isActivitySnapshot(value: unknown, runId: string): value is ActivitySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ActivitySnapshot>;
  const { inboxWindow } = snapshot;
  return (
    snapshot.runId === runId &&
    Array.isArray(snapshot.events) &&
    Array.isArray(snapshot.presence) &&
    Array.isArray(snapshot.checks) &&
    typeof snapshot.pendingCount === "number" &&
    typeof snapshot.truncated === "boolean" &&
    typeof snapshot.generatedAt === "number" &&
    (inboxWindow === null ||
      (typeof inboxWindow?.limit === "number" &&
        typeof inboxWindow.observed === "number" &&
        typeof inboxWindow.saturated === "boolean"))
  );
}

/**
 * Subscribe to live Run activity updates:
 * - Standalone mode: opens `EventSource('/api/activity/stream?run=...')`
 * - Orca plugin mode: subscribes to worker push events via `window.orca.plugin.on`
 */
export function openActivityStream(
  runId: string,
  handlers: {
    onOpen: () => void;
    onSnapshot: (snapshot: ActivitySnapshot) => void;
    onError: () => void;
  },
): () => void {
  if (isOrcaPluginFrame()) {
    const host = getOrcaGlobal()!;
    const subId = `activity_${++streamSeq}`;
    const signal = panelWorkspace?.signal;
    let closed = false;
    const listener = (payload: unknown) => {
      if (!closed && !signal?.aborted && isActivitySnapshot(payload, runId) &&
        (payload as ActivitySnapshot & { subId?: string }).subId === subId) handlers.onSnapshot(payload);
    };
    const subPlugin = host.plugin?.on?.("orca-dag.activity", listener);
    const subFrame = !subPlugin ? host.on?.("orca-dag.activity", listener) : undefined;
    void requestWorkspace<{ ok: boolean }>("orca-dag.activity.subscribe", { subId, runId })
      .then(({ ok }) => {
        if (!closed && !signal?.aborted) (ok ? handlers.onOpen : handlers.onError)();
      })
      .catch(() => {
        if (!closed && !signal?.aborted) handlers.onError();
      });
    return () => {
      closed = true;
      disposeOf(subPlugin);
      disposeOf(subFrame);
      void host.plugin?.request("orca-dag.activity.unsubscribe", { subId }).catch(() => {});
    };
  }

  const source = new EventSource(`/api/activity/stream?run=${encodeURIComponent(runId)}`);
  source.onopen = () => handlers.onOpen();
  source.onmessage = (message) => {
    try {
      const payload: unknown = JSON.parse(message.data);
      if (isActivitySnapshot(payload, runId)) handlers.onSnapshot(payload);
    } catch {
      handlers.onError();
    }
  };
  source.onerror = () => handlers.onError();
  return () => source.close();
}
