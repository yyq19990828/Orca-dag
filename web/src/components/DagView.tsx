import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  getSmoothStepPath,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowDownUp,
  ArrowLeftRight,
  Diamond,
  GitBranch,
  GitFork,
  ListTree,
  Map as MapIcon,
  Maximize2,
  Network,
  RotateCcw,
  ShieldCheck,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { applyLayout, GATE_H, GATE_W, NODE_H, NODE_W } from "../layout";
import { effectiveHarness, useConfig } from "../harness";
import { useLang, useT, type TranslationKey, type Translator } from "../i18n";
import { laneSummaryLabel } from "../placement";
import { workerWorkspaceLabel } from "../workerWorkspace";
import { HarnessAvatar } from "./HarnessAvatar";
import { isGatePending, isIntegrationGate, StatusGlyph, statusTokenVars } from "./statusUi";
import {
  type DagNode,
  type DagResponse,
  type Gate,
  type LayoutKind,
  type RunAttempt,
  type TaskStatus,
  type WorkerRowView,
} from "../types";

const GATE_NODE_PREFIX = "gate:";

type TaskNodeData = {
  kind: "task";
  label: string;
  status: TaskStatus;
  runId: string;
  summary: string;
  summaryTitle: string;
  selected: boolean;
  dimmed: boolean;
  lead: boolean;
  harness: string;
  harnessActual: boolean;
  harnessPlanned: boolean;
  settings: string | null;
  settingsTitle: string;
  settingsActual: boolean;
  workspaceLabel: string | null;
  dir: "LR" | "TB";
  executing: boolean;
  active: boolean;
};

type GateNodeData = {
  kind: "gate";
  gate: Gate;
  integration: boolean;
  resolved: boolean;
  selected: boolean;
  dimmed: boolean;
  dir: "LR" | "TB";
};

type CanvasNodeData = TaskNodeData | GateNodeData;

type StageSummary = { text: string; title: string };

const STAGE_SUMMARY_LIMIT = 88;

const MOVE_DIRECTION_KEY: Record<string, TranslationKey> = {
  left: "dag.a11y.dirLeft",
  right: "dag.a11y.dirRight",
  up: "dag.a11y.dirUp",
  down: "dag.a11y.dirDown",
};

