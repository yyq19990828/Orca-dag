import { useCallback, useEffect, useState } from "react";
import { acknowledgeStopEvent, releaseWorker, replyToMessage, retainWorker } from "../api";
import { useCoordinatorControl } from "./useCoordinatorControl";
import { useDecisionDialog } from "./DecisionDialog";
import { timeAgo } from "../format";
import { useT, type TranslationKey } from "../i18n";
import type { CleanupDebtItem, PendingInboxItem } from "../types";

/**
 * The Run inbox (Phase 3): questions and escalations from workers, plus the
 * cleanup debt the coordinator refuses to guess through. A worker question
 * holds its FIFO Delivery unacknowledged until it is answered here — the run
 * literally waits for the reply, so the panel renders whenever anything is
 * pending, regardless of canvas selection.
 *
 * Replies go to POST /api/messages/:id/reply; the server checks coordinator
 * authority and may refuse when control cannot be established safely.
 */

/**
 * Debt kinds → dictionary keys. The value type is `| undefined` so an unknown
 * kind from a newer server falls back to the raw token instead of throwing,
 * and a typo in a key name fails `tsc` instead of rendering blank.
 */
const DEBT_LABEL: Record<CleanupDebtItem["kind"], TranslationKey | undefined> = {
  release_unknown: "inbox.debt.releaseUnknown",
  release_pending: "inbox.debt.releasePending",
  close_failed: "inbox.debt.closeFailed",
  coordinator_close_failed: "inbox.debt.coordinatorCloseFailed",
  stop_unknown: "inbox.debt.stopUnknown",
  reclaimable: "inbox.debt.reclaimable",
};

