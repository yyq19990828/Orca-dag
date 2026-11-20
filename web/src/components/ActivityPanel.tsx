import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  CircleX,
  ExternalLink,
  Search,
  Terminal,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  acknowledgeStopEvent,
  ApiError,
  decideWorkerPermission,
  fetchActivity,
  releaseWorker,
  replyToMessage,
  retainWorker,
  retryWorker,
} from "../api";
import { openActivityStream } from "../bridge/orcaBridge";
import { formatConsoleTime, formatTimestamp, isUrgent, priorityLabel } from "../format";
import { t, useT, type TranslationKey } from "../i18n";
import type { ActivityEvent, ActivitySnapshot } from "../types";
import { useDecisionDialog } from "./DecisionDialog";
import { useCoordinatorControl } from "./useCoordinatorControl";

type ActivityFilter = "all" | "coordinator" | "agents" | "needs_reply";
type ActivityTransport = "connecting" | "live" | "polling";

const FILTER_KEY: Record<ActivityFilter, TranslationKey> = {
  all: "activity.filter.all",
  coordinator: "activity.filter.coordinator",
  agents: "activity.filter.agents",
  needs_reply: "activity.filter.needsReply",
};

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
      return null;
  }
}

function SeverityIcon({ event }: { event: ActivityEvent }) {
  if (event.severity === "error") {
    return <CircleX size={13} style={{ color: "var(--st-failed)" }} aria-hidden="true" />;
  }
  if (event.severity === "warning" || event.actionable) {
    return <TriangleAlert size={13} style={{ color: "var(--st-dispatched)" }} aria-hidden="true" />;
  }
  if (event.severity === "success" || event.kind === "worker_done") {
    return <CheckCircle2 size={13} style={{ color: "var(--st-completed)" }} aria-hidden="true" />;
  }
  return <Terminal size={12} style={{ color: "var(--fg-tertiary)" }} aria-hidden="true" />;
}

