import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchActivity,
  releaseWorker,
  replyToMessage,
  retainWorker,
  retryWorker,
} from "../api";
import type { ActivityEvent, ActivitySnapshot } from "../types";
import { formatTimestamp, isUrgent, priorityLabel } from "../format";
import { t, useT, type TranslationKey } from "../i18n";

type ActivityFilter = "all" | "coordinator" | "agents" | "needs_reply";
type ActivityTransport = "connecting" | "live" | "polling";

/** Filter tab -> dictionary key, so the tab list stays data. */
const FILTER_KEY: Record<ActivityFilter, TranslationKey> = {
  all: "activity.filter.all",
  coordinator: "activity.filter.coordinator",
  agents: "activity.filter.agents",
  needs_reply: "activity.filter.needsReply",
};

/** Transport state -> dictionary key (SSE live vs. the polling fallback). */
const TRANSPORT_KEY: Record<ActivityTransport, TranslationKey> = {
  connecting: "activity.transport.connecting",
  live: "activity.transport.live",
  polling: "activity.transport.polling",
};

const EMPTY: ActivitySnapshot = {
  runId: "",
  events: [],
  presence: [],
  checks: [],
  pendingCount: 0,
  truncated: false,
  inboxWindow: null,
  generatedAt: 0,
};

function technicalJson(event: ActivityEvent): string {
  return JSON.stringify(
    {
      messageId: event.technical.messageId,
      taskId: event.taskId,
      dispatchId: event.dispatchId,
      threadId: event.threadId,
      priority: event.priority,
      // Tri-state: null survives JSON round-trip so "unknown" stays distinct
      // from an explicit false in the diagnostic dump.
      read: event.read === null ? null : event.read,
      terminalHandle: event.technical.terminalHandle,
      provenance: event.technical.provenance,
      argv: event.technical.argv,
      payload: event.technical.payload,
    },
    null,
    2,
  );
}

function provenanceLabel(event: ActivityEvent): { text: string; title: string } | null {
  switch (event.technical.provenance) {
    case "viewer_journal":
      return {
        text: t("activity.provenance.viewerJournal"),
        title: t("activity.provenance.viewerJournalTitle"),
      };
    case "coordinator":
      return {
        text: t("activity.provenance.coordinator"),
        title: t("activity.provenance.coordinatorTitle"),
      };
    default:
      // `orca_message` is the authoritative default and needs no label;
      // `fleet` rows are presence data, not chat history.
      return null;
  }
}

/**
 * A Run-scoped work log, not a synthetic chat transcript. Orca lifecycle
 * messages remain authoritative; this component only presents the server's
 * normalized projection and exposes actions when the event is still pending.
 */
