import { useCallback, useEffect, useState } from "react";
import { fetchRequestDetail, fetchRequests } from "../api";
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
 * The panel renders only once there is something audited to show.
 */

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

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/** The presentation bucket for a receipt state; unknown states stay verbatim. */
function stateBucket(state: string): "completed" | "pending" | "absent" | "unknown" | "other" {
  if (state === "completed" || state === "pending" || state === "absent") return state;
  if (state === "unknown") return "unknown";
  return "other";
}

function stateCaption(receipt: RequestReceiptView): string {
  switch (stateBucket(receipt.state)) {
    case "completed":
      return "Orca recorded an outcome for this request.";
    case "pending":
      return "Orca recorded the request without a final outcome — it may still be in flight, or its response was lost.";
    case "absent":
      return "Orca holds no record under this id. Absence is NOT proof that the mutation did not happen.";
    case "unknown":
      return "Orca could not be asked right now — the outcome stays unresolved. Nothing is inferred.";
    default:
      return "The runtime reported this state verbatim; no interpretation is added.";
  }
}

export function RequestAuditPanel({ runId }: { runId: string }) {
  const [rows, setRows] = useState<RequestLedgerRowView[]>([]);
  const [otherRunCount, setOtherRunCount] = useState(0);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Map<string, RequestReceiptView>>(new Map());
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
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
  }, [runId]);

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

  if (loadedFor !== runId) return null;
  if (rows.length === 0 && !err) return null;

  return (
    <div className="gates inbox audit" data-testid="request-audit-panel">
      <div className="gate inbox__item">
        <div className="gate__badge">Mutation requests · audit</div>
        <div className="inbox__meta audit__caption">
          Viewer-originated request ids, kept so <code>request-show</code> stays reachable even
          after a response loss or a viewer restart. Read-only — this surface never replays a
          mutation.
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
                title="Ask Orca request-show for this id (read-only)"
              >
                <span className="audit__op" data-op={row.operation}>
                  {row.operation}
                </span>
                {receipt && (
                  <span className="audit__state" data-state={bucket}>
                    {receipt.state}
                    {receipt.probe === "failed" ? " (probe failed)" : ""}
                  </span>
                )}
                <code>{shortId(row.requestId)}</code>
                <span className="inbox__meta">
                  {row.taskId ? ` · ${row.taskId}` : ""}
                  {row.dispatchId ? ` · ${row.dispatchId}` : ""}
                  {` · ${row.runId === null ? "scope unknown" : row.runId}`}
                  {` · ${clock(row.updatedAt)}`}
                </span>
                <span className="audit__hint">{isOpen ? "▲" : "Inspect"}</span>
              </button>
              {row.note && <div className="inbox__body audit__note">{row.note}</div>}
              {isOpen && receipt && (
                <div className="audit__detail">
                  <div className={`audit__receipt audit__receipt--${bucket}`}>
                    <b>{receipt.state}</b> — {stateCaption(receipt)}
                  </div>
                  {receipt.interpretation && (
                    <div className="inbox__body">
                      Orca says: <i>{receipt.interpretation}</i>
                    </div>
                  )}
                  <div className="inbox__meta">
                    Probed {clock(receipt.probedAt)} ·{" "}
                    {row.settledLocally === true
                      ? "the viewer observed a definitive outcome during the call"
                      : row.settledLocally === false
                        ? "the viewer never learned the outcome during the call"
                        : "the viewer recorded no outcome observation"}
                    . The live probe above is what counts.
                  </div>
                  {receipt.outcome != null && (
                    <details className="audit__outcome">
                      <summary>Recorded outcome (diagnostic)</summary>
                      <pre className="workers__rawpre">{JSON.stringify(receipt.outcome, null, 2)}</pre>
                    </details>
                  )}
                </div>
              )}
              {isOpen && probing === row.requestId && (
                <div className="inbox__body">Probing Orca…</div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && err === null && (
          <div className="inbox__body">No viewer-originated mutation requests recorded yet.</div>
        )}
        {otherRunCount > 0 && (
          <div className="inbox__meta">
            {otherRunCount} recorded request{otherRunCount === 1 ? "" : "s"} belong
            {otherRunCount === 1 ? "s" : ""} to other Runs and are not listed here.
          </div>
        )}
        {err && <div className="exec__err inbox__err">⚠️ {err}</div>}
      </div>
    </div>
  );
}
