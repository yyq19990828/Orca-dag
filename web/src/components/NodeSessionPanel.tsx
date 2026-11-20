import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { openWorkerOutputStream } from "../api";
import { useT } from "../i18n";
import { usePageVisible } from "../visibility";
import type {
  DagNode,
  WorkerOutputView,
  WorkerRowView,
  WorkerTranscriptMessageView,
} from "../types";
import "./node-session.css";

const MAX_RETAINED_MESSAGES = 1_000;
const MAX_RETAINED_LINES = 5_000;
const STICK_THRESHOLD_PX = 40;
/** Only apply content-visibility: auto to items well below the initial fold. */
const DEFER_BELOW_INDEX = 12;

type TimelineItem =
  | {
      kind: "prompt";
      key: string;
      text: string;
      preview: string;
      timestamp: number | null;
    }
  | {
      kind: "text";
      key: string;
      role: string;
      text: string;
      model: string | null;
      timestamp: number | null;
    }
  | {
      kind: "tool";
      key: string;
      name: string;
      inputFormatted: string;
      preview: string;
      output: string | null;
      isError: boolean;
      status: "ok" | "error" | "pending";
      timestamp: number | null;
    }
  | {
      kind: "meta";
      key: string;
      label: string;
      detail: string;
    };

function formatToolPayload(raw: string): { formatted: string; preview: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { formatted: "", preview: "" };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") {
      const firstLine = parsed.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
      return { formatted: parsed, preview: firstLine.slice(0, 120) };
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      const priorityKeys = ["cmd", "command", "path", "file_path", "filePath", "query", "url", "pattern", "target"];
      let preview = "";
      for (const k of priorityKeys) {
        if (typeof rec[k] === "string" && rec[k].trim()) {
          preview = rec[k].trim().split("\n")[0].slice(0, 120);
          break;
        }
      }
      if (!preview) {
        const entries = Object.entries(rec)
          .slice(0, 2)
          .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 48) : JSON.stringify(v)?.slice(0, 48)}`);
        preview = entries.join(" ").slice(0, 120);
      }
      return { formatted: JSON.stringify(parsed, null, 2), preview };
    }
    return { formatted: JSON.stringify(parsed, null, 2), preview: trimmed.slice(0, 120) };
  } catch {
    const firstLine = trimmed.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
    return { formatted: trimmed, preview: firstLine.slice(0, 120) };
  }
}

function isDispatchPreamble(role: string, text: string, idx: number): boolean {
  if (role !== "user") return false;
  if (idx === 0 && text.length > 260) return true;
  return text.startsWith("You are working inside Orca");
}

function buildTimeline(messages: WorkerTranscriptMessageView[] | undefined): { items: TimelineItem[]; toolCount: number } {
  const items: TimelineItem[] = [];
  const toolByCallId = new Map<string, Extract<TimelineItem, { kind: "tool" }>>();
  let lastToolWithoutResult: Extract<TimelineItem, { kind: "tool" }> | null = null;
  let toolCount = 0;

  if (messages) {
    messages.forEach((msg, mIdx) => {
      const msgKey = msg.id ?? `m-${mIdx}`;
      msg.blocks.forEach((block, bIdx) => {
        const key = `${msgKey}:${bIdx}`;
        switch (block.type) {
          case "text": {
            const text = block.text.trim();
            if (!text) break;
            if (isDispatchPreamble(msg.role, text, mIdx)) {
              const firstLine = text.split("\n").find((l) => l.trim())?.trim() ?? "Worker dispatch prompt";
              items.push({
                kind: "prompt",
                key,
                text,
                preview: firstLine.slice(0, 110),
                timestamp: msg.timestamp,
              });
            } else {
              items.push({
                kind: "text",
                key,
                role: msg.role,
                text,
                model: msg.model ?? null,
                timestamp: msg.timestamp,
              });
            }
            break;
          }
          case "tool-call": {
            const { formatted, preview } = formatToolPayload(block.input);
            const item: Extract<TimelineItem, { kind: "tool" }> = {
              kind: "tool",
              key,
              name: block.name,
              inputFormatted: formatted,
              preview,
              output: null,
              isError: block.status === "error",
              status: block.status === "error" ? "error" : block.status === "completed" ? "ok" : "pending",
              timestamp: msg.timestamp,
            };
            items.push(item);
            toolCount += 1;
            if (block.callId) toolByCallId.set(block.callId, item);
            lastToolWithoutResult = item;
            break;
          }
          case "tool-result": {
            const target =
              (block.callId ? toolByCallId.get(block.callId) : null) ??
              (lastToolWithoutResult && lastToolWithoutResult.output === null ? lastToolWithoutResult : null);
            if (target) {
              target.output = target.output ? `${target.output}\n${block.output}` : block.output;
              if (block.isError) target.isError = true;
              target.status = target.isError ? "error" : "ok";
              if (target === lastToolWithoutResult) lastToolWithoutResult = null;
            } else {
              items.push({
                kind: "tool",
                key,
                name: "tool-result",
                inputFormatted: "",
                preview: block.output.split("\n")[0]?.slice(0, 110) ?? "",
                output: block.output,
                isError: Boolean(block.isError),
                status: block.isError ? "error" : "ok",
                timestamp: msg.timestamp,
              });
              toolCount += 1;
            }
            break;
          }
          case "subagent":
            items.push({ kind: "meta", key, label: "subagent", detail: `${block.label} · ${block.state}` });
            break;
          case "subagent-group":
            items.push({
              kind: "meta",
              key,
              label: "subagents",
              detail: block.count !== null ? `${block.count} agents` : "unknown",
            });
            break;
          case "background-task":
            items.push({ kind: "meta", key, label: "background", detail: `${block.label} · ${block.state}` });
            break;
          case "image-ref":
            items.push({ kind: "meta", key, label: "image", detail: block.reference ?? "(omitted)" });
            break;
          case "unsupported":
            items.push({ kind: "meta", key, label: "block", detail: block.blockType ?? "unsupported" });
            break;
        }
      });
    });
  }

  return { items, toolCount };
}

function formatClock(ts: number | null): string | null {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return null;
  }
}

/**
 * Right-inspector "Session" tab for a single Task node (M2).
 *
 * Subscribes to the centralized server-side OutputTail SSE stream only while
 * this tab is active and the page is visible. Renders structured assistant
 * turns and collapsible `<details>` tool-call cards so the operator can see
 * what the node is doing at a glance from its scoped transcript.
 */
export const NodeSessionPanel = memo(function NodeSessionPanel({
  runId,
  task,
  workerRows,
  active,
  onOpenOutput,
}: {
  runId: string;
  task: DagNode;
  workerRows: WorkerRowView[];
  active: boolean;
  onOpenOutput?: (dispatchId: string) => void;
}) {
  const t = useT();
  const visible = usePageVisible();

  const taskDispatches = useMemo(() => {
    const matches = workerRows.filter((row) => row.taskId === task.id && row.dispatchId);
    // Keep the task's current dispatch first if present.
    if (task.dispatchId) {
      matches.sort((a, b) => (a.dispatchId === task.dispatchId ? -1 : b.dispatchId === task.dispatchId ? 1 : 0));
    }
    return matches;
  }, [workerRows, task.id, task.dispatchId]);

  const [pickedDispatchId, setPickedDispatchId] = useState<string | null>(null);
  const activeDispatchId = useMemo(() => {
    if (pickedDispatchId && taskDispatches.some((r) => r.dispatchId === pickedDispatchId)) {
      return pickedDispatchId;
    }
    return task.dispatchId ?? taskDispatches[0]?.dispatchId ?? null;
  }, [pickedDispatchId, taskDispatches, task.dispatchId]);

  const [streamState, setStreamState] = useState<{
    output: WorkerOutputView;
    drained: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    setStreamState(null);
    setError(null);
    stickToBottom.current = true;
    setAwayFromBottom(false);
  }, [runId, activeDispatchId]);

  const shouldStream = active && visible && Boolean(runId && activeDispatchId);
  useEffect(() => {
    if (!shouldStream || !runId || !activeDispatchId) return;
    const close = openWorkerOutputStream(
      runId,
      activeDispatchId,
      { source: "auto" },
      {
        onInit: (snap) => {
          setError(null);
          setStreamState({
            output: snap.output,
            drained: snap.streamingState === "drained",
          });
        },
        onReset: (snap) => {
          setError(null);
          setStreamState({
            output: snap.output,
            drained: snap.streamingState === "drained",
          });
        },
        onAppend: (delta) => {
          setError(null);
          setStreamState((prev) => {
            if (!prev) {
              return {
                output: delta.output,
                drained: delta.streamingState === "drained",
              };
            }
            const mergedLines = [...prev.output.lines, ...delta.output.lines].slice(-MAX_RETAINED_LINES);
            const mergedMessages = delta.output.messages
              ? [...(prev.output.messages ?? []), ...delta.output.messages].slice(-MAX_RETAINED_MESSAGES)
              : prev.output.messages;
            return {
              output: {
                ...delta.output,
                lines: mergedLines,
                ...(mergedMessages !== undefined ? { messages: mergedMessages } : {}),
              },
              drained: delta.streamingState === "drained",
            };
          });
        },
        onError: (msg) => setError(msg),
      },
    );
    return close;
  }, [shouldStream, runId, activeDispatchId]);

  const output = streamState?.output ?? null;
  const drained = streamState?.drained ?? false;

  const messages = output?.messages;
  const { items, toolCount } = useMemo(() => buildTimeline(messages), [messages]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [items.length, output?.lines.length]);

  if (!activeDispatchId) {
    return (
      <div className="odag-session">
        <div className="odag-session__empty">{t("session.noDispatch")}</div>
      </div>
    );
  }

  const hasStructured = Boolean(messages?.length);
  const isTerminalOnly = Boolean(output && !hasStructured);

  return (
    <div className="odag-session">
      <div className="odag-session__bar">
        {taskDispatches.length > 1 ? (
          <select
            className="odag-session__select"
            value={activeDispatchId}
            onChange={(e) => setPickedDispatchId(e.target.value)}
            aria-label={t("ide.dock.selectDispatch")}
          >
            {taskDispatches.map((row) => (
              <option key={row.dispatchId} value={row.dispatchId}>
                {row.dispatchId} · {row.workerState}
              </option>
            ))}
          </select>
        ) : (
          <span className="odag-session__pill">{activeDispatchId}</span>
        )}

        {output && (
          <span className="odag-session__pill" title={t("worker.outputEvidenceNote")}>
            {output.source}
            {output.provider ? ` · ${output.provider}` : ""}
          </span>
        )}

        <span className={`odag-session__pill${drained ? "" : " odag-session__pill--live"}`}>
          {drained ? t("session.stateDrained") : t("session.stateLive")}
        </span>

        {toolCount > 0 && (
          <span className="odag-session__pill">{t("session.toolCount", { n: toolCount })}</span>
        )}

        <span className="odag-session__bar-actions">
          {onOpenOutput && (
            <button
              type="button"
              className="odag-session__raw-btn"
              onClick={() => onOpenOutput(activeDispatchId)}
              title={t("worker.viewOutputTitle")}
            >
              <span>{t("session.openRawOutput")}</span>
              <ExternalLink size={11} aria-hidden="true" />
            </button>
          )}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="odag-session__scroll odag-scroll"
        aria-label={t("session.timelineAria")}
        onScroll={(e) => {
          const el = e.currentTarget;
          const pinned = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
          stickToBottom.current = pinned;
          setAwayFromBottom(!pinned);
        }}
      >
        {error && <div className="odag-session__error">{error}</div>}
        {output?.warnings?.map((w, i) => (
          <div key={i} className="odag-session__warn">
            ⚠ {w}
          </div>
        ))}

        {!output && !error && (
          <div className="odag-session__empty">{t("session.loading")}</div>
        )}

        {hasStructured &&
          items.map((item, idx) => {
            const deferCls = idx >= DEFER_BELOW_INDEX ? " odag-session__deferred" : "";
            if (item.kind === "prompt") {
              return (
                <details key={item.key} className={`odag-tool-card${deferCls}`}>
                  <summary>
                    <ChevronDown size={13} className="odag-tool-card__chevron" aria-hidden="true" />
                    <span className="odag-tool-card__name">{t("session.dispatchPrompt")}</span>
                    <span className="odag-tool-card__preview">{item.preview}</span>
                  </summary>
                  <div className="odag-tool-card__body">
                    <pre className="odag-tool-card__code">{item.text}</pre>
                  </div>
                </details>
              );
            }
            if (item.kind === "text") {
              const clock = formatClock(item.timestamp);
              return (
                <article
                  key={item.key}
                  className={`odag-session__turn${item.role === "user" ? " odag-session__turn--user" : ""}${deferCls}`}
                >
                  <div className="odag-session__turn-meta">
                    <span className="odag-session__turn-role">{item.role}</span>
                    {item.model && <span>· {item.model}</span>}
                    {clock && <span style={{ marginInlineStart: "auto" }}>{clock}</span>}
                  </div>
                  <p className="odag-session__turn-text">{item.text}</p>
                </article>
              );
            }
            if (item.kind === "tool") {
              const clock = formatClock(item.timestamp);
              return (
                <details
                  key={item.key}
                  className={`odag-tool-card${item.isError ? " odag-tool-card--error" : ""}${deferCls}`}
                >
                  <summary>
                    <ChevronDown size={13} className="odag-tool-card__chevron" aria-hidden="true" />
                    <span
                      className={`odag-tool-card__dot odag-tool-card__dot--${item.status}`}
                      aria-hidden="true"
                    />
                    <span className="odag-tool-card__name">{item.name}</span>
                    <span className="odag-tool-card__preview">{item.preview}</span>
                    {item.isError && (
                      <span className="odag-tool-card__tag odag-tool-card__tag--error">ERR</span>
                    )}
                    {clock && <span style={{ color: "var(--fg-tertiary)", flex: "none" }}>{clock}</span>}
                  </summary>
                  <div className="odag-tool-card__body">
                    {item.inputFormatted && (
                      <div>
                        <div className="odag-tool-card__label">{t("session.toolInput")}</div>
                        <pre className="odag-tool-card__code">{item.inputFormatted}</pre>
                      </div>
                    )}
                    {item.output !== null && (
                      <div>
                        <div className="odag-tool-card__label">{t("session.toolOutput")}</div>
                        <pre
                          className={`odag-tool-card__code${item.isError ? " odag-tool-card__code--error" : ""}`}
                        >
                          {item.output}
                        </pre>
                      </div>
                    )}
                  </div>
                </details>
              );
            }
            return (
              <div key={item.key} className={`odag-session__pill${deferCls}`}>
                <strong>{item.label}</strong>
                <span>{item.detail}</span>
              </div>
            );
          })}

        {isTerminalOnly && (
          <>
            {output!.source === "terminal" && (
              <div className="odag-session__warn">{t("session.terminalFallbackNote")}</div>
            )}
            {output!.lines.length > 0 ? (
              <pre className="odag-session__terminal-fallback">
                {output!.lines.slice(-80).join("\n")}
              </pre>
            ) : (
              <div className="odag-session__empty">{t("worker.outputEmpty")}</div>
            )}
          </>
        )}

        {awayFromBottom && (
          <button
            type="button"
            className="odag-session__jump"
            onClick={() => {
              stickToBottom.current = true;
              setAwayFromBottom(false);
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            {t("session.jumpLatest")}
          </button>
        )}
      </div>
    </div>
  );
});
