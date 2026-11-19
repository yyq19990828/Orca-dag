import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchEnvironments, fetchWorkerOutput, openWorkerOutputStream } from "../api";
import { useT } from "../i18n";
import { usePageVisible } from "../visibility";
import type { WorkerOutputView, WorkerRowView } from "../types";

type OutputSource = "auto" | "terminal" | "transcript";

/** Rows per manual worker-read page (server clamps to 200). */
const PAGE_LIMIT = 120;
/** Client-side retention cap; older loaded rows are dropped, never refetched. */
const MAX_RETAINED_LINES = 5_000;
/** Distance from the bottom that still counts as "pinned to the tail". */
const STICK_THRESHOLD_PX = 32;

/**
 * The single worker-read viewer (bottom dock → "Worker output").
 *
 * Every other surface (Scheduler fleet rows, Node Session panel) jumps here
 * via `onOpenOutput` instead of rendering a second copy of the raw output.
 *
 * Auto-refresh ("follow") subscribes to the server's centralized OutputTail
 * SSE stream (`/api/workers/:id/output/stream`), so multiple views share one
 * upstream `worker-read` poller — woke immediately by the companion Orca
 * plugin when connected. Pauses when the dock is collapsed or the page is
 * hidden, and shows "worker exited · stopped" once drained.
 */