function cleanLine(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function boundedLine(value: string, limit = STAGE_SUMMARY_LIMIT): string {
  const normalized = cleanLine(value);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function firstSentence(value: string): string {
  const normalized = cleanLine(value);
  const end = normalized.search(/[.!?。！？](?:\s|$)/);
  return end > 0 ? normalized.slice(0, end + 1) : normalized;
}

function resultPreview(raw: string | null, t: Translator): string | null {
  if (!raw?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return firstSentence(parsed) || null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const report = parsed as { subject?: unknown; body?: unknown; outcome?: unknown };
      if (typeof report.subject === "string" && report.subject.trim()) return firstSentence(report.subject);
      if (typeof report.body === "string" && report.body.trim()) return firstSentence(report.body);
      if (typeof report.outcome === "string" && report.outcome.trim()) {
        return t("dag.workerReported", { outcome: report.outcome.replaceAll("_", " ") });
      }
      return t("dag.resultRecorded");
    }
  } catch {
    /* plain text result */
  }
  return firstSentence(raw) || null;
}

function hostLabel(host: { kind: string; id: string } | null | undefined, t: Translator): string | null {
  if (!host) return null;
  if (host.kind === "local" || host.id.toLowerCase() === "local") return t("dag.hostLocal");
  const place = cleanLine(host.id) || cleanLine(host.kind);
  return place ? t("dag.hostOn", { place }) : null;
}

function plannedWorktreeLabel(selector: string, t: Translator): string {
  const path = selector.split("::").at(-1) ?? selector;
  return path.split("/").filter(Boolean).at(-1) ?? t("dag.plannedExistingWorkspace");
}

function plannedPlacementLabel(
  placement: { kind: string; selector?: string; name?: string } | undefined,
  t: Translator,
): string | null {
  if (!placement || placement.kind === "current") return null;
  if (placement.kind === "existing" && placement.selector) {
    return plannedWorktreeLabel(placement.selector, t);
  }
  return placement.name || (placement.kind === "new-child" ? t("dag.plannedNewChildWorkspace") : t("dag.plannedNewWorkspace"));
}

function activeStageSummary(
  worker: WorkerRowView | undefined,
  attempt: RunAttempt | undefined,
  t: Translator,
): string {
  const stage = worker?.projection?.stage ?? attempt?.stage ?? null;
  const detail = cleanLine(stage?.detail).replaceAll("_", " ");
  const activity = cleanLine(stage?.activity).toLowerCase();
  const activityLabel =
    activity === "working" || activity === "implementing"
      ? t("dag.workerActive")
      : activity === "idle"
        ? t("dag.workerIdle")
        : activity && activity !== "unknown"
          ? t("dag.workerActivity", { activity: activity.replaceAll("_", " ") })
          : t("dag.workerDispatchActive");
  const work = detail || activityLabel;
  const location = hostLabel(worker?.projection?.host ?? attempt?.host, t);
  return location ? `${work} · ${location}` : work;
}

function summarizeStage(
  node: DagNode,
  dag: DagResponse,
  nodesById: Map<string, DagNode>,
  worker: WorkerRowView | undefined,
  attempt: RunAttempt | undefined,
  t: Translator,
): StageSummary {
  const readiness = dag.readiness[node.id];
  const evidenceTitle = boundedLine(readiness?.reasons.join(" ") || "", 360);

  if (node.status === "ready" && readiness?.runnable !== false) {
    const text = readiness?.codes.includes("waiting_for_capacity")
      ? t("dag.readyWaitingSlot")
      : t("dag.readyDispatch");
    return { text, title: evidenceTitle || text };
  }

  if (node.status === "pending" || node.status === "blocked" || node.status === "ready") {
    const codes = readiness?.codes ?? [];
    let text: string;
    if (codes.includes("unmet_dependencies")) {
      const ids = readiness?.unmetDependencyIds ?? [];
      if (ids.length === 1) {
        const dependency = nodesById.get(ids[0]);
        text = dependency
          ? t("dag.waitingOnStage", { stage: dependency.label })
          : t("dag.waitingOutside");
      } else {
        text = t("dag.waitingOnDeps", { n: ids.length });
      }
    } else if (codes.includes("pending_gate")) {
      const gateIds = readiness?.pendingGateIds ?? [];
      const gate = gateIds.length === 1 ? dag.gates.find((candidate) => candidate.id === gateIds[0]) : undefined;
      text = gate?.question?.trim()
        ? t("dag.decisionNeeded", { question: gate.question })
        : gateIds.length > 1
          ? t("dag.waitingOnGates", { n: gateIds.length })
          : t("dag.waitingOnGate");
    } else {
      text = node.status === "blocked" ? t("dag.blockedInspect") : t("dag.pendingInspect");
    }
    return { text: boundedLine(text), title: evidenceTitle || text };
  }

  if (node.status === "dispatched") {
    const text = activeStageSummary(worker, attempt, t);
    const details = worker?.projection?.stage?.detail ?? attempt?.stage?.detail;
    return { text: boundedLine(text), title: boundedLine(details || text, 360) };
  }

  const result = resultPreview(node.result, t);
  if (result) {
    return { text: boundedLine(result), title: boundedLine(node.result ?? result, 360) };
  }

  if (node.status === "completed") {
    const succeeded = attempt?.outcome === "succeeded" || worker?.projection?.outcome === "succeeded";
    const text = succeeded ? t("dag.workerSucceeded") : t("dag.completedNoSummary");
    return { text, title: text };
  }

  if (node.status === "failed") {
    if (attempt?.settledVia === "start_failed") {
      const failedStage = attempt.startReceipt?.failedStage;
      const text = failedStage
        ? t("dag.startFailedAt", { stage: failedStage.replaceAll("_", " ") })
        : t("dag.startFailed");
      return { text: boundedLine(text), title: text };
    }
    const failed = attempt?.outcome === "failed" || worker?.projection?.outcome === "failed";
    const text = failed ? t("dag.workerFailed") : t("dag.failureUnavailable");
    return { text, title: text };
  }

  return { text: t("dag.contextUnavailable"), title: t("dag.contextUnavailable") };
}

const TaskNode = memo(function TaskNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const t = useT();
  const vars = statusTokenVars(data.status);
  const statusLabel = t(`status.${data.status}`);
  const isTB = data.dir === "TB";

  return (
    <div
      role="group"
      className={`odag-node${data.selected ? " is-selected" : ""}${data.dimmed ? " is-dimmed" : ""}`}
      data-status={data.status}
      title={data.lead ? t("dag.node.leadTitle") : undefined}
      aria-label={[
        `${data.label}.`,
        `${statusLabel}.`,
        `${data.summary}.`,
        data.harnessActual
          ? t("dag.node.ariaHarnessActual", { harness: data.harness })
          : t("dag.node.ariaHarnessPlanned", { harness: data.harness }),
        data.settings
          ? data.settingsActual
            ? t("dag.node.ariaActualSettings", { settings: data.settingsTitle })
            : t("dag.node.ariaPlannedSettings", { settings: data.settingsTitle })
          : null,
        data.lead ? t("dag.node.ariaLead") : null,
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        {
          inlineSize: NODE_W,
          blockSize: NODE_H,
          "--node-color": vars.fg,
        } as CSSProperties
      }
    >
      <Handle type="target" position={isTB ? Position.Top : Position.Left} style={{ opacity: 0.45 }} />
      <div className="odag-node__head">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minInlineSize: 0 }}>
          <HarnessAvatar harness={data.harness} size={19} />
          <span
            className="mono truncate"
            style={{ fontSize: "var(--text-xs)", color: "var(--fg-secondary)", maxInlineSize: 118 }}
            title={
              data.harnessActual
                ? t("dag.node.harnessActualTitle")
                : data.harnessPlanned
                  ? t("dag.node.harnessPlannedTitle")
                  : t("dag.node.harnessUnknownTitle")
            }
          >
            {data.harness}
          </span>
          {data.lead && (
            <span
              className="mono"
              title={t("dag.node.leadBadgeTitle")}
              style={{
                fontSize: "var(--text-xs)",
                padding: "1px 5px",
                borderRadius: 4,
                background: "var(--bg-subtle)",
                color: "var(--fg-secondary)",
                border: "1px solid var(--border-hairline)",
              }}
            >
              {t("dag.node.lead")}
            </span>
          )}
        </span>
        <span
          className="odag-pill"
          style={{ "--pill-fg": vars.fg, "--pill-bg": vars.bg } as CSSProperties}
        >
          <StatusGlyph status={data.status} executing={data.executing && data.active} size={11} />
          {statusLabel}
        </span>
      </div>

      <div className="odag-node__title" title={data.label}>
        {data.label}
      </div>

      <div className="odag-node__summary" title={data.summaryTitle}>
        {data.summary}
      </div>

      <div className="odag-node__foot">
        <span className="truncate" style={{ display: "inline-flex", alignItems: "center", gap: 4, minInlineSize: 0 }}>
          <GitBranch size={10} aria-hidden="true" />
          <span className="truncate">{data.workspaceLabel || "workspace"}</span>
        </span>
        {data.settings && (
          <span className="truncate" style={{ maxInlineSize: 116 }} title={data.settingsTitle}>
            {data.settings}
          </span>
        )}
      </div>
      <Handle type="source" position={isTB ? Position.Bottom : Position.Right} style={{ opacity: 0.45 }} />
    </div>
  );
});

