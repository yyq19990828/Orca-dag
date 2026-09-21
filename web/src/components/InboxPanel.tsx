import { useCallback, useEffect, useState } from "react";
import { releaseWorker, replyToMessage, retainWorker } from "../api";
import { timeAgo } from "../format";
import type { CleanupDebtItem, PendingInboxItem } from "../types";

/**
 * The Run inbox (Phase 3): questions and escalations from workers, plus the
 * cleanup debt the coordinator refuses to guess through. A worker question
 * holds its FIFO Delivery unacknowledged until it is answered here — the run
 * literally waits for the reply, so the panel renders whenever anything is
 * pending, regardless of canvas selection.
 *
 * Replies go to POST /api/messages/:id/reply; the server routes them through
 * the live coordinator when it is running (so the Delivery is acknowledged
 * exactly once, after the reply lands) or borrows a throwaway terminal when
 * the loop is down.
 */

const DEBT_LABEL: Record<CleanupDebtItem["kind"], string> = {
  release_unknown: "Release unverified",
  release_pending: "Release pending",
  close_failed: "Terminal close refused",
  coordinator_close_failed: "Coordinator close refused",
  stop_unknown: "Stop outcome unknown",
  reclaimable: "Reclaimable worker left",
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
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const busy = useCallback((id: string) => busyId === id, [busyId]);

  async function reply(item: PendingInboxItem) {
    if (disabled || busy(item.messageId)) return;
    const body = (drafts[item.messageId] ?? "").trim();
    if (!body) return;
    setBusyId(item.messageId);
    setErr(null);
    try {
      await replyToMessage(item.messageId, body, runId);
      setDrafts(({ [item.messageId]: _drop, ...rest }) => rest);
      onResolved();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusyId(null);
    }
  }

  async function resolveDebt(item: CleanupDebtItem, action: "release" | "retain") {
    if (!item.dispatchId || disabled || busy(item.key)) return;
    setBusyId(item.key);
    setErr(null);
    try {
      if (action === "release") await releaseWorker(item.dispatchId);
      else await retainWorker(item.dispatchId);
      onResolved();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusyId(null);
    }
  }

  if (!runId || (pending.length === 0 && cleanupDebt.length === 0)) return null;

  return (
    <div className="gates inbox" data-testid="inbox-panel">
      {pending.map((item) => (
        <div key={item.messageId} className={`gate inbox__item inbox__item--${item.kind}`}>
          <div className="gate__badge">
            {item.kind === "question" ? "Worker question" : "Worker escalation"}
            <span className="inbox__meta">
              {timeAgo(item.createdAt)}
              {item.taskId ? ` · ${item.taskId}` : ""}
            </span>
          </div>
          <div className="gate__question">{item.subject || "(no subject)"}</div>
          {item.body && <div className="inbox__body">{item.body}</div>}
          <div className="gate__actions inbox__reply">
            <input
              className="inbox__input"
              placeholder={disabled ? "Execution unavailable" : "Type a reply…"}
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
              title={disabled ? disabledReason ?? "Execution is unavailable" : "Reply and acknowledge"}
              onClick={() => void reply(item)}
            >
              {busy(item.messageId) ? "…" : "Reply"}
            </button>
          </div>
        </div>
      ))}

      {cleanupDebt.map((item) => (
        <div key={item.key} className={`gate inbox__item inbox__debt inbox__debt--${item.kind}`}>
          <div className="gate__badge">{DEBT_LABEL[item.kind] ?? item.kind}</div>
          <div className="gate__question">
            {item.dispatchId ?? item.handle ?? "unknown target"}
          </div>
          {item.detail && <div className="inbox__body">{item.detail}</div>}
          {item.dispatchId && (
            <div className="gate__actions">
              <button
                className="btn btn--gate btn--ok"
                disabled={disabled || busy(item.key)}
                title="Release the worker terminal now (worker-release)"
                onClick={() => void resolveDebt(item, "release")}
              >
                Release
              </button>
              <button
                className="btn btn--gate"
                disabled={disabled || busy(item.key)}
                title="Keep the terminal live for debugging (worker-retain)"
                onClick={() => void resolveDebt(item, "retain")}
              >
                Retain
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
