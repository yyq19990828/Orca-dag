import { useEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import "./run-health-popover.css";
import { fetchRemovedWork } from "../api";
import { COORDINATION_MODE_META, resolveCoordinationMode } from "../coordinationMode";
import { t, useT } from "../i18n";
import type { RemovedWorkEntryView, RemovedWorkPageView, RunHealthView } from "../types";
import { useRunHealth } from "../useRunHealth";
import { CoordinationModeIcon } from "./CoordinationModeIcon";

/**
 * Compact Run orchestration-mode & health indicator (operations epic O2).
 *
 * Sits beside the Run selector in the full workbench, or at the bottom of
 * the Orca sidebar, and answers two operational questions at a glance:
 *  - which coordination mode is active (Human · Panel, Agent · Orca Native Chat,
 *    Agent · External Terminal PTY, Panel mismatch, Unbound, or Unknown), and
 *    whether this panel is active control or read-only observation;
 *  - whether any evidence-backed health warnings exist (a failed read renders
 *    as "unknown", never as a reassuring zero).
 *
 * Accepts an optional parent-owned `health` snapshot so App / SidebarApp share
 * a single `/api/run-health` poll; falls back to its own `useRunHealth` poll
 * when mounted standalone.
 */

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

export function RunHealthBadge({
  runId,
  health: providedHealth,
  sidebar = false,
}: {
  runId: string;
  /** Optional shared snapshot from parent `useRunHealth`; omits duplicate polling when passed. */
  health?: RunHealthView | null;
  /** The sidebar capsule includes the handle and opens its popover upward. */
  sidebar?: boolean;
}) {
  const t = useT();
  const pollOwn = providedHealth === undefined;
  const { health: polledHealth } = useRunHealth(runId, pollOwn);
  const health = pollOwn ? polledHealth : providedHealth;
  const [open, setOpen] = useState(false);
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

  useEffect(() => {
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

  if (!runId || !health) return null;

  const mode = resolveCoordinationMode(health);
  const meta = COORDINATION_MODE_META[mode];
  const warningCount = health.warnings.filter((w) => w.severity === "warning").length;
  const infoCount = health.warnings.length - warningCount;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className="runhealth">
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`runhealth__chip runhealth__chip--${meta.tone}`}
          title={`${t(meta.label)} — ${t(meta.brief)}\n${health.ownershipDetail}`}
        >
          <CoordinationModeIcon mode={mode} size={sidebar ? 11 : 13} />
          <span className="runhealth__chip-label">{t(meta.shortLabel)}</span>
          {sidebar && health.coordinatorHandle && (
            <code className="runhealth__chip-handle">{health.coordinatorHandle}</code>
          )}
          {warningCount > 0 && <b className="runhealth__flag">{warningCount}</b>}
          {warningCount === 0 && infoCount > 0 && <span className="runhealth__info-dot">i</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="runhealth__panel runhealth__panel--popover"
          role="region"
          aria-label={t("health.panelAria")}
          sideOffset={8}
          side={sidebar ? "top" : "bottom"}
          align={sidebar ? "center" : "end"}
          collisionPadding={12}
        >
          <div className="runhealth__row">
            <span className="runhealth__key">{t("health.modeKey")}</span>
            <span className="runhealth__val runhealth__val--mode">
              <CoordinationModeIcon mode={mode} size={13} />
              <strong>{t(meta.label)}</strong>
            </span>
          </div>
          <div className="runhealth__row">
            <span className="runhealth__key">{t("health.carrierKey")}</span>
            <span className="runhealth__val">
              {t(meta.carrier)}
              {health.coordinatorHandle ? (
                <>
                  {" · "}
                  <code className="runhealth__handle">{health.coordinatorHandle}</code>
                </>
              ) : null}
              {health.consumerGeneration !== null
                ? t("health.generation", { n: health.consumerGeneration })
                : ""}
            </span>
          </div>
          <div className="runhealth__row">
            <span className="runhealth__key">{t("health.panelRoleKey")}</span>
            <span className="runhealth__val">{t(meta.panelRole)}</span>
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
          <p className="runhealth__detail">{t(meta.brief)}</p>
          <p className="runhealth__detail runhealth__detail--verbatim">{health.ownershipDetail}</p>
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
        </Popover.Content>
      </Popover.Portal>
      </div>
    </Popover.Root>
  );
}