const GateNode = memo(function GateNode({ data }: NodeProps<Node<GateNodeData>>) {
  const t = useT();
  const isTB = data.dir === "TB";
  const { gate, integration, resolved, selected, dimmed } = data;
  const question = gate.question?.trim() || t("gate.resolveFallback");

  return (
    <div
      role="group"
      className={`odag-node odag-node--gate${resolved ? " is-resolved" : ""}${selected ? " is-selected" : ""}${dimmed ? " is-dimmed" : ""}`}
      style={{ inlineSize: GATE_W, blockSize: GATE_H } as CSSProperties}
      aria-label={`${integration ? t("ide.gate.integrationBadge") : t("ide.gate.approvalBadge")}: ${question}`}
    >
      <Handle type="target" position={isTB ? Position.Top : Position.Left} style={{ opacity: 0.45 }} />
      <div className="odag-node__head">
        <span
          className="mono"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: "var(--text-xs)",
            fontWeight: 700,
            color: resolved ? "var(--st-completed)" : "var(--st-blocked)",
          }}
        >
          {resolved ? <ShieldCheck size={12} aria-hidden="true" /> : <Diamond size={11} aria-hidden="true" />}
          {integration ? t("ide.gate.integrationBadge") : t("ide.gate.approvalBadge")}
        </span>
        <span
          className="odag-pill"
          style={
            {
              "--pill-fg": resolved ? "var(--st-completed)" : "var(--st-blocked)",
              "--pill-bg": resolved ? "var(--st-completed-bg)" : "var(--st-blocked-bg)",
            } as CSSProperties
          }
        >
          {resolved
            ? t("ide.gate.resolvedTag", { resolution: gate.resolution ?? "ok" })
            : t("ide.gate.pendingTag")}
        </span>
      </div>

      <div className="odag-node__title" title={question}>
        {question}
      </div>

      <div className="odag-node__foot">
        <span className="truncate">{gate.id}</span>
        <span>{integration ? t("ide.gate.integrationHint") : gate.options.join(" / ")}</span>
      </div>
      <Handle type="source" position={isTB ? Position.Bottom : Position.Right} style={{ opacity: 0.45 }} />
    </div>
  );
});

const nodeTypes = { task: TaskNode, gate: GateNode };

function HierarchyEdge(props: EdgeProps) {
  const t = useT();
  const [path] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    borderRadius: 14,
  });
  return (
    <g className="hierarchy-edge" aria-label={t("dag.edge.hierarchyAria")}>
      <path className="hierarchy-edge__link" d={path} fill="none" />
      <circle className="hierarchy-edge__ring" cx={props.targetX} cy={props.targetY} r={4} />
    </g>
  );
}

const edgeTypes = { hierarchy: HierarchyEdge };

const NO_PENDING_DISPATCHES: readonly string[] = [];

interface DagViewProps {
  dag: DagResponse;
  leadTaskId: string | null;
  selectedId: string | null;
  selectedGateId?: string | null;
  onSelect: (id: string | null) => void;
  onSelectGate?: (gateId: string) => void;
  layout: LayoutKind;
  onLayoutChange?: (layout: LayoutKind) => void;
  reorgNonce: number;
  onRelayout?: () => void;
  fitNonce: number;
  showHierarchy: boolean;
  onToggleHierarchy?: () => void;
  statusFilter?: TaskStatus | "all";
  searchQuery?: string;
  workerRows: WorkerRowView[];
  attempts: RunAttempt[];
  active?: boolean;
  fleetFresh?: boolean;
  pendingDispatchIds?: readonly string[];
}

