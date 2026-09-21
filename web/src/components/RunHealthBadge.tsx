import { useEffect, useRef, useState } from "react";
import { fetchRunHealth } from "../api";
import type { RunHealthView, RunOwnershipState } from "../types";

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
 * five Orca reads; the server additionally shares a short cache.
 */

const OWNERSHIP_META: Record<
  RunOwnershipState,
  { label: string; tone: "ok" | "warn" | "bad" | "muted"; brief: string }
> = {
  viewer_coordinator: {
    label: "Viewer-owned",
    tone: "ok",
    brief: "This viewer's live coordinator owns the Run.",
  },
  viewer_coordinator_other_run: {
    label: "Viewer bound · Run mismatch",
    tone: "warn",
    brief: "The viewer's coordinator terminal is bound here but the loop reports another Run.",
  },
  external_coordinator: {
    label: "External coordinator",
    tone: "warn",
    brief: "Another terminal is bound as coordinator; starting here would fence it.",
  },
  unbound: {
    label: "No coordinator",
    tone: "muted",
    brief: "No coordinator terminal is bound to this Run.",
  },
  unverifiable: {
    label: "Ownership unknown",
    tone: "bad",
    brief: "The Run record could not be read, so ownership cannot be verified.",
  },
};

const POLL_MS = 5_000;

function formatCounts(health: RunHealthView): string {
  // A failed read renders as "—" (unknown), never as a reassuring zero.
  const c = health.counts;
  const n = (v: number | null): string => (v === null ? "—" : String(v));
  const gates = c.pendingGates === null ? n(c.gates) : `${n(c.gates)} (${c.pendingGates} pending)`;
  return `Tasks ${n(c.tasks)} · Messages ${n(c.messages)} · Workers ${n(c.workers)} · Gates ${gates}`;
}

export function RunHealthBadge({ runId }: { runId: string }) {
  const [health, setHealth] = useState<RunHealthView | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!runId) {
      setHealth(null);
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
  }, [runId]);

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
        title={`${meta.brief}\n${health.ownershipDetail}`}
      >
        {meta.label}
        {warningCount > 0 && <b className="runhealth__flag">{warningCount}</b>}
        {warningCount === 0 && infoCount > 0 && <span className="runhealth__info-dot">i</span>}
      </button>
      {open && (
        <div className="runhealth__panel" role="region" aria-label="Run ownership and health">
          <div className="runhealth__row">
            <span className="runhealth__key">Ownership</span>
            <span className="runhealth__val">
              {meta.label}
              {health.coordinatorHandle ? ` · ${health.coordinatorHandle}` : ""}
              {health.consumerGeneration !== null ? ` · generation ${health.consumerGeneration}` : ""}
            </span>
          </div>
          <div className="runhealth__row">
            <span className="runhealth__key">Evidence</span>
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
              {health.evidenceComplete ? "No warnings — the reads that back this view all succeeded." : "No warnings, but some reads failed."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
