import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Cpu,
  Diamond,
  GitBranch,
  HelpCircle,
  History,
  Kanban,
  Link2,
  Link2Off,
  MessageSquareWarning,
  Moon,
  Network,
  PanelLeft,
  PanelRight,
  Search,
  SlidersHorizontal,
  Sun,
  TerminalSquare,
  Workflow,
  X,
} from "lucide-react";
import { fetchDag, fetchRunStatus, fetchWorkers } from "./api";
import { ActivityPanel } from "./components/ActivityPanel";
import { BoardView } from "./components/BoardView";
import { CapabilityPanel } from "./components/CapabilityPanel";
import { ChatPanel } from "./components/ChatPanel";
import { CleanupPanel } from "./components/CleanupPanel";
import { isGatePending, StatusGlyph } from "./components/statusUi";
import { ExecControls } from "./components/ExecControls";
import { GateInspector } from "./components/GateInspector";
import { GatePanel } from "./components/GatePanel";
import { HarnessAvatar } from "./components/HarnessAvatar";
import { CommandPalette, ShortcutsDialog, type IdeStageView } from "./components/IdeModals";
import { LanesPanel } from "./components/LanesPanel";
import { LangToggle } from "./components/LangToggle";
import { NodePanel } from "./components/NodePanel";
import {
  countActionableOperations,
  countKnownActionableOperations,
  OperationsAttention,
} from "./components/OperationsAttention";
import { RecoveryPanel } from "./components/RecoveryPanel";
import { RequestAuditPanel } from "./components/RequestAuditPanel";
import { RunHealthBadge } from "./components/RunHealthBadge";
import { RunPicker, type RunListReadState } from "./components/RunPicker";
import { RunsView } from "./components/RunsView";
import { SchedulerDockView } from "./components/SchedulerDockView";
import { WorkerOutputDockView } from "./components/WorkerOutputDockView";
import { WorkerPanel } from "./components/WorkerPanel";
import {
  effectiveHarness,
  initConfig,
  setLayout,
  setLeadTask,
  setMaxConcurrency,
  setRunId,
  useConfig,
  useReadiness,
} from "./harness";
import { setLang, useLang, useT, type TranslationKey } from "./i18n";
import { focusOperation, type OperationFocus } from "./operation-navigation";
import { toggleColorScheme, useColorScheme } from "./theme";
import "./tooltip.css";
import {
  type ActivitySnapshot,
  type DagResponse,
  type LayoutKind,
  type RunAttempt,
  type RunStatus,
  type TaskStatus,
  type WorkerRowView,
} from "./types";
import { usePageVisible } from "./visibility";
import { workerWorkspaceLabel } from "./workerWorkspace";

const DagView = lazy(() =>
  import("./components/DagView").then((module) => ({ default: module.DagView })),
);

function GraphMounted({ onMount, children }: { onMount: () => void; children: ReactNode }) {
  useEffect(() => {
    onMount();
  }, [onMount]);
  return children;
}

const EMPTY: DagResponse = {
  runId: "",
  nodes: [],
  edges: [],
  gates: [],
  hierarchy: [],
  readyWave: { taskIds: [], freeSlots: null },
  readiness: {},
  generatedAt: 0,
};

const EMPTY_ACTIVITY: ActivitySnapshot = {
  runId: "",
  events: [],
  presence: [],
  checks: [],
  pendingCount: 0,
  truncated: false,
  inboxWindow: null,
  generatedAt: 0,
};

const EMPTY_ATTEMPTS: RunAttempt[] = [];
const POLL_MS = 2000;
const STAGE_VIEWS: readonly IdeStageView[] = ["canvas", "board", "runs", "resources", "settings"];

const PHASE_KEY: Partial<Record<RunStatus["phase"], TranslationKey>> = {
  idle: "phase.idle",
  binding: "phase.binding",
  running: "phase.running",
  awaiting_input: "phase.awaitingInput",
  stopping: "phase.stopping",
  completed: "phase.completed",
  recovering: "phase.recovering",
  error: "phase.error",
};

interface IdeRoute {
  view: IdeStageView;
  task: string | null;
  gate: string | null;
  openDock: boolean;
}

function readRoute(): IdeRoute {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const rawView = params.get("view");
  const legacySection = params.get("section");
  const gate = params.get("gate") || null;
  const task = gate ? null : params.get("task") || null;

  let view: IdeStageView = "canvas";
  let openDock = false;

  if (rawView && (STAGE_VIEWS as readonly string[]).includes(rawView)) {
    view = rawView as IdeStageView;
  } else if (legacySection) {
    if (legacySection === "decisions" || legacySection === "executions") view = "board";
    else if (legacySection === "resources") view = "resources";
    else if (legacySection === "settings") view = "settings";
    else if (legacySection === "activity") {
      view = "canvas";
      openDock = true;
    } else {
      view = "canvas";
    }
  }

  return { view, task, gate, openDock };
}

function writeRoute(
  view: IdeStageView,
  task: string | null,
  gate: string | null,
  replace = false,
): void {
  const params = new URLSearchParams();
  params.set("view", view);
  if (gate) params.set("gate", gate);
  else if (task) params.set("task", task);
  const hash = `#${params.toString()}`;
  if (window.location.hash !== hash) {
    if (replace) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
    } else {
      window.history.pushState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
    }
  }
}

const INSPECTOR_MIN_WIDTH = 320;
const INSPECTOR_MAX_WIDTH = 760;
const DOCK_MIN_HEIGHT = 136;
const DOCK_MAX_HEIGHT = 480;

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type StatusFilter = TaskStatus | "all";
const FILTER_CHIPS: readonly StatusFilter[] = [
  "all",
  "dispatched",
  "blocked",
  "ready",
  "completed",
  "failed",
];

type DockTab = "scheduler" | "activity" | "output" | "audit";

