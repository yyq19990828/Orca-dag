import { StructuredData } from "./StructuredData";
import { memo, useCallback, useEffect, useState } from "react";
import { fetchRequestDetail, fetchRequests } from "../api";
import { formatTimestamp, operationLabel } from "../format";
import { t, useT } from "../i18n";
import { usePageVisible } from "../visibility";
import type { RequestLedgerRowView, RequestReceiptView } from "../types";

/**
 * Mutation-request audit (Phase 5): the durable ledger of viewer-originated
 * mutation requests (worker-start / worker-release / worker-retain /
 * worker-stop), each carrying the `--retry-request` id needed to ask Orca
 * `request-show` what happened — including after a response loss or a viewer
 * restart, when the coordinator's in-memory projection is long gone.
 *
 * Strictly read-only: the only thing "Inspect" does is run a fresh
 * `request-show` probe, and the receipt renders Orca's own state and
 * interpretation verbatim. `absent` never proves a mutation did not happen,
 * a failed probe renders as "unknown", and the local ledger hint
 * (`settledLocally`) is labeled as exactly that — a hint, never authority.
 * Loading, empty and failed reads remain visible in the diagnostics category.
 */

/** The presentation bucket for a receipt state; unknown states stay verbatim. */
function stateBucket(state: string): "completed" | "pending" | "absent" | "unknown" | "other" {
  if (state === "completed" || state === "pending" || state === "absent") return state;
  if (state === "unknown") return "unknown";
  return "other";
}

function stateCaption(receipt: RequestReceiptView): string {
  switch (stateBucket(receipt.state)) {
    case "completed":
      return t("audit.caption.completed");
    case "pending":
      return t("audit.caption.pending");
    case "absent":
      return t("audit.caption.absent");
    case "unknown":
      return t("audit.caption.unknown");
    default:
      return t("audit.caption.other");
  }
}

