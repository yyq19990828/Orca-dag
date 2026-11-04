import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  getSmoothStepPath,
  Handle,
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
import "../graph-motion.css";
import { applyLayout, NODE_H, NODE_W } from "../layout";
import { effectiveHarness, useConfig } from "../harness";
import { useLang, useT, type TranslationKey, type Translator } from "../i18n";
import { laneSummaryLabel } from "../placement";
import {
  STATUS_META,
  type DagNode,
  type DagResponse,
  type LayoutKind,
  type RunAttempt,
  type TaskStatus,
  type WorkerRowView,
} from "../types";


type TaskNodeData = {  label: string;
  status: TaskStatus;
  runId: string;
  /** One stable, single-line clue about what this stage needs or produced. */
  summary: string;
  /** Full evidence text, available on hover when the visible summary is clipped. */
  summaryTitle: string;
  selected: boolean;
  /** Viewer-only semantic ownership; never changes DAG or Orca authority. */
  lead: boolean;
  harness: string;
  /** True when `harness` comes from Dispatch launch evidence, not the plan. */
  harnessActual: boolean;
  /** A Task with no Dispatch can show its configured future harness. */
  harnessPlanned: boolean;
  /** Dispatch-evidenced model or future planned settings. */
  settings: string | null;
  settingsTitle: string;
  settingsActual: boolean;
  dir: "LR" | "TB";
  /** Motion is enabled only while the graph is the active view. */
  executing: boolean;
  active: boolean;
};

type StageSummary = { text: string; title: string };

const STAGE_SUMMARY_LIMIT = 88;

/**
 * React Flow announces a keyboard node move with the raw arrow token it read
 * off the key event; each maps to a key, exactly like PLACEMENT_KIND_KEY in
 * placement.ts. An unknown token falls back to the token itself rather than
 * inventing a direction.
 */
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

/**
 * Result previews and stage summaries are built by plain functions below, not
 * React components: they take the translator as a parameter (the contract
 * placement.ts documents) and the caller — Flow — subscribes to the language
 * store, so a language switch re-runs them. Their own text is viewer copy;
 * task results, readiness reasons and host identities render verbatim.
 */
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
    // Plain text is a valid task result too; show its first sentence below.
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
  // " · " between two finished fragments is structural (the same separator the
  // planned-settings chip joins its parts with); both sides are translated.
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

  // A raw Orca `ready` row can still owe another gate decision. Prefer the
  // Run-scoped readiness projection over a misleading dispatchable subtitle.
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

function TaskNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const t = useT();
  const meta = STATUS_META[data.status];
  const statusLabel = t(`status.${data.status}`);
  const isTB = data.dir === "TB";
  const marker = useRef<HTMLSpanElement>(null);
  const previousStatus = useRef({ runId: data.runId, status: data.status });
  useEffect(() => {
    const changed = previousStatus.current.runId === data.runId &&
      previousStatus.current.status !== data.status;
    previousStatus.current = { runId: data.runId, status: data.status };
    if (!changed || !data.active || document.hidden ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = marker.current?.animate(
      [{ opacity: 0.35 }, { opacity: 1 }],
      { duration: 260, easing: "ease-out" },
    );
    return () => animation?.cancel();
  }, [data.runId, data.status, data.active]);
  return (
    <div
      role="group"
      className={[
        "task-node",
        data.selected ? "task-node--selected" : "",
        data.lead ? "task-node--lead" : "",
      ]
        .filter(Boolean)
        .join(" ")}
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
          width: NODE_W,
          height: NODE_H,
          "--node-status": meta.color,
          "--node-status-ink": meta.ink,
        } as CSSProperties
      }
    >
      {data.lead && (
        <span className="task-node__lead-badge" title={t("dag.node.leadBadgeTitle")}>
          {t("dag.node.lead")}
        </span>
      )}
      <Handle type="target" position={isTB ? Position.Top : Position.Left} />
      <div className="task-node__title" title={data.label}>{data.label}</div>
      <div className="task-node__row">
        <div className="task-node__status">
          <span ref={marker} className="task-node__marker" aria-hidden="true">
            <span className={data.executing && data.active ? "task-node__marker-dot task-node__marker-dot--executing" : "task-node__marker-dot"} />
          </span>
          {statusLabel}
        </div>
        <span
          className="task-node__harness"
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
      </div>
      <div className="task-node__summary" title={data.summaryTitle}>
        {data.summary}
      </div>
      {data.settings && (
        <div className="task-node__planned" title={data.settingsTitle}>
          {data.settings}
        </div>
      )}
      <Handle type="source" position={isTB ? Position.Bottom : Position.Right} />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

