import { memo, useMemo, useState, type CSSProperties } from "react";
import { CheckCircle2, Diamond, GitBranch, Lock, PlayCircle } from "lucide-react";
import { resolveGate } from "../api";
import { effectiveHarness, useConfig } from "../harness";
import { useT } from "../i18n";
import type { DagNode, DagResponse, Gate, TaskStatus, WorkerRowView } from "../types";
import { workerWorkspaceLabel } from "../workerWorkspace";
import { isGatePending, isIntegrationGate, StatusGlyph, statusTokenVars } from "./statusUi";
import { useDecisionDialog } from "./DecisionDialog";
import { HarnessAvatar } from "./HarnessAvatar";
import { useCoordinatorControl } from "./useCoordinatorControl";

export const BoardView = memo(function BoardView({
  dag,
  runId,
  workerRows,
  selectedTaskId,
  selectedGateId,
  statusFilter = "all",
  searchQuery = "",
  execDisabled = false,
  execDisabledReason,
  onSelectTask,
  onSelectGate,
  onResolved,
}: {
  dag: DagResponse;
  runId: string;
  workerRows: WorkerRowView[];
  selectedTaskId: string | null;
  selectedGateId: string | null;
  statusFilter?: TaskStatus | "all";
  searchQuery?: string;
  execDisabled?: boolean;
  execDisabledReason?: string | null;
  onSelectTask: (taskId: string) => void;
  onSelectGate: (gateId: string) => void;
  onResolved: () => void;
}) {
  const t = useT();
  const config = useConfig();
  const dialog = useDecisionDialog();
  const withControl = useCoordinatorControl();
  const [busyGateId, setBusyGateId] = useState<string | null>(null);

  const workerMetaByTask = useMemo(() => {
    const map = new Map<string, { harness: string | null; workspace: string | null }>();
    for (const row of workerRows) {
      if (!row.taskId || map.has(row.taskId)) continue;
      const agent =
        row.launchEvidence?.agent ??
        row.projection?.launch?.agent ??
        row.projection?.provider?.id ??
        null;
      const rawWs = workerWorkspaceLabel(row.projection?.workspace) ?? row.projection?.launch?.worktree ?? null;
      const ws = rawWs ? rawWs.split("::").at(-1)?.split("/").at(-1) || rawWs : null;
      map.set(row.taskId, { harness: agent, workspace: ws });
    }
    return map;
  }, [workerRows]);

  const q = searchQuery.trim().toLowerCase();

  const filteredTasks = useMemo(() => {
    return dag.nodes.filter((n) => {
      if (statusFilter !== "all" && n.status !== statusFilter) return false;
      if (!q) return true;
      const wm = workerMetaByTask.get(n.id);
      return (
        n.id.toLowerCase().includes(q) ||
        n.label.toLowerCase().includes(q) ||
        (wm?.workspace ?? "").toLowerCase().includes(q) ||
        (wm?.harness ?? effectiveHarness(n.id)).toLowerCase().includes(q)
      );
    });
  }, [dag.nodes, statusFilter, q, workerMetaByTask]);

  const filteredGates = useMemo(() => {
    return dag.gates.filter((g) => {
      const pending = isGatePending(g);
      if (
        statusFilter !== "all" &&
        !((statusFilter === "blocked" && pending) || (statusFilter === "completed" && !pending))
      ) {
        return false;
      }
      if (!q) return true;
      return g.id.toLowerCase().includes(q) || g.question.toLowerCase().includes(q);
    });
  }, [dag.gates, statusFilter, q]);

  async function handleResolveGate(gate: Gate, opt: string) {
    if (execDisabled || busyGateId === gate.id || !runId) return;
    setBusyGateId(gate.id);
    try {
      await withControl(runId, (control) => resolveGate(gate.id, opt, runId, control));
      onResolved();
    } catch (err) {
      await dialog.alert({
        title: t("gate.resolveFailedTitle"),
        message: String((err as Error).message ?? err),
        tone: "danger",
      });
    } finally {
      setBusyGateId(null);
    }
  }

  function taskReason(node: DagNode): string {
    const r = dag.readiness[node.id];
    if (r?.reasons?.length) return r.reasons[0];
    if (node.result?.trim()) return node.result.trim().slice(0, 120);
    return node.spec.trim().slice(0, 120);
  }

  const columns = [
    {
      id: "queued",
      title: t("ide.board.laneQueued"),
      icon: <PlayCircle size={14} style={{ color: "var(--st-ready)" }} aria-hidden="true" />,
      tasks: filteredTasks.filter((n) => n.status === "pending" || n.status === "ready"),
      gates: [] as Gate[],
    },
    {
      id: "executing",
      title: t("ide.board.laneExecuting"),
      icon: <span className="odag-pulse-dot odag-pulse-dot--live" aria-hidden="true" />,
      tasks: filteredTasks.filter((n) => n.status === "dispatched"),
      gates: [] as Gate[],
    },
    {
      id: "blocked",
      title: t("ide.board.laneBlocked"),
      icon: <Lock size={14} style={{ color: "var(--st-blocked)" }} aria-hidden="true" />,
      tasks: filteredTasks.filter((n) => n.status === "blocked"),
      gates: filteredGates.filter((g) => isGatePending(g)),
    },
    {
      id: "settled",
      title: t("ide.board.laneSettled"),
      icon: <CheckCircle2 size={14} style={{ color: "var(--st-completed)" }} aria-hidden="true" />,
      tasks: filteredTasks.filter((n) => n.status === "completed" || n.status === "failed"),
      gates: filteredGates.filter((g) => !isGatePending(g)),
    },
  ];

  return (
    <div className="odag-board odag-scroll">
      {columns.map((col) => {
        const total = col.tasks.length + col.gates.length;
        return (
          <section key={col.id} className="odag-board-col" aria-label={col.title}>
            <header className="odag-board-col__head">
              {col.icon}
              <span className="truncate" style={{ flex: 1 }}>
                {col.title}
              </span>
              <span className="odag-count">{total}</span>
            </header>

            <div className="odag-board-col__body odag-scroll">
              {col.gates.map((gate) => {
                const pending = isGatePending(gate);
                const integration = isIntegrationGate(gate);
                return (
                  <div
                    key={gate.id}
                    className="odag-card"
                    style={{
                      borderStyle: pending ? "dashed" : "solid",
                      borderColor:
                        selectedGateId === gate.id
                          ? "var(--accent)"
                          : pending
                            ? "var(--st-blocked)"
                            : "var(--border-hairline)",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectGate(gate.id)}
                      style={{
                        display: "block",
                        inlineSize: "100%",
                        border: 0,
                        padding: 0,
                        background: "transparent",
                        textAlign: "start",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                        <span
                          className="mono"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            fontSize: "var(--text-xs)",
                            fontWeight: 700,
                            color: pending ? "var(--st-blocked)" : "var(--st-completed)",
                          }}
                        >
                          <Diamond size={11} aria-hidden="true" />
                          {integration ? t("ide.gate.integrationBadge") : t("ide.gate.approvalBadge")}
                        </span>
                        <span className="mono truncate" style={{ fontSize: "var(--text-xs)", color: "var(--fg-tertiary)", maxInlineSize: 100 }}>
                          {gate.id}
                        </span>
                      </div>
                      <div style={{ fontWeight: 600, fontSize: "var(--text-base)", marginBlockStart: 5 }}>
                        {gate.question || t("gate.resolveFallback")}
                      </div>
                    </button>

                    {pending && (
                      <div style={{ display: "flex", gap: 6, marginBlockStart: 8, flexWrap: "wrap" }}>
                        {gate.options.map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            disabled={execDisabled || busyGateId === gate.id}
                            title={execDisabled ? execDisabledReason ?? t("gate.executionIsUnavailable") : undefined}
                            className={
                              /reject|deny|no/i.test(opt)
                                ? "odag-btn odag-btn--danger"
                                : "odag-btn odag-btn--primary"
                            }
                            style={{ blockSize: 26, fontSize: "var(--text-xs)", flex: 1 }}
                            onClick={() => void handleResolveGate(gate, opt)}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {col.tasks.map((task) => {
                const vars = statusTokenVars(task.status);
                const wm = workerMetaByTask.get(task.id);
                const harness = wm?.harness ?? effectiveHarness(task.id);
                const laneId = config.laneByTask[task.id];
                const ws = wm?.workspace ?? laneId ?? "current";
                return (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onSelectTask(task.id)}
                    className="odag-card"
                    style={{
                      textAlign: "start",
                      borderColor: selectedTaskId === task.id && !selectedGateId ? "var(--accent)" : undefined,
                      display: "flex",
                      flexDirection: "column",
                      gap: 7,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minInlineSize: 0 }}>
                        <HarnessAvatar harness={harness} size={19} />
                        <span className="mono truncate" style={{ fontSize: "var(--text-xs)", color: "var(--fg-secondary)" }}>
                          {harness}
                        </span>
                      </span>
                      <span
                        className="odag-pill"
                        style={{ "--pill-fg": vars.fg, "--pill-bg": vars.bg } as CSSProperties}
                      >
                        <StatusGlyph status={task.status} size={11} />
                        {t(`status.${task.status}`)}
                      </span>
                    </div>

                    <div style={{ fontWeight: 600, fontSize: "var(--text-base)", lineHeight: 1.35 }}>{task.label}</div>

                    <div className="truncate" style={{ fontSize: "var(--text-sm)", color: "var(--fg-secondary)" }}>
                      {taskReason(task)}
                    </div>

                    <div
                      className="mono"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        paddingBlockStart: 6,
                        borderBlockStart: "1px solid var(--border-hairline)",
                        fontSize: "var(--text-xs)",
                        color: "var(--fg-tertiary)",
                      }}
                    >
                      <span className="truncate" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <GitBranch size={10} aria-hidden="true" />
                        {ws}
                      </span>
                      <span className="truncate" style={{ maxInlineSize: 96 }}>
                        {task.id}
                      </span>
                    </div>
                  </button>
                );
              })}

              {total === 0 && (
                <div
                  style={{
                    padding: "24px 12px",
                    textAlign: "center",
                    color: "var(--fg-tertiary)",
                    fontSize: "var(--text-sm)",
                    border: "1px dashed var(--border-hairline)",
                    borderRadius: 8,
                  }}
                >
                  {t("ide.board.emptyLane")}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
});
