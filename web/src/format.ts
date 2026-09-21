import type { ActivityEvent } from "./types";

/**
 * Shared presentation helpers (Phase 7 integration).
 *
 * Phases 1–6 each grew a small private date/priority formatter, and by
 * integration time five components carried near-identical copies. One module
 * now owns them so the LABELS can never drift between panels (e.g. Chat and
 * Activity disagreeing about what counts as "Urgent"). Pure functions only —
 * no React, no store access — so every panel can import them cheaply.
 *
 * Every formatter is total over garbage input: an unparseable date renders as
 * the raw string rather than "Invalid Date", because an absent/odd timestamp
 * is display noise, never a reason to crash a panel.
 */

function format(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function parse(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "HH:mm" — intra-day timeline stamps (Chat message bubbles). */
export function formatClock(iso: string): string {
  const date = parse(iso);
  if (!date) return iso;
  return format(date, { hour: "2-digit", minute: "2-digit" });
}

/** "Mon D, HH:mm" — dated stamps where seconds are noise (Node results, Chat day headers). */
export function formatDateTime(iso: string): string {
  const date = parse(iso);
  if (!date) return iso;
  return format(date, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "Mon D, HH:mm:ss" — audit-grade stamps where seconds carry meaning (Activity, request ledger). */
export function formatTimestamp(iso: string): string {
  const date = parse(iso);
  if (!date) return iso;
  return format(date, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Coarse relative age for inbox/cleanup rows ("42s ago", "7m ago", "3h ago"). */
export function timeAgo(iso: string): string {
  const date = parse(iso);
  if (!date) return iso;
  const s = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/**
 * Only Orca's own high/urgent priorities may render the urgent flag. The
 * priority string is normalized defensively (trim + case-fold) because the
 * value round-trips from Orca rows, the viewer journal, and the group-send
 * receipt, and an invented variant must never escalate presentation.
 */
const URGENT_PRIORITIES = new Set(["high", "urgent"]);

export function isUrgent(event: Pick<ActivityEvent, "priority">): boolean {
  return event.priority != null && URGENT_PRIORITIES.has(event.priority.trim().toLowerCase());
}

/**
 * Human label for an Orca priority. "high"/"urgent" are the escalation
 * labels; low/normal exist so group-send metadata can render a chip without
 * each panel re-deriving its own wording.
 */
export function priorityLabel(event: Pick<ActivityEvent, "priority">): string {
  const normalized = event.priority?.trim().toLowerCase();
  if (normalized === "urgent") return "Urgent";
  if (normalized === "low") return "Low priority";
  if (normalized === "normal") return "Normal priority";
  return "High priority";
}