export const WorkerOutputDockView = memo(function WorkerOutputDockView({
  runId,
  workerRows,
  labelsById,
  selectedDispatchId,
  onSelectDispatchId,
  active = true,
}: {
  runId: string;
  workerRows: WorkerRowView[];
  labelsById: Record<string, string>;
  selectedDispatchId: string | null;
  onSelectDispatchId: (dispatchId: string) => void;
  /** False while the dock is collapsed: live stream closes to avoid idle work. */
  active?: boolean;
}) {
  const t = useT();
  const visible = usePageVisible();
  const [source, setSource] = useState<OutputSource>("auto");
  const [view, setView] = useState<{
    output: WorkerOutputView;
    trimmed: number;
    drained: boolean;
  } | null>(null);
  const output = view?.output ?? null;
  const trimmed = view?.trimmed ?? 0;
  const drained = view?.drained ?? false;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");
  const [envs, setEnvs] = useState<Awaited<ReturnType<typeof fetchEnvironments>>>([]);
  const reqSeq = useRef(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    let alive = true;
    fetchEnvironments()
      .then((e) => alive && setEnvs(e))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // A selection from another Run (or a vanished row) never addresses a read.
  const activeRow =
    workerRows.find((row) => row.dispatchId === selectedDispatchId) ?? workerRows[0] ?? null;
  const activeId = activeRow?.dispatchId || null;

  // Structured transcript reads are a peer capability: always for local
  // workers, for remote workers only when their environment advertises it.
  const host = activeRow?.projection?.host ?? null;
  const hostEnv = host ? envs.find((e) => e.id === host.id) : undefined;
  const canTranscript =
    host?.kind === "local" || (host?.kind != null && host.kind !== "local" && (hostEnv?.peer.transcriptRead ?? false));
  const effectiveSource: OutputSource = source === "transcript" && !canTranscript ? "auto" : source;

  // Manual one-shot paging (used when auto-refresh is off).
  const loadPage = useCallback(
    async (cursor?: string) => {
      if (!runId || !activeId) {
        setView(null);
        return;
      }
      const seq = ++reqSeq.current;
      setLoading(true);
      try {
        const res = await fetchWorkerOutput(runId, activeId, {
          source: effectiveSource === "auto" ? undefined : effectiveSource,
          cursor,
          limit: PAGE_LIMIT,
        });
        if (seq !== reqSeq.current) return;
        const continues = Boolean(cursor) && !res.sourceChanged;
        const exited = res.status?.liveness === "exited";
        setView((prev) => {
          if (!continues || !prev) {
            return { output: res, trimmed: 0, drained: exited && res.lines.length === 0 };
          }
          const merged = [...prev.output.lines, ...res.lines];
          const overflow = Math.max(0, merged.length - MAX_RETAINED_LINES);
          return {
            output: { ...res, lines: overflow > 0 ? merged.slice(overflow) : merged },
            trimmed: prev.trimmed + overflow,
            drained: exited && res.lines.length === 0,
          };
        });
        setError(null);
      } catch (err) {
        if (seq === reqSeq.current) setError(String((err as Error).message ?? err));
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [runId, activeId, effectiveSource],
  );

  // Reset state on Dispatch/source change.
  useEffect(() => {
    setView(null);
    setError(null);
    setFilter("");
    stickToBottom.current = true;
  }, [runId, activeId, effectiveSource]);

  // Live mode: subscribe to server-side OutputTail SSE when visible & open.
  const streamActive = follow && active && visible && Boolean(runId && activeId);
  useEffect(() => {
    if (!streamActive || !runId || !activeId) return;
    setLoading(true);
    const close = openWorkerOutputStream(
      runId,
      activeId,
      { source: effectiveSource },
      {
        onInit: (snap) => {
          setLoading(false);
          setError(null);
          setView({
            output: snap.output,
            trimmed: snap.trimmedLines,
            drained: snap.streamingState === "drained",
          });
        },
        onReset: (snap) => {
          setLoading(false);
          setError(null);
          setView({
            output: snap.output,
            trimmed: snap.trimmedLines,
            drained: snap.streamingState === "drained",
          });
        },
        onAppend: (delta) => {
          setLoading(false);
          setError(null);
          setView((prev) => {
            if (!prev) {
              return {
                output: delta.output,
                trimmed: delta.trimmedLines,
                drained: delta.streamingState === "drained",
              };
            }
            const merged = [...prev.output.lines, ...delta.output.lines];
            const overflow = Math.max(0, merged.length - MAX_RETAINED_LINES);
            return {
              output: { ...delta.output, lines: overflow > 0 ? merged.slice(overflow) : merged },
              trimmed: Math.max(delta.trimmedLines, prev.trimmed + overflow),
              drained: delta.streamingState === "drained",
            };
          });
        },
        onError: (msg) => {
          setLoading(false);
          setError(msg);
        },
      },
    );
    return close;
  }, [streamActive, runId, activeId, effectiveSource]);

  // Manual mode: fetch initial page if switching to manual before anything loaded.
  useEffect(() => {
    if (follow || !active || !runId || !activeId || output !== null) return;
    void loadPage();
  }, [follow, active, runId, activeId, output, loadPage]);

  // Keep the newest rows in view while following, unless the user scrolled up.
  const lineCount = output?.lines.length ?? 0;
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el || !follow || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lineCount, trimmed, follow]);

  if (workerRows.length === 0) {
    return <div className="odag-console-empty">{t("ide.dock.noWorkers")}</div>;
  }

  const q = filter.trim().toLowerCase();
  const lines = output?.lines ?? [];
  const rows = lines.map((line, idx) => ({ n: trimmed + idx + 1, line }));
  const visibleRows = q ? rows.filter((r) => r.line.toLowerCase().includes(q)) : rows;

  const downloadLoaded = () => {
    if (!output) return;
    const blob = new Blob([output.lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `worker-output-${output.dispatchId}-${output.source}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const selectStyle = {
    blockSize: 21,
    paddingInline: 6,
    borderRadius: 4,
    border: "1px solid var(--border-hairline)",
    background: "var(--bg-panel)",
    fontSize: "var(--text-xs)",
  } as const;
  const metaStyle = { fontSize: "var(--text-xs)", color: "var(--fg-tertiary)" } as const;

  const followState = !follow
    ? null
    : drained
      ? t("ide.dock.followDone")
      : !visible || !active
        ? t("ide.dock.followPaused")
        : t("ide.dock.followLive");

  return (
    <div style={{ display: "flex", flexDirection: "column", blockSize: "100%", minBlockSize: 0 }}>
      <div className="odag-dock-toolbar" style={{ flexWrap: "wrap" }}>
        <select
          value={activeId ?? ""}
          onChange={(e) => onSelectDispatchId(e.target.value)}
          aria-label={t("ide.dock.selectDispatch")}
          className="mono"
          style={selectStyle}
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
            value={effectiveSource}
            onChange={(e) => setSource(e.target.value as OutputSource)}
            aria-label={t("worker.outputSourceLabel")}
            style={selectStyle}
          >
            <option value="auto">auto</option>
            <option value="terminal">terminal</option>
            {canTranscript && <option value="transcript">transcript</option>}
          </select>
        </label>

        <label
          className="mono"
          title={t("ide.dock.followTitle")}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--text-xs)", color: "var(--fg-secondary)" }}
        >
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => {
              setFollow(e.target.checked);
              if (e.target.checked) stickToBottom.current = true;
            }}
          />
          <span>{t("ide.dock.follow")}</span>
          {followState && <span style={metaStyle}>· {followState}</span>}
        </label>

        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("worker.filterPlaceholder")}
          aria-label={t("worker.filterOutputAria")}
          className="mono"
          style={{ ...selectStyle, inlineSize: 180 }}
        />

        {output && (
          <span className="mono" style={metaStyle} title={t("worker.outputEvidenceNote")}>
            source={output.source}
            {output.archived === true ? ` · ${t("worker.outputArchived")}` : output.archived === false ? ` · ${t("worker.outputLive")}` : ""}
            {output.sourceExact != null ? ` · ${output.sourceExact ? t("worker.outputExact") : t("worker.outputNotExact")}` : ""}
            {output.provider ? ` · ${output.provider}` : ""}
            {output.clipped ? ` · ${t("worker.clipped")}` : ""}
            {output.sourceChanged ? ` · ${t("worker.sourceChanged")}` : ""}
          </span>
        )}

        <span style={{ marginInlineStart: "auto", display: "inline-flex", gap: 6, alignItems: "center" }}>
          {output && (
            <span className="mono" style={metaStyle}>
              {q
                ? t("worker.matchCount", { visible: visibleRows.length, total: lines.length })
                : t("ide.dock.rowsCount", { n: lines.length })}
            </span>
          )}
          {!follow && output?.cursor && !output.contentComplete && (
            <button
              type="button"
              className="odag-dock-chip"
              style={{ borderColor: "var(--border-control)" }}
              disabled={loading}
              onClick={() => void loadPage(output.cursor ?? undefined)}
            >
              {t("ide.dock.loadNextPage")}
            </button>
          )}
          {output && output.lines.length > 0 && (
            <button
              type="button"
              className="odag-dock-chip"
              style={{ borderColor: "var(--border-control)" }}
              onClick={downloadLoaded}
              title={t("worker.downloadTitle")}
            >
              {t("worker.download")}
            </button>
          )}
        </span>
      </div>

      <div
        ref={viewportRef}
        className="odag-dock-viewport odag-scroll"
        style={{ padding: "6px 10px" }}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
        }}
      >
        {error && <div style={{ color: "var(--st-failed)", marginBlockEnd: 6 }}>{error}</div>}
        {output?.fallbackReason != null && (
          <div style={{ ...metaStyle, marginBlockEnd: 4 }}>
            {t("worker.outputFallback")} {output.fallbackReason}
          </div>
        )}
        {output?.warnings?.map((w, idx) => (
          <div key={idx} style={{ color: "var(--st-dispatched)", marginBlockEnd: 4 }}>
            ⚠ {w}
          </div>
        ))}
        {trimmed > 0 && (
          <div style={{ ...metaStyle, marginBlockEnd: 4 }}>{t("ide.dock.trimmed", { n: MAX_RETAINED_LINES })}</div>
        )}
        {output && visibleRows.length === 0 && (
          <div style={metaStyle}>{t(q ? "worker.noMatch" : "worker.outputEmpty")}</div>
        )}
        {visibleRows.map(({ n, line }) => (
          <div key={n} style={{ display: "flex", gap: 10, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            <span style={{ color: "var(--fg-tertiary)", minInlineSize: 26, textAlign: "end", flex: "none", userSelect: "none" }}>
              {n}
            </span>
            <span style={{ flex: 1 }}>{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