/**
 * VS Code Output / Debug Console style Run-scoped work log.
 * Keeps single-line monospace density for rapid scanning while opening
 * full untruncated details, replies, and technical receipts inline on click.
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
  const t = useT();
  const withControl = useCoordinatorControl();
  const dialog = useDecisionDialog();
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(EMPTY);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [query, setQuery] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [transport, setTransport] = useState<ActivityTransport>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [operatorReceipt, setOperatorReceipt] = useState<{ runId: string; value: string } | null>(
    null,
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestSeq = useRef(0);
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
    lastSnapshotJson.current = "";
    setDrafts({});
    setExpandedIds(new Set());
    setTransport("connecting");
    onPendingCount(0);
    if (!runId) return;

    let alive = true;
    let pollTimer: number | null = null;
    let closeStream: (() => void) | null = null;
    const stop = () => {
      closeStream?.();
      closeStream = null;
      if (pollTimer !== null) window.clearInterval(pollTimer);
      pollTimer = null;
      requestSeq.current++;
    };
    const start = () => {
      if (!alive || document.visibilityState !== "visible") return;
      setTransport("connecting");
      void refresh();
      let activeToken = true;
      const currentClose = openActivityStream(runId, {
        onOpen: () => {
          if (alive && activeToken) setTransport("live");
        },
        onSnapshot: (next) => {
          if (!alive || !activeToken) return;
          applySnapshot(next);
          setTransport("live");
        },
        onError: () => {
          if (!alive || !activeToken) return;
          activeToken = false;
          currentClose();
          if (closeStream === currentClose) closeStream = null;
          setTransport("polling");
          void refresh();
          pollTimer = window.setInterval(() => void refresh(), 2_000);
        },
      });
      closeStream = () => {
        activeToken = false;
        currentClose();
      };
    };
    const onHide = () => {
      stop();
      start();
    };
    document.addEventListener("visibilitychange", onHide);
    start();
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onHide);
      stop();
    };
  }, [applySnapshot, onPendingCount, onSnapshot, refresh, runId]);

  const normalizedQuery = query.trim().toLowerCase();

  const visible = useMemo(
    () =>
      snapshot.events.filter((event) => {
        if (filter === "coordinator" && event.direction === "agent_to_coordinator") return false;
        if (filter === "agents" && event.direction !== "agent_to_coordinator") return false;
        if (filter === "needs_reply" && event.actionable?.kind !== "reply") return false;
        if (!normalizedQuery) return true;
        return (
          event.actor.label.toLowerCase().includes(normalizedQuery) ||
          event.title.toLowerCase().includes(normalizedQuery) ||
          event.summary.toLowerCase().includes(normalizedQuery) ||
          (event.taskId ?? "").toLowerCase().includes(normalizedQuery) ||
          (event.dispatchId ?? "").toLowerCase().includes(normalizedQuery)
        );
      }),
    [filter, normalizedQuery, snapshot.events],
  );

  function toggleRow(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function acknowledge(event: ActivityEvent) {
    if (!event.dispatchId || disabled || busyId) return;
    const confirmed = await dialog.confirm({
      title: t("inbox.ackStopTitle"),
      message: t("inbox.ackStopMessage", {
        dispatch: event.dispatchId,
        reason: String(
          (event.technical.payload as { stopReason?: unknown } | undefined)?.stopReason ??
            t("worker.unknown"),
        ),
      }),
      confirmLabel: t("inbox.ackStop"),
    });
    if (!confirmed) return;
    setBusyId(event.id);
    setError(null);
    try {
      await acknowledgeStopEvent(runId, event.id, event.dispatchId);
      await refresh();
      onResolved();
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusyId(null);
    }
  }

  async function decidePrompt(event: ActivityEvent, decision: "approve" | "deny") {
    if (!event.dispatchId || !event.permissionPrompt || disabled || busyId) return;
    const rawReason = (drafts[event.id] ?? "").trim();
    const reason = decision === "approve" ? rawReason || t("permission.approveDefaultReason") : rawReason;
    if (!reason) return;
    setBusyId(event.id);
    setError(null);
    try {
      const receipt = await withControl(runId, (control) =>
        decideWorkerPermission(runId, event.dispatchId!, event.permissionPrompt!.id, decision, reason, control),
      );
      setOperatorReceipt({ runId, value: JSON.stringify(receipt) });
      setDrafts(({ [event.id]: _drop, ...rest }) => rest);
      await refresh();
      onResolved();
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusyId(null);
    }
  }

  async function runAction(
    event: ActivityEvent,
    action: "reply" | "release" | "retain" | "retry",
  ) {
    if (!event.actionable || disabled || busyId) return;
    const targetId = event.actionable.targetId;
    setBusyId(event.id);
    setError(null);
    try {
      if (action === "reply") {
        const body = (drafts[event.id] ?? "").trim();
        if (!body) return;
        const receipt = await withControl(runId, (control) =>
          replyToMessage(targetId, body, runId, control),
        );
        setOperatorReceipt({ runId, value: JSON.stringify(receipt) });
        setDrafts(({ [event.id]: _drop, ...rest }) => rest);
      } else if (action === "release") {
        await releaseWorker(runId, targetId);
      } else if (action === "retain") {
        await retainWorker(runId, targetId);
      } else {
        await retryWorker(targetId);
      }
      await refresh();
      onResolved();
    } catch (err) {
      if (action === "retry" && err instanceof ApiError) {
        setError(
          err.code === "retry_response_invalid"
            ? t("retry.invalidResponse")
            : err.code
              ? t("retry.apiError", { code: err.code, message: err.message })
              : err.message,
        );
      } else {
        setError(String((err as Error).message ?? err));
      }
    } finally {
      setBusyId(null);
    }
  }

  if (!runId) {
    return <div className="odag-console-empty">{t("activity.empty.pickRun")}</div>;
  }

  const transportDotColor =
    transport === "live"
      ? "var(--st-completed)"
      : transport === "polling"
        ? "var(--st-dispatched)"
        : "var(--fg-tertiary)";

  return (
    <section
      aria-label={t("activity.aria.section")}
      style={{ display: "flex", flexDirection: "column", blockSize: "100%", minBlockSize: 0 }}
    >
      {/* Compact VS Code Output Channel Sub-Toolbar */}
      <div className="odag-dock-toolbar">
        <search
          style={{ display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}
        >
          <div
            role="group"
            aria-label={t("activity.aria.filters")}
            style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
          >
            {(["all", "coordinator", "agents", "needs_reply"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="odag-dock-chip"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                <span>{t(FILTER_KEY[value])}</span>
                {value === "needs_reply" && snapshot.pendingCount > 0 && (
                  <span className="odag-count" style={{ blockSize: 15, fontSize: "var(--text-xs)" }}>
                    {snapshot.pendingCount}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="odag-dock-search">
            <Search size={11} style={{ color: "var(--fg-tertiary)" }} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("ide.dock.filterEvents")}
              aria-label={t("ide.dock.filterEvents")}
            />
            {query && (
              <button
                type="button"
                aria-label={t("ide.subbar.clearSearch")}
                onClick={() => setQuery("")}
                style={{ border: 0, background: "transparent", padding: 0, color: "var(--fg-tertiary)" }}
              >
                <X size={11} />
              </button>
            )}
          </div>
        </search>

        <div
          className="mono"
          style={{
            marginInlineStart: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            color: "var(--fg-tertiary)",
            fontSize: "var(--text-xs)",
          }}
        >
          <span>{t("ide.dock.rowsCount", { n: visible.length })}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--fg-secondary)" }}>
            <span
              style={{
                inlineSize: 6,
                blockSize: 6,
                borderRadius: 99,
                background: transportDotColor,
              }}
              aria-hidden="true"
            />
            {t(TRANSPORT_KEY[transport])}
          </span>
        </div>
      </div>

      {/* Scrollable Monospace Console Output Stream */}
      <div className="odag-dock-viewport odag-scroll" aria-live="polite">
        {operatorReceipt?.runId === runId && (
          <div className="odag-console-notice" role="status">
            <strong>{t("chat.message.operatorReceipt")}:</strong>
            <span className="truncate">{operatorReceipt.value}</span>
          </div>
        )}
        {snapshot.truncated && (
          <div className="odag-console-notice">{t("activity.truncated")}</div>
        )}
        {snapshot.inboxWindow?.saturated && (
          <div className="odag-console-notice" role="status">
            {t("activity.historyWarning", {
              observed: snapshot.inboxWindow.observed,
              limit: snapshot.inboxWindow.limit,
            })}
          </div>
        )}
        {error && (
          <div className="odag-console-notice odag-console-notice--error" role="status">
            ⚠ {error}
          </div>
        )}

        {visible.length === 0 ? (
          <div className="odag-console-empty">
            {filter === "needs_reply" ? t("activity.empty.needsReply") : t("activity.empty.none")}
          </div>
        ) : (
          visible.map((event) => {
            const expanded = expandedIds.has(event.id) || event.actionable?.kind === "reply";
            const provenance = provenanceLabel(event);
            const urgent = isUrgent(event);
            const actorColor =
              event.actor.role === "coordinator"
                ? "var(--accent)"
                : event.actor.role === "lead"
                  ? "var(--st-ready)"
                  : "var(--fg-secondary)";

            return (
              <div key={event.id}>
                <div
                  className={`odag-console-row odag-console-row--activity${
                    event.actionable ? " is-actionable" : ""
                  }${event.severity === "error" ? " is-error" : ""}`}
                >
                  <button
                    type="button"
                    className="odag-console-row__main"
                    aria-expanded={expanded}
                    onClick={() => toggleRow(event.id)}
                  >
                    <span style={{ color: "var(--fg-tertiary)", display: "inline-flex" }} aria-hidden="true">
                      <ChevronDown size={12} className="odag-chevron" data-open={expanded || undefined} />
                    </span>

                    <time
                      dateTime={event.createdAt}
                      title={formatTimestamp(event.createdAt)}
                      style={{ color: "var(--fg-tertiary)", fontSize: "var(--text-xs)" }}
                    >
                      {formatConsoleTime(event.createdAt)}
                    </time>

                    <span style={{ display: "inline-flex" }}>
                      <SeverityIcon event={event} />
                    </span>

                    <span
                      className="truncate"
                      style={{ color: actorColor, fontWeight: 600 }}
                      title={
                        event.actor.harness
                          ? `${event.actor.label} (${event.actor.harness}${
                              event.actor.model ? ` · ${event.actor.model}` : ""
                            })`
                          : event.actor.label
                      }
                    >
                      {event.actor.role === "lead" ? `[${t("activity.lead")}] ` : ""}
                      {event.actor.label}
                    </span>

                    <span className="truncate" style={{ minInlineSize: 0 }}>
                      <strong style={{ fontWeight: 600, color: "var(--fg-primary)" }}>
                        {event.title}
                      </strong>
                      {event.summary && event.summary !== event.title && (
                        <span style={{ color: "var(--fg-secondary)" }}> — {event.summary}</span>
                      )}
                    </span>
                  </button>

                  <div className="odag-console-row__tail">
                    {event.groupedCount > 1 && (
                      <span className="odag-console-tag">×{event.groupedCount}</span>
                    )}
                    {urgent && (
                      <span
                        className="odag-console-tag"
                        style={{ color: "var(--st-failed)", borderColor: "var(--st-failed)" }}
                        title={t("priority.orcaTitle", { priority: event.priority ?? "" })}
                      >
                        {priorityLabel(event)}
                      </span>
                    )}
                    {event.read === false && (
                      <span
                        className="odag-console-tag"
                        style={{ color: "var(--accent)" }}
                        title={t("activity.unreadTitle")}
                      >
                        {t("activity.unread")}
                      </span>
                    )}
                    {provenance && (
                      <span
                        className="odag-console-tag odag-console-hide-compact"
                        title={provenance.title}
                      >
                        {provenance.text}
                      </span>
                    )}
                    {event.taskId && (
                      <button
                        type="button"
                        className="odag-console-tag"
                        title={t("activity.openStage", { id: event.taskId })}
                        onClick={() => onSelectTask(event.taskId!)}
                        style={{ color: "var(--accent)" }}
                      >
                        <span>{event.taskId.slice(0, 14)}</span>
                        <ExternalLink size={10} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>

                {expanded && (
                  <div className="odag-console-drawer">
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                      <strong>{event.title}</strong>
                      {event.actor.harness && (
                        <span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--fg-tertiary)" }}>
                          {event.actor.harness}
                          {event.actor.model ? ` · ${event.actor.model}` : ""}
                        </span>
                      )}
                      {event.threadId && (
                        <span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--fg-tertiary)" }}>
                          {t("activity.thread", { id: event.threadId })}
                        </span>
                      )}
                    </div>

                    <div style={{ color: "var(--fg-primary)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                      {event.summary}
                    </div>

                    {event.detail && (
                      <div style={{ color: "var(--fg-secondary)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                        {event.detail}
                      </div>
                    )}

                    {event.kind === "stop_event" && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span className="mono" style={{ fontSize: "var(--text-sm)", color: "var(--st-dispatched)" }}>
                          {t("inbox.stopEvent", {
                            reason: String(
                              (event.technical.payload as { stopReason?: unknown } | undefined)
                                ?.stopReason ?? t("worker.unknown"),
                            ),
                          })}
                        </span>
                        {event.actionable?.kind === "acknowledge_stop" && event.dispatchId && (
                          <button
                            type="button"
                            className="odag-btn odag-btn--primary"
                            style={{ blockSize: 25, fontSize: "var(--text-xs)" }}
                            disabled={disabled || Boolean(busyId)}
                            onClick={() => void acknowledge(event)}
                          >
                            {t("inbox.ackStop")}
                          </button>
                        )}
                      </div>
                    )}

                    {event.permissionPrompt && event.dispatchId && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxInlineSize: 680 }}>
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <span className="odag-console-tag">{t("permission.badge")}</span>
                          <code style={{ fontSize: "var(--text-xs)", color: "var(--fg-tertiary)" }}>
                            {event.permissionPrompt.id}
                          </code>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <input
                            type="text"
                            value={drafts[event.id] ?? ""}
                            disabled={disabled || busyId === event.id}
                            placeholder={t("permission.reasonPlaceholder")}
                            aria-label={t("permission.reasonPlaceholder")}
                            onChange={(e) =>
                              setDrafts((current) => ({ ...current, [event.id]: e.target.value }))
                            }
                            style={{
                              flex: "1 1 260px",
                              blockSize: 28,
                              paddingInline: 8,
                              borderRadius: 5,
                              border: "1px solid var(--border-control)",
                              background: "var(--bg-canvas)",
                              fontSize: "var(--text-sm)",
                            }}
                          />
                          <button
                            type="button"
                            className="odag-btn odag-btn--primary"
                            style={{ blockSize: 28, fontSize: "var(--text-xs)" }}
                            disabled={
                              disabled ||
                              busyId === event.id ||
                              event.permissionPrompt.allowSupported === false
                            }
                            title={
                              event.permissionPrompt.allowSupported === false
                                ? t("permission.allowDisabledTitle")
                                : undefined
                            }
                            onClick={() => void decidePrompt(event, "approve")}
                          >
                            {t("permission.allowOnce")}
                          </button>
                          <button
                            type="button"
                            className="odag-btn"
                            style={{ blockSize: 28, fontSize: "var(--text-xs)" }}
                            disabled={
                              disabled || busyId === event.id || !(drafts[event.id] ?? "").trim()
                            }
                            onClick={() => void decidePrompt(event, "deny")}
                          >
                            {t("permission.deny")}
                          </button>
                        </div>
                      </div>
                    )}

                    {event.actionable?.kind === "reply" && !event.permissionPrompt && (
                      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", maxInlineSize: 680 }}>
                        <textarea
                          rows={2}
                          placeholder={
                            disabled ? t("activity.reply.unavailable") : t("activity.reply.placeholder")
                          }
                          value={drafts[event.id] ?? ""}
                          disabled={disabled || busyId === event.id}
                          onChange={(e) =>
                            setDrafts((current) => ({ ...current, [event.id]: e.target.value }))
                          }
                          style={{
                            flex: 1,
                            padding: "6px 8px",
                            borderRadius: 5,
                            border: "1px solid var(--border-control)",
                            background: "var(--bg-canvas)",
                            fontSize: "var(--text-sm)",
                          }}
                        />
                        <button
                          type="button"
                          className="odag-btn odag-btn--primary"
                          disabled={
                            disabled || busyId === event.id || !(drafts[event.id] ?? "").trim()
                          }
                          title={
                            disabled
                              ? disabledReason ?? t("activity.reply.unavailableTitle")
                              : t("activity.reply.title")
                          }
                          onClick={() => void runAction(event, "reply")}
                        >
                          {busyId === event.id ? t("activity.sending") : t("activity.reply.button")}
                        </button>
                      </div>
                    )}

                    {event.actionable?.kind === "release" && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          type="button"
                          className="odag-btn odag-btn--primary"
                          style={{ blockSize: 26, fontSize: "var(--text-sm)" }}
                          disabled={disabled || Boolean(busyId)}
                          onClick={() => void runAction(event, "release")}
                        >
                          {t("activity.release")}
                        </button>
                        <button
                          type="button"
                          className="odag-btn"
                          style={{ blockSize: 26, fontSize: "var(--text-sm)" }}
                          disabled={disabled || Boolean(busyId)}
                          onClick={() => void runAction(event, "retain")}
                        >
                          {t("activity.retain")}
                        </button>
                      </div>
                    )}

                    {event.actionable?.kind === "retain" && (
                      <div>
                        <button
                          type="button"
                          className="odag-btn"
                          style={{ blockSize: 26, fontSize: "var(--text-sm)" }}
                          disabled={disabled || Boolean(busyId)}
                          onClick={() => void runAction(event, "retain")}
                        >
                          {t("activity.retain")}
                        </button>
                      </div>
                    )}

                    {event.actionable?.kind === "retry" && (
                      <div>
                        <button
                          type="button"
                          className="odag-btn odag-btn--primary"
                          style={{ blockSize: 26, fontSize: "var(--text-sm)" }}
                          disabled={disabled || Boolean(busyId)}
                          onClick={() => void runAction(event, "retry")}
                        >
                          {t("activity.retry")}
                        </button>
                      </div>
                    )}

                    {Boolean(
                      event.technical.messageId ||
                        event.dispatchId ||
                        event.technical.argv ||
                        event.technical.payload,
                    ) && (
                      <details>
                        <summary
                          className="mono"
                          style={{ cursor: "pointer", fontSize: "var(--text-xs)", color: "var(--fg-secondary)" }}
                        >
                          {t("activity.details")}
                        </summary>
                        <pre tabIndex={0} role="region" aria-label={t("activity.details")}>
                          <code>{technicalJson(event)}</code>
                        </pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
});
