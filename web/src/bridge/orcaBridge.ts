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
      opts?: { timeoutMs?: number },
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

/** Read Orca's active UI locale (`en`, `zh-CN`, etc.) when inside a plugin frame. */
export function readOrcaHostLocale(): string | null {
  const host = getOrcaGlobal();
  return typeof host?.locale === "string" && host.locale.trim() ? host.locale.trim() : null;
}

/** Subscribe to Orca host theme updates (`<html class="light|dark">` + `--orca-*`). */
export function subscribeOrcaHostTheme(onChange: () => void): () => void {
  const host = getOrcaGlobal();
  if (!host?.on) return () => {};
  const sub = host.on("theme", () => onChange());
  return () => disposeOf(sub);
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
  const host = getOrcaGlobal();
  if (!host?.plugin?.request) {
    throw new Error("Orca plugin bridge is unavailable.");
  }
  const payload = body === undefined ? { method, url } : { method, url, body };
  const raw = await host.plugin.request<OrcaPluginBridgeResponse | { output?: OrcaPluginBridgeResponse }>(
    "orca-dag.api",
    payload,
  );
  if (raw && typeof raw === "object" && "output" in raw && raw.output) {
    return raw.output;
  }
  return raw as OrcaPluginBridgeResponse;
}

let outputSubSeq = 0;

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
  const subId = `out_${++outputSubSeq}_${Date.now()}`;
  let closed = false;
  const sub = host.plugin.on("orca-dag.output", (raw) => {
    if (closed || !raw || typeof raw !== "object") return;
    const msg = raw as { subId?: unknown; event?: unknown; data?: unknown };
    if (msg.subId !== subId || typeof msg.event !== "string") return;
    handlers.onEvent(msg.event, msg.data);
  });
  void host.plugin
    .request("orca-dag.output.subscribe", { subId, runId, dispatchId, source })
    .catch((err) => {
      if (!closed) handlers.onError(String((err as Error)?.message ?? err));
    });
  return () => {
    closed = true;
    disposeOf(sub);
    void host.plugin?.request("orca-dag.output.unsubscribe", { subId }).catch(() => {});
  };
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
    onSnapshot: (rawData: unknown) => void;
    onError: () => void;
  },
): () => void {
  if (isOrcaPluginFrame()) {
    const host = getOrcaGlobal()!;
    let closed = false;
    const listener = (payload: unknown) => {
      if (closed) return;
      handlers.onSnapshot(payload);
    };
    const subPlugin = host.plugin?.on?.("orca-dag.activity", listener);
    const subFrame = !subPlugin ? host.on?.("orca-dag.activity", listener) : undefined;
    void host.plugin
      ?.request("orca-dag.activity.subscribe", { runId })
      .then(() => {
        if (!closed) handlers.onOpen();
      })
      .catch(() => {
        if (!closed) handlers.onError();
      });
    return () => {
      closed = true;
      disposeOf(subPlugin);
      disposeOf(subFrame);
      void host.plugin?.request("orca-dag.activity.unsubscribe", { runId }).catch(() => {});
    };
  }

  const source = new EventSource(`/api/activity/stream?run=${encodeURIComponent(runId)}`);
  source.onopen = () => handlers.onOpen();
  source.onmessage = (message) => {
    try {
      handlers.onSnapshot(JSON.parse(message.data));
    } catch {
      handlers.onError();
    }
  };
  source.onerror = () => handlers.onError();
  return () => source.close();
}