function Flow({
  dag,
  leadTaskId,
  selectedId,
  selectedGateId = null,
  onSelect,
  onSelectGate,
  layout,
  onLayoutChange,
  reorgNonce,
  onRelayout,
  fitNonce,
  showHierarchy,
  onToggleHierarchy,
  statusFilter = "all",
  searchQuery = "",
  workerRows,
  attempts,
  active = true,
  fleetFresh = false,
  pendingDispatchIds = NO_PENDING_DISPATCHES,
}: DagViewProps) {
  const rf = useReactFlow();
  const config = useConfig();
  const t = useT();
  const lang = useLang();
  const wrapRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(-1);
  const dragged = useRef<Map<string, { x: number; y: number }>>(new Map());
  const draggingId = useRef<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CanvasNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [showMinimap, setShowMinimap] = useState(true);
  const [manualFlowList, setManualFlowList] = useState(false);
  const [narrowContainer, setNarrowContainer] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const handledFitNonce = useRef(fitNonce);
  const handledLayout = useRef({ layout, reorgNonce });
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);

  useEffect(() => {
    const onVisibilityChange = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => {
      setNarrowContainer(el.clientWidth > 0 && el.clientWidth <= 680);
    });
    obs.observe(el);
    setNarrowContainer(el.clientWidth > 0 && el.clientWidth <= 680);
    return () => obs.disconnect();
  }, []);

  // Build combined Task + First-Class Gate topology for deterministic dagre layout
  const topologyKey = `${JSON.stringify(dag.nodes.map((n) => n.id))}|${JSON.stringify(
    dag.edges.map((e) => [e.id, e.source, e.target]),
  )}|${JSON.stringify(dag.gates.map((g) => [g.id, g.taskId]))}`;

  const laid = useMemo(() => {
    const taskNodeSpecs: Node[] = dag.nodes.map((n) => ({
      id: n.id,
      type: "task",
      position: { x: 0, y: 0 },
      data: {},
    }));
    const gateNodeSpecs: Node[] = dag.gates.map((g) => ({
      id: `${GATE_NODE_PREFIX}${g.id}`,
      type: "gate",
      position: { x: 0, y: 0 },
      data: {},
    }));

    const taskIds = new Set(dag.nodes.map((n) => n.id));
    const gatesByTask = new Map<string, Gate[]>();
    const runLevelGates: Gate[] = [];
    for (const gate of dag.gates) {
      if (gate.taskId && taskIds.has(gate.taskId)) {
        const list = gatesByTask.get(gate.taskId) ?? [];
        list.push(gate);
        gatesByTask.set(gate.taskId, list);
      } else {
        runLevelGates.push(gate);
      }
    }

    const layoutEdges: Edge[] = [];
    for (const edge of dag.edges) {
      const targetGates = gatesByTask.get(edge.target);
      if (targetGates && targetGates.length > 0) {
        // Route upstream dependency through the blocking Gate node(s)
        for (const g of targetGates) {
          layoutEdges.push({
            id: `gate-in:${edge.source}->${g.id}`,
            source: edge.source,
            target: `${GATE_NODE_PREFIX}${g.id}`,
          });
        }
      } else {
        layoutEdges.push({ id: edge.id, source: edge.source, target: edge.target });
      }
    }

    for (const [targetTaskId, gList] of gatesByTask) {
      for (const g of gList) {
        layoutEdges.push({
          id: `gate-out:${g.id}->${targetTaskId}`,
          source: `${GATE_NODE_PREFIX}${g.id}`,
          target: targetTaskId,
        });
      }
    }

    if (runLevelGates.length > 0 && dag.nodes.length > 0) {
      const sourcesWithOutgoing = new Set(dag.edges.map((e) => e.source));
      const sinks = dag.nodes.filter((n) => !sourcesWithOutgoing.has(n.id));
      const anchors = sinks.length > 0 ? sinks.slice(0, 3) : [dag.nodes[dag.nodes.length - 1]];
      for (const g of runLevelGates) {
        for (const anchor of anchors) {
          layoutEdges.push({
            id: `run-gate:${anchor.id}->${g.id}`,
            source: anchor.id,
            target: `${GATE_NODE_PREFIX}${g.id}`,
          });
        }
      }
    }

    return applyLayout(layout, [...taskNodeSpecs, ...gateNodeSpecs], layoutEdges);
  }, [topologyKey, layout, reorgNonce]);

  useEffect(() => {
    dragged.current.clear();
  }, [layout, reorgNonce]);

  const harnessEvidence = useMemo(() => {
    const actual = new Map<string, string>();
    const actualModel = new Map<string, string>();
    const actualWorkspace = new Map<string, string>();
    const launched = new Set<string>();
    const latestRow = new Map<string, WorkerRowView>();
    const currentDispatch = new Map(dag.nodes.map((node) => [node.id, node.dispatchId]));
    for (const row of workerRows) {
      if (currentDispatch.get(row.taskId) && currentDispatch.get(row.taskId) !== row.dispatchId) continue;
      if (!row.taskId || latestRow.has(row.taskId)) continue;
      latestRow.set(row.taskId, row);
      launched.add(row.taskId);
      const agent =
        row.launchEvidence?.agent ??
        row.projection?.launch?.agent ??
        row.projection?.provider?.id ??
        null;
      if (agent) actual.set(row.taskId, agent);
      const model = row.projection?.launch?.model ?? row.projection?.provider?.model;
      if (model) actualModel.set(row.taskId, model);
      const rawWs = workerWorkspaceLabel(row.projection?.workspace) ?? row.projection?.launch?.worktree ?? null;
      const ws = rawWs ? rawWs.split("::").at(-1)?.split("/").at(-1) || rawWs : null;
      if (ws) actualWorkspace.set(row.taskId, ws);
    }
    const latestAttemptByTask = new Map<string, RunAttempt>();
    for (const attempt of attempts) {
      const prev = latestAttemptByTask.get(attempt.taskId);
      if (!prev || attempt.startedAt >= prev.startedAt) latestAttemptByTask.set(attempt.taskId, attempt);
    }
    for (const [taskId, attempt] of latestAttemptByTask) {
      if (attempt.adopted || !attempt.dispatchId) continue;
      const row = latestRow.get(taskId);
      if (currentDispatch.get(taskId) && currentDispatch.get(taskId) !== attempt.dispatchId) continue;
      if (row && row.dispatchId !== attempt.dispatchId) continue;
      launched.add(taskId);
      const agent = attempt.effective?.agent ?? attempt.harness;
      if (agent && !actual.has(taskId)) actual.set(taskId, agent);
      if (attempt.effective?.model && !actualModel.has(taskId)) actualModel.set(taskId, attempt.effective.model);
      if (attempt.effective?.worktree && !actualWorkspace.has(taskId)) {
        actualWorkspace.set(taskId, attempt.effective.worktree.split("::").at(-1)?.split("/").at(-1) ?? attempt.effective.worktree);
      }
    }
    return { actual, actualModel, actualWorkspace, launched };
  }, [workerRows, attempts, dag.nodes]);

  const stageSummaries = useMemo(() => {
    const nodesById = new Map(dag.nodes.map((node) => [node.id, node]));
    const latestAttemptByTask = new Map<string, RunAttempt>();
    const attemptByDispatch = new Map<string, RunAttempt>();
    for (const attempt of attempts) {
      const previous = latestAttemptByTask.get(attempt.taskId);
      if (!previous || attempt.startedAt >= previous.startedAt) latestAttemptByTask.set(attempt.taskId, attempt);
      if (attempt.dispatchId) attemptByDispatch.set(attempt.dispatchId, attempt);
    }

    const latestWorkerByTask = new Map<string, WorkerRowView>();
    const activeWorkerByTask = new Map<string, WorkerRowView>();
    const workerByDispatch = new Map<string, WorkerRowView>();
    for (const worker of workerRows) {
      if (!worker.taskId) continue;
      if (!latestWorkerByTask.has(worker.taskId)) latestWorkerByTask.set(worker.taskId, worker);
      if (worker.dispatchId && !workerByDispatch.has(worker.dispatchId)) {
        workerByDispatch.set(worker.dispatchId, worker);
      }
      if (worker.dispatchStatus === "dispatched" && !activeWorkerByTask.has(worker.taskId)) {
        activeWorkerByTask.set(worker.taskId, worker);
      }
    }

    return new Map(
      dag.nodes.map((node) => {
        const worker = node.dispatchId
          ? workerByDispatch.get(node.dispatchId)
          : node.status === "dispatched"
            ? activeWorkerByTask.get(node.id)
            : latestWorkerByTask.get(node.id);
        const attempt = node.dispatchId
          ? attemptByDispatch.get(node.dispatchId)
          : latestAttemptByTask.get(node.id);
        return [node.id, summarizeStage(node, dag, nodesById, worker, attempt, t)] as const;
      }),
    );
  }, [dag, workerRows, attempts, lang, t]);

  useEffect(() => {
    const dir: "LR" | "TB" = layout === "layered-tb" ? "TB" : "LR";
    const statusById = new Map(dag.nodes.map((n) => [n.id, n.status]));
    const nodeById = new Map(dag.nodes.map((n) => [n.id, n]));
    const gateById = new Map(dag.gates.map((g) => [`${GATE_NODE_PREFIX}${g.id}`, g]));
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const pendingDispatches = new Set(pendingDispatchIds);
    const liveDispatches = new Set(
      fleetFresh
        ? workerRows
            .filter(
              (row) =>
                row.runId === dag.runId &&
                row.dispatchStatus === "dispatched" &&
                !pendingDispatches.has(row.dispatchId) &&
                row.projection?.attention?.requiresAction !== true &&
                row.projection?.liveness?.verdict === "live" &&
                !/stale|unknown|missing|pending|unverifiable/i.test(row.projection.liveness.reason ?? ""),
            )
            .map((row) => `${row.taskId}\0${row.dispatchId}`)
        : [],
    );

    const dimmedById = new Map<string, boolean>();

    const decoratedNodes: Node<CanvasNodeData>[] = laid.nodes.map((n) => {
      if (n.id.startsWith(GATE_NODE_PREFIX)) {
        const gate = gateById.get(n.id)!;
        const pending = isGatePending(gate);
        const statusMatches =
          statusFilter === "all" ||
          (statusFilter === "blocked" && pending) ||
          (statusFilter === "completed" && !pending);
        const queryMatches =
          !normalizedQuery ||
          gate.id.toLowerCase().includes(normalizedQuery) ||
          gate.question.toLowerCase().includes(normalizedQuery);
        const dimmed = !(statusMatches && queryMatches);
        dimmedById.set(n.id, dimmed);
        return {
          ...n,
          type: "gate",
          data: {
            kind: "gate",
            gate,
            integration: isIntegrationGate(gate),
            resolved: !pending,
            selected: selectedGateId === gate.id,
            dimmed,
            dir,
          },
        };
      }

      const dagNode = nodeById.get(n.id);
      const status = dagNode?.status ?? "pending";
      const harnessPlanned =
        !harnessEvidence.launched.has(n.id) &&
        (status === "pending" || status === "ready" || status === "blocked");
      const laneId = config.laneByTask[n.id];
      const placement = laneId
        ? config.worktreeLanes[laneId]?.placement
        : config.placementByTask[n.id];
      const plannedParts = harnessPlanned
        ? [
            config.modelByTask[n.id] ? t("dag.plannedModel", { model: config.modelByTask[n.id] }) : null,
            laneId
              ? laneSummaryLabel(laneId, plannedPlacementLabel(placement, t))
              : plannedPlacementLabel(placement, t),
          ].filter((part): part is string => Boolean(part))
        : [];
      const model = harnessEvidence.actualModel.get(n.id);
      const resolvedHarness =
        harnessEvidence.actual.get(n.id) ??
        (harnessPlanned ? effectiveHarness(n.id) : t("dag.harnessUnknown"));
      const wsLabel =
        harnessEvidence.actualWorkspace.get(n.id) ??
        (laneId ? laneId : plannedPlacementLabel(placement, t)) ??
        "current";

      const statusMatches = statusFilter === "all" || status === statusFilter;
      const queryMatches =
        !normalizedQuery ||
        n.id.toLowerCase().includes(normalizedQuery) ||
        (dagNode?.label ?? "").toLowerCase().includes(normalizedQuery) ||
        resolvedHarness.toLowerCase().includes(normalizedQuery) ||
        wsLabel.toLowerCase().includes(normalizedQuery);
      const dimmed = !(statusMatches && queryMatches);
      dimmedById.set(n.id, dimmed);

      return {
        ...n,
        type: "task",
        data: {
          kind: "task",
          runId: dag.runId,
          label: dagNode?.label ?? n.id,
          status,
          summary: stageSummaries.get(n.id)?.text ?? t("dag.contextUnavailable"),
          summaryTitle: stageSummaries.get(n.id)?.title ?? t("dag.contextUnavailable"),
          selected: n.id === selectedId && !selectedGateId,
          dimmed,
          lead: n.id === leadTaskId,
          harness: resolvedHarness,
          harnessActual: harnessEvidence.actual.has(n.id),
          harnessPlanned,
          settings: model ? model.split("/").at(-1) ?? model : plannedParts.length ? plannedParts.join(" · ") : null,
          settingsActual: !!model,
          settingsTitle: model
            ? t("dag.actualTitle", { summary: t("dag.actualModel", { model }) })
            : plannedParts.length
              ? t("dag.plannedTitle", {
                  summary:
                    plannedParts.join(" · ") +
                    (placement?.kind === "existing"
                      ? t("dag.plannedSelectorSuffix", { selector: placement.selector })
                      : ""),
                })
              : "",
          workspaceLabel: wsLabel,
          dir,
          executing:
            status === "dispatched" &&
            !!dagNode?.dispatchId &&
            liveDispatches.has(`${n.id}\0${dagNode.dispatchId}`),
          active: active && documentVisible,
        },
      };
    });

    const decoratedEdges: Edge[] = laid.edges.map((e) => {
      const bothDimmed = (dimmedById.get(e.source) ?? false) && (dimmedById.get(e.target) ?? false);
      const srcGate = gateById.get(e.source);
      const dstGate = gateById.get(e.target);
      const fromStatus = statusById.get(e.source);
      const toStatus = statusById.get(e.target);

      let stroke = "var(--border-control)";
      let dash: string | undefined;
      if ((srcGate && isGatePending(srcGate)) || (dstGate && isGatePending(dstGate))) {
        stroke = "var(--st-blocked)";
        dash = "5 4";
      } else if (fromStatus === "dispatched" || toStatus === "dispatched") {
        stroke = "var(--st-dispatched)";
        dash = "6 5";
      } else if (fromStatus === "completed" && (toStatus === "completed" || (srcGate && !isGatePending(srcGate)))) {
        stroke = "var(--st-completed)";
      }

      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: "smoothstep",
        style: {
          stroke,
          strokeWidth: 1.75,
          strokeDasharray: dash,
          opacity: bothDimmed ? 0.16 : 0.88,
        },
      };
    });

    const hierarchyEdges: Edge[] = showHierarchy
      ? (dag.hierarchy ?? []).map((l) => ({
          id: l.id,
          source: l.parent,
          target: l.child,
          type: "hierarchy",
          className: "edge--hierarchy",
          selectable: false,
          deletable: false,
        }))
      : [];

    setNodes((cur) => {
      const currentById = new Map(cur.map((n) => [n.id, n]));
      return decoratedNodes.map((n) => {
        const current = currentById.get(n.id);
        const keep =
          dragged.current.get(n.id) ??
          (draggingId.current === n.id ? current?.position : undefined);
        return {
          ...n,
          position: keep ?? n.position,
          measured: current?.measured,
        };
      });
    });
    setEdges([...hierarchyEdges, ...decoratedEdges]);
  }, [
    laid,
    dag,
    leadTaskId,
    selectedId,
    selectedGateId,
    layout,
    reorgNonce,
    showHierarchy,
    statusFilter,
    searchQuery,
    harnessEvidence,
    stageSummaries,
    config,
    lang,
    t,
    setNodes,
    setEdges,
    fleetFresh,
    workerRows,
    active,
    documentVisible,
    pendingDispatchIds,
  ]);

  const triggerFit = useCallback(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    void rf.fitView({ padding: 0.1, duration: reducedMotion ? 0 : 220 });
    window.setTimeout(() => setZoomPct(Math.round(rf.getZoom() * 100)), 240);
  }, [rf]);

  useEffect(() => {
    if (!active || !documentVisible || manualFlowList || narrowContainer) return;
    if (nodes.length === 0) {
      prevCount.current = 0;
      return;
    }
    const countChanged = nodes.length !== prevCount.current;
    const layoutChanged =
      layout !== handledLayout.current.layout ||
      reorgNonce !== handledLayout.current.reorgNonce;
    const fitRequested = fitNonce !== handledFitNonce.current;
    if (!countChanged && !layoutChanged && !fitRequested) return;
    const timer = window.setTimeout(() => {
      if (document.hidden) return;
      prevCount.current = nodes.length;
      handledLayout.current = { layout, reorgNonce };
      handledFitNonce.current = fitNonce;
      triggerFit();
    }, 90);
    return () => window.clearTimeout(timer);
  }, [active, documentVisible, manualFlowList, narrowContainer, nodes.length, layout, reorgNonce, fitNonce, triggerFit]);

  const onNodeDragStart = useCallback((_e: unknown, node: Node) => {
    draggingId.current = node.id;
  }, []);
  const onNodeDragStop = useCallback((_e: unknown, node: Node) => {
    dragged.current.set(node.id, node.position);
    draggingId.current = null;
  }, []);

  const ariaLabelConfig = useMemo(
    () => ({
      "controls.ariaLabel": t("dag.canvas.controlsAria"),
      "controls.zoomIn.ariaLabel": t("dag.canvas.zoomIn"),
      "controls.zoomOut.ariaLabel": t("dag.canvas.zoomOut"),
      "controls.fitView.ariaLabel": t("dag.canvas.fitView"),
      "node.a11yDescription.default": t("dag.a11y.nodeDesc"),
      "node.a11yDescription.keyboardDisabled": t("dag.a11y.nodeDescKeyboard"),
      "edge.a11yDescription.default": t("dag.a11y.edgeDesc"),
      "node.a11yDescription.ariaLiveMessage": ({
        direction,
        x,
        y,
      }: {
        direction: string;
        x: number;
        y: number;
      }) => {
        const key = MOVE_DIRECTION_KEY[direction];
        return t("dag.a11y.nodeMoved", { direction: key ? t(key) : direction, x, y });
      },
    }),
    [lang, t],
  );

  const activateNodeId = useCallback(
    (rawId: string) => {
      if (rawId.startsWith(GATE_NODE_PREFIX)) {
        const gId = rawId.slice(GATE_NODE_PREFIX.length);
        onSelectGate?.(gId);
      } else {
        onSelect(rawId);
      }
    },
    [onSelect, onSelectGate],
  );

  if (dag.nodes.length === 0 && dag.gates.length === 0) {
    return (
      <div className="dag-empty" style={{ margin: "auto", padding: 32, textAlign: "center" }}>
        <div className="dag-empty__title" style={{ fontSize: "var(--text-lg)", fontWeight: 600, marginBlockEnd: 8 }}>
          {t("dag.empty.title")}
        </div>
        <div className="dag-empty__hint" style={{ color: "var(--fg-secondary)", maxInlineSize: 480 }}>
          {t("dag.empty.body")} <code>orca-dag</code> {t("dag.empty.bodyTail")}
          <br />
          {t("dag.empty.hint")}
        </div>
      </div>
    );
  }

  const showFlowList = manualFlowList || narrowContainer;

  return (
    <div
      ref={wrapRef}
      className="odag-canvas-wrap"
      style={
        showFlowList
          ? { display: "flex", flexDirection: "column" }
          : {
              backgroundImage: "radial-gradient(circle at 1px 1px, var(--canvas-dot) 1px, transparent 0)",
              backgroundSize: "22px 22px",
            }
      }
    >
      {showFlowList ? (
        <div className="odag-scroll" style={{ flex: 1, minBlockSize: 0, overflowY: "auto", padding: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBlockEnd: 10 }}>
            <span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--fg-secondary)" }}>
              {t("ide.canvas.flowModeTitle")} · {t("toolbar.taskDepCount", { tasks: dag.nodes.length, deps: dag.edges.length })}
            </span>
            {!narrowContainer && (
              <button type="button" className="odag-btn" style={{ blockSize: 25 }} onClick={() => setManualFlowList(false)}>
                <Network size={12} />
                {t("ide.canvas.return2d")}
              </button>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxInlineSize: 640, marginInline: "auto" }}>
            {nodes.map((node) => {
              if (node.data.kind === "gate") {
                const gd = node.data;
                return (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => onSelectGate?.(gd.gate.id)}
                    className="odag-card"
                    style={{
                      textAlign: "start",
                      borderStyle: gd.resolved ? "solid" : "dashed",
                      borderColor: gd.selected ? "var(--accent)" : "var(--st-blocked)",
                      opacity: gd.dimmed ? 0.35 : 1,
                      display: "flex",
                      flexDirection: "column",
                      gap: 5,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span className="mono" style={{ fontSize: "var(--text-xs)", fontWeight: 700, color: "var(--st-blocked)" }}>
                        ◆ {gd.integration ? t("ide.gate.integrationBadge") : t("ide.gate.approvalBadge")}
                      </span>
                      <span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--fg-secondary)" }}>
                        {gd.resolved ? gd.gate.resolution : t("ide.gate.pendingTag")}
                      </span>
                    </div>
                    <strong style={{ fontSize: "var(--text-base)" }}>{gd.gate.question || t("gate.resolveFallback")}</strong>
                  </button>
                );
              }
              const td = node.data;
              const vars = statusTokenVars(td.status);
              const taskId = node.id;
              return (
                <button
                  key={taskId}
                  type="button"
                  onClick={() => onSelect(taskId)}
                  className="odag-card"
                  style={{
                    textAlign: "start",
                    borderColor: td.selected ? "var(--accent)" : undefined,
                    opacity: td.dimmed ? 0.35 : 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minInlineSize: 0 }}>
                      <HarnessAvatar harness={td.harness} size={22} />
                      <strong className="truncate" style={{ fontSize: "var(--text-base)" }}>
                        {td.label}
                      </strong>
                    </span>
                    <span className="odag-pill" style={{ "--pill-fg": vars.fg, "--pill-bg": vars.bg } as CSSProperties}>
                      <StatusGlyph status={td.status} executing={td.executing} size={11} />
                      {t(`status.${td.status}`)}
                    </span>
                  </div>
                  <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-secondary)" }}>{td.summary}</div>
                  <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--text-xs)", color: "var(--fg-tertiary)" }}>
                    <span>{td.workspaceLabel}</span>
                    <span>{td.harness}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onMoveEnd={(_, viewport) => setZoomPct(Math.round(viewport.zoom * 100))}
            onKeyDownCapture={(event) => {
              if ((event.key !== "Enter" && event.key !== " ") || !(event.target instanceof HTMLElement)) return;
              const node = event.target.closest<HTMLElement>(".react-flow__node");
              if (!node || event.target !== node || !node.dataset.id) return;
              event.preventDefault();
              event.stopPropagation();
              activateNodeId(node.dataset.id);
            }}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesDraggable
            nodesConnectable={false}
            deleteKeyCode={null}
            elementsSelectable
            minZoom={0.25}
            maxZoom={1.75}
            onlyRenderVisibleElements
            proOptions={{ hideAttribution: true }}
            ariaLabelConfig={ariaLabelConfig}
            onNodeClick={(_, n) => activateNodeId(n.id)}
            onPaneClick={() => onSelect(null)}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="transparent" />
            {showMinimap && (
              <MiniMap
                pannable
                zoomable
                style={{
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-hairline)",
                  borderRadius: 8,
                  bottom: 12,
                  right: 12,
                }}
                maskColor="rgb(0 0 0 / 0.16)"
                nodeColor={(n) => {
                  const d = n.data as CanvasNodeData | undefined;
                  if (d?.kind === "gate") return d.resolved ? "#34d399" : "#a78bfa";
                  if (d?.kind === "task") {
                    if (d.status === "completed") return "#34d399";
                    if (d.status === "dispatched") return "#f59e0b";
                    if (d.status === "failed") return "#f87171";
                    if (d.status === "blocked") return "#a78bfa";
                    if (d.status === "ready") return "#a1a1aa";
                  }
                  return "#71717a";
                }}
              />
            )}
          </ReactFlow>

          {/* Top-Left Floating Topology Chrome */}
          <div className="odag-glass-bar" style={{ insetBlockStart: 10, insetInlineStart: 10 }}>
            <span className="mono" style={{ fontSize: "var(--text-xs)", paddingInline: 6, color: "var(--fg-secondary)" }}>
              {t("toolbar.taskDepCount", { tasks: dag.nodes.length, deps: dag.edges.length })}
            </span>
            {onToggleHierarchy && (
              <button
                type="button"
                className="odag-btn odag-btn--ghost"
                style={{
                  blockSize: 24,
                  paddingInline: 7,
                  fontSize: "var(--text-xs)",
                  color: showHierarchy ? "var(--accent)" : undefined,
                }}
                aria-pressed={showHierarchy}
                onClick={onToggleHierarchy}
                title={t("toolbar.hierarchyToggleTitle")}
              >
                <GitFork size={12} />
                {t("ide.canvas.lineage")}
              </button>
            )}
            <button
              type="button"
              className="odag-btn odag-btn--ghost"
              style={{ blockSize: 24, paddingInline: 7, fontSize: "var(--text-xs)" }}
              onClick={() => setManualFlowList(true)}
            >
              <ListTree size={12} />
              {t("ide.canvas.flowList")}
            </button>
          </div>

          {/* Top-Right Floating Layout & Zoom Bar */}
          <div className="odag-glass-bar" style={{ insetBlockStart: 10, insetInlineEnd: 10 }}>
            {onLayoutChange && (
              <>
                <button
                  type="button"
                  className="odag-btn odag-btn--ghost"
                  style={{
                    blockSize: 24,
                    paddingInline: 7,
                    fontSize: "var(--text-xs)",
                    color: layout === "layered-lr" ? "var(--accent)" : undefined,
                  }}
                  onClick={() => onLayoutChange("layered-lr")}
                  title={t("layout.title.layered-lr")}
                >
                  <ArrowLeftRight size={12} />
                  LR
                </button>
                <button
                  type="button"
                  className="odag-btn odag-btn--ghost"
                  style={{
                    blockSize: 24,
                    paddingInline: 7,
                    fontSize: "var(--text-xs)",
                    color: layout === "layered-tb" ? "var(--accent)" : undefined,
                  }}
                  onClick={() => onLayoutChange("layered-tb")}
                  title={t("layout.title.layered-tb")}
                >
                  <ArrowDownUp size={12} />
                  TB
                </button>
                <span style={{ inlineSize: 1, blockSize: 14, background: "var(--border-hairline)" }} />
              </>
            )}
            <button
              type="button"
              className="odag-btn odag-btn--ghost odag-btn--icon"
              style={{ inlineSize: 24, blockSize: 24 }}
              aria-label={t("dag.canvas.zoomOut")}
              onClick={() => {
                void rf.zoomOut({ duration: 150 });
                window.setTimeout(() => setZoomPct(Math.round(rf.getZoom() * 100)), 170);
              }}
            >
              <ZoomOut size={13} />
            </button>
            <span className="mono" style={{ fontSize: "var(--text-xs)", minInlineSize: 38, textAlign: "center" }}>
              {zoomPct}%
            </span>
            <button
              type="button"
              className="odag-btn odag-btn--ghost odag-btn--icon"
              style={{ inlineSize: 24, blockSize: 24 }}
              aria-label={t("dag.canvas.zoomIn")}
              onClick={() => {
                void rf.zoomIn({ duration: 150 });
                window.setTimeout(() => setZoomPct(Math.round(rf.getZoom() * 100)), 170);
              }}
            >
              <ZoomIn size={13} />
            </button>
            <button
              type="button"
              className="odag-btn odag-btn--ghost odag-btn--icon"
              style={{ inlineSize: 24, blockSize: 24 }}
              aria-label={t("dag.canvas.fitView")}
              title={t("dag.canvas.fitView")}
              onClick={triggerFit}
            >
              <Maximize2 size={12} />
            </button>
            {onRelayout && (
              <button
                type="button"
                className="odag-btn odag-btn--ghost odag-btn--icon"
                style={{ inlineSize: 24, blockSize: 24 }}
                aria-label={t("toolbar.relayout")}
                title={t("toolbar.relayoutTitle")}
                onClick={onRelayout}
              >
                <RotateCcw size={12} />
              </button>
            )}
            <button
              type="button"
              className="odag-btn odag-btn--ghost odag-btn--icon"
              style={{
                inlineSize: 24,
                blockSize: 24,
                color: showMinimap ? "var(--accent)" : undefined,
              }}
              aria-label={t("ide.canvas.minimap")}
              title={t("ide.canvas.minimap")}
              onClick={() => setShowMinimap((v) => !v)}
            >
              <MapIcon size={12} />
            </button>
          </div>

          {/* Bottom-Left Compact Status Legend */}
          <div className="odag-glass-bar" style={{ insetBlockEnd: 10, insetInlineStart: 10, gap: 10, paddingInline: 10 }}>
            {(["ready", "dispatched", "blocked", "completed", "failed"] as TaskStatus[]).map((st) => {
              const vars = statusTokenVars(st);
              return (
                <span
                  key={st}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: "var(--text-xs)",
                    color: "var(--fg-secondary)",
                  }}
                >
                  <span style={{ inlineSize: 7, blockSize: 7, borderRadius: 99, background: vars.fg }} />
                  {t(`status.${st}`)}
                </span>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export const DagView = memo(function DagView(props: DagViewProps) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
});