export function InboxPanel({
  runId,
  pending,
  cleanupDebt,
  onResolved,
  disabled = false,
  disabledReason,
}: {
  runId: string;
  pending: PendingInboxItem[];
  cleanupDebt: CleanupDebtItem[];
  /** Called after a successful reply/release/retain so the parent can refresh. */
  onResolved: () => void;
  /** Execution disabled (readiness gate) — inputs render but stay off. */
  disabled?: boolean;
  disabledReason?: string | null;
}) {
  // timeAgo() reads the language non-reactively (format.ts owns the wording),
  // so the panel subscribes through useT() and re-renders its rows on a
  // language switch.
  const t = useT();
  const withControl = useCoordinatorControl();
  const dialog = useDecisionDialog();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [operatorReceipt, setOperatorReceipt] = useState<{ runId: string; value: string } | null>(null);

  const busy = useCallback((id: string) => busyId === id, [busyId]);

  async function reply(item: PendingInboxItem) {
    if (disabled || busy(item.messageId)) return;
    const body = (drafts[item.messageId] ?? "").trim();
    if (!body) return;
    setBusyId(item.messageId);
    setErr(null);
    try {
      const receipt = await withControl(runId, (control) => replyToMessage(item.messageId, body, runId, control));
      setOperatorReceipt({ runId, value: JSON.stringify(receipt) });
      setDrafts(({ [item.messageId]: _drop, ...rest }) => rest);
      onResolved();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusyId(null);
    }
  }

  async function acknowledge(item: PendingInboxItem) {
    if (!item.dispatchId || disabled || busy(item.messageId)) return;
    const confirmed = await dialog.confirm({
      title: t("inbox.ackStopTitle"),
      message: t("inbox.ackStopMessage", { dispatch: item.dispatchId, reason: item.stopReason ?? t("worker.unknown") }),
      confirmLabel: t("inbox.ackStop"),
    });
    if (!confirmed) return;
    setBusyId(item.messageId);
    setErr(null);
    try {
      await acknowledgeStopEvent(runId, item.messageId, item.dispatchId);
      onResolved();
    } catch (error) {
      setErr(String((error as Error).message ?? error));
    } finally {
      setBusyId(null);
    }
  }

  async function resolveDebt(item: CleanupDebtItem, action: "release" | "retain") {
    if (!item.dispatchId || disabled || busy(item.key)) return;
    setBusyId(item.key);
    setErr(null);
    try {
      if (action === "release") await releaseWorker(runId, item.dispatchId);
      else await retainWorker(runId, item.dispatchId);
      onResolved();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusyId(null);
    }
  }

  if (!runId || (pending.length === 0 && cleanupDebt.length === 0 && operatorReceipt?.runId !== runId)) return null;

  return (
    <div className="gates inbox" data-testid="inbox-panel">
      {operatorReceipt?.runId === runId && <div role="status" className="inbox__body"><strong>{t("chat.message.operatorReceipt")}</strong><pre>{operatorReceipt.value}</pre></div>}
      {pending.map((item) => (
        <div key={item.messageId} className={`gate inbox__item inbox__item--${item.kind}`}>
          <div className="gate__badge">
            {item.kind === "question" ? t("inbox.workerQuestion") : t("inbox.workerEscalation")}
            <span className="inbox__meta">
              {timeAgo(item.createdAt)}
              {item.taskId ? ` · ${item.taskId}` : ""}
            </span>
          </div>
          <div className="gate__question">{item.subject || t("inbox.noSubject")}</div>
          {item.body && <div className="inbox__body">{item.body}</div>}
          {item.kind === "stop_event" ? (
            <div className="inbox__meta">
              {t("inbox.stopEvent", { reason: item.stopReason ?? t("worker.unknown") })}
              {item.dispatchId && <div><code>{item.dispatchId}</code>{" "}<button type="button" className="btn btn--gate" disabled={disabled || busy(item.messageId)} onClick={() => void acknowledge(item)}>{t("inbox.ackStop")}</button></div>}
            </div>
          ) : <div className="gate__actions inbox__reply">
            <input
              className="inbox__input"
              aria-label={t("inbox.replyPlaceholder")}
              placeholder={disabled ? t("inbox.executionUnavailable") : t("inbox.replyPlaceholder")}
              value={drafts[item.messageId] ?? ""}
              disabled={disabled || busy(item.messageId)}
              onChange={(e) => setDrafts((d) => ({ ...d, [item.messageId]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void reply(item);
              }}
            />
            <button
              className="btn btn--gate btn--ok"
              disabled={disabled || busy(item.messageId) || !(drafts[item.messageId] ?? "").trim()}
              title={
                disabled ? disabledReason ?? t("inbox.executionIsUnavailable") : t("inbox.replyTitle")
              }
              onClick={() => void reply(item)}
            >
              {busy(item.messageId) ? "…" : t("inbox.reply")}
            </button>
          </div>}
        </div>
      ))}

      {cleanupDebt.map((item) => (
        <div key={item.key} className={`gate inbox__item inbox__debt inbox__debt--${item.kind}`}>
          <div className="gate__badge">
            {DEBT_LABEL[item.kind] ? t(DEBT_LABEL[item.kind]!) : item.kind}
          </div>
          <div className="gate__question">
            {item.dispatchId ?? item.handle ?? t("inbox.unknownTarget")}
          </div>
          {item.detail && <div className="inbox__body">{item.detail}</div>}
          {item.dispatchId && (
            <div className="gate__actions">
              <button
                className="btn btn--gate btn--ok"
                disabled={disabled || busy(item.key)}
                title={t("inbox.releaseTitle")}
                onClick={() => void resolveDebt(item, "release")}
              >
                {t("inbox.release")}
              </button>
              <button
                className="btn btn--gate"
                disabled={disabled || busy(item.key)}
                title={t("inbox.retainTitle")}
                onClick={() => void resolveDebt(item, "retain")}
              >
                {t("inbox.retain")}
              </button>
            </div>
          )}
        </div>
      ))}

      {err && <div className="exec__err inbox__err">⚠️ {err}</div>}
    </div>
  );
}

/**
 * Poll the coordinator inbox (pending questions + cleanup debt) independently
 * of the DAG poll, so an arriving question surfaces within one tick.
 */
export function useInboxPoll(pollMs = 2000): {
  pending: PendingInboxItem[];
  cleanupDebt: CleanupDebtItem[];
  refresh: () => void;
} {
  const [pending, setPending] = useState<PendingInboxItem[]>([]);
  const [cleanupDebt, setCleanupDebt] = useState<CleanupDebtItem[]>([]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/inbox");
        const json = (await res.json()) as {
          inbox?: { pending?: PendingInboxItem[] };
          cleanupDebt?: CleanupDebtItem[];
        };
        if (!alive) return;
        setPending(json.inbox?.pending ?? []);
        setCleanupDebt(json.cleanupDebt ?? []);
      } catch {
        /* transient — keep the last known state */
      }
    };
    void load();
    const t = window.setInterval(load, pollMs);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [pollMs, nonce]);

  return { pending, cleanupDebt, refresh: useCallback(() => setNonce((n) => n + 1), []) };
}
