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
 * `trusted-worker`), push events via `window.orca.on(...)`, and host locale /
 * `--orca-*` theme variables.
 */

interface OrcaPluginBridgeResponse {
  status: number;
  ok: boolean;
  body: Record<string, unknown>;
}

interface OrcaHostGlobal {
  locale?: string;
  on?: (event: string, handler: (payload: unknown) => void) => (() => void) | void;
  plugin?: {
    request: <T = unknown>(
      name: string,
      input?: unknown,
      opts?: { timeoutMs?: number },
    ) => Promise<T>;
    on?: (event: string, handler: (payload: unknown) => void) => (() => void) | void;
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

/** Read Orca's active UI locale (`en`, `zh-CN`, etc.) when inside a plugin frame. */
export function readOrcaHostLocale(): string | null {
  const host = getOrcaGlobal();
  return typeof host?.locale === "string" && host.locale.trim() ? host.locale.trim() : null;
}

/** Subscribe to Orca host theme updates (`<html class="light|dark">` + `--orca-*`). */
export function subscribeOrcaHostTheme(onChange: () => void): () => void {
  const host = getOrcaGlobal();
  if (!host?.on) return () => {};
  const off = host.on("theme", () => onChange());
  return typeof off === "function" ? off : () => {};
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
  const raw = await host.plugin.request<OrcaPluginBridgeResponse | { output?: OrcaPluginBridgeResponse }>(
    "orca-dag.api",
    { method, url, body },
  );
  if (raw && typeof raw === "object" && "output" in raw && raw.output) {
    return raw.output;
  }
  return raw as OrcaPluginBridgeResponse;
}

/**
 * Subscribe to live Run activity updates:
 * - Standalone mode: opens `EventSource('/api/activity/stream?run=...')`
 * - Orca plugin mode: subscribes to worker push events via `window.orca.plugin.on` / `window.orca.on`
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
    const offPlugin = host.plugin?.on?.("orca-dag.activity", listener);
    const offFrame = !offPlugin ? host.on?.("orca-dag.activity", listener) : undefined;
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
      if (typeof offPlugin === "function") offPlugin();
      if (typeof offFrame === "function") offFrame();
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
