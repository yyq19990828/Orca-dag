import { memo, useCallback, useEffect, useRef, useState } from "react";
import { fetchWorkerOutput } from "../api";
import { useT } from "../i18n";
import type { WorkerOutputView, WorkerRowView } from "../types";

export const WorkerOutputDockView = memo(function WorkerOutputDockView({
  runId,
  workerRows,
  labelsById,
  selectedDispatchId,
  onSelectDispatchId,
}: {
  runId: string;
  workerRows: WorkerRowView[];
  labelsById: Record<string, string>;
  selectedDispatchId: string | null;
  onSelectDispatchId: (dispatchId: string) => void;
}) {
  const t = useT();
  const [source, setSource] = useState<"auto" | "terminal" | "transcript">("auto");
  const [output, setOutput] = useState<WorkerOutputView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqSeq = useRef(0);

  const activeId = selectedDispatchId || workerRows[0]?.dispatchId || null;

  const loadPage = useCallback(
    async (cursor?: string) => {
      if (!runId || !activeId) {
        setOutput(null);
        return;
      }
      const seq = ++reqSeq.current;
      setLoading(true);
      try {
        const res = await fetchWorkerOutput(runId, activeId, { source, cursor, limit: 120 });
        if (seq !== reqSeq.current) return;
        setOutput((prev) =>
          cursor && prev && !res.sourceChanged
            ? { ...res, lines: [...prev.lines, ...res.lines] }
            : res,
        );
        setError(null);
      } catch (err) {
        if (seq === reqSeq.current) setError(String((err as Error).message ?? err));
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [runId, activeId, source],
  );

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  if (workerRows.length === 0) {
    return <div className="odag-console-empty">{t("ide.dock.noWorkers")}</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", blockSize: "100%", minBlockSize: 0 }}>
      <div className="odag-dock-toolbar">
        <select
          value={activeId ?? ""}
          onChange={(e) => onSelectDispatchId(e.target.value)}
          aria-label={t("ide.dock.selectDispatch")}
          className="mono"
          style={{
            blockSize: 21,
            paddingInline: 6,
            borderRadius: 4,
            border: "1px solid var(--border-hairline)",
            background: "var(--bg-panel)",
            fontSize: "var(--text-xs)",
          }}
        >
          {workerRows.map((row) => (
            <option key={row.dispatchId} value={row.dispatchId}>
              {(labelsById[row.taskId] ?? row.taskId).slice(0, 28)} · {row.dispatchId}
            </option>
          ))}
        </select>

        <label
          className="mono"
          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--text-xs)", color: "var(--fg-secondary)" }}
        >
          <span>{t("ide.dock.outputSource")}:</span>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as "auto" | "terminal" | "transcript")}
            style={{
              blockSize: 21,
              paddingInline: 6,
              borderRadius: 4,
              border: "1px solid var(--border-hairline)",
              background: "var(--bg-panel)",
              fontSize: "var(--text-xs)",
            }}
          >
            <option value="auto">auto</option>
            <option value="terminal">terminal</option>
            <option value="transcript">transcript</option>
          </select>
        </label>

        {output && (
          <span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--fg-tertiary)" }}>
            source={output.source}
            {output.archived ? " · archived" : ""}
            {output.clipped ? " · clipped" : ""}
          </span>
        )}

        {output?.cursor && !output.contentComplete && (
          <button
            type="button"
            className="odag-dock-chip"
            style={{ marginInlineStart: "auto", borderColor: "var(--border-control)" }}
            disabled={loading}
            onClick={() => void loadPage(output.cursor ?? undefined)}
          >
            {t("ide.dock.loadNextPage")}
          </button>
        )}
      </div>

      <div
        className="odag-dock-viewport odag-scroll"
        style={{ padding: "6px 10px" }}
      >
        {error && <div style={{ color: "var(--st-failed)", marginBlockEnd: 6 }}>{error}</div>}
        {output?.warnings?.map((w, idx) => (
          <div key={idx} style={{ color: "var(--st-dispatched)", marginBlockEnd: 4 }}>
            ⚠ {w}
          </div>
        ))}
        {output?.lines.map((line, idx) => (
          <div key={idx} style={{ display: "flex", gap: 10, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            <span style={{ color: "var(--fg-tertiary)", inlineSize: 26, textAlign: "end", flex: "none", userSelect: "none" }}>
              {idx + 1}
            </span>
            <span style={{ flex: 1 }}>{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