export default function App() {
  const [dag, setDag] = useState<DagResponse>(EMPTY);
  const [route, setRoute] = useState<IdeRoute>(readRoute);
  const [taskSelection, setTaskSelection] = useState<{ taskId: string } | null>(() =>
    route.task ? { taskId: route.task } : null,
  );
  const [groupSelection, setGroupSelection] = useState<{ nonce: number } | null>(() =>
    route.task ? null : { nonce: 1 },
  );

  // Responsive 4-zone panel visibility: collapse sidebars on narrow Orca plugin frames by default
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => window.innerWidth > 760);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(
    () => Boolean(route.task || route.gate) || window.innerWidth > 1180,
  );
  const [dockOpen, setDockOpen] = useState<boolean>(
    () => route.openDock || window.innerHeight > 700,
  );
  const [dockTab, setDockTab] = useState<DockTab>("scheduler");
  const [dockHeight, setDockHeight] = useState<number>(224);
  const [selectedOutputDispatchId, setSelectedOutputDispatchId] = useState<string | null>(null);

  const [inspectorWidth, setInspectorWidth] = useState<number | null>(null);
  const [inspectorSize, setInspectorSize] = useState({ width: 416, max: INSPECTOR_MAX_WIDTH });

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showHierarchy, setShowHierarchy] = useState(true);
  const [reorgNonce, setReorgNonce] = useState(0);
  const [canvasFitNonce, setCanvasFitNonce] = useState(0);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const [operationFocus, setOperationFocus] = useState<OperationFocus | null>(null);
  const [actionHost, setActionHost] = useState<HTMLElement | null>(null);
  const [launchHost, setLaunchHost] = useState<HTMLElement | null>(null);

  const operationRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useRef<HTMLElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const inspectorResize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(
    null,
  );
  const dockResize = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(
    null,
  );

  const [activityPending, setActivityPending] = useState(0);
  const [activitySnapshot, setActivitySnapshot] = useState<ActivitySnapshot>(EMPTY_ACTIVITY);
  const [dagFailure, setDagFailure] = useState<{ runId: string; message: string } | null>(null);

  const config = useConfig();
  const t = useT();
  const lang = useLang();
  const colorScheme = useColorScheme();
  const readiness = useReadiness();
  const execOff = readiness !== null && !readiness.executionEnabled;
  const runId = config.runId;
  const layout: LayoutKind = config.layout || "layered-lr";
  const connError = dagFailure?.runId === runId ? dagFailure.message : null;

  const [graphMountedRun, setGraphMountedRun] = useState<string | null>(null);
  const markGraphMounted = useCallback(() => setGraphMountedRun(runId), [runId]);
  const [retryingRead, setRetryingRead] = useState(false);

  const timer = useRef<number | null>(null);
  const executionTimer = useRef<number | null>(null);
  const startedByRun = useRef<Map<string, Set<string>>>(new Map());
  const [startedRevision, setStartedRevision] = useState(0);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [startingRunId, setStartingRunId] = useState<string | null>(null);
  const [workerHistoryLoading, setWorkerHistoryLoading] = useState(false);
  const [workerHistoryError, setWorkerHistoryError] = useState<string | null>(null);
  const [workerRows, setWorkerRows] = useState<WorkerRowView[]>([]);
  const [fleetRead, setFleetRead] = useState<{ runId: string; at: number } | null>(null);
  const [fleetExpired, setFleetExpired] = useState(true);

  useEffect(() => {
    if (!fleetRead || fleetRead.runId !== runId) {
      setFleetExpired(true);
      return;
    }
    setFleetExpired(false);
    const timeout = window.setTimeout(
      () => setFleetExpired(true),
      Math.max(0, 10000 - (Date.now() - fleetRead.at)),
    );
    return () => window.clearTimeout(timeout);
  }, [fleetRead, runId]);

  const fleetFresh = Boolean(
    fleetRead?.runId === runId &&
      !fleetExpired &&
      !workerHistoryLoading &&
      !workerHistoryError &&
      Date.now() - fleetRead.at <= 10000,
  );

  const selectedRunRef = useRef(runId);
  selectedRunRef.current = runId;
  const dagRequestSeq = useRef(0);
  const dagAppliedSeq = useRef(0);
  const executionPollSeq = useRef(0);
  const workersAppliedSeq = useRef(0);
  const statusAppliedSeq = useRef(0);

  // Hydrate server-side viewer config BEFORE RunPicker autoPick may fire
  const [hydrated, setHydrated] = useState(false);
  const [runListRead, setRunListRead] = useState<RunListReadState>({ loaded: false, error: null });
  useEffect(() => {
    initConfig()
      .catch(() => {
        /* defaults + localStorage mirror still apply */
      })
      .finally(() => setHydrated(true));
  }, []);

  // Normalize legacy `#section=...` URLs and react to browser Back/Forward
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    if (params.has("section")) {
      writeRoute(route.view, route.task, route.gate, true);
    }
  }, [route.view, route.task, route.gate]);

  useEffect(() => {
    const restore = () => {
      const next = readRoute();
      setRoute(next);
      setTaskSelection(next.task ? { taskId: next.task } : null);
      if (next.task || next.gate) setInspectorOpen(true);
      if (next.openDock) {
        setDockOpen(true);
        setDockTab("activity");
      }
      setOperationFocus(null);
    };
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
    };
  }, []);

  const switchView = useCallback(
    (nextView: IdeStageView) => {
      writeRoute(nextView, route.task, route.gate);
      setRoute((prev) => ({ ...prev, view: nextView }));
      if (window.innerWidth <= 720) setSidebarOpen(false);
    },
    [route.task, route.gate],
  );

  const selectTask = useCallback(
    (taskId: string | null) => {
      writeRoute(route.view, taskId, null);
      setRoute((prev) => ({ ...prev, task: taskId, gate: null }));
      setTaskSelection(taskId ? { taskId } : null);
      if (taskId) {
        setInspectorOpen(true);
        if (window.innerWidth <= 720) setSidebarOpen(false);
      }
    },
    [route.view],
  );

  const selectGate = useCallback(
    (gateId: string) => {
      writeRoute(route.view, null, gateId);
      setRoute((prev) => ({ ...prev, task: null, gate: gateId }));
      setTaskSelection(null);
      setInspectorOpen(true);
      if (window.innerWidth <= 720) setSidebarOpen(false);
    },
    [route.view],
  );

  const clearSelection = useCallback(() => {
    writeRoute(route.view, null, null);
    setRoute((prev) => ({ ...prev, task: null, gate: null }));
    setTaskSelection(null);
    setGroupSelection((prev) => ({ nonce: (prev?.nonce ?? 0) + 1 }));
    if (window.innerWidth <= 1120) setInspectorOpen(false);
  }, [route.view]);

  const openCoordinatorView = useCallback(
    (target: "scheduler" | "chat" = "scheduler") => {
      writeRoute(route.view, null, null);
      setRoute((prev) => ({ ...prev, task: null, gate: null }));
      setTaskSelection(null);
      setGroupSelection((prev) => ({ nonce: (prev?.nonce ?? 0) + 1 }));
      if (target === "scheduler") {
        setDockTab("scheduler");
        setDockOpen(true);
      }
      setInspectorOpen(true);
      if (window.innerWidth <= 720) setSidebarOpen(false);
    },
    [route.view],
  );

  const pickRun = useCallback(
    (id: string) => {
      setRunId(id);
      setGraphMountedRun(null);
      setOperationFocus(null);
      setSelectedOutputDispatchId(null);
      setActivityPending(0);
      setActivitySnapshot({ ...EMPTY_ACTIVITY, runId: id });
      setDag(EMPTY);
      setDagFailure(null);
      writeRoute(route.view, null, null);
      setRoute((prev) => ({ ...prev, task: null, gate: null }));
      setTaskSelection(null);
    },
    [route.view],
  );

  const refresh = useCallback(async () => {
    const requestedRun = runId;
    const seq = ++dagRequestSeq.current;
    if (!requestedRun) {
      setDag(EMPTY);
      return;
    }
    try {
      const next = await fetchDag(requestedRun);
      if (
        selectedRunRef.current !== requestedRun ||
        seq < dagAppliedSeq.current ||
        next.runId !== requestedRun
      ) {
        return;
      }
      dagAppliedSeq.current = seq;
      setDag((prev) => (sameJson(prev, next) ? prev : next));
      setDagFailure(null);
    } catch (e) {
      if (selectedRunRef.current === requestedRun && seq >= dagAppliedSeq.current) {
        const msg = String((e as Error).message ?? e);
        setDagFailure({ runId: requestedRun, message: msg });
        const code = (e as { code?: string })?.code;
        const status = (e as { status?: number })?.status;
        const isMissing =
          code === "run_not_found" ||
          status === 404 ||
          status === 409 ||
          /not_found|not found/i.test(msg);
        if (isMissing && hydrated) {
          pickRun("");
        }
      }
    }
  }, [runId, hydrated, pickRun]);

  const pageVisible = usePageVisible();

  useEffect(() => {
    if (!pageVisible) return;
    void refresh();
    timer.current = window.setInterval(refresh, POLL_MS);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [refresh, pageVisible]);

  const refreshExecutionState = useCallback(async () => {
    const requestedRun = runId;
    if (!requestedRun) {
      setRunStatus(null);
      setWorkerHistoryLoading(false);
      setWorkerHistoryError(null);
      return;
    }

    const seq = ++executionPollSeq.current;
    const [workersResult, statusResult] = await Promise.allSettled([
      fetchWorkers(requestedRun),
      fetchRunStatus(),
    ]);

    if (selectedRunRef.current !== requestedRun) return;

    if (seq >= workersAppliedSeq.current) {
      workersAppliedSeq.current = seq;
      setWorkerHistoryLoading(false);
      if (workersResult.status === "fulfilled") {
        setFleetRead(
          workersResult.value.partialHostErrors.length ? null : { runId: requestedRun, at: Date.now() },
        );
        const known = startedByRun.current.get(requestedRun) ?? new Set<string>();
        let changed = false;
        for (const worker of workersResult.value.workers) {
          if (!worker.taskId || known.has(worker.taskId)) continue;
          known.add(worker.taskId);
          changed = true;
        }
        startedByRun.current.set(requestedRun, known);
        if (changed) setStartedRevision((n) => n + 1);
        setWorkerHistoryError(
          workersResult.value.partialHostErrors.length
            ? `${t("worker.partialHostErrors")}: ${JSON.stringify(workersResult.value.partialHostErrors)}`
            : null,
        );
        setWorkerRows((prev) =>
          sameJson(prev, workersResult.value.workers) ? prev : workersResult.value.workers,
        );
      } else {
        setFleetRead(null);
        setWorkerHistoryError(
          String((workersResult.reason as Error)?.message ?? workersResult.reason),
        );
      }
    }

    if (statusResult.status === "fulfilled" && seq >= statusAppliedSeq.current) {
      statusAppliedSeq.current = seq;
      setRunStatus((prev) => (sameJson(prev, statusResult.value) ? prev : statusResult.value));
    }
  }, [runId, t]);

  useEffect(() => {
    if (!pageVisible) return;
    setWorkerHistoryLoading(Boolean(runId));
    setWorkerHistoryError(null);
    setFleetRead(null);
    setWorkerRows([]);
    void refreshExecutionState();
    executionTimer.current = window.setInterval(refreshExecutionState, POLL_MS);
    return () => {
      if (executionTimer.current) window.clearInterval(executionTimer.current);
    };
  }, [refreshExecutionState, runId, pageVisible]);

  const onRunStarting = useCallback((id: string) => {
    setStartingRunId(id);
  }, []);

  const onRunStartFinished = useCallback((id: string, status: RunStatus | null) => {
    setStartingRunId((current) => (current === id ? null : current));
    if (status && selectedRunRef.current === id) setRunStatus(status);
  }, []);

  const onRunStopped = useCallback(() => {
    void refreshExecutionState();
  }, [refreshExecutionState]);

  // Inspector horizontal resize
  function clampInspectorWidth(width: number): number {
    const parentWidth = inspectorRef.current?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    const upper = Math.max(INSPECTOR_MIN_WIDTH, Math.min(INSPECTOR_MAX_WIDTH, parentWidth - 280));
    return Math.round(Math.min(Math.max(width, INSPECTOR_MIN_WIDTH), upper));
  }

  useLayoutEffect(() => {
    const panel = inspectorRef.current;
    const parent = panel?.parentElement;
    if (!panel || !parent) return;
    const obs = new ResizeObserver(() => {
      const width = Math.round(panel.getBoundingClientRect().width);
      const max = Math.max(
        INSPECTOR_MIN_WIDTH,
        Math.min(INSPECTOR_MAX_WIDTH, Math.floor(parent.getBoundingClientRect().width - 280)),
      );
      setInspectorSize((prev) => (prev.width === width && prev.max === max ? prev : { width, max }));
    });
    obs.observe(panel);
    obs.observe(parent);
    return () => obs.disconnect();
  }, []);

  function beginInspectorResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!inspectorRef.current) return;
    inspectorResize.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: inspectorRef.current.getBoundingClientRect().width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveInspectorResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = inspectorResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setInspectorWidth(clampInspectorWidth(resize.startWidth + resize.startX - event.clientX));
  }

  function endInspectorResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = inspectorResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    inspectorResize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  // Dock vertical resize
  function beginDockResize(event: ReactPointerEvent<HTMLDivElement>) {
    dockResize.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: dockHeight,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveDockResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = dockResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const next = Math.round(
      Math.min(DOCK_MAX_HEIGHT, Math.max(DOCK_MIN_HEIGHT, resize.startHeight + resize.startY - event.clientY)),
    );
    setDockHeight(next);
  }

  function endDockResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = dockResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    dockResize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const visibleDag = dag.runId === runId ? dag : EMPTY;
  const hasDagSnapshot = Boolean(runId && dag.runId === runId);
  const readError = connError ?? (!runId ? runListRead.error : null);
  const connectionError = connError ?? runListRead.error;
  const waitingForData =
    !hydrated ||
    (runId ? !hasDagSnapshot && !connError : !runListRead.loaded && !runListRead.error);

  async function retryRead() {
    if (retryingRead) return;
    setRetryingRead(true);
    try {
      await Promise.all([refresh(), refreshExecutionState()]);
    } finally {
      setRetryingRead(false);
    }
  }

  const counts = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const n of visibleDag.nodes) acc[n.status] = (acc[n.status] ?? 0) + 1;
    return acc;
  }, [visibleDag.nodes]);

  const pendingGates = useMemo(
    () => visibleDag.gates.filter((g) => isGatePending(g)),
    [visibleDag.gates],
  );

  const labelsById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const n of visibleDag.nodes) map[n.id] = n.label;
    return map;
  }, [visibleDag.nodes]);

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

  const operationSnapshots = {
    runId,
    dag: visibleDag.runId === runId ? visibleDag : null,
    status: runStatus?.runId === runId ? runStatus : null,
    workers: workerHistoryLoading || workerHistoryError ? null : workerRows,
  };
  const actionableCount = countActionableOperations(operationSnapshots);
  const knownActionableCount = countKnownActionableOperations(operationSnapshots);

  const openOperation = useCallback(
    (target: OperationFocus) => {
      if (target.kind === "gate" && visibleDag.gates.some((g) => g.id === target.id)) {
        selectGate(target.id);
        return;
      }
      if (target.kind === "worker") {
        setDockTab("scheduler");
        setDockOpen(true);
        setOperationFocus(target);
        return;
      }
      switchView("resources");
      setOperationFocus(target);
    },
    [visibleDag.gates, selectGate, switchView],
  );

  useEffect(() => {
    if (!operationFocus) return;
    if (
      focusOperation(dockRef.current, operationFocus) ||
      focusOperation(operationRef.current, operationFocus) ||
      focusOperation(inspectorRef.current, operationFocus)
    ) {
      setOperationFocus(null);
    }
  }, [route.view, dockTab, dockOpen, operationFocus, visibleDag, workerRows, runStatus]);

  const startedTaskIds = useMemo(
    () => new Set(runId ? startedByRun.current.get(runId) ?? [] : []),
    [runId, startedRevision],
  );
  const selectedRunExecuting = Boolean(runStatus?.running && runStatus.runId === runId);
  const selectedRunStarting = startingRunId === runId;
  const leadTaskId = runId ? config.leadTaskByRun[runId] ?? null : null;

  const pendingDispatchIds = useMemo(() => {
    const ids = new Set<string>();
    if (runStatus?.runId === runId) {
      for (const item of runStatus.inbox.pending) {
        if (item.dispatchId) ids.add(item.dispatchId);
      }
    }
    if (activitySnapshot.runId === runId) {
      for (const event of activitySnapshot.events) {
        if (event.actionable && event.dispatchId) ids.add(event.dispatchId);
      }
    }
    return [...ids];
  }, [runId, runStatus, activitySnapshot]);

  const selectedGate = useMemo(
    () => (route.gate ? visibleDag.gates.find((g) => g.id === route.gate) ?? null : null),
    [route.gate, visibleDag.gates],
  );

  // Urgent Attention Strip items (max 3 displayed)
  const attentionItems = useMemo(() => {
    const list: {
      id: string;
      tone: "gate" | "inbox" | "failed";
      text: string;
      cta: string;
      action: () => void;
    }[] = [];

    for (const g of pendingGates) {
      list.push({
        id: `gate:${g.id}`,
        tone: "gate",
        text: g.question || g.id,
        cta: t("ide.gate.pendingTag"),
        action: () => selectGate(g.id),
      });
    }

    if (activitySnapshot.runId === runId) {
      for (const ev of activitySnapshot.events) {
        if (
          ev.actionable?.kind === "reply" ||
          ev.actionable?.kind === "acknowledge_stop"
        ) {
          list.push({
            id: `ev:${ev.id}`,
            tone: "inbox",
            text: `${ev.actor.label}: ${ev.summary}`,
            cta:
              ev.actionable.kind === "reply"
                ? t("ide.attention.replyNow")
                : t("ide.attention.ackStop"),
            action: () => {
              if (ev.taskId) selectTask(ev.taskId);
              else openCoordinatorView("chat");
            },
          });
        }
      }
    }

    if (runStatus?.runId === runId) {
      for (const att of runStatus.attempts) {
        if (att.settledVia === "start_failed" && att.startReceipt?.ok === false) {
          list.push({
            id: `fail:${att.taskId}:${att.startedAt}`,
            tone: "failed",
            text: `${labelsById[att.taskId] ?? att.taskId} · ${t("recovery.startFailed")}`,
            cta: t("ide.attention.ackStop"),
            action: () => selectTask(att.taskId),
          });
        }
      }
    }

    return list.slice(0, 3);
  }, [
    pendingGates,
    activitySnapshot,
    runId,
    runStatus,
    labelsById,
    t,
    selectGate,
    selectTask,
    openCoordinatorView,
  ]);

  // Global keyboard shortcuts (disabled inside editable inputs or open <dialog>)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (paletteOpen || shortcutsOpen || document.querySelector("dialog[open]")) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
      } else if (event.key === "f" || event.key === "F" || event.key === "0") {
        event.preventDefault();
        setCanvasFitNonce((n) => n + 1);
      } else if (event.key === "l" || event.key === "L") {
        event.preventDefault();
        setLayout(layout === "layered-lr" ? "layered-tb" : "layered-lr");
      } else if (event.key === "[" || event.key === "]") {
        const order: ({ kind: "task"; id: string } | { kind: "gate"; id: string })[] = [
          ...visibleDag.nodes.map((n) => ({ kind: "task" as const, id: n.id })),
          ...visibleDag.gates.map((g) => ({ kind: "gate" as const, id: g.id })),
        ];
        if (order.length === 0) return;
        event.preventDefault();
        const curIdx = order.findIndex(
          (item) =>
            (item.kind === "task" && item.id === route.task && !route.gate) ||
            (item.kind === "gate" && item.id === route.gate),
        );
        const delta = event.key === "]" ? 1 : -1;
        const nextIdx =
          curIdx < 0 ? 0 : (curIdx + delta + order.length) % order.length;
        const next = order[nextIdx];
        if (next.kind === "gate") selectGate(next.id);
        else selectTask(next.id);
      } else if (event.key === "Escape" && (route.task || route.gate)) {
        clearSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    paletteOpen,
    shortcutsOpen,
    layout,
    visibleDag.nodes,
    visibleDag.gates,
    route.task,
    route.gate,
    selectGate,
    selectTask,
    clearSelection,
  ]);

  const connDetail =
    connectionError ??
    (execOff
      ? readiness?.reason ?? t("topbar.connDetailViewOnly")
      : readiness
        ? t("topbar.connDetailReady", { version: readiness.version ?? "", cli: readiness.cli })
        : t("topbar.connDetailChecking"));

  const completedCount = counts.completed ?? 0;
  const failedCount = counts.failed ?? 0;
  const stageCount = visibleDag.nodes.length;
  const progressAria = t("topbar.progressAria", { done: completedCount, total: stageCount });
  const progressGroupAria =
    failedCount > 0
      ? progressAria + t("topbar.progressFailedAria", { n: failedCount })
      : progressAria;

  const activeWorkerCount = useMemo(
    () => workerRows.filter((r) => r.dispatchStatus === "dispatched").length,
    [workerRows],
  );

  const coordPhaseLabel =
    runStatus?.runId === runId
      ? t(PHASE_KEY[runStatus.phase] ?? "phase.idle")
      : t("ide.coord.idle");
  const coordHandle = runStatus?.runId === runId ? runStatus.coordinatorHandle : null;

  const themeModeLabel =
    colorScheme.rendered === "dark" ? t("ide.theme.dark") : t("ide.theme.light");
  const themeSourceLabel = colorScheme.pluginManaged
    ? t("ide.theme.host")
    : colorScheme.stored
      ? t("ide.theme.pinned")
      : t("ide.theme.system");
  const themeTooltip = t("ide.theme.tooltip", {
    mode: themeModeLabel,
    source: themeSourceLabel,
  });

  const showChatPanel = !selectedGate;

  return (
    <div className="odag-workbench">
      {/* 1. Top Command & Run Header — Uniform Control Height & Sibling Typography */}
      <header className="odag-topbar">
        <button
          type="button"
          className="odag-btn odag-btn--icon"
          aria-pressed={sidebarOpen}
          aria-label={t("ide.sidebar.toggle")}
          title={t("ide.sidebar.toggle")}
          onClick={() => setSidebarOpen((v) => !v)}
        >
          <PanelLeft size={15} aria-hidden="true" />
        </button>

        <div className="odag-brand">
          <span className="odag-brand__mark" aria-hidden="true">
            <Workflow size={15} />
          </span>
          <div className="odag-brand__text">
            <strong>{t("topbar.title")}</strong>
            {readiness?.workspace && (
              <span title={readiness.workspace}>
                {readiness.workspace.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ||
                  readiness.workspace}
              </span>
            )}
          </div>
        </div>

        <span className="odag-topbar__sep odag-hide-narrow" aria-hidden="true" />

        <div className="odag-topbar__run">
          <RunPicker
            runId={runId}
            onPick={pickRun}
            autoPick={hydrated}
            onReadStateChange={setRunListRead}
          />
        </div>

        {hasDagSnapshot && (
          <span
            className="odag-topbar-chip odag-hide-narrow"
            aria-label={progressGroupAria}
            title={progressGroupAria}
          >
            {stageCount
              ? t("topbar.doneOf", { done: completedCount, total: stageCount })
              : t("topbar.noStages")}
          </span>
        )}

        <div className="odag-hide-narrow" style={{ display: "inline-flex" }}>
          <RunHealthBadge runId={runId} />
        </div>

        <div
          className={`conn odag-hide-narrow ${
            connectionError ? "conn--bad" : execOff || !readiness ? "conn--warn" : "conn--ok"
          }`}
          role="status"
          tabIndex={0}
          title={connDetail}
          aria-label={connDetail}
        >
          {!connectionError && readiness ? <Link2 size={15} /> : <Link2Off size={15} />}
        </div>

        <div
          style={{
            marginInlineStart: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <div className="odag-exec-portal">
            <span ref={setActionHost} style={{ display: "contents" }} />
            <span ref={setLaunchHost} style={{ display: "contents" }} />
          </div>

          <span className="odag-topbar__sep odag-hide-narrow" aria-hidden="true" />

          <button
            type="button"
            className="odag-btn"
            aria-label={t("ide.cmd.openAria")}
            title={`${t("ide.cmd.openAria")} (⌘K)`}
            onClick={() => setPaletteOpen(true)}
          >
            <Search size={14} aria-hidden="true" />
            <span className="odag-hide-narrow">{t("ide.cmd.button")}</span>
            <kbd className="odag-kbd odag-hide-narrow">⌘K</kbd>
          </button>

          <span className="odag-topbar__sep odag-hide-narrow" aria-hidden="true" />

          <LangToggle />

          <button
            type="button"
            className="odag-btn odag-btn--icon"
            aria-label={
              colorScheme.rendered === "dark"
                ? t("ide.theme.switchToLight")
                : t("ide.theme.switchToDark")
            }
            title={themeTooltip}
            onClick={toggleColorScheme}
          >
            {colorScheme.rendered === "dark" ? (
              <Sun size={15} aria-hidden="true" />
            ) : (
              <Moon size={15} aria-hidden="true" />
            )}
          </button>

          <button
            type="button"
            className="odag-btn odag-btn--icon odag-hide-narrow"
            aria-label={t("ide.shortcuts.openAria")}
            title={`${t("ide.shortcuts.openAria")} (?)`}
            onClick={() => setShortcutsOpen(true)}
          >
            <HelpCircle size={15} aria-hidden="true" />
          </button>

          <button
            type="button"
            className="odag-btn odag-btn--icon"
            aria-pressed={inspectorOpen}
            aria-label={t("ide.inspector.toggle")}
            title={t("ide.inspector.toggle")}
            onClick={() => setInspectorOpen((v) => !v)}
          >
            <PanelRight size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* 1b. Dynamic Urgent Attention Strip */}
      {attentionItems.length > 0 && (
        <div className="odag-attention-strip" role="region" aria-label={t("workbench.section.decisions")}>
          {attentionItems.map((item) => (
            <div key={item.id} className="odag-attention-card">
              {item.tone === "gate" ? (
                <Diamond size={13} style={{ color: "var(--st-blocked)", flex: "none" }} aria-hidden="true" />
              ) : item.tone === "failed" ? (
                <AlertCircle size={13} style={{ color: "var(--st-failed)", flex: "none" }} aria-hidden="true" />
              ) : (
                <MessageSquareWarning
                  size={13}
                  style={{ color: "var(--st-dispatched)", flex: "none" }}
                  aria-hidden="true"
                />
              )}
              <span className="odag-attention-card__text" title={item.text}>
                {item.text}
              </span>
              <button
                type="button"
                className="odag-btn odag-btn--primary"
                style={{ blockSize: 24, paddingInline: 8, fontSize: "var(--text-xs)" }}
                onClick={item.action}
              >
                {item.cta}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 2. Four-Zone Workbench Body */}
      <div className="odag-body">
        {/* Zone A: Collapsible Left Fleet & Stage Sidebar */}
        <aside
          className={`odag-sidebar${sidebarOpen ? "" : " odag-sidebar--collapsed"}`}
          aria-label={t("workbench.navigation")}
        >
          <nav className="odag-nav" aria-label={t("workbench.navigation")}>
            <button
              type="button"
              className="odag-nav-item"
              aria-current={route.view === "canvas" ? "page" : undefined}
              onClick={() => switchView("canvas")}
            >
              <Network size={15} aria-hidden="true" />
              <span className="truncate" style={{ flex: 1 }}>
                {t("ide.nav.canvas")}
              </span>
              {hasDagSnapshot && <span className="odag-count">{visibleDag.nodes.length}</span>}
            </button>

            <button
              type="button"
              className="odag-nav-item"
              aria-current={route.view === "board" ? "page" : undefined}
              onClick={() => switchView("board")}
            >
              <Kanban size={15} aria-hidden="true" />
              <span className="truncate" style={{ flex: 1 }}>
                {t("ide.nav.board")}
              </span>
              {(knownActionableCount > 0 || pendingGates.length > 0) && (
                <span className="odag-count">
                  {actionableCount === null
                    ? `${knownActionableCount}+`
                    : Math.max(actionableCount, pendingGates.length)}
                </span>
              )}
            </button>

            <button
              type="button"
              className="odag-nav-item"
              aria-current={route.view === "runs" ? "page" : undefined}
              onClick={() => switchView("runs")}
            >
              <History size={15} aria-hidden="true" />
              <span className="truncate" style={{ flex: 1 }}>
                {t("ide.nav.runs")}
              </span>
            </button>

            <button
              type="button"
              className="odag-nav-item"
              aria-current={route.view === "resources" ? "page" : undefined}
              onClick={() => switchView("resources")}
            >
              <GitBranch size={15} aria-hidden="true" />
              <span className="truncate" style={{ flex: 1 }}>
                {t("ide.nav.resources")}
              </span>
              {Object.keys(config.worktreeLanes).length > 0 && (
                <span className="odag-count">{Object.keys(config.worktreeLanes).length}</span>
              )}
            </button>

            <button
              type="button"
              className="odag-nav-item"
              aria-current={route.view === "settings" ? "page" : undefined}
              onClick={() => switchView("settings")}
            >
              <SlidersHorizontal size={15} aria-hidden="true" />
              <span className="truncate" style={{ flex: 1 }}>
                {t("ide.nav.settings")}
              </span>
            </button>
          </nav>

          {/* Coordinator Status Card */}
          <button
            type="button"
            className="odag-coord-box"
            title={t("ide.coord.hint")}
            onClick={() => openCoordinatorView("scheduler")}
            style={{
              borderColor:
                !route.task && !route.gate && (dockOpen && dockTab === "scheduler")
                  ? "var(--accent)"
                  : undefined,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
              <span className="mono" style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--fg-tertiary)" }}>
                {t("ide.coord.header")}
              </span>
              <span
                className="mono"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: "var(--text-xs)",
                  color: selectedRunExecuting ? "var(--st-completed)" : "var(--fg-secondary)",
                }}
              >
                <span
                  className={`odag-pulse-dot${selectedRunExecuting ? " odag-pulse-dot--live" : ""}`}
                  style={{
                    background: selectedRunExecuting ? "var(--st-completed)" : "var(--fg-tertiary)",
                  }}
                />
                {coordPhaseLabel}
              </span>
            </div>
            <div className="mono truncate" style={{ fontSize: "var(--text-xs)", color: "var(--fg-secondary)" }}>
              {coordHandle ? `${t("ide.coord.bound")} · ${coordHandle}` : t("ide.coord.hint")}
            </div>
          </button>

          {/* Live Fleet & Gates List */}
          <div className="odag-fleet-list odag-scroll">
            {visibleDag.gates.length > 0 && (
              <>
                <div
                  className="mono"
                  style={{
                    padding: "4px 6px 2px",
                    fontSize: "var(--text-xs)",
                    fontWeight: 600,
                    color: "var(--fg-tertiary)",
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <span>{t("ide.fleet.gatesHeader")}</span>
                  <span>{visibleDag.gates.length}</span>
                </div>
                {visibleDag.gates.map((gate) => {
                  const pending = isGatePending(gate);
                  return (
                    <button
                      key={gate.id}
                      type="button"
                      className={`odag-fleet-row${route.gate === gate.id ? " is-selected" : ""}`}
                      onClick={() => selectGate(gate.id)}
                    >
                      <Diamond
                        size={14}
                        style={{
                          color: pending ? "var(--st-blocked)" : "var(--st-completed)",
                          flex: "none",
                        }}
                        aria-hidden="true"
                      />
                      <div style={{ flex: 1, minInlineSize: 0 }}>
                        <div className="truncate" style={{ fontSize: "var(--text-sm)", fontWeight: 500 }}>
                          {gate.question || gate.id}
                        </div>
                        <div className="mono truncate" style={{ fontSize: "var(--text-xs)", color: "var(--fg-tertiary)" }}>
                          {gate.id}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </>
            )}

            <div
              className="mono"
              style={{
                padding: "6px 6px 2px",
                fontSize: "var(--text-xs)",
                fontWeight: 600,
                color: "var(--fg-tertiary)",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>{t("ide.fleet.header")}</span>
              <span>{visibleDag.nodes.length}</span>
            </div>

            {visibleDag.nodes.map((node) => {
              const wm = workerMetaByTask.get(node.id);
              const harness = wm?.harness ?? effectiveHarness(node.id);
              const ws = wm?.workspace ?? config.laneByTask[node.id] ?? "current";
              const isSelected = route.task === node.id && !route.gate;
              return (
                <button
                  key={node.id}
                  type="button"
                  className={`odag-fleet-row${isSelected ? " is-selected" : ""}`}
                  onClick={() => selectTask(node.id)}
                >
                  <HarnessAvatar harness={harness} size={20} />
                  <div style={{ flex: 1, minInlineSize: 0 }}>
                    <div className="truncate" style={{ fontSize: "var(--text-sm)", fontWeight: 500 }}>
                      {node.label}
                    </div>
                    <div className="mono truncate" style={{ fontSize: "var(--text-xs)", color: "var(--fg-tertiary)" }}>
                      {harness} · {ws}
                    </div>
                  </div>
                  <StatusGlyph status={node.status} size={13} />
                </button>
              );
            })}
          </div>
        </aside>

        {/* Zone B: Center Stage + Bottom Activity Dock */}
        <main className="odag-center">
          {hasDagSnapshot && connError && (
            <div
              role="status"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "6px 12px",
                background: "var(--st-dispatched-bg)",
                color: "var(--st-dispatched)",
                borderBlockEnd: "1px solid var(--border-hairline)",
                fontSize: "var(--text-sm)",
              }}
            >
              <span>
                {t("read.staleTitle")} · {t("read.staleBody")}
              </span>
              <button
                type="button"
                className="odag-btn"
                style={{ blockSize: 24 }}
                disabled={retryingRead}
                onClick={() => void retryRead()}
              >
                {t(retryingRead ? "read.retrying" : "read.retry")}
              </button>
            </div>
          )}

          {/* Stage Subbar for Canvas & Board */}
          {hasDagSnapshot && (route.view === "canvas" || route.view === "board") && (
            <div className="odag-subbar">
              <div
                role="group"
                aria-label={t("toolbar.statusLegendAria")}
                style={{ display: "inline-flex", alignItems: "center", gap: 3, flexWrap: "wrap" }}
              >
                {FILTER_CHIPS.map((chip) => {
                  const chipCount =
                    chip === "all"
                      ? visibleDag.nodes.length
                      : chip === "blocked"
                        ? (counts.blocked ?? 0) + pendingGates.length
                        : counts[chip] ?? 0;
                  return (
                    <button
                      key={chip}
                      type="button"
                      className="odag-filter-chip"
                      aria-pressed={statusFilter === chip}
                      onClick={() => setStatusFilter(chip)}
                    >
                      {chip !== "all" && <StatusGlyph status={chip} size={11} />}
                      <span>{chip === "all" ? t("ide.subbar.all") : t(`status.${chip}`)}</span>
                      <span className="odag-count">{chipCount}</span>
                    </button>
                  );
                })}
              </div>

              {/* Inline Concurrency Cap */}
              <label
                className="mono odag-hide-narrow"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: "var(--text-xs)",
                  color: "var(--fg-secondary)",
                  paddingInline: 8,
                  borderInlineStart: "1px solid var(--border-hairline)",
                }}
              >
                <Cpu size={13} aria-hidden="true" />
                <span>{t("ide.subbar.concurrency")}</span>
                <input
                  type="range"
                  min={1}
                  max={16}
                  value={config.maxConcurrency}
                  disabled={selectedRunExecuting || selectedRunStarting || execOff}
                  onChange={(e) => setMaxConcurrency(Number(e.target.value))}
                  style={{ inlineSize: 68 }}
                />
                <span>
                  {activeWorkerCount}/{config.maxConcurrency}
                </span>
              </label>

              {/* Search Filter */}
              <div className="odag-search-box">
                <Search size={12} style={{ color: "var(--fg-tertiary)" }} aria-hidden="true" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("ide.subbar.searchPlaceholder")}
                  aria-label={t("ide.subbar.searchPlaceholder")}
                />
                {searchQuery && (
                  <button
                    type="button"
                    aria-label={t("ide.subbar.clearSearch")}
                    onClick={() => setSearchQuery("")}
                    style={{ border: 0, background: "transparent", padding: 0, color: "var(--fg-tertiary)" }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Stage Primary Area */}
          <div style={{ flex: 1, minBlockSize: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {/* Empty / Loading / Error Read States when no DAG snapshot */}
            {!hasDagSnapshot && route.view !== "runs" && route.view !== "settings" && (
              <div
                className="odag-scroll"
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 24,
                }}
              >
                {waitingForData || readError ? (
                  <section className="dag-read-state" aria-labelledby="dag-read-title">
                    <h2 id="dag-read-title">
                      {readError
                        ? t(runId ? "read.tasksFailed" : "read.runsFailed")
                        : t(runId ? "read.loadingTasks" : "read.loadingRuns")}
                    </h2>
                    <p role="status">{t(readError ? "read.failedBody" : "read.loadingBody")}</p>
                    {readError && (
                      <>
                        <div className="dag-read-actions">
                          <button
                            className="odag-btn odag-btn--primary"
                            type="button"
                            onClick={() => window.location.reload()}
                          >
                            {t("read.reload")}
                          </button>
                          {runId && (
                            <button
                              className="odag-btn"
                              type="button"
                              onClick={() => {
                                pickRun("");
                                setDagFailure(null);
                              }}
                            >
                              {t("read.switchRun")}
                            </button>
                          )}
                        </div>
                        <details className="dag-read-details">
                          <summary>{t("read.technicalDetails")}</summary>
                          <pre>{readError}</pre>
                        </details>
                      </>
                    )}
                  </section>
                ) : (
                  <div className="empty-run" style={{ maxInlineSize: 480, textAlign: "center" }}>
                    <p className="empty-run__title">{t("empty.pickRunTitle")}</p>
                    <p className="empty-run__body">
                      {t("empty.pickRunBody")} <code>orca orchestration run-create</code>{" "}
                      {t("empty.pickRunBodyTail")}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* View 1: 2D DAG Canvas (retained in DOM once mounted for this Run) */}
            {hasDagSnapshot && (graphMountedRun === runId || route.view === "canvas") && (
              <div
                hidden={route.view !== "canvas"}
                style={{
                  flex: 1,
                  minBlockSize: 0,
                  display: route.view === "canvas" ? "flex" : "none",
                  flexDirection: "column",
                }}
              >
                <Suspense
                  fallback={
                    <p role="status" style={{ padding: 20 }}>
                      {t("workbench.loadingGraph")}
                    </p>
                  }
                >
                  <GraphMounted onMount={markGraphMounted}>
                    <DagView
                      dag={visibleDag}
                      leadTaskId={leadTaskId}
                      selectedId={route.task}
                      selectedGateId={route.gate}
                      onSelect={selectTask}
                      onSelectGate={selectGate}
                      layout={layout}
                      onLayoutChange={setLayout}
                      reorgNonce={reorgNonce}
                      onRelayout={() => setReorgNonce((n) => n + 1)}
                      fitNonce={canvasFitNonce}
                      showHierarchy={showHierarchy}
                      onToggleHierarchy={() => setShowHierarchy((v) => !v)}
                      statusFilter={statusFilter}
                      searchQuery={searchQuery}
                      workerRows={workerRows}
                      attempts={runStatus?.runId === runId ? runStatus.attempts : EMPTY_ATTEMPTS}
                      active={route.view === "canvas"}
                      fleetFresh={fleetFresh}
                      pendingDispatchIds={pendingDispatchIds}
                    />
                  </GraphMounted>
                </Suspense>
              </div>
            )}

            {/* View 2: 4-Lane Status Board */}
            {hasDagSnapshot && route.view === "board" && (
              <BoardView
                dag={visibleDag}
                runId={runId}
                workerRows={workerRows}
                selectedTaskId={route.task}
                selectedGateId={route.gate}
                statusFilter={statusFilter}
                searchQuery={searchQuery}
                execDisabled={execOff}
                execDisabledReason={readiness?.reason}
                onSelectTask={(id) => selectTask(id)}
                onSelectGate={selectGate}
                onResolved={refresh}
              />
            )}

            {/* View 3: Paginated Run History & Health Explorer */}
            {route.view === "runs" && (
              <RunsView
                runId={runId}
                workerRows={workerRows}
                pendingGatesCount={pendingGates.length}
                pendingInboxCount={activityPending}
                onPickRun={(nextId) => {
                  pickRun(nextId);
                  switchView("canvas");
                }}
              />
            )}

            {/* View 4: Workspaces, Cleanup & Recovery */}
            {hasDagSnapshot && route.view === "resources" && (
              <div
                ref={operationRef}
                className="odag-scroll"
                style={{ flex: 1, minBlockSize: 0, overflowY: "auto", padding: 16 }}
              >
                <div
                  style={{
                    maxInlineSize: 1080,
                    marginInline: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: 16,
                  }}
                >
                  <OperationsAttention {...operationSnapshots} onFocus={openOperation} />
                  <LanesPanel
                    runId={runId}
                    active={route.view === "resources"}
                    disabled={execOff}
                    disabledReason={readiness?.reason}
                  />
                  <CleanupPanel runId={runId} disabled={execOff} />
                  <RecoveryPanel
                    runId={runId}
                    status={runStatus}
                    taskIds={visibleDag.nodes.map((n) => n.id)}
                    blockedTaskIds={visibleDag.nodes
                      .filter((n) => n.status === "blocked")
                      .map((n) => n.id)}
                    onRunStarting={onRunStarting}
                    onRunStartFinished={onRunStartFinished}
                    onRetried={() => {
                      void refresh();
                      void refreshExecutionState();
                    }}
                    disabled={execOff}
                    disabledReason={readiness?.reason}
                  />
                  <GatePanel
                    gates={visibleDag.gates}
                    runId={runId}
                    onResolved={refresh}
                    disabled={execOff}
                    disabledReason={readiness?.reason}
                  />
                </div>
              </div>
            )}

            {/* View 5: Execution & Capabilities (Always mounted so ExecControls portals stay live!) */}
            <div
              hidden={route.view !== "settings"}
              className="odag-scroll"
              style={{
                flex: 1,
                minBlockSize: 0,
                overflowY: "auto",
                padding: 16,
                display: route.view === "settings" ? "block" : "none",
              }}
            >
              <div
                style={{
                  maxInlineSize: 1040,
                  marginInline: "auto",
                  display: "flex",
                  flexDirection: "column",
                  gap: 16,
                }}
              >
                <ExecControls
                  actionHost={actionHost}
                  launchHost={launchHost}
                  runId={runId}
                  labelsById={labelsById}
                  taskIds={visibleDag.nodes.map((n) => n.id)}
                  edges={visibleDag.edges}
                  readyCount={counts.ready ?? 0}
                  startingRunId={startingRunId}
                  status={runStatus}
                  workerHistoryLoading={workerHistoryLoading}
                  workerHistoryError={workerHistoryError}
                  onRunStarting={onRunStarting}
                  onRunStartFinished={onRunStartFinished}
                  onRunStopped={onRunStopped}
                />
                <CapabilityPanel />
              </div>
            </div>
          </div>

          {/* Zone C: Bottom Collapsible & Resizable Scheduler / Activity / Output / Audit Dock */}
          <section
            ref={dockRef}
            className="odag-dock"
            aria-label={t("ide.dock.activity")}
            style={{ blockSize: dockOpen ? `${dockHeight}px` : "32px" }}
          >
            {dockOpen && (
              <div
                role="separator"
                aria-orientation="horizontal"
                onPointerDown={beginDockResize}
                onPointerMove={moveDockResize}
                onPointerUp={endDockResize}
                onPointerCancel={endDockResize}
                style={{
                  position: "absolute",
                  insetInline: 0,
                  insetBlockStart: -3,
                  blockSize: 6,
                  cursor: "row-resize",
                  zIndex: 12,
                }}
              />
            )}

            <div className="odag-dock__bar">
              <div className="odag-tablist" role="tablist" aria-label={t("ide.dock.activity")}>
                <button
                  type="button"
                  role="tab"
                  className="odag-tab"
                  aria-selected={dockOpen && dockTab === "scheduler"}
                  onClick={() => {
                    setDockTab("scheduler");
                    setDockOpen(true);
                  }}
                >
                  <span>{t("ide.inspector.overviewTab")}</span>
                  {knownActionableCount > 0 && (
                    <span className="odag-count">
                      {actionableCount === null ? `${knownActionableCount}+` : actionableCount}
                    </span>
                  )}
                </button>

                <button
                  type="button"
                  role="tab"
                  className="odag-tab"
                  aria-selected={dockOpen && dockTab === "activity"}
                  onClick={() => {
                    setDockTab("activity");
                    setDockOpen(true);
                  }}
                >
                  <span>{t("ide.dock.activity")}</span>
                  {activityPending > 0 && <span className="odag-count">{activityPending}</span>}
                </button>

                <button
                  type="button"
                  role="tab"
                  className="odag-tab"
                  aria-selected={dockOpen && dockTab === "output"}
                  onClick={() => {
                    setDockTab("output");
                    setDockOpen(true);
                  }}
                >
                  <span>{t("ide.dock.output")}</span>
                  {workerRows.length > 0 && <span className="odag-count">{workerRows.length}</span>}
                </button>

                <button
                  type="button"
                  role="tab"
                  className="odag-tab"
                  aria-selected={dockOpen && dockTab === "audit"}
                  onClick={() => {
                    setDockTab("audit");
                    setDockOpen(true);
                  }}
                >
                  <span>{t("ide.dock.audit")}</span>
                </button>
              </div>

              <button
                type="button"
                className="odag-btn odag-btn--ghost odag-btn--icon"
                style={{ minBlockSize: 24, inlineSize: 24, minInlineSize: 24 }}
                aria-label={dockOpen ? t("ide.dock.collapse") : t("ide.dock.expand")}
                title={dockOpen ? t("ide.dock.collapse") : t("ide.dock.expand")}
                onClick={() => setDockOpen((v) => !v)}
              >
                {dockOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
              </button>
            </div>

            {/* Single shared ActivityPanel stays mounted so its live SSE stream never drops */}
            <div
              className="odag-dock__content"
              style={{ display: dockOpen ? "flex" : "none" }}
            >
              {dockOpen && dockTab === "scheduler" && (
                <div className="odag-dock-pane">
                  <SchedulerDockView
                    runId={runId}
                    dag={visibleDag}
                    runStatus={runStatus}
                    workerRows={workerRows}
                    workerHistoryLoading={workerHistoryLoading}
                    workerHistoryError={workerHistoryError}
                    labelsById={labelsById}
                    focusWorkerId={operationFocus?.kind === "worker" ? operationFocus.id : null}
                    knownActionableCount={knownActionableCount}
                    actionableCount={actionableCount}
                    execOff={execOff}
                    disabledReason={readiness?.reason}
                    onSelectTask={(id) => selectTask(id)}
                    onFocusOperation={openOperation}
                  />
                </div>
              )}

              <div className="odag-dock-pane" hidden={!dockOpen || dockTab !== "activity"}>
                <ActivityPanel
                  runId={runId}
                  onSelectTask={(id) => selectTask(id)}
                  onResolved={refresh}
                  onPendingCount={setActivityPending}
                  onSnapshot={setActivitySnapshot}
                  disabled={execOff}
                  disabledReason={readiness?.reason}
                />
              </div>

              {dockOpen && dockTab === "output" && (
                <div className="odag-dock-pane">
                  <WorkerOutputDockView
                    runId={runId}
                    workerRows={workerRows}
                    labelsById={labelsById}
                    selectedDispatchId={selectedOutputDispatchId}
                    onSelectDispatchId={setSelectedOutputDispatchId}
                  />
                </div>
              )}

              <div className="odag-dock-pane" hidden={!dockOpen || dockTab !== "audit"}>
                <RequestAuditPanel
                  labelsById={labelsById}
                  runId={runId}
                  active={dockOpen && dockTab === "audit"}
                />
              </div>
            </div>
          </section>
        </main>

        {/* Zone D: Right Resizable Contextual Inspector (Gate Inspector or Task / Run Group Chat) */}
        <aside
          id="odag-inspector"
          ref={inspectorRef}
          className={`odag-inspector odag-inspector--compact-chat${
            inspectorOpen ? "" : " odag-inspector--closed"
          }`}
          style={{ width: inspectorWidth === null ? undefined : `${inspectorWidth}px` }}
          aria-label={t("ide.inspector.toggle")}
          aria-hidden={!inspectorOpen}
        >
          <div
            className="odag-inspector__resize"
            role="separator"
            aria-label={t("toolbar.resizeCommunicationAria")}
            aria-controls="odag-inspector"
            aria-orientation="vertical"
            aria-valuemin={INSPECTOR_MIN_WIDTH}
            aria-valuemax={inspectorSize.max}
            aria-valuenow={inspectorSize.width || undefined}
            tabIndex={0}
            title={t("toolbar.resizeCommunicationTitle")}
            onPointerDown={beginInspectorResize}
            onPointerMove={moveInspectorResize}
            onPointerUp={endInspectorResize}
            onPointerCancel={endInspectorResize}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              const current =
                inspectorRef.current?.getBoundingClientRect().width ?? INSPECTOR_MIN_WIDTH;
              const requested =
                event.key === "Home"
                  ? INSPECTOR_MIN_WIDTH
                  : event.key === "End"
                    ? inspectorSize.max
                    : current + (event.key === "ArrowLeft" ? 32 : -32);
              setInspectorWidth(clampInspectorWidth(requested));
              event.preventDefault();
            }}
          />

          {/* Mode 1: Dedicated Gate Inspector */}
          {selectedGate && (
            <GateInspector
              gate={selectedGate}
              dag={visibleDag}
              runId={runId}
              workerRows={workerRows}
              disabled={execOff}
              disabledReason={readiness?.reason}
              onSelectTask={(id) => selectTask(id)}
              onClose={clearSelection}
              onResolved={refresh}
            />
          )}

          {/* Mode 2: ChatPanel for Task Private Threads & Run Group Chat */}
          <div
            hidden={!showChatPanel}
            style={{
              flex: 1,
              minBlockSize: 0,
              display: showChatPanel ? "flex" : "none",
              flexDirection: "column",
            }}
          >
            <ChatPanel
              active={inspectorOpen && showChatPanel}
              runId={runId}
              snapshot={activitySnapshot}
              tasks={visibleDag.nodes}
              taskSelection={taskSelection}
              groupSelection={groupSelection}
              leadTaskId={leadTaskId}
              onSelectTask={selectTask}
              onSelectWorker={(id) => openOperation({ kind: "worker", id })}
              onResolved={refresh}
              onCloseInspector={route.task ? clearSelection : () => setInspectorOpen(false)}
              coordinatorActive={selectedRunExecuting}
              disabled={execOff}
              disabledReason={readiness?.reason}
              renderTask={(node) => (
                <NodePanel
                  key={`${runId}:${node.id}`}
                  node={node}
                  runId={runId}
                  isLead={node.id === leadTaskId}
                  parentLabel={node.parentId ? labelsById[node.parentId] ?? node.parentId : null}
                  childLabels={visibleDag.nodes
                    .filter((child) => child.parentId === node.id)
                    .map((child) => child.label)}
                  readiness={visibleDag.readiness[node.id] ?? null}
                  edges={visibleDag.edges}
                  labelsById={labelsById}
                  onLeadChange={(taskId) => setLeadTask(runId, taskId)}
                  permanentlyLocked={startedTaskIds.has(node.id)}
                  temporarilyLocked={selectedRunExecuting}
                  coordinatorStarting={selectedRunStarting}
                  workerHistoryLoading={workerHistoryLoading}
                  workerHistoryError={workerHistoryError}
                  failedStart={Boolean(
                    runStatus?.runId === runId &&
                      runStatus.attempts.some(
                        (attempt) =>
                          attempt.taskId === node.id &&
                          attempt.settledVia === "start_failed" &&
                          attempt.startReceipt?.ok === false,
                      ),
                  )}
                  hasWorkerHistory={workerRows.some((row) => row.taskId === node.id)}
                  workerRows={workerRows}
                  onRefresh={refresh}
                  onOpenOperations={openOperation}
                />
              )}
              renderDispatch={(node) => {
                const taskWorkers = workerRows.filter((row) => row.taskId === node.id);
                const latestDispatch = taskWorkers[0]?.dispatchId ?? node.dispatchId;
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {latestDispatch && (
                      <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <button
                          type="button"
                          className="odag-btn"
                          onClick={() => {
                            setSelectedOutputDispatchId(latestDispatch);
                            setDockTab("output");
                            setDockOpen(true);
                          }}
                        >
                          <TerminalSquare size={13} aria-hidden="true" />
                          {t("ide.inspector.openOutput")}
                        </button>
                      </div>
                    )}
                    {taskWorkers.length === 0 && !workerHistoryError ? (
                      <p style={{ color: "var(--fg-secondary)", fontSize: "var(--text-base)" }}>
                        {t("operations.noWorkers")}
                      </p>
                    ) : (
                      <WorkerPanel
                        key={`${runId}:${node.id}`}
                        labelsById={labelsById}
                        focusId={operationFocus?.kind === "worker" ? operationFocus.id : null}
                        runId={runId}
                        rows={taskWorkers}
                        rowsError={workerHistoryError}
                        status={runStatus}
                        disabled={execOff}
                        disabledReason={readiness?.reason}
                      />
                    )}
                  </div>
                );
              }}
            />
          </div>
        </aside>
      </div>

      {/* Native <dialog> Modals */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        tasks={visibleDag.nodes}
        gates={visibleDag.gates}
        onSelectTask={(id) => selectTask(id)}
        onSelectGate={selectGate}
        onSwitchView={switchView}
        onRelayout={() => setReorgNonce((n) => n + 1)}
        onFitView={() => setCanvasFitNonce((n) => n + 1)}
        onToggleLayout={() =>
          setLayout(layout === "layered-lr" ? "layered-tb" : "layered-lr")
        }
        onToggleDock={() => setDockOpen((v) => !v)}
        onToggleTheme={toggleColorScheme}
        onToggleLang={() => setLang(lang === "en" ? "zh" : "en")}
      />

      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
