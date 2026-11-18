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

function detectSystemDark(): boolean {
  if (typeof window === "undefined") return false;
  if (document.documentElement.classList.contains("dark")) return true;
  if (document.documentElement.classList.contains("light")) return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function syncMeta(choice: ColorSchemeChoice): void {
  if (typeof document === "undefined") return;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.setAttribute("content", choice ?? "light dark");
  }
}

function emit(): void {
  for (const fn of listeners) fn();
}

function ensureListeners(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  syncMeta(storedChoice);

  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  mq?.addEventListener("change", () => {
    systemDark = detectSystemDark();
    // Never clear storedChoice retroactively on OS day/night transitions (`dark-mode-toggle` rule).
    emit();
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== SCHEME_KEY) return;
    storedChoice = readInitialChoice();
    syncMeta(storedChoice);
    emit();
  });

  subscribeOrcaHostTheme(() => {
    systemDark = detectSystemDark();
    emit();
  });
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
  const pluginManaged = isOrcaPluginFrame() &&
    (document.documentElement.classList.contains("dark") ||
      document.documentElement.classList.contains("light"));
  const rendered: "light" | "dark" = pluginManaged
    ? document.documentElement.classList.contains("dark")
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