export const RequestAuditPanel = memo(function RequestAuditPanel({ runId, labelsById, active = true }: { runId: string; labelsById: Record<string, string>; active?: boolean }) {
  const t = useT();
  const [rows, setRows] = useState<RequestLedgerRowView[]>([]);
  const [otherRunCount, setOtherRunCount] = useState(0);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Map<string, RequestReceiptView>>(new Map());
  const [open, setOpen] = useState<string | null>(null);

  const visible = usePageVisible();
  useEffect(() => {
    // Pause both for a backgrounded page and an inactive Operations tab.
    // Returning to either performs one immediate refresh before re-arming.
    if (!active || !visible) return;
    let alive = true;
    const load = async () => {
      try {
        const { requests, otherRunCount: other } = await fetchRequests(runId);
        if (!alive) return;
        setRows(requests);
        setOtherRunCount(other);
        setLoadedFor(runId);
        setErr(null);
      } catch (e) {
        if (alive) setErr(String((e as Error).message ?? e));
      }
    };
    void load();
    const t = window.setInterval(load, 4000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [active, runId, visible]);

  // Probes are keyed by request id AND kept per Run switch — a stale probe
  // from another Run must never dress up this Run's rows.
  useEffect(() => {
    setReceipts(new Map());
    setOpen(null);
  }, [runId]);

  const inspect = useCallback(
    async (row: RequestLedgerRowView) => {
      if (probing) return;
      if (open === row.requestId) {
        setOpen(null);
        return;
      }
      setProbing(row.requestId);
      try {
        const { receipt } = await fetchRequestDetail(runId, row.requestId);
        setReceipts((prev) => new Map(prev).set(row.requestId, receipt));
        setOpen(row.requestId);
      } catch (e) {
        setErr(String((e as Error).message ?? e));
      } finally {
        setProbing(null);
      }
    },
    [open, probing, runId],
  );

  if (loadedFor !== runId) return <p className="operations-empty" role="status">{err || t("audit.loading")}</p>;

  return (
    <div className="gates inbox audit" data-testid="request-audit-panel">
      <div className="gate inbox__item">
        <div className="gate__badge">{t("audit.badge")}</div>
        <div className="inbox__meta audit__caption">
          {t("audit.captionBefore")}<code>request-show</code>{t("audit.captionAfter")}
        </div>
        {rows.map((row) => {
          const receipt = receipts.get(row.requestId);
          const isOpen = open === row.requestId;
          const bucket = receipt ? stateBucket(receipt.state) : null;
          return (
            <div key={row.requestId} className="audit__row">
              <button
                type="button"
                className="audit__toggle"
                onClick={() => void inspect(row)}
                disabled={probing === row.requestId}
                aria-expanded={isOpen}
                title={`${t("audit.inspectTitle")}\n${row.requestId}`}
              >
                <span className="audit__summary">
                  <strong>{operationLabel(row.operation)}</strong>
                  <span>{row.taskId ? labelsById[row.taskId] || row.taskId : t("audit.runOperation")}</span>
                  <time dateTime={row.updatedAt}>{formatTimestamp(row.updatedAt)}</time>
                </span>
                {receipt && (
                  <span className="audit__state" data-state={bucket}>
                    {bucket && bucket !== "other" ? t(`audit.state.${bucket}`) : receipt.state}
                    {receipt.probe === "failed" ? t("audit.probeFailed") : ""}
                  </span>
                )}
                <span className="audit__hint">{isOpen ? "▲" : t("audit.inspect")}</span>
              </button>
              {row.note && <div className="inbox__body audit__note">{row.note}</div>}
              {isOpen && receipt && (
                <div className="audit__detail">
                  <dl className="record-facts">
                    <dt>{t("record.request")}</dt><dd><code>{row.requestId}</code></dd>
                    <dt>{t("record.operation")}</dt><dd><code>{row.operation}</code></dd>
                    <dt>{t("record.run")}</dt><dd><code>{row.runId ?? t("audit.scopeUnknown")}</code></dd>
                    {row.taskId && <><dt>{t("record.task")}</dt><dd><code>{row.taskId}</code></dd></>}
                    {row.dispatchId && <><dt>{t("record.dispatch")}</dt><dd><code>{row.dispatchId}</code></dd></>}
                  </dl>
                  <div className={`audit__receipt audit__receipt--${bucket}`}>
                    <b>{receipt.state}</b> — {stateCaption(receipt)}
                  </div>
                  {receipt.interpretation && (
                    <div className="inbox__body">
                      {t("audit.orcaSays")} <i>{receipt.interpretation}</i>
                    </div>
                  )}
                  <div className="inbox__meta">
                    {t("audit.probedAt", { time: formatTimestamp(receipt.probedAt) })}
                    {row.settledLocally === true
                      ? t("audit.settledDefinitive")
                      : row.settledLocally === false
                        ? t("audit.settledUnlearned")
                        : t("audit.settledNone")}
                    {t("audit.settledTail")}
                  </div>
                  {receipt.outcome != null && (
                    <div className="audit__outcome">
                      <h4>{t("record.outcome")}</h4>
                      <StructuredData value={receipt.outcome} />
                      <details>
                        <summary>{t("report.raw")}</summary>
                        <pre className="workers__rawpre">{JSON.stringify(receipt.outcome, null, 2)}</pre>
                      </details>
                    </div>
                  )}
                </div>
              )}
              {isOpen && probing === row.requestId && (
                <div className="inbox__body">{t("audit.probing")}</div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && err === null && (
          <div className="inbox__body">{t("audit.empty")}</div>
        )}
        {otherRunCount > 0 && (
          <div className="inbox__meta">
            {otherRunCount === 1
              ? t("audit.otherRunsOne", { n: otherRunCount })
              : t("audit.otherRunsMany", { n: otherRunCount })}
          </div>
        )}
        {err && <div className="exec__err inbox__err">⚠️ {err}</div>}
      </div>
    </div>
  );
});
