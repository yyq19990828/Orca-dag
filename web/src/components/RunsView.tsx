import { memo, useCallback, useEffect, useState } from "react";
import { Archive, History, Search } from "lucide-react";
import { fetchRemovedWork, fetchRunById, fetchRunHealth, fetchRunsPage } from "../api";
import {
  classifyRunRowMode,
  COORDINATION_MODE_META,
  formatCoordinatorHandleShort,
  resolveCoordinationMode,
} from "../coordinationMode";
import { formatDateTime } from "../format";
import { useT } from "../i18n";
import type { OrcaRun, RemovedWorkEntryView, RunHealthView, RunStatus, WorkerRowView } from "../types";
import { CoordinationModeIcon } from "./CoordinationModeIcon";

export const RunsView = memo(function RunsView({
  runId,
  workerRows,
  pendingGatesCount,
  pendingInboxCount,
  health: providedHealth,
  runStatus = null,
  onPickRun,
}: {
  runId: string;
  workerRows: WorkerRowView[];
  pendingGatesCount: number;
  pendingInboxCount: number;
  health?: RunHealthView | null;
  runStatus?: RunStatus | null;
  onPickRun: (nextRunId: string) => void;
}) {
  const t = useT();
  const [runs, setRuns] = useState<OrcaRun[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [exactId, setExactId] = useState("");
  const [exactError, setExactError] = useState<string | null>(null);
  const [polledHealth, setPolledHealth] = useState<RunHealthView | null>(null);
  const health = providedHealth !== undefined ? providedHealth : polledHealth;

  const [removedItems, setRemovedItems] = useState<RemovedWorkEntryView[] | null>(null);
  const [removedCursor, setRemovedCursor] = useState<string | null>(null);
  const [removedLoading, setRemovedLoading] = useState(false);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const page = await fetchRunsPage({ limit: 25 });
      setRuns(page.runs);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    setRemovedItems(null);
    setRemovedCursor(null);
    if (providedHealth !== undefined) return;
    setPolledHealth(null);
    if (!runId) return;
    let alive = true;
    void fetchRunHealth(runId)
      .then((h) => {
        if (alive) setPolledHealth(h);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [runId, providedHealth]);

  async function loadOlder() {
    if (!nextCursor || loading) return;
    setLoading(true);
    try {
      const page = await fetchRunsPage({ cursor: nextCursor, limit: 25 });
      setRuns((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...page.runs.filter((r) => !seen.has(r.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setLoading(false);
    }
  }

  async function lookupExact(e: React.FormEvent) {
    e.preventDefault();
    const target = exactId.trim();
    if (!target) return;
    setExactError(null);
    try {
      const { run } = await fetchRunById(target);
      setRuns((prev) => (prev.some((r) => r.id === run.id) ? prev : [run, ...prev]));
      onPickRun(run.id);
      setExactId("");
    } catch (err) {
      setExactError(String((err as Error).message ?? err));
    }
  }

  async function loadRemoved(cursor?: string) {
    if (!runId || removedLoading) return;
    setRemovedLoading(true);
    try {
      const page = await fetchRemovedWork(runId, cursor);
      setRemovedItems((prev) => (cursor && prev ? [...prev, ...page.entries] : page.entries));
      setRemovedCursor(page.page.nextCursor);
    } catch {
      /* read failure leaves removedItems untouched */
    } finally {
      setRemovedLoading(false);
    }
  }

  const q = query.trim().toLowerCase();
  const filteredRuns = runs.filter((r) => {
    if (!q) return true;
    const rowMode = classifyRunRowMode(r, runStatus);
    const modeLabel = t(COORDINATION_MODE_META[rowMode].label).toLowerCase();
    return (
      r.id.toLowerCase().includes(q) ||
      (r.objective ?? "").toLowerCase().includes(q) ||
      (r.coordinator_handle ?? "").toLowerCase().includes(q) ||
      modeLabel.includes(q)
    );
  });

  const activeDispatches = workerRows.filter((w) => w.dispatchStatus === "dispatched").length;
  const retainedPanes = workerRows.filter((w) => w.terminalState === "retained").length;
  const activeMode = health ? resolveCoordinationMode(health) : null;
  const activeModeMeta = activeMode ? COORDINATION_MODE_META[activeMode] : null;

  return (
    <div className="odag-scroll" style={{ flex: 1, minBlockSize: 0, overflowY: "auto", padding: 16 }}>
      <div style={{ maxInlineSize: 1120, marginInline: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Evidence-backed Run Health Metrics */}
        {runId && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
            {[
              {
                label: t("ide.runs.activeDispatches"),
                value: String(activeDispatches),
                sub: activeModeMeta
                  ? health?.coordinatorHandle
                    ? `${t(activeModeMeta.shortLabel)} · ${formatCoordinatorHandleShort(health.coordinatorHandle, 22)}`
                    : t(activeModeMeta.shortLabel)
                  : t("ide.runs.unbound"),
                tone: "var(--accent)",
              },
              {
                label: t("ide.runs.pendingGates"),
                value: String(pendingGatesCount),
                sub: runId,
                tone: pendingGatesCount > 0 ? "var(--st-blocked)" : "var(--st-completed)",
              },
              {
                label: t("ide.runs.inboxPending"),
                value: String(pendingInboxCount),
                sub: health?.warnings?.length ? `${health.warnings.length} warnings` : "Orca inbox",
                tone: pendingInboxCount > 0 ? "var(--st-dispatched)" : "var(--fg-secondary)",
              },
              {
                label: t("ide.runs.retainedPanes"),
                value: String(retainedPanes),
                sub: "worker-list custody",
                tone: "var(--fg-secondary)",
              },
            ].map((card) => (
              <div key={card.label} className="odag-card">
                <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-secondary)" }}>{card.label}</div>
                <div className="mono" style={{ fontSize: "var(--text-xl)", fontWeight: 700, marginBlock: "4px 2px", color: card.tone }}>
                  {card.value}
                </div>
                <div className="mono truncate" style={{ fontSize: "var(--text-xs)", color: "var(--fg-tertiary)" }}>
                  {card.sub}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Paginated Run Ledger */}
        <section className="odag-card" style={{ padding: 0, overflow: "hidden" }}>
          <header
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "10px 14px",
              borderBlockEnd: "1px solid var(--border-hairline)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <History size={15} style={{ color: "var(--accent)" }} aria-hidden="true" />
              <strong>{t("ide.runs.historyTitle")}</strong>
              <span className="odag-count">{filteredRuns.length}</span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div className="odag-search-box" style={{ marginInlineStart: 0 }}>
                <Search size={12} style={{ color: "var(--fg-tertiary)" }} aria-hidden="true" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("ide.runs.filterPlaceholder")}
                  aria-label={t("ide.runs.filterPlaceholder")}
                />
              </div>

              <form onSubmit={lookupExact} style={{ display: "inline-flex", gap: 4 }}>
                <input
                  value={exactId}
                  onChange={(e) => setExactId(e.target.value)}
                  placeholder={t("ide.runs.exactPlaceholder")}
                  aria-label={t("ide.runs.exactPlaceholder")}
                  className="mono"
                  style={{
                    blockSize: 28,
                    inlineSize: 136,
                    paddingInline: 8,
                    borderRadius: 6,
                    border: "1px solid var(--border-control)",
                    background: "var(--bg-panel)",
                    fontSize: "var(--text-sm)",
                  }}
                />
                <button type="submit" className="odag-btn" style={{ blockSize: 28 }}>
                  {t("ide.runs.lookup")}
                </button>
              </form>
            </div>
          </header>

          {(error || exactError) && (
            <div style={{ padding: "8px 14px", background: "var(--st-failed-bg)", color: "var(--st-failed)", fontSize: "var(--text-sm)" }}>
              {exactError ?? error}
            </div>
          )}

          <div style={{ overflowX: "auto" }}>
            <table style={{ inlineSize: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
              <thead>
                <tr
                  style={{
                    color: "var(--fg-tertiary)",
                    borderBlockEnd: "1px solid var(--border-hairline)",
                    background: "var(--bg-panel)",
                  }}
                >
                  <th scope="col" style={{ padding: "8px 14px", textAlign: "start", fontWeight: 600 }}>{t("ide.runs.colId")}</th>
                  <th scope="col" style={{ padding: "8px 14px", textAlign: "start", fontWeight: 600 }}>{t("ide.runs.colObjective")}</th>
                  <th scope="col" style={{ padding: "8px 14px", textAlign: "start", fontWeight: 600 }}>{t("ide.runs.colCoordinator")}</th>
                  <th scope="col" style={{ padding: "8px 14px", textAlign: "start", fontWeight: 600 }}>{t("ide.runs.colCreated")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredRuns.map((row) => {
                  const active = row.id === runId;
                  const rowMode = classifyRunRowMode(row, runStatus);
                  const rowMeta = COORDINATION_MODE_META[rowMode];
                  return (
                    <tr
                      key={row.id}
                      onClick={() => onPickRun(row.id)}
                      style={{
                        cursor: "pointer",
                        borderBlockEnd: "1px solid var(--border-hairline)",
                        background: active ? "color-mix(in oklab, var(--accent), transparent 90%)" : undefined,
                      }}
                    >
                      <td className="mono" style={{ padding: "10px 14px", color: "var(--accent)", fontWeight: 600 }}>
                        {row.id}
                      </td>
                      <td style={{ padding: "10px 14px", fontWeight: 500 }}>{row.objective || "—"}</td>
                      <td style={{ padding: "10px 14px" }}>
                        <div className="odag-runs-mode-cell">
                          <span
                            className={`odag-mode-pill odag-mode-pill--${rowMeta.tone}`}
                            title={t(rowMeta.brief)}
                          >
                            <CoordinationModeIcon mode={rowMode} size={11} />
                            <span>{t(rowMeta.shortLabel)}</span>
                          </span>
                          {row.coordinator_handle && (
                            <span
                              className="mono truncate"
                              style={{ fontSize: "var(--text-xs)", color: "var(--fg-tertiary)", maxInlineSize: 220 }}
                              title={row.coordinator_handle}
                            >
                              {row.coordinator_handle}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="mono" style={{ padding: "10px 14px", color: "var(--fg-tertiary)", fontSize: "var(--text-xs)" }}>
                        {row.created_at ? formatDateTime(row.created_at) : "—"}
                      </td>
                    </tr>
                  );
                })}
                {filteredRuns.length === 0 && !loading && (
                  <tr>
                    <td colSpan={4} style={{ padding: 24, textAlign: "center", color: "var(--fg-tertiary)" }}>
                      {t("ide.runs.noRuns")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <footer
            style={{
              padding: "8px 14px",
              fontSize: "var(--text-sm)",
              color: "var(--fg-tertiary)",
              background: "var(--bg-panel)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <span>{t("ide.runs.boundaryNote")}</span>
            {nextCursor && (
              <button type="button" className="odag-btn" disabled={loading} onClick={() => void loadOlder()}>
                {t("ide.runs.loadOlder")}
              </button>
            )}
          </footer>
        </section>

        {/* On-Demand Removed Worktree Audit */}
        {runId && (
          <section className="odag-card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Archive size={15} style={{ color: "var(--fg-secondary)" }} aria-hidden="true" />
                <strong>{t("ide.runs.removedTitle")}</strong>
              </div>
              {removedItems === null ? (
                <button type="button" className="odag-btn" disabled={removedLoading} onClick={() => void loadRemoved()}>
                  {t("ide.runs.loadRemoved")}
                </button>
              ) : removedCursor ? (
                <button
                  type="button"
                  className="odag-btn"
                  disabled={removedLoading}
                  onClick={() => void loadRemoved(removedCursor)}
                >
                  {t("ide.runs.loadOlder")}
                </button>
              ) : null}
            </div>

            {removedItems !== null && (
              <div style={{ marginBlockStart: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                {removedItems.length === 0 ? (
                  <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-tertiary)" }}>—</span>
                ) : (
                  removedItems.map((item) => (
                    <div
                      key={`${item.seq}:${item.id}`}
                      className="mono"
                      style={{
                        fontSize: "var(--text-sm)",
                        paddingBlock: 6,
                        borderBlockStart: "1px solid var(--border-hairline)",
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <span className="truncate">{`${item.kind}: ${item.id}`}</span>
                      <span style={{ color: "var(--fg-tertiary)" }}>{item.removedAt ? formatDateTime(item.removedAt) : ""}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
});
