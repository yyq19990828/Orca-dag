import { useEffect, useRef, useState } from "react";
import { fetchRemovedWork, fetchRunHealth } from "../api";
import { t, useT, type TranslationKey } from "../i18n";
import type { RemovedWorkEntryView, RemovedWorkPageView, RunHealthView, RunOwnershipState } from "../types";
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
  const [showRemoved, setShowRemoved] = useState(false);
  const [removedPages, setRemovedPages] = useState<RemovedWorkEntryView[]>([]);
  const [removedCursor, setRemovedCursor] = useState<string | null>(null);
  const [removedHasMore, setRemovedHasMore] = useState(false);
  const [removedLoaded, setRemovedLoaded] = useState(false);
  const [removedLoading, setRemovedLoading] = useState(false);
  const [removedError, setRemovedError] = useState(false);
  const requestGeneration = useRef(0);
  const seenCursors = useRef(new Set<string>());
  const inFlightPage = useRef<{ runId: string; cursor: string | undefined } | null>(null);

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
  useEffect(() => {
    setHealth(null);
    requestGeneration.current += 1;
    setShowRemoved(false);
    setRemovedPages([]);
    setRemovedCursor(null);
    setRemovedHasMore(false);
    setRemovedLoaded(false);
    setRemovedLoading(false);
    inFlightPage.current = null;
    seenCursors.current.clear();
    setRemovedError(false);
  }, [runId]);

  const loadRemoved = async (cursor?: string) => {
    if (inFlightPage.current?.runId === runId && inFlightPage.current.cursor === cursor) return;
    if (cursor !== undefined && seenCursors.current.has(cursor)) {
      setRemovedError(true);
      setRemovedHasMore(false);
      return;
    }
    const generation = requestGeneration.current;
    const request = { runId, cursor };
    inFlightPage.current = request;
    setRemovedLoading(true);
    setRemovedError(false);
    try {
      const page: RemovedWorkPageView = await fetchRemovedWork(runId, cursor);
      if (generation !== requestGeneration.current) return;
      if (
        page.page.hasMore &&
        page.page.nextCursor !== null &&
        (page.page.nextCursor === cursor || seenCursors.current.has(page.page.nextCursor))
      ) {
        setRemovedError(true);
        setRemovedHasMore(false);
        return;
      }
      setRemovedLoaded(true);
      if (cursor !== undefined) seenCursors.current.add(cursor);
      setRemovedPages((old) => cursor === undefined ? page.entries : [...old, ...page.entries]);
      setRemovedCursor(page.page.nextCursor);
      setRemovedHasMore(page.page.hasMore);
    } catch {
      if (generation === requestGeneration.current) setRemovedError(true);
    } finally {
      if (inFlightPage.current === request) {
        inFlightPage.current = null;
        if (generation === requestGeneration.current) setRemovedLoading(false);
      }
    }
  };

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
          <section className="runhealth__removed" aria-label={t("health.removed.title")}>
            <h3>{t("health.removed.title")}</h3>
            {health.removedWork ? (
              <>
                <p>{t("health.removed.summary", {
                  tasks: health.removedWork.tasks,
                  dispatches: health.removedWork.dispatches,
                  workers: health.removedWork.workers,
                  terminals: health.removedWork.terminals,
                })}</p>
                <p>{t(
                  health.removedWork.coverage === "complete" ? "health.removed.coverage.complete" : "health.removed.coverage.partial",
                  { since: health.removedWork.recordedSince },
                )}</p>
                {health.removedWork.lastRemovedAt && <p>{t("health.removed.last", { at: health.removedWork.lastRemovedAt })}</p>}
                <p className={health.removedWork.activeWorkersAtRemoval > 0 ? "runhealth__removed-warning" : undefined}>
                  {t("health.removed.active", { n: health.removedWork.activeWorkersAtRemoval })}
                </p>
              </>
            ) : <p>{t("health.removed.unavailable")}</p>}
            <button type="button" aria-expanded={showRemoved} onClick={() => {
              const next = !showRemoved;
              setShowRemoved(next);
              if (next && !removedLoaded) void loadRemoved();
            }}>{t(showRemoved ? "health.removed.close" : "health.removed.open")}</button>
            {showRemoved && (
              <div className="runhealth__removed-list" aria-live="polite">
                {removedLoading && <p>{t("health.removed.loading")}</p>}
                {removedError && <p role="alert">{t("health.removed.error")}</p>}
                {!removedLoading && !removedError && removedLoaded && removedPages.length === 0 && <p>{t("health.removed.empty")}</p>}
                <ul>
                  {removedPages.map((entry) => (
                    <li key={`${entry.seq}:${entry.id}`}>
                      <span>{entry.unreadable
                        ? t("health.removed.unreadable", { kind: entry.kind, id: entry.id, at: entry.removedAt })
                        : t("health.removed.entry", { kind: entry.kind, id: entry.id, at: entry.removedAt })}</span>
                      {entry.activeAtRemoval === true && <small>{t("health.removed.activeEntry")}</small>}
                    </li>
                  ))}
                </ul>
                {removedHasMore && removedCursor !== null && <button type="button" disabled={removedLoading} onClick={() => void loadRemoved(removedCursor)}>{t("health.removed.loadMore")}</button>}
                {!removedHasMore && removedPages.length > 0 && <p>{t("health.removed.end")}</p>}
              </div>
            )}
          </section>
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
