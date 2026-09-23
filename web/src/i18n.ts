// UI language store + translator. Zero-dependency by design — this repo has
// no runtime deps beyond react/flow/dagre, and a small module beats a
// framework for two languages. Parity between en/zh is enforced by the type
// system (zh: Record<TranslationKey, string>), so `npm run typecheck` fails
// on any missing or extra key — no separate check script needed.

import { useSyncExternalStore } from "react";
import { en } from "./i18n/en";
import { zh } from "./i18n/zh";

export type Lang = "en" | "zh";
const LANG_KEY = "orca-dag:lang";

export type TranslationKey = keyof typeof en;
export type Dict = Record<TranslationKey, string>;
export type Params = Record<string, string | number>;

// Readonly at both levels: nothing may add a language or rewrite a key at
// runtime (tests included — the parity guarantee lives in the type system).
export const TRANSLATIONS: Readonly<Record<Lang, Readonly<Dict>>> = { en, zh };

let lang: Lang = detectLang();
const listeners = new Set<() => void>();

function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === "en" || stored === "zh") return stored;
  } catch {
    /* private mode — fall through to navigator */
  }
  // Guard the navigator GLOBAL, not just the property: `?.` would not stop a
  // ReferenceError in a non-DOM runtime (node tests, workers), and this
  // module is imported for its side-effect-free API — it must not throw on
  // import. Guarding here (not moving the return into the try above) keeps
  // zh detection alive when localStorage itself throws in private mode.
  const nav = typeof navigator === "undefined" ? "" : navigator.language;
  return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}

// Hoisted and shared across every consumer (same shape as harness.ts): React
// keys its store subscription on the subscribe function's identity, so an
// inline closure would tear down and re-add the listener on every render of
// every useT() component.
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getLang(): Lang {
  return lang;
}

/** Reactive access to the active UI language (re-renders consumers on switch). */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang);
}

/** Subscribe-and-return-the-translator hook — the one-line per-component wiring. */
export function useT(): (key: TranslationKey, params?: Params) => string {
  useLang();
  return t;
}

export function setLang(next: Lang): void {
  if (next === lang) {
    // Same-as-detected choices don't write: the value is identical, and the
    // toggle only ever offers the *other* language, so nothing explicit is lost.
    return;
  }
  lang = next;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    /* private mode — in-memory choice still works this session */
  }
  for (const fn of listeners) fn();
}

/** BCP47 locale for Intl formatters; "en" keeps the runtime default. */
export function langLocale(): string {
  return lang === "zh" ? "zh-CN" : "en";
}

/**
 * Plain-text lookup with {name} interpolation. NON-REACTIVE: reads the
 * current language without subscribing, so React components must go through
 * `useT()` (only non-React formatters call `t` directly, relying on their
 * caller's subscription). Values are rendered as React text nodes — never
 * inject a `t()` result into HTML.
 */
export function t(key: TranslationKey, params?: Params): string {
  // The en fallback is unreachable while both dictionaries typecheck (parity
  // is type-enforced), but TRANSLATIONS is exported — it stays as a net for
  // mutated/partial dicts. Note `??` is nullish-only: an empty-string value
  // is returned as-is, by design.
  const template = TRANSLATIONS[lang][key] ?? en[key];
  if (!params) return template;
  // hasOwn, not `in`: tokens like {constructor} must resolve against the
  // caller's own params, never Object.prototype.
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : m,
  );
}
