import { useEffect, useRef, useState } from "react";
import { fetchRunHealth } from "../api";
import { t, useT, type TranslationKey } from "../i18n";
import type { RunHealthView, RunOwnershipState } from "../types";
import { usePageVisible } from "../visibility";

/**
 * Compact Run ownership/health indicator (operations epic O2, Phase 1).
 *
 * Sits next to the Run selector and answers the first operational question —
 * who owns this Run, and is anything visibly wrong — without raw JSON:
 *  - ownership comes from Orca's Run record (run-show) combined with this
 *    viewer's process-local coordinator state, so an externally-bound Run is
 *    named as external rather than silently looking editable;
 *  - warnings are evidence-based on the server side; this component only
 *    renders them. A failed read shows as "unknown", never as a zero.
 *
 * Polls slower than the DAG (5s) because each health projection fans out to
 * five Orca reads; the server additionally shares a short cache. Paused
 * entirely while the tab is hidden — five fan-out reads per tick is exactly
 * the work nobody needs from a background page — and the effect re-run on
 * becoming visible delivers the single immediate refresh before the next
 * interval tick.
 */

const OWNERSHIP_META: Record<
  RunOwnershipState,
  { label: TranslationKey; tone: "ok" | "warn" | "bad" | "muted"; brief: TranslationKey }
> = {
  viewer_coordinator: {
    label: "health.ownership.viewer.label",
    tone: "ok",
    brief: "health.ownership.viewer.brief",
  },
  viewer_coordinator_other_run: {
    label: "health.ownership.otherRun.label",
    tone: "warn",
    brief: "health.ownership.otherRun.brief",
  },
  external_coordinator: {
    label: "health.ownership.external.label",
    tone: "warn",
    brief: "health.ownership.external.brief",
  },
  unbound: {
    label: "health.ownership.unbound.label",
    tone: "muted",
    brief: "health.ownership.unbound.brief",
  },
  unverifiable: {
    label: "health.ownership.unverifiable.label",
    tone: "bad",
    brief: "health.ownership.unverifiable.brief",
  },
};

const POLL_MS = 5_000;

function formatCounts(health: RunHealthView): string {
  // A failed read renders as "—" (unknown), never as a reassuring zero. The
  // non-reactive `t` is fine here: the badge subscribes through useT().
  const c = health.counts;
  const n = (v: number | null): string => (v === null ? "—" : String(v));
  const gates =
    c.pendingGates === null
      ? n(c.gates)
      : t("health.gatesPending", { gates: n(c.gates), pending: c.pendingGates });
  return t("health.counts", {
    tasks: n(c.tasks),
    messages: n(c.messages),
    workers: n(c.workers),
    gates,
  });
}

export function RunHealthBadge({ runId }: { runId: string }) {
  const t = useT();
  const [health, setHealth] = useState<RunHealthView | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const visible = usePageVisible();
  useEffect(() => {
    // Paused while hidden: no health fan-out reads from a background page.
    // The effect re-run on becoming visible is the one immediate refresh.
    if (!runId || !visible) {
      if (!runId) setHealth(null);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const next = await fetchRunHealth(runId);
        // A Run switch must not paint the previous Run's health.
        if (alive) setHealth(next);
      } catch {
        // Polling noise (viewer restarting, Orca busy) keeps the last known
        // state; the badge never invents an ownership verdict from an error.
      }
    };
    void load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [runId, visible]);

  // Close the popover when clicking anywhere else — the badge is a peek panel.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (!runId || !health) return null;

  const meta = OWNERSHIP_META[health.ownership];
  const warningCount = health.warnings.filter((w) => w.severity === "warning").length;
  const infoCount = health.warnings.length - warningCount;

  return (
    <div className="runhealth" ref={wrapRef}>
      <button
        type="button"
        className={`runhealth__chip runhealth__chip--${meta.tone}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`${t(meta.brief)}\n${health.ownershipDetail}`}
      >
        {t(meta.label)}
        {warningCount > 0 && <b className="runhealth__flag">{warningCount}</b>}
        {warningCount === 0 && infoCount > 0 && <span className="runhealth__info-dot">i</span>}
      </button>
      {open && (
        <div className="runhealth__panel" role="region" aria-label={t("health.panelAria")}>
          <div className="runhealth__row">
            <span className="runhealth__key">{t("health.ownershipKey")}</span>
            <span className="runhealth__val">
              {t(meta.label)}
              {health.coordinatorHandle ? ` · ${health.coordinatorHandle}` : ""}
              {health.consumerGeneration !== null
                ? t("health.generation", { n: health.consumerGeneration })
                : ""}
            </span>
          </div>
          <div className="runhealth__row">
            <span className="runhealth__key">{t("health.evidenceKey")}</span>
            <span className="runhealth__val">{formatCounts(health)}</span>
          </div>
          <p className="runhealth__detail">{health.ownershipDetail}</p>
          {health.warnings.length > 0 ? (
            <ul className="runhealth__warnings">
              {health.warnings.map((w) => (
                <li key={w.code} className={`runhealth__warning runhealth__warning--${w.severity}`}>
                  <span aria-hidden="true">{w.severity === "warning" ? "⚠" : "ⓘ"}</span> {w.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="runhealth__clean">
              {health.evidenceComplete ? t("health.clean") : t("health.cleanPartial")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
