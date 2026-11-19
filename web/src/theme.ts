import { useSyncExternalStore } from "react";
import { isOrcaPluginFrame, subscribeOrcaHostTheme } from "./bridge/orcaBridge";

export type ColorSchemeChoice = "light" | "dark" | null;
const SCHEME_KEY = "orca-dag:color-scheme";

let storedChoice: ColorSchemeChoice = readInitialChoice();
let systemDark = detectSystemDark();
const listeners = new Set<() => void>();
let initialized = false;

function readInitialChoice(): ColorSchemeChoice {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SCHEME_KEY);
    return raw === "light" || raw === "dark" ? raw : null;
  } catch {
    return null;
  }
}

let cachedOrcaRawBg: string | null = null;
let cachedOrcaBgDark: boolean | null = null;
let lastOrcaEventDark: boolean | null = null;

function parseThemePayload(payload: unknown): boolean | null {
  if (typeof payload === "string") {
    const lower = payload.trim().toLowerCase();
    if (lower === "dark") return true;
    if (lower === "light") return false;
    return null;
  }
  if (payload && typeof payload === "object") {
    const rec = payload as Record<string, unknown>;
    for (const key of ["colorScheme", "mode", "theme", "scheme"]) {
      const val = rec[key];
      if (typeof val === "string") {
        const lower = val.trim().toLowerCase();
        if (lower === "dark") return true;
        if (lower === "light") return false;
      }
    }
  }
  return null;
}