const edgeTypes = { hierarchy: HierarchyEdge };

/** Hierarchy is a distinct, static relationship, never a scheduling edge. */
function HierarchyEdge(props: EdgeProps) {
  // Its own aria-label is viewer copy, so this edge subscribes to the
  // language store like TaskNode does.
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
      {/* the open ring marks the CHILD end: who something belongs to, drawn
          like a little hoop resting on the owned stage */}
      <circle className="hierarchy-edge__ring" cx={props.targetX} cy={props.targetY} r={4} />
    </g>
  );
}

const NO_PENDING_DISPATCHES: readonly string[] = [];

function Flow({
  dag,
  leadTaskId,
  selectedId,
  onSelect,
  layout,
  reorgNonce,
  fitNonce,
  showHierarchy,
  workerRows,
  attempts,
  active = true,
  fleetFresh = false,
  pendingDispatchIds = NO_PENDING_DISPATCHES,
}: {
  dag: DagResponse;
  leadTaskId: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  layout: LayoutKind;
  reorgNonce: number;
  fitNonce: number;
  showHierarchy: boolean;
  /** Run-scoped fleet rows enriched with durable Dispatch launch evidence. */
  workerRows: WorkerRowView[];
  /** Live attempts fill the gap before the new Dispatch reaches worker-list. */
  attempts: RunAttempt[];
  active?: boolean;
  fleetFresh?: boolean;
  pendingDispatchIds?: readonly string[];
}) {
  const rf = useReactFlow();
  const config = useConfig();
  // Two subscriptions to the same store, on purpose: `t` is the stable
  // translator, while the language VALUE is what the memoized summaries and
  // the decoration effect below must key on — a language switch leaves every
  // other dependency (dag, worker rows, attempts, config) identical, so
  // without it the canvas would keep rendering the previous language.
  const t = useT();
  const lang = useLang();
  const prevCount = useRef(-1);
  // positions the user has explicitly dragged — preserved across status polls
  const dragged = useRef<Map<string, { x: number; y: number }>>(new Map());
  // id of the node under an active drag gesture (keep its live position)
  const draggingId = useRef<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TaskNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const handledFitNonce = useRef(fitNonce);
  const handledLayout = useRef({ layout, reorgNonce });
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onVisibilityChange = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // --- Stage 1 · topology → positioned geometry ----------------------------
  //
  // The layout is derived ONLY from what the algorithms actually consume: the
  // node id sequence (order seeds the force layout's circle and breaks dagre
  // ties) and the dependency edges. It sits behind a string signature instead
  // of `dag` identity because every 2s poll re-fetches the DAG and hands us
  // fresh objects and arrays even when nothing changed — memoizing on those
  // would re-solve (a 320-iteration Fruchterman–Reingold pass per poll) and
  // keep yanking the graph out from under the cursor. Statuses, labels,
  // selection, lead, harness picks, worker rows: none of them move a node, so
  // none of them may re-rank one. Layout kind and reorgNonce are in the key so
  // an algorithm switch or explicit Re-layout re-solves even with an unchanged
  // shape.
  const topologyKey = `${JSON.stringify(dag.nodes.map((n) => n.id))}|${JSON.stringify(
    dag.edges.map((e) => [e.id, e.source, e.target]),
  )}`;
  const laid = useMemo(
    () =>
      applyLayout(
        layout,
        // Topology-only inputs — no decoration rides in, so the memoized
        // result can never go stale on decoration churn. Dependency edges
        // only: hierarchy links are NEVER layout input (see the
        // reconciliation below), exactly as before. `data` is present only
        // because React Flow's Node type requires it — the solvers read just
        // ids and endpoints; Stage 4 replaces it wholesale.
        dag.nodes.map((n) => ({ id: n.id, position: { x: 0, y: 0 }, data: {} })),
        dag.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
      ),
    // `topologyKey` fully covers the `dag.*` inputs above; keying on the
    // string rather than the per-poll arrays is the whole point of the split.
    [topologyKey, layout, reorgNonce],
  );

  // Switching layout algorithm or asking for a re-org discards manual drags so
  // the graph snaps fully to the fresh auto-layout. Declared before the
  // reconciliation effect so the ref is cleared before it re-merges positions.
  useEffect(() => {
    dragged.current.clear();
  }, [layout, reorgNonce]);


  // --- Stage 3 · actual-launch evidence --------------------------------------
  //
  // A badge on a launched Stage describes its latest Dispatch, never today's
  // mutable harness preference. The server enriches worker-list with its
  // persisted launch record or a one-time worker-show observation. Until the
  // row appears, the live Attempt supplies the same identity. Old legacy
  // Dispatches without either kind of evidence show "unknown" honestly.
  const harnessEvidence = useMemo(() => {
    const actual = new Map<string, string>();
    const actualModel = new Map<string, string>();
    const launched = new Set<string>();
    const latestRow = new Map<string, WorkerRowView>();
    const currentDispatch = new Map(dag.nodes.map((node) => [node.id, node.dispatchId]));
    for (const row of workerRows) {
      if (currentDispatch.get(row.taskId) && currentDispatch.get(row.taskId) !== row.dispatchId) continue;
      if (!row.taskId || latestRow.has(row.taskId)) continue;
      latestRow.set(row.taskId, row);
      launched.add(row.taskId);
      const agent = row.launchEvidence?.agent ??
        row.projection?.launch?.agent ?? row.projection?.provider?.id ?? null;
      if (agent) actual.set(row.taskId, agent);
      const model = row.projection?.launch?.model ?? row.projection?.provider?.model;
      if (model) actualModel.set(row.taskId, model);
    }
    const latestAttemptByTask = new Map<string, RunAttempt>();
    for (const attempt of attempts) {
      const prev = latestAttemptByTask.get(attempt.taskId);
      if (!prev || attempt.startedAt >= prev.startedAt) latestAttemptByTask.set(attempt.taskId, attempt);
    }
    for (const [taskId, attempt] of latestAttemptByTask) {
      // Adopted attempts reconstruct `harness` from today's config. A reserved
      // attempt has not yet created a Dispatch. Neither proves a launch.
      if (attempt.adopted || !attempt.dispatchId) continue;
      const row = latestRow.get(taskId);
      // Never paste an older attempt's harness onto a newer Dispatch.
      if (currentDispatch.get(taskId) && currentDispatch.get(taskId) !== attempt.dispatchId) continue;
      if (row && row.dispatchId !== attempt.dispatchId) continue;
      launched.add(taskId);
      const agent = attempt.effective?.agent ?? attempt.harness;
      if (agent && !actual.has(taskId)) actual.set(taskId, agent);
      if (attempt.effective?.model && !actualModel.has(taskId)) actualModel.set(taskId, attempt.effective.model);
    }
    return { actual, actualModel, launched };
  }, [workerRows, attempts, dag.nodes]);

  // One compact, evidence-backed clue per card. Prefer the exact current
  // Dispatch when Orca supplied its id; only fall back to newest-per-Task
  // facts when the Task row has no current Dispatch id. Parent/child ownership
  // is deliberately absent here: only server-projected readiness (which is
  // based on dependencies and gates) can explain why a task is waiting.
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
      // worker-list is newest-first; preserve its first row for the Task.
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
  }, [dag, workerRows, attempts, lang]);

  // --- Stage 4 · reconciliation: decoration onto positioned geometry ---------
  //
  // Re-derives the SEMANTICS — status colouring, selection, lead ring, harness
  // provenance, pop, edge classes, hierarchy links — and merges them onto the
  // memoized positions from Stage 1. This effect is the only place decoration
  // can change what the user sees, and it never re-runs the solver: `laid`
  // changes identity only when topology, layout kind or reorgNonce change.
  // `layout` and `reorgNonce` are listed directly because a Re-layout with an
  // unchanged shape memo-hits `laid` yet must still re-merge (the drag-clear
  // above has emptied `dragged`, and the stale merged positions must go).
  useEffect(() => {
    const dir: "LR" | "TB" = layout === "layered-tb" ? "TB" : "LR";
    const statusById = new Map(dag.nodes.map((n) => [n.id, n.status]));
    const nodeById = new Map(dag.nodes.map((n) => [n.id, n]));
    const pendingDispatches = new Set(pendingDispatchIds);
    const liveDispatches = new Set(
      fleetFresh ? workerRows.filter((row) =>
        row.runId === dag.runId &&
        row.dispatchStatus === "dispatched" &&
        !pendingDispatches.has(row.dispatchId) &&
        row.projection?.attention?.requiresAction !== true &&
        row.projection?.liveness?.verdict === "live" &&
        !/stale|unknown|missing|pending|unverifiable/i.test(row.projection.liveness.reason ?? ""),
      ).map((row) => `${row.taskId}\0${row.dispatchId}`) : [],
    );

    const decoratedNodes: Node<TaskNodeData>[] = laid.nodes.map((n) => {
      const dagNode = nodeById.get(n.id);
      const status = dagNode?.status ?? "pending";
      const harnessPlanned = !harnessEvidence.launched.has(n.id) &&
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
      return {
        ...n,
        type: "task",
        data: {
          runId: dag.runId,
          label: dagNode?.label ?? n.id,
          status,
          summary: stageSummaries.get(n.id)?.text ?? t("dag.contextUnavailable"),
          summaryTitle: stageSummaries.get(n.id)?.title ?? t("dag.contextUnavailable"),
          selected: n.id === selectedId,
          lead: n.id === leadTaskId,
          // A launched stage shows what Orca/the coordinator recorded; stages
          // with no Dispatch show the planned harness. Unknown historical
          // launches never borrow today's editable default.
          harness: harnessEvidence.actual.get(n.id) ??
            (harnessPlanned ? effectiveHarness(n.id) : t("dag.harnessUnknown")),
          harnessActual: harnessEvidence.actual.has(n.id),
          harnessPlanned,
          settings: model ? t("dag.actualModel", { model }) : plannedParts.length ? plannedParts.join(" · ") : null,
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
          dir,
          executing: status === "dispatched" && !!dagNode?.dispatchId &&
            liveDispatches.has(`${n.id}\0${dagNode.dispatchId}`),
          active: active && documentVisible,
        },
      };
    });
    // Dependency edges remain static, with their source status distinguished.
    const decoratedEdges: Edge[] = laid.edges.map((e) => {
      const from = statusById.get(e.source);
      const running = from === "dispatched";
      const done = from === "completed";
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        className: running ? "edge--run" : done ? "edge--done" : "edge--idle",
      };
    });

    // Ownership links (Phase 4) are rendered as edges but are NEVER layout
    // input: the Stage 1 solver ranked only the dependency arrows, so a
    // parent whose child is ready does not drag it into an earlier rank, and
    // every layout algorithm (LR/TB/force) behaves exactly as before. Merged
    // BELOW the dependency edges (array order = paint order) so ownership
    // reads as the subordinate structure it is. The toolbar toggle removes
    // them outright — they are presentation-only, so hiding them loses no
    // scheduling meaning. An owner's Task can also be missing from this Run
    // (dangling parent_id): the server already emits no link for it.
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

        // `setNodes` receives brand-new user-node objects on every status poll.
        // In React Flow, a new object without `measured` means "re-initialize
        // this node": its cached handle bounds are cleared until ResizeObserver
        // measures it again, and during that gap every connected EdgeWrapper
        // returns null — so edges and their handles unmount/remount on ordinary
        // polls, which reads as flicker and used to restart the (now removed)
        // per-edge WAAPI trace. Carrying the library-owned dimensions tells
        // React Flow this is the same measured node, so handles, edge DOM and
        // dragged positions survive ordinary polls.
        return {
          ...n,
          position: keep ?? n.position,
          measured: current?.measured,
        };
      });
    });
    setEdges([...hierarchyEdges, ...decoratedEdges]);
  }, [laid, dag, leadTaskId, selectedId, layout, reorgNonce, showHierarchy, harnessEvidence, stageSummaries, config, lang, setNodes, setEdges, fleetFresh, workerRows, active, documentVisible, pendingDispatchIds]);

  // Defer requested fits while the graph or document is hidden. Record only
  // after the timer fires, so a cancelled timer is retried when visible.
  useEffect(() => {
    if (!active || !documentVisible) return;
    if (nodes.length === 0) {
      prevCount.current = 0;
      return;
    }
    const countChanged = nodes.length !== prevCount.current;
    const layoutChanged = layout !== handledLayout.current.layout ||
      reorgNonce !== handledLayout.current.reorgNonce;
    const fitRequested = fitNonce !== handledFitNonce.current;
    if (!countChanged && !layoutChanged && !fitRequested) return;
    const timer = window.setTimeout(() => {
      if (document.hidden) return;
      prevCount.current = nodes.length;
      handledLayout.current = { layout, reorgNonce };
      handledFitNonce.current = fitNonce;
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      void rf.fitView({ padding: 0.22, duration: reducedMotion ? 0 : 300 });
    }, 90);
    return () => window.clearTimeout(timer);
  }, [active, documentVisible, nodes.length, layout, reorgNonce, fitNonce, rf]);

  const onNodeDragStart = useCallback((_e: unknown, node: Node) => {
    draggingId.current = node.id;
  }, []);
  const onNodeDragStop = useCallback((_e: unknown, node: Node) => {
    dragged.current.set(node.id, node.position);
    draggingId.current = null;
  }, []);

  // React Flow's own chrome — the controls panel and the screen-reader
  // descriptions it injects for nodes and edges — is English out of the box;
  // its ariaLabelConfig prop is the seam for supplying the viewer's words.
  // Memoized on the language: React Flow re-syncs this prop whenever its
  // identity changes, so a fresh literal on every render would push a new
  // config into its store on each poll.
  const ariaLabelConfig = useMemo(
    () => ({
      "controls.ariaLabel": t("dag.canvas.controlsAria"),
      "controls.zoomIn.ariaLabel": t("dag.canvas.zoomIn"),
      "controls.zoomOut.ariaLabel": t("dag.canvas.zoomOut"),
      "controls.fitView.ariaLabel": t("dag.canvas.fitView"),
      "node.a11yDescription.default": t("dag.a11y.nodeDesc"),
      "node.a11yDescription.keyboardDisabled": t("dag.a11y.nodeDescKeyboard"),
      "edge.a11yDescription.default": t("dag.a11y.edgeDesc"),
      "node.a11yDescription.ariaLiveMessage": ({ direction, x, y }: { direction: string; x: number; y: number }) => {
        const key = MOVE_DIRECTION_KEY[direction];
        return t("dag.a11y.nodeMoved", { direction: key ? t(key) : direction, x, y });
      },
    }),
    [lang, t],
  );

  if (dag.nodes.length === 0) {
    return (
      <div className="dag-empty">
        <div className="dag-empty__title">{t("dag.empty.title")}</div>
        <div className="dag-empty__hint">
          {t("dag.empty.body")}{" "}
          <code>orca-dag</code>{" "}
          {t("dag.empty.bodyTail")}
          <br />
          {t("dag.empty.hint")}
        </div>
      </div>
    );
  }

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onKeyDownCapture={(event) => {
          if ((event.key !== "Enter" && event.key !== " ") || !(event.target instanceof HTMLElement)) return;
          const node = event.target.closest<HTMLElement>(".react-flow__node");
          // React Flow retains arrow-key positioning. Only the node itself
          // activates details; future controls inside a node keep their keys.
          if (!node || event.target !== node || !node.dataset.id) return;
          event.preventDefault();
          event.stopPropagation();
          onSelect(node.dataset.id);
        }}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable
        nodesConnectable={false}
        /* The canvas is a projection, not a task/dependency editor. Native
           Delete/Backspace must not make authoritative records vanish locally. */
        deleteKeyCode={null}
        elementsSelectable
        minZoom={0.2}
        /* Cull to the viewport: a dense, zoomed-out graph mounts only what is
           actually on screen (and still mounts whatever becomes visible while
           panning/zooming), which is what keeps a big DAG from building every
           node, filter and stamp at once. Visibility is computed from React
           Flow's own viewport transform, so dragged positions, edge
           connectivity, hierarchy links and the node `role="group"`/aria-label
           accessibility are untouched — only off-screen DOM is skipped. */
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
        ariaLabelConfig={ariaLabelConfig}
        onNodeClick={(_, n) => onSelect(n.id === selectedId ? null : n.id)}
        onPaneClick={() => onSelect(null)}
      >
        <Background variant={BackgroundVariant.Lines} gap={30} color="rgba(96,132,178,0.085)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </>
  );
}

export const DagView = memo(function DagView(props: {
  dag: DagResponse;
  leadTaskId: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  layout: LayoutKind;
  reorgNonce: number;
  fitNonce: number;
  showHierarchy: boolean;
  /** Durable fleet rows — the authority on what actually launched per Task. */
  workerRows: WorkerRowView[];
  /** Viewer-coordinator attempt records — the only launch evidence for
   *  legacy/tracking starts (opencode, custom commands), whose fleet rows
   *  carry no launch facts at all. Scoped to the selected Run by the caller. */
  attempts: RunAttempt[];
  /** False when this view is hidden; does not reset graph position. */
  active?: boolean;
  /** Current-Run fleet inventory has successfully loaded and is not stale. */
  fleetFresh?: boolean;
  /** Current-Run Dispatches with unresolved human input or actionable events. */
  pendingDispatchIds?: readonly string[];
}) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
});
