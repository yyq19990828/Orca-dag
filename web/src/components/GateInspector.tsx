import { memo, useMemo, useState, type CSSProperties } from "react";
import { FileDiff, ShieldCheck, X } from "lucide-react";
import { openLaneChanges, resolveGate } from "../api";
import { effectiveHarness, useConfig } from "../harness";
import { useT } from "../i18n";
import type { DagResponse, Gate, WorkerRowView } from "../types";
import { isGatePending, isIntegrationGate, statusTokenVars } from "./statusUi";
import { useDecisionDialog } from "./DecisionDialog";
import { HarnessAvatar } from "./HarnessAvatar";
import { ResultSummary } from "./ResultSummary";
import { useCoordinatorControl } from "./useCoordinatorControl";

export const GateInspector = memo(function GateInspector({
  gate,
  dag,
  runId,
  workerRows,
  disabled = false,
  disabledReason,
  onSelectTask,
  onClose,
  onResolved,
}: {
  gate: Gate;
  dag: DagResponse;
  runId: string;
  workerRows: WorkerRowView[];
  disabled?: boolean;
  disabledReason?: string | null;
  onSelectTask: (taskId: string) => void;
  onClose: () => void;
  onResolved: () => void;
}) {
  const t = useT();
  const config = useConfig();
  const dialog = useDecisionDialog();
  const withControl = useCoordinatorControl();
  const [busy, setBusy] = useState(false);

  const pending = isGatePending(gate);
  const integration = isIntegrationGate(gate);
  const blockedTask = gate.taskId ? dag.nodes.find((n) => n.id === gate.taskId) : undefined;

  const upstreamTasks = useMemo(() => {
    if (gate.taskId) {
      const upIds = new Set(dag.edges.filter((e) => e.target === gate.taskId).map((e) => e.source));
      return dag.nodes.filter((n) => upIds.has(n.id));
    }
    const outgoing = new Set(dag.edges.map((e) => e.source));
    return dag.nodes.filter((n) => !outgoing.has(n.id));
  }, [dag.edges, dag.nodes, gate.taskId]);

  const actualHarnessByTask = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of workerRows) {
      if (!row.taskId || map.has(row.taskId)) continue;
      const agent =
        row.launchEvidence?.agent ??
        row.projection?.launch?.agent ??
        row.projection?.provider?.id ??
        null;
      if (agent) map.set(row.taskId, agent);
    }
    return map;
  }, [workerRows]);

  async function resolve(opt: string) {
    if (disabled || busy || !runId) return;
    setBusy(true);
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
      setBusy(false);
    }
  }

  async function handleOpenLaneDiff(laneId: string) {
    try {
      await openLaneChanges(laneId, "diff");
    } catch (err) {
      await dialog.alert({
        title: t("ide.gate.openDiff"),
        message: String((err as Error).message ?? err),
        tone: "danger",
      });
    }
  }

  return (
    <div style={{ flex: 1, minBlockSize: 0, display: "flex", flexDirection: "column" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "10px 12px",
          borderBlockEnd: "1px solid var(--border-hairline)",
        }}
      >
        <div style={{ minInlineSize: 0 }}>
          <div className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--st-blocked)", fontWeight: 700 }}>
            ◆ {gate.id}
          </div>
          <strong className="truncate" style={{ display: "block", fontSize: "var(--text-base)" }}>
            {integration ? t("ide.gate.integrationBadge") : t("ide.gate.approvalBadge")}
          </strong>
        </div>
        <button
          type="button"
          className="odag-btn odag-btn--ghost odag-btn--icon"
          aria-label={t("ide.inspector.close")}
          title={t("ide.inspector.close")}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>

      <div className="odag-scroll" style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="odag-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: "var(--text-base)", fontWeight: 600, lineHeight: 1.45 }}>
            {gate.question || t("gate.resolveFallback")}
          </div>

          {integration && (
            <div
              style={{
                padding: "8px 10px",
                borderRadius: 6,
                background: "var(--st-blocked-bg)",
                color: "var(--st-blocked)",
                fontSize: "var(--text-sm)",
                lineHeight: 1.45,
              }}
            >
              {t("gate.integrationExplainBefore")} <code>integrated</code> {t("gate.integrationExplainAfter")}
            </div>
          )}

          {pending ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBlockStart: 4 }}>
              {gate.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  disabled={disabled || busy}
                  title={disabled ? disabledReason ?? t("gate.executionIsUnavailable") : undefined}
                  className={
                    /reject|deny|no/i.test(opt)
                      ? "odag-btn odag-btn--danger"
                      : "odag-btn odag-btn--primary"
                  }
                  style={{ flex: 1, blockSize: 32 }}
                  onClick={() => void resolve(opt)}
                >
                  <ShieldCheck size={14} aria-hidden="true" />
                  {opt}
                </button>
              ))}
            </div>
          ) : (
            <div className="mono" style={{ fontSize: "var(--text-sm)", color: "var(--st-completed)" }}>
              ✓ {t("ide.gate.resolvedTag", { resolution: gate.resolution ?? "ok" })}
            </div>
          )}

          {disabled && disabledReason && (
            <div className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--fg-tertiary)" }}>
              🔒 {disabledReason}
            </div>
          )}
        </div>

        {/* Upstream Worktree Evidence Comparison Cards */}
        {upstreamTasks.length > 0 && (
          <div>
            <div className="mono" style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--fg-secondary)", marginBlockEnd: 6 }}>
              {t("ide.gate.upstreamEvidence", { n: upstreamTasks.length })}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {upstreamTasks.map((up) => {
                const vars = statusTokenVars(up.status);
                const harness = actualHarnessByTask.get(up.id) ?? effectiveHarness(up.id);
                const laneId = config.laneByTask[up.id];
                return (
                  <div key={up.id} className="odag-card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => onSelectTask(up.id)}
                        style={{
                          border: 0,
                          padding: 0,
                          background: "transparent",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          fontWeight: 600,
                          fontSize: "var(--text-sm)",
                          textAlign: "start",
                        }}
                      >
                        <HarnessAvatar harness={harness} size={18} />
                        <span>{up.label}</span>
                      </button>
                      <span className="odag-pill" style={{ "--pill-fg": vars.fg, "--pill-bg": vars.bg } as CSSProperties}>
                        {t(`status.${up.status}`)}
                      </span>
                    </div>

                    {up.result && (
                      <div style={{ fontSize: "var(--text-sm)" }}>
                        <ResultSummary raw={up.result} />
                      </div>
                    )}

                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                      <code style={{ fontSize: "var(--text-xs)", color: "var(--fg-tertiary)" }}>{up.id}</code>
                      {laneId && (
                        <button
                          type="button"
                          className="odag-btn"
                          style={{ blockSize: 24, fontSize: "var(--text-xs)" }}
                          disabled={disabled}
                          onClick={() => void handleOpenLaneDiff(laneId)}
                        >
                          <FileDiff size={11} aria-hidden="true" />
                          {t("ide.gate.openDiff")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {blockedTask && (
          <div>
            <div className="mono" style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--fg-secondary)", marginBlockEnd: 6 }}>
              {t("ide.gate.unblocksTask")}
            </div>
            <button
              type="button"
              className="odag-card"
              onClick={() => onSelectTask(blockedTask.id)}
              style={{
                inlineSize: "100%",
                textAlign: "start",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span style={{ fontWeight: 600 }}>{blockedTask.label}</span>
              <code style={{ fontSize: "var(--text-xs)", color: "var(--fg-tertiary)" }}>{blockedTask.id}</code>
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
