import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchActivity,
  releaseWorker,
  replyToMessage,
  retainWorker,
  retryWorker,
} from "../api";
import type { ActivityEvent, ActivitySnapshot } from "../types";

type ActivityFilter = "all" | "coordinator" | "agents" | "needs_reply";

const EMPTY: ActivitySnapshot = {
  runId: "",
  events: [],
  presence: [],
  checks: [],
  pendingCount: 0,
  truncated: false,
  generatedAt: 0,
};

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function technicalJson(event: ActivityEvent): string {
  return JSON.stringify(
    {
      messageId: event.technical.messageId,
      taskId: event.taskId,
      dispatchId: event.dispatchId,
      terminalHandle: event.technical.terminalHandle,
      provenance: event.technical.provenance,
      argv: event.technical.argv,
      payload: event.technical.payload,
    },
    null,
    2,
  );
}

/**
 * A Run-scoped work log, not a synthetic chat transcript. Orca lifecycle
 * messages remain authoritative; this component only presents the server's
 * normalized projection and exposes actions when the event is still pending.
 */
export function ActivityPanel({
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
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(EMPTY);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [transport, setTransport] = useState<"connecting" | "live" | "polling">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const applySnapshot = useCallback(
    (next: ActivitySnapshot) => {
      if (next.runId !== runId) return;
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
    setDrafts({});
    setTransport("connecting");
    onPendingCount(0);
    if (!runId) return;

    let alive = true;
    let pollTimer: number | null = null;
    const source = new EventSource(`/api/activity/stream?run=${encodeURIComponent(runId)}`);
    void refresh();
    source.onopen = () => {
      if (alive) setTransport("live");
    };
    source.onmessage = (message) => {
      if (!alive) return;
      try {
        applySnapshot(JSON.parse(message.data) as ActivitySnapshot);
        setTransport("live");
      } catch {
        setError("Activity stream returned an unreadable update.");
      }
    };
    source.onerror = () => {
      if (!alive || pollTimer !== null) return;
      // EventSource reconnects forever by default. Falling back explicitly
      // gives the user a stable 2s path through proxies that buffer SSE.
      source.close();
      setTransport("polling");
      void refresh();
      pollTimer = window.setInterval(() => void refresh(), 2_000);
    };
    return () => {
      alive = false;
      source.close();
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
    return <div className="activity__empty">Pick a Run to see its activity.</div>;
  }

  return (
    <section className="activity" aria-label="Run activity">
      <div className="activity__tools">
        <div className="activity__filters" role="group" aria-label="Filter activity">
          {([
            ["all", "All"],
            ["coordinator", "Coordinator"],
            ["agents", "Agents"],
            ["needs_reply", "Needs reply"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={filter === value ? "active" : ""}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
              {value === "needs_reply" && snapshot.pendingCount > 0 ? (
                <span className="activity__count">{snapshot.pendingCount}</span>
              ) : null}
            </button>
          ))}
        </div>
        <span className={`activity__transport activity__transport--${transport}`}>
          <span aria-hidden="true" /> {transport === "live" ? "Live" : transport === "polling" ? "Polling" : "Connecting"}
        </span>
      </div>

      {snapshot.truncated && (
        <div className="activity__notice">Showing the latest 500 orchestration messages.</div>
      )}
      {error && <div className="activity__error" role="status">⚠ {error}</div>}

      <div className="activity__timeline" aria-live="polite">
        {visible.length === 0 ? (
          <div className="activity__empty">
            {filter === "needs_reply" ? "No worker is waiting for a reply." : "No activity has been recorded for this Run yet."}
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
                  {event.actor.role === "lead" && <span className="activity-event__lead">★ Lead</span>}
                  {event.actor.harness && (
                    <span>{event.actor.harness}{event.actor.model ? ` · ${event.actor.model}` : ""}</span>
                  )}
                  <time dateTime={event.createdAt}>{clock(event.createdAt)}</time>
                </div>
                <h3>{event.title}</h3>
                <p>{event.summary}</p>
                {event.groupedCount > 1 && (
                  <span className="activity-event__grouped">{event.groupedCount} similar heartbeats grouped</span>
                )}
                {event.taskId && (
                  <button
                    type="button"
                    className="activity-event__task"
                    onClick={() => onSelectTask(event.taskId!)}
                  >
                    Open stage · {event.taskId}
                  </button>
                )}

                {event.actionable?.kind === "reply" && (
                  <div className="activity-event__reply">
                    <textarea
                      rows={2}
                      placeholder={disabled ? "Execution unavailable" : "Reply to this worker…"}
                      value={drafts[event.id] ?? ""}
                      disabled={disabled || busyId === event.id}
                      onChange={(e) => setDrafts((current) => ({ ...current, [event.id]: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="btn btn--ok"
                      disabled={disabled || busyId === event.id || !(drafts[event.id] ?? "").trim()}
                      title={disabled ? disabledReason ?? "Execution is unavailable" : "Reply and acknowledge"}
                      onClick={() => void runAction(event, "reply")}
                    >
                      {busyId === event.id ? "Sending…" : "Reply"}
                    </button>
                  </div>
                )}

                {event.actionable?.kind === "release" && (
                  <div className="activity-event__actions">
                    <button type="button" className="btn btn--ok" disabled={disabled || Boolean(busyId)} onClick={() => void runAction(event, "release")}>Release</button>
                    <button type="button" className="btn" disabled={disabled || Boolean(busyId)} onClick={() => void runAction(event, "retain")}>Retain</button>
                  </div>
                )}
                {event.actionable?.kind === "retry" && (
                  <button type="button" className="btn" disabled={disabled || Boolean(busyId)} onClick={() => void runAction(event, "retry")}>Retry safely</button>
                )}

                {Boolean(event.detail || event.technical.messageId || event.dispatchId || event.technical.argv || event.technical.payload) && (
                  <details className="activity-event__details">
                    <summary>Technical details</summary>
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
}
