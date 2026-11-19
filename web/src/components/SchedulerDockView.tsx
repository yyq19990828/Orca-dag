import { memo, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleX,
  Clock,
  Diamond,
  ExternalLink,
  PlayCircle,
  TriangleAlert,
} from "lucide-react";
import { useLang, useT } from "../i18n";
import type { OperationFocus } from "../operation-navigation";
import type { DagNode, DagResponse, RunStatus, WorkerRowView } from "../types";
import { collectAttentionItems } from "./OperationsAttention";
import { WorkerPanel } from "./WorkerPanel";

type SchedulerSubTab = "all" | "queue" | "fleet" | "attention";

/**
 * VS Code Bottom-Panel style Scheduler, Problems & Durable Fleet Overview.
 * Renders all problems, ready/waiting stages, and fleet rows as uniform 25px
 * monospace console lines — zero legacy boxed cards.
 */
export const SchedulerDockView = memo(function SchedulerDockView({
  runId,
  dag,
  runStatus,
  workerRows,
  workerHistoryLoading,
  workerHistoryError,
  labelsById,
  focusWorkerId,
  knownActionableCount,
  actionableCount,
  execOff,
  disabledReason,
  onSelectTask,
  onFocusOperation,
  onOpenOutput,
}: {
  runId: string;
  dag: DagResponse;
  runStatus: RunStatus | null;
  workerRows: WorkerRowView[];
  workerHistoryLoading: boolean;
  workerHistoryError: string | null;
  labelsById: Record<string, string>;
  focusWorkerId: string | null;
  knownActionableCount: number;
  actionableCount: number | null;
  execOff: boolean;
  disabledReason?: string | null;
  onSelectTask: (taskId: string) => void;
  onFocusOperation: (target: OperationFocus) => void;
  /** Jump to the dock's single Worker-output viewer for one Dispatch. */
  onOpenOutput?: (dispatchId: string) => void;
}) {
  const t = useT();
  const lang = useLang();
  const [subTab, setSubTab] = useState<SchedulerSubTab>("all");

  const nodesById = useMemo(() => new Map(dag.nodes.map((n) => [n.id, n])), [dag.nodes]);
  const readyWave = dag.readyWave ?? { taskIds: [], freeSlots: null };
  const readiness = dag.readiness ?? {};

  const statusForRun = runStatus?.running && runStatus.runId === runId ? runStatus : null;
  const capacityKnown = statusForRun !== null;
  const busy = statusForRun?.busy ?? null;
  const max = statusForRun?.maxConcurrency ?? null;

  const attentionItems = useMemo(
    () =>
      collectAttentionItems({
        runId,
        dag: dag.runId === runId ? dag : null,
        status: runStatus?.runId === runId ? runStatus : null,
        workers: workerHistoryLoading || workerHistoryError ? null : workerRows,
      }),
    [dag, lang, runId, runStatus, workerHistoryError, workerHistoryLoading, workerRows],
  );

  const readyNodes = useMemo(
    () =>
      readyWave.taskIds
        .map((id) => nodesById.get(id))
        .filter((n): n is DagNode => Boolean(n)),
    [nodesById, readyWave.taskIds],
  );

  const queuedIdSet = useMemo(
    () =>
      new Set(
        readyNodes
          .filter((n) => (readiness[n.id]?.codes ?? []).includes("waiting_for_capacity"))
          .map((n) => n.id),
      ),
    [readiness, readyNodes],
  );

  const waitingNodes = useMemo(
    () =>
      dag.nodes
        .filter(
          (n) =>
            n.status === "pending" ||
            n.status === "blocked" ||
            (n.status === "ready" && readiness[n.id]?.runnable === false),
        )
        .map((n) => ({ node: n, reasons: readiness[n.id]?.reasons ?? [] }))
        .filter(({ reasons }) => reasons.length > 0),
    [dag.nodes, readiness],
  );

  if (!runId) {
    return <div className="odag-console-empty">{t("empty.pickRunTitle")}</div>;
  }

  const queueTotal = readyNodes.length + waitingNodes.length;
  const effectiveSubTab = focusWorkerId ? "fleet" : subTab;
  const shownProblems =
    effectiveSubTab === "attention" ? attentionItems : attentionItems.slice(0, 3);
  const hiddenProblemsCount = attentionItems.length - shownProblems.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", blockSize: "100%", minBlockSize: 0 }}>
      {/* Sticky VS Code Sub-Toolbar */}
      <div className="odag-dock-toolbar">
        <div
          role="group"
          aria-label={t("scheduler.aria")}
          style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
        >
          <button
            type="button"
            className="odag-dock-chip"
            aria-pressed={effectiveSubTab === "all"}
            onClick={() => setSubTab("all")}
          >
            {t("ide.dock.schedAll")}
          </button>
          <button
            type="button"
            className="odag-dock-chip"
            aria-pressed={effectiveSubTab === "attention"}
            onClick={() => setSubTab("attention")}
          >
            <span>{t("ide.dock.schedAttention")}</span>
            {knownActionableCount > 0 && (
              <span className="odag-count">
                {actionableCount === null ? `${knownActionableCount}+` : actionableCount}
              </span>
            )}
          </button>
          <button
            type="button"
            className="odag-dock-chip"
            aria-pressed={effectiveSubTab === "queue"}
            onClick={() => setSubTab("queue")}
          >
            <span>{t("ide.dock.schedQueue")}</span>
            <span className="odag-count">{queueTotal}</span>
          </button>
          <button
            type="button"
            className="odag-dock-chip"
            aria-pressed={effectiveSubTab === "fleet"}
            onClick={() => setSubTab("fleet")}
          >
            <span>{t("ide.dock.schedFleet")}</span>
            <span className="odag-count">{workerRows.length}</span>
          </button>
        </div>

        <div
          className="mono"
          style={{
            marginInlineStart: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 12,
            color: "var(--fg-secondary)",
            fontSize: "var(--text-xs)",
          }}
        >
          <span title={t("scheduler.waveTitle")} style={{ color: "var(--fg-primary)", fontWeight: 600 }}>
            {t("scheduler.waveReady", { n: readyNodes.length })}
          </span>
          <span className="odag-console-hide-compact" style={{ color: "var(--fg-tertiary)" }}>
            {capacityKnown && max !== null
              ? `${t("scheduler.workers")} ${busy}/${max}`
              : t("scheduler.capacityUnknown")}
          </span>
        </div>
      </div>

      {/* High-Density VS Code Problems / Queue / Fleet Console Viewport */}
      <div className="odag-dock-viewport odag-scroll">
        {actionableCount === null && (effectiveSubTab === "all" || effectiveSubTab === "attention") && (
          <div className="odag-console-notice" role="status">
            <span>
              {attentionItems.length > 0
                ? attentionItems.length === 1
                  ? t("attention.atLeastOne", { n: attentionItems.length })
                  : t("attention.atLeastMany", { n: attentionItems.length })
                : t("attention.unknownTotal")}
            </span>
          </div>
        )}

        {/* 1. VS Code Problems Console Rows (Zero Legacy Card Box!) */}
        {(effectiveSubTab === "all" || effectiveSubTab === "attention") && (
          <div>
            {shownProblems.map((item) => (
              <button
                key={item.key}
                type="button"
                className="odag-console-row odag-console-row--problem is-actionable"
                onClick={() => {
                  if (item.kind === "worker") setSubTab("fleet");
                  onFocusOperation({ kind: item.kind, id: item.id });
                }}
                title={`${item.eyebrow}: ${item.title} — ${item.detail}`}
              >
                {item.tone === "gate" ? (
                  <Diamond size={12} style={{ color: "var(--st-blocked)" }} aria-hidden="true" />
                ) : item.tone === "recovery" ? (
                  <CircleX size={13} style={{ color: "var(--st-failed)" }} aria-hidden="true" />
                ) : (
                  <TriangleAlert size={13} style={{ color: "var(--st-dispatched)" }} aria-hidden="true" />
                )}

                <span
                  className="truncate"
                  style={{
                    color:
                      item.tone === "gate"
                        ? "var(--st-blocked)"
                        : item.tone === "recovery"
                          ? "var(--st-failed)"
                          : "var(--st-dispatched)",
                    fontWeight: 600,
                  }}
                >
                  {item.eyebrow}
                </span>

                <span className="truncate" style={{ fontWeight: 600, color: "var(--fg-primary)" }}>
                  {item.title}
                </span>

                <span className="truncate" style={{ color: "var(--fg-secondary)" }}>
                  {item.identity ? `${item.identity} · ` : ""}
                  {item.detail}
                </span>

                <span
                  className="odag-console-tag odag-console-hide-compact"
                  style={{ justifySelf: "end", color: "var(--fg-primary)" }}
                >
                  <span>{item.action}</span>
                  <ExternalLink size={10} aria-hidden="true" />
                </span>
              </button>
            ))}

            {hiddenProblemsCount > 0 && effectiveSubTab === "all" && (
              <button
                type="button"
                className="odag-console-row"
                style={{ gridTemplateColumns: "1fr", color: "var(--fg-secondary)" }}
                onClick={() => setSubTab("attention")}
              >
                <span>+ {t("attention.showMore", { n: hiddenProblemsCount })}</span>
              </button>
            )}

            {effectiveSubTab === "attention" && attentionItems.length === 0 && actionableCount !== null && (
              <div className="odag-console-empty" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <CheckCircle2 size={13} style={{ color: "var(--st-completed)" }} aria-hidden="true" />
                <span>{t("attention.emptyClean")}</span>
              </div>
            )}
          </div>
        )}

        {/* 2. Ready Wave & Waiting Diagnostics Console Rows */}
        {(effectiveSubTab === "all" || effectiveSubTab === "queue") && (
          <div>
            {readyNodes.map((node) => {
              const queued = queuedIdSet.has(node.id);
              return (
                <button
                  key={`ready:${node.id}`}
                  type="button"
                  className="odag-console-row odag-console-row--problem"
                  onClick={() => onSelectTask(node.id)}
                  title={queued ? t("scheduler.chipQueuedTitle") : t("scheduler.chipReadyTitle")}
                >
                  <PlayCircle size={13} style={{ color: "var(--fg-primary)" }} aria-hidden="true" />
                  <span style={{ color: "var(--fg-primary)", fontWeight: 600 }}>
                    {t("status.ready")}
                  </span>
                  <span className="truncate" style={{ fontWeight: 600 }}>
                    {node.label}
                  </span>
                  <span className="truncate" style={{ color: "var(--fg-secondary)" }}>
                    {queued ? t("scheduler.chipQueuedTitle") : t("scheduler.chipReadyTitle")}
                  </span>
                  <span
                    className="odag-console-tag odag-console-hide-compact"
                    style={{ justifySelf: "end" }}
                  >
                    <span>{node.id.slice(0, 14)}</span>
                    <ExternalLink size={10} aria-hidden="true" />
                  </span>
                </button>
              );
            })}

            {waitingNodes.map(({ node, reasons }) => (
              <button
                key={`wait:${node.id}`}
                type="button"
                className="odag-console-row odag-console-row--problem"
                onClick={() => onSelectTask(node.id)}
                title={reasons.join("\n")}
              >
                <Clock
                  size={13}
                  style={{
                    color: node.status === "blocked" ? "var(--st-blocked)" : "var(--fg-tertiary)",
                  }}
                  aria-hidden="true"
                />
                <span
                  style={{
                    color: node.status === "blocked" ? "var(--st-blocked)" : "var(--fg-tertiary)",
                    fontWeight: 600,
                  }}
                >
                  {t(`status.${node.status}`)}
                </span>
                <span className="truncate" style={{ fontWeight: 500 }}>
                  {node.label}
                </span>
                <span className="truncate" style={{ color: "var(--fg-secondary)" }}>
                  {reasons[0]}
                </span>
                <span
                  className="odag-console-tag odag-console-hide-compact"
                  style={{ justifySelf: "end" }}
                >
                  <span>{node.id.slice(0, 14)}</span>
                  <ExternalLink size={10} aria-hidden="true" />
                </span>
              </button>
            ))}

            {queueTotal === 0 && effectiveSubTab === "queue" && (
              <div className="odag-console-empty">{t("scheduler.nothingWaiting")}</div>
            )}
          </div>
        )}

        {/* 3. Durable Worker Fleet Rows */}
        {(effectiveSubTab === "all" || effectiveSubTab === "fleet") && (
          <div className="odag-dock-workers">
            {workerRows.length === 0 && !workerHistoryError ? (
              effectiveSubTab === "fleet" ? (
                <div className="odag-console-empty">{t("operations.noWorkers")}</div>
              ) : null
            ) : (
              <WorkerPanel
                key={runId}
                labelsById={labelsById}
                focusId={focusWorkerId}
                runId={runId}
                rows={workerRows}
                rowsError={workerHistoryError}
                status={runStatus}
                disabled={execOff}
                disabledReason={disabledReason}
                onOpenOutput={onOpenOutput}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
});