export const ActivityPanel = memo(function ActivityPanel({
  runId,
  onSelectTask,
  onResolved,
  onPendingCount,
  onSnapshot,
  disabled = false,
  disabledReason,
}: {
  runId: string;
  onSelectTask: (taskId: string) => void;
  onResolved: () => void;
  onPendingCount: (count: number) => void;
  onSnapshot?: (snapshot: ActivitySnapshot) => void;
  disabled?: boolean;
  disabledReason?: string | null;
}) {
  // Timestamps and priority chips come from format.ts, whose language access
  // is intentionally non-reactive — this subscription is what re-renders the
  // memo()'d panel when the UI language changes.
  const t = useT();
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(EMPTY);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [transport, setTransport] = useState<ActivityTransport>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestSeq = useRef(0);
  // Identical snapshots must not reach App state: every apply re-renders the
  // Chat panel and re-runs its timeline memoization. Compare by JSON — the
  // projection only produces a new object when something actually changed,
  // but SSE re-pushes the current snapshot on its own cadence too.
  const lastSnapshotJson = useRef<string>("");

  const applySnapshot = useCallback(
    (next: ActivitySnapshot) => {
      if (next.runId !== runId) return;
      const json = JSON.stringify(next);
      if (json === lastSnapshotJson.current) return;
      lastSnapshotJson.current = json;
      setSnapshot(next);
      onPendingCount(next.pendingCount);
      onSnapshot?.(next);
      setError(null);
    },
    [onPendingCount, onSnapshot, runId],
  );

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    if (!runId) {
      setSnapshot(EMPTY);
      onPendingCount(0);
      onSnapshot?.(EMPTY);
      return;
    }
    try {
      const next = await fetchActivity(runId);
      if (seq === requestSeq.current) applySnapshot(next);
    } catch (err) {
      if (seq === requestSeq.current) setError(String((err as Error).message ?? err));
    }
  }, [applySnapshot, onPendingCount, onSnapshot, runId]);

  useEffect(() => {
    setSnapshot({ ...EMPTY, runId });
    onSnapshot?.({ ...EMPTY, runId });
    // the fingerprint must not outlive the Run switch, or a quiet Run whose
    // fresh snapshot matches the pre-switch bytes would be skipped as a no-op
    lastSnapshotJson.current = "";
    setDrafts({});
    setTransport("connecting");
    onPendingCount(0);
    if (!runId) return;

    let alive = true;
    let pollTimer: number | null = null;
    // While the tab is hidden, SSE pushes and polls are dropped (a hidden
    // tab cannot show them, and Orca's embedded browser never throttles the
    // timers behind them). The first visible transition re-syncs.
    let dirtyWhileHidden = false;
    const onHide = () => {
      if (document.visibilityState !== "visible" || !dirtyWhileHidden) return;
      dirtyWhileHidden = false;
      void refresh();
    };
    const markDirtyIfHidden = () => {
      if (document.visibilityState === "visible") return false;
      dirtyWhileHidden = true;
      return true;
    };
    document.addEventListener("visibilitychange", onHide);

    let source: EventSource | null = new EventSource(`/api/activity/stream?run=${encodeURIComponent(runId)}`);
    void refresh();
    source.onopen = () => {
      if (alive) setTransport("live");
    };
    source.onmessage = (message) => {
      if (!alive || markDirtyIfHidden()) return;
      try {
        applySnapshot(JSON.parse(message.data) as ActivitySnapshot);
        setTransport("live");
      } catch {
        setError(t("activity.streamError"));
      }
    };
    source.onerror = () => {
      if (!alive || pollTimer !== null) return;
      // EventSource reconnects forever by default. Falling back explicitly
      // gives the user a stable 2s path through proxies that buffer SSE.
      source.close();
      setTransport("polling");
      if (!markDirtyIfHidden()) void refresh();
      pollTimer = window.setInterval(() => {
        if (!markDirtyIfHidden()) void refresh();
      }, 2_000);
    };
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onHide);
      source?.close();
      if (pollTimer !== null) window.clearInterval(pollTimer);
    };
  }, [applySnapshot, onPendingCount, onSnapshot, refresh, runId]);

  const visible = useMemo(
    () =>
      snapshot.events.filter((event) => {
        if (filter === "coordinator") return event.direction !== "agent_to_coordinator";
        if (filter === "agents") return event.direction === "agent_to_coordinator";
        if (filter === "needs_reply") return event.actionable?.kind === "reply";
        return true;
      }),
    [filter, snapshot.events],
  );

  async function runAction(event: ActivityEvent, action: "reply" | "release" | "retain" | "retry") {
    if (!event.actionable || disabled || busyId) return;
    const targetId = event.actionable.targetId;
    setBusyId(event.id);
    setError(null);
    try {
      if (action === "reply") {
        const body = (drafts[event.id] ?? "").trim();
        if (!body) return;
        await replyToMessage(targetId, body, runId);
        setDrafts(({ [event.id]: _drop, ...rest }) => rest);
      } else if (action === "release") {
        await releaseWorker(targetId);
      } else if (action === "retain") {
        await retainWorker(targetId);
      } else {
        await retryWorker(targetId);
      }
      await refresh();
      onResolved();
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusyId(null);
    }
  }

  if (!runId) {
    return <div className="activity__empty">{t("activity.empty.pickRun")}</div>;
  }

  return (
    <section className="activity" aria-label={t("activity.aria.section")}>
      <div className="activity__tools">
        <div className="activity__filters" role="group" aria-label={t("activity.aria.filters")}>
          {([
            "all",
            "coordinator",
            "agents",
            "needs_reply",
          ] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={filter === value ? "active" : ""}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {t(FILTER_KEY[value])}
              {value === "needs_reply" && snapshot.pendingCount > 0 ? (
                <span className="activity__count">{snapshot.pendingCount}</span>
              ) : null}
            </button>
          ))}
        </div>
        <span className={`activity__transport activity__transport--${transport}`}>
          <span aria-hidden="true" /> {t(TRANSPORT_KEY[transport])}
        </span>
      </div>

      {snapshot.truncated && (
        <div className="activity__notice">{t("activity.truncated")}</div>
      )}
      {snapshot.inboxWindow?.saturated && (
        // Saturation is global-window evidence, so the warning fires even when
        // this Run shows only a handful of messages — few rows here do not
        // mean the Run's history was always this short.
        <div className="activity__notice activity__notice--warning" role="status">
          {t("activity.historyWarning", {
            observed: snapshot.inboxWindow.observed,
            limit: snapshot.inboxWindow.limit,
          })}
        </div>
      )}
      {error && <div className="activity__error" role="status">⚠ {error}</div>}

      <div className="activity__timeline" aria-live="polite">
        {visible.length === 0 ? (
          <div className="activity__empty">
            {filter === "needs_reply" ? t("activity.empty.needsReply") : t("activity.empty.none")}
          </div>
        ) : (
          visible.map((event) => (
            <article
              key={event.id}
              className={`activity-event activity-event--${event.severity} activity-event--${event.actor.role}`}
            >
              <div className="activity-event__rail" aria-hidden="true">
                <span />
              </div>
              <div className="activity-event__content">
                <div className="activity-event__meta">
                  <span className="activity-event__actor">{event.actor.label}</span>
                  {event.actor.role === "lead" && <span className="activity-event__lead">{t("activity.lead")}</span>}
                  {(() => {
                    const provenance = provenanceLabel(event);
                    return provenance ? (
                      <span className="activity-event__flag" title={provenance.title}>
                        {provenance.text}
                      </span>
                    ) : null;
                  })()}
                  {isUrgent(event) && (
                    <span className="activity-event__flag activity-event__flag--urgent" title={t("priority.orcaTitle", { priority: event.priority ?? "" })}>
                      {priorityLabel(event)}
                    </span>
                  )}
                  {event.read === false && (
                    <span className="activity-event__flag activity-event__flag--unread" title={t("activity.unreadTitle")}>
                      {t("activity.unread")}
                    </span>
                  )}
                  {event.actor.harness && (
                    <span>{event.actor.harness}{event.actor.model ? ` · ${event.actor.model}` : ""}</span>
                  )}
                  <time dateTime={event.createdAt}>{formatTimestamp(event.createdAt)}</time>
                </div>
                <h3>{event.title}</h3>
                {event.threadId && (
                  // Reply relationships render only from Orca's own thread_id;
                  // without it no linkage is claimed.
                  <p className="activity-event__thread">{t("activity.thread", { id: event.threadId })}</p>
                )}
                <p>{event.summary}</p>
                {event.groupedCount > 1 && (
                  <span className="activity-event__grouped">{t("activity.grouped", { n: event.groupedCount })}</span>
                )}
                {event.taskId && (
                  <button
                    type="button"
                    className="activity-event__task"
                    onClick={() => onSelectTask(event.taskId!)}
                  >
                    {t("activity.openStage", { id: event.taskId })}
                  </button>
                )}

                {event.actionable?.kind === "reply" && (
                  <div className="activity-event__reply">
                    <textarea
                      rows={2}
                      placeholder={disabled ? t("activity.reply.unavailable") : t("activity.reply.placeholder")}
                      value={drafts[event.id] ?? ""}
                      disabled={disabled || busyId === event.id}
                      onChange={(e) => setDrafts((current) => ({ ...current, [event.id]: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="btn btn--ok"
                      disabled={disabled || busyId === event.id || !(drafts[event.id] ?? "").trim()}
                      title={disabled ? disabledReason ?? t("activity.reply.unavailableTitle") : t("activity.reply.title")}
                      onClick={() => void runAction(event, "reply")}
                    >
                      {busyId === event.id ? t("activity.sending") : t("activity.reply.button")}
                    </button>
                  </div>
                )}

                {event.actionable?.kind === "release" && (
                  <div className="activity-event__actions">
                    <button type="button" className="btn btn--ok" disabled={disabled || Boolean(busyId)} onClick={() => void runAction(event, "release")}>{t("activity.release")}</button>
                    <button type="button" className="btn" disabled={disabled || Boolean(busyId)} onClick={() => void runAction(event, "retain")}>{t("activity.retain")}</button>
                  </div>
                )}
                {event.actionable?.kind === "retry" && (
                  <button type="button" className="btn" disabled={disabled || Boolean(busyId)} onClick={() => void runAction(event, "retry")}>{t("activity.retry")}</button>
                )}

                {Boolean(event.detail || event.technical.messageId || event.dispatchId || event.technical.argv || event.technical.payload) && (
                  <details className="activity-event__details">
                    <summary>{t("activity.details")}</summary>
                    {event.detail && <p>{event.detail}</p>}
                    <pre>{technicalJson(event)}</pre>
                  </details>
                )}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
});
