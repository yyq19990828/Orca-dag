import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, Search, X } from "lucide-react";
import { fetchRequestDetail, fetchRequests } from "../api";
import { formatConsoleTime, formatTimestamp, operationLabel } from "../format";
import { t, useT } from "../i18n";
import type { RequestLedgerRowView, RequestReceiptView } from "../types";
import { usePageVisible } from "../visibility";
import { StructuredData } from "./StructuredData";

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

function receiptTone(bucket: ReturnType<typeof stateBucket> | null): string {
  switch (bucket) {
    case "completed":
      return "var(--st-completed)";
    case "pending":
      return "var(--st-dispatched)";
    case "unknown":
      return "var(--st-failed)";
    default:
      return "var(--fg-tertiary)";
  }
}

/**
 * VS Code Network / Request Trace style read-only mutation ledger.
 * Each `--retry-request` row stays on a compact 25px monospace line; clicking a row
 * runs a fresh read-only `request-show` probe and opens its receipt drawer inline.
 */
export const RequestAuditPanel = memo(function RequestAuditPanel({
  runId,
  labelsById,
  active = true,
}: {
  runId: string;
  labelsById: Record<string, string>;
  active?: boolean;
}) {
  const t = useT();
  const [rows, setRows] = useState<RequestLedgerRowView[]>([]);
  const [otherRunCount, setOtherRunCount] = useState(0);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Map<string, RequestReceiptView>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const visible = usePageVisible();
  useEffect(() => {
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
    const timer = window.setInterval(load, 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [active, runId, visible]);

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

  const normalizedQuery = query.trim().toLowerCase();
  const filteredRows = useMemo(() => {
    if (!normalizedQuery) return rows;
    return rows.filter((row) => {
      const targetLabel = row.taskId ? labelsById[row.taskId] || row.taskId : "";
      return (
        row.operation.toLowerCase().includes(normalizedQuery) ||
        operationLabel(row.operation).toLowerCase().includes(normalizedQuery) ||
        row.requestId.toLowerCase().includes(normalizedQuery) ||
        targetLabel.toLowerCase().includes(normalizedQuery) ||
        (row.dispatchId ?? "").toLowerCase().includes(normalizedQuery)
      );
    });
  }, [labelsById, normalizedQuery, rows]);

  if (loadedFor !== runId) {
    return (
      <div className="odag-console-empty" role="status">
        {err || t("audit.loading")}
      </div>
    );
  }

  return (
    <div
      data-testid="request-audit-panel"
      style={{ display: "flex", flexDirection: "column", blockSize: "100%", minBlockSize: 0 }}
    >
      {/* Compact VS Code Trace Sub-Toolbar */}
      <div className="odag-dock-toolbar">
        <search style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <div className="odag-dock-search">
            <Search size={11} style={{ color: "var(--fg-tertiary)" }} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("ide.dock.filterRequests")}
              aria-label={t("ide.dock.filterRequests")}
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

        <span className="mono truncate odag-console-hide-compact" style={{ color: "var(--fg-tertiary)", fontSize: "var(--text-xs)" }}>
          <code>--retry-request</code> · {t("ide.dock.probeHint")}
        </span>

        <div
          className="mono"
          style={{
            marginInlineStart: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontSize: "var(--text-xs)",
            color: "var(--fg-tertiary)",
          }}
        >
          {otherRunCount > 0 && (
            <span className="odag-console-hide-compact">
              {otherRunCount === 1
                ? t("audit.otherRunsOne", { n: otherRunCount })
                : t("audit.otherRunsMany", { n: otherRunCount })}
            </span>
          )}
          <span>{t("ide.dock.rowsCount", { n: filteredRows.length })}</span>
        </div>
      </div>

      {/* Scrollable Monospace Request Trace Viewport */}
      <div className="odag-dock-viewport odag-scroll">
        {err && (
          <div className="odag-console-notice odag-console-notice--error" role="alert">
            ⚠ {err}
          </div>
        )}

        {filteredRows.length === 0 ? (
          <div className="odag-console-empty">{t("audit.empty")}</div>
        ) : (
          <>
            <div className="odag-console-head odag-console-row--audit" aria-hidden="true">
              <span />
              <span>{t("ide.dock.colTime")}</span>
              <span>{t("ide.dock.colOp")}</span>
              <span>{t("ide.dock.colTarget")}</span>
              <span className="odag-console-hide-compact">{t("ide.dock.colRequestId")}</span>
              <span className="odag-console-hide-compact">{t("ide.dock.colLocal")}</span>
              <span>{t("ide.dock.colReceipt")}</span>
            </div>

            {filteredRows.map((row) => {
              const receipt = receipts.get(row.requestId);
              const isOpen = open === row.requestId;
              const isProbing = probing === row.requestId;
              const bucket = receipt ? stateBucket(receipt.state) : null;
              const targetText = row.taskId
                ? labelsById[row.taskId] || row.taskId
                : t("audit.runOperation");

              return (
                <div key={row.requestId}>
                  <button
                    type="button"
                    className={`odag-console-row odag-console-row--audit${
                      bucket === "unknown" ? " is-error" : ""
                    }`}
                    onClick={() => void inspect(row)}
                    disabled={isProbing}
                    aria-expanded={isOpen}
                    title={`${t("audit.inspectTitle")} · ${row.requestId}`}
                  >
                    <span style={{ color: "var(--fg-tertiary)", display: "inline-flex" }} aria-hidden="true">
                      {isProbing ? (
                        <Loader2 size={12} />
                      ) : (
                        <ChevronDown size={12} className="odag-chevron" data-open={isOpen || undefined} />
                      )}
                    </span>

                    <time
                      dateTime={row.updatedAt}
                      title={formatTimestamp(row.updatedAt)}
                      style={{ color: "var(--fg-tertiary)", fontSize: "var(--text-xs)" }}
                    >
                      {formatConsoleTime(row.updatedAt)}
                    </time>

                    <span className="truncate" style={{ fontWeight: 600, color: "var(--accent)" }}>
                      {operationLabel(row.operation)}
                    </span>

                    <span className="truncate" style={{ color: "var(--fg-primary)" }}>
                      {targetText}
                    </span>

                    <span
                      className="truncate odag-console-hide-compact"
                      style={{ color: "var(--fg-tertiary)" }}
                    >
                      {row.requestId}
                    </span>

                    <span
                      className="truncate odag-console-hide-compact"
                      style={{
                        color:
                          row.settledLocally === true
                            ? "var(--st-completed)"
                            : row.settledLocally === false
                              ? "var(--st-dispatched)"
                              : "var(--fg-tertiary)",
                        fontSize: "var(--text-xs)",
                      }}
                    >
                      {row.settledLocally === true
                        ? t("ide.dock.localSettled")
                        : row.settledLocally === false
                          ? t("ide.dock.localUnsettled")
                          : "—"}
                    </span>

                    <span className="truncate" style={{ display: "inline-flex", justifyContent: "flex-start" }}>
                      {receipt ? (
                        <span
                          className="odag-console-tag"
                          style={{
                            color: receiptTone(bucket),
                            borderColor: `color-mix(in oklab, ${receiptTone(bucket)}, transparent 60%)`,
                          }}
                        >
                          {bucket && bucket !== "other" ? t(`audit.state.${bucket}`) : receipt.state}
                          {receipt.probe === "failed" ? ` ${t("audit.probeFailed")}` : ""}
                        </span>
                      ) : (
                        <span className="odag-console-tag" style={{ color: "var(--fg-tertiary)" }}>
                          {isProbing ? t("audit.probing") : t("audit.inspect")}
                        </span>
                      )}
                    </span>
                  </button>

                  {isOpen && receipt && (
                    <div className="odag-console-drawer">
                      {row.note && (
                        <div style={{ color: "var(--fg-secondary)" }}>{row.note}</div>
                      )}

                      <dl className="record-facts" style={{ margin: 0 }}>
                        <dt>{t("record.request")}</dt>
                        <dd>
                          <code>{row.requestId}</code>
                        </dd>
                        <dt>{t("record.operation")}</dt>
                        <dd>
                          <code>{row.operation}</code>
                        </dd>
                        <dt>{t("record.run")}</dt>
                        <dd>
                          <code>{row.runId ?? t("audit.scopeUnknown")}</code>
                        </dd>
                        {row.taskId && (
                          <>
                            <dt>{t("record.task")}</dt>
                            <dd>
                              <code>{row.taskId}</code>
                            </dd>
                          </>
                        )}
                        {row.dispatchId && (
                          <>
                            <dt>{t("record.dispatch")}</dt>
                            <dd>
                              <code>{row.dispatchId}</code>
                            </dd>
                          </>
                        )}
                      </dl>

                      <div
                        className="mono"
                        style={{
                          padding: "6px 10px",
                          borderRadius: 5,
                          background: "var(--bg-canvas)",
                          border: "1px solid var(--border-hairline)",
                          color: receiptTone(bucket),
                          fontSize: "var(--text-sm)",
                        }}
                      >
                        <b>{receipt.state}</b> — {stateCaption(receipt)}
                      </div>

                      {receipt.interpretation && (
                        <div>
                          {t("audit.orcaSays")} <i>{receipt.interpretation}</i>
                        </div>
                      )}

                      <div className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--fg-tertiary)" }}>
                        {t("audit.probedAt", { time: formatTimestamp(receipt.probedAt) })}
                        {row.settledLocally === true
                          ? t("audit.settledDefinitive")
                          : row.settledLocally === false
                            ? t("audit.settledUnlearned")
                            : t("audit.settledNone")}
                        {t("audit.settledTail")}
                      </div>

                      {receipt.outcome != null && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <strong style={{ fontSize: "var(--text-sm)" }}>{t("record.outcome")}</strong>
                          <StructuredData value={receipt.outcome} />
                          <details>
                            <summary
                              className="mono"
                              style={{ cursor: "pointer", fontSize: "var(--text-xs)", color: "var(--fg-secondary)" }}
                            >
                              {t("report.raw")}
                            </summary>
                            <pre tabIndex={0} role="region" aria-label={t("report.raw")}>
                              <code>{JSON.stringify(receipt.outcome, null, 2)}</code>
                            </pre>
                          </details>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
});