function parseColorLuminance(raw: string): number | null {
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    const r = parseInt(h.length === 3 ? h[0] + h[0] : h.slice(0, 2), 16) / 255;
    const g = parseInt(h.length === 3 ? h[1] + h[1] : h.slice(2, 4), 16) / 255;
    const b = parseInt(h.length === 3 ? h[2] + h[2] : h.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const rgb = raw.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) {
    const r = Number(rgb[1]) / 255;
    const g = Number(rgb[2]) / 255;
    const b = Number(rgb[3]) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const srgb = raw.match(/^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
  if (srgb) {
    return 0.2126 * Number(srgb[1]) + 0.7152 * Number(srgb[2]) + 0.0722 * Number(srgb[3]);
  }
  const oklch = raw.match(/^okl(?:ch|ab)\(\s*([\d.]+)(%?)/i);
  if (oklch) {
    const l = Number(oklch[1]);
    return oklch[2] === "%" ? l / 100 : l;
  }
  const hsl = raw.match(/^hsla?\(\s*[\d.]+[a-z]*[,\s]+[\d.]+%[,\s]+([\d.]+)%/i);
  if (hsl) {
    return Number(hsl[1]) / 100;
  }
  return null;
}

function detectOrcaCssDark(): boolean | null {
  if (typeof window === "undefined" || !isOrcaPluginFrame()) return null;
  if (document.documentElement.classList.contains("dark")) return true;
  if (document.documentElement.classList.contains("light")) return false;
  if (lastOrcaEventDark !== null) return lastOrcaEventDark;
  try {
    const rootStyle = getComputedStyle(document.documentElement);
    const rawVar = rootStyle.getPropertyValue("--orca-background").trim();
    const resolvedBg = document.body ? getComputedStyle(document.body).backgroundColor : "";
    const key = `${rawVar}|${resolvedBg}`;
    if (key === cachedOrcaRawBg) return cachedOrcaBgDark;
    let luma = rawVar ? parseColorLuminance(rawVar) : null;
    if (luma === null && resolvedBg && resolvedBg !== "rgba(0, 0, 0, 0)" && resolvedBg !== "transparent") {
      luma = parseColorLuminance(resolvedBg);
    }
    cachedOrcaRawBg = key;
    cachedOrcaBgDark = luma === null ? null : luma < 0.45;
    return cachedOrcaBgDark;
  } catch {
    return null;
  }
}

function detectSystemDark(): boolean {
  if (typeof window === "undefined") return false;
  if (document.documentElement.classList.contains("dark")) return true;
  if (document.documentElement.classList.contains("light")) return false;
  const orcaDark = detectOrcaCssDark();
  if (orcaDark !== null) return orcaDark;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function syncMeta(choice: ColorSchemeChoice): void {
  if (typeof document === "undefined") return;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.setAttribute("content", choice ?? "light dark");
  }
  if (choice) {
    document.documentElement.setAttribute("data-theme", choice);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

/**
 * Sync the document's `color-scheme` meta and `data-theme` attribute so CSS
 * `light-dark()` tokens follow Orca's host theme inside plugin frames (even
 * when OS `prefers-color-scheme` disagrees) and user choice in standalone tabs.
 */
function syncDocumentTheme(): void {
  const orcaDark = detectOrcaCssDark();
  if (orcaDark !== null) {
    syncMeta(orcaDark ? "dark" : "light");
    return;
  }
  syncMeta(storedChoice);
}

function emit(): void {
  for (const fn of listeners) fn();
}

function ensureListeners(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  syncDocumentTheme();

  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  mq?.addEventListener("change", () => {
    systemDark = detectSystemDark();
    // Never clear storedChoice retroactively on OS day/night transitions (`dark-mode-toggle` rule).
    syncDocumentTheme();
    emit();
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== SCHEME_KEY) return;
    storedChoice = readInitialChoice();
    syncDocumentTheme();
    emit();
  });

  const handleHostThemeUpdate = (payload?: unknown) => {
    const parsed = parseThemePayload(payload);
    if (parsed !== null) lastOrcaEventDark = parsed;
    cachedOrcaRawBg = null;
    systemDark = detectSystemDark();
    syncDocumentTheme();
    emit();
  };

  subscribeOrcaHostTheme(handleHostThemeUpdate);

  if (isOrcaPluginFrame() && typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver(() => {
      cachedOrcaRawBg = null;
      const prev = cachedSnapshot.rendered;
      systemDark = detectSystemDark();
      syncDocumentTheme();
      if (getSnapshot().rendered !== prev) emit();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => handleHostThemeUpdate());
    }
  }
}

function subscribe(fn: () => void): () => void {
  ensureListeners();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export interface ColorSchemeState {
  rendered: "light" | "dark";
  stored: ColorSchemeChoice;
  pluginManaged: boolean;
}

let cachedSnapshot: ColorSchemeState = {
  rendered: storedChoice ?? (systemDark ? "dark" : "light"),
  stored: storedChoice,
  pluginManaged: false,
};

function getSnapshot(): ColorSchemeState {
  const orcaDark = detectOrcaCssDark();
  const pluginManaged = orcaDark !== null;
  const rendered: "light" | "dark" = pluginManaged
    ? orcaDark
      ? "dark"
      : "light"
    : storedChoice ?? (systemDark ? "dark" : "light");

  if (
    cachedSnapshot.rendered !== rendered ||
    cachedSnapshot.stored !== storedChoice ||
    cachedSnapshot.pluginManaged !== pluginManaged
  ) {
    cachedSnapshot = { rendered, stored: storedChoice, pluginManaged };
  }
  return cachedSnapshot;
}

export function useColorScheme(): ColorSchemeState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Two-state comfort toggle backed by tri-state storage (`light dark`, `light`, `dark`):
 * checks OS divergence ONLY at toggle time, reverting to system preference when the
 * requested scheme matches the current OS scheme.
 */
export function toggleColorScheme(): void {
  ensureListeners();
  const current = getSnapshot().rendered;
  const target: "light" | "dark" = current === "dark" ? "light" : "dark";
  const osScheme: "light" | "dark" = detectSystemDark() ? "dark" : "light";
  const nextStored: ColorSchemeChoice = target === osScheme ? null : target;
  storedChoice = nextStored;
  try {
    if (nextStored === null) localStorage.removeItem(SCHEME_KEY);
    else localStorage.setItem(SCHEME_KEY, nextStored);
  } catch {
    /* private mode — in-memory state still updates meta */
  }
  syncMeta(nextStored);
  emit();
}
