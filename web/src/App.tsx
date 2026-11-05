import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { Popover } from "radix-ui";
import { ExecControls } from "./components/ExecControls";
import { ActivityPanel } from "./components/ActivityPanel";
import { ChatPanel } from "./components/ChatPanel";
import { GatePanel } from "./components/GatePanel";
import { NodePanel } from "./components/NodePanel";
import { RecoveryPanel } from "./components/RecoveryPanel";
import { RequestAuditPanel } from "./components/RequestAuditPanel";
import { SchedulerPanel } from "./components/SchedulerPanel";
import { WorkerPanel } from "./components/WorkerPanel";
import { CleanupPanel } from "./components/CleanupPanel";
import { RunPicker, type RunListReadState } from "./components/RunPicker";
import { RunHealthBadge } from "./components/RunHealthBadge";
import { LangToggle } from "./components/LangToggle";
import { useT } from "./i18n";
import { CapabilityPanel } from "./components/CapabilityPanel";
import { fetchDag, fetchRunStatus, fetchWorkers } from "./api";
import { initConfig, setLayout, setLeadTask, setRunId, useConfig, useReadiness } from "./harness";
import { usePageVisible } from "./visibility";
import { LanesPanel } from "./components/LanesPanel";
import { OperationsAttention, countActionableOperations, countKnownActionableOperations } from "./components/OperationsAttention";
import { focusOperation, type OperationFocus } from "./operation-navigation";
import "./operations-nav.css";
import "./workbench.css";
import "./read-state.css";
import "./tooltip.css";
import {
  ActivityIcon,
  CpuIcon,
  GitForkIcon,
  GridIcon,
  LayersIcon,
  NetworkIcon,
  RefreshIcon,
  ServerIcon,
  ShieldIcon,
  SlidersIcon,
  ChatBubbleIcon,
  HomeIcon,
  LinkIcon,
  LinkOffIcon,
} from "./components/Icons";
import { TaskList } from "./components/TaskList";
import {
  LAYOUTS,
  STATUS_META,
  type ActivitySnapshot,
  type DagResponse,
  type LayoutKind,
  type RunAttempt,
  type RunStatus,
  type TaskStatus,
  type WorkerRowView,
} from "./types";

const DagView = lazy(() => import("./components/DagView").then((module) => ({ default: module.DagView })));

function GraphMounted({ onMount, children }: { onMount: () => void; children: ReactNode }) {
  useEffect(() => { onMount(); }, [onMount]);
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
const SECTIONS = ["overview", "tasks", "decisions", "executions", "activity", "resources", "settings"] as const;
type Section = typeof SECTIONS[number];
type WorkbenchPage = Section | "home" | "chat";
const DOCK_PRIMARY: Partial<Record<WorkbenchPage, true>> = { chat: true, tasks: true, decisions: true, executions: true };

const SECTION_ICONS: Record<Section, ReactNode> = {
  overview: <GridIcon size={16} />,
  tasks: <LayersIcon size={16} />,
  decisions: <ShieldIcon size={16} />,
  executions: <CpuIcon size={16} />,
  activity: <ActivityIcon size={16} />,
  resources: <ServerIcon size={16} />,
  settings: <SlidersIcon size={16} />,
};

function readRoute(): { section: WorkbenchPage; task: string | null } {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const requested = params.get("section");
  const section = requested === "home" || requested === "chat"
    ? requested
    : SECTIONS.find((item) => item === requested) ?? (params.has("task") ? "tasks" : "home");
  return { section, task: params.get("task") };
}

function writeRoute(section: WorkbenchPage, task: string | null) {
  const params = new URLSearchParams({ section });
  if (task) params.set("task", task);
  const hash = `#${params}`;
  if (window.location.hash !== hash) {
    window.history.pushState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
  }
}
const COMMUNICATION_MIN_WIDTH = 380;
const COMMUNICATION_MAX_WIDTH = 820;
const CANVAS_MIN_WIDTH = 320;

/** Structural equality via JSON — the poll guards' only concern is "would
 *  rendering this change anything the user can see", and it always answers. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}


export default function App() {
  const [dag, setDag] = useState<DagResponse>(EMPTY);
  const [route, setRoute] = useState(readRoute);
  // One route owns the visible application and inspector. Home and chat are
  // real destinations too, so refresh/back cannot silently reveal an old app.
  const selectedId = route.task;
  const stageOpen = Boolean(route.task);
  const communicationOpen = route.section === "chat" && !stageOpen;
  const operationHome = route.section === "home" && !stageOpen;
  const [mobilePane, setMobilePane] = useState<"canvas" | "operations">(() => window.location.hash ? "operations" : "canvas");
  const [communicationWidth, setCommunicationWidth] = useState<number | null>(null);
  const [communicationResizing, setCommunicationResizing] = useState(false);
  const [operationsSize, setOperationsSize] = useState({ width: 0, max: COMMUNICATION_MAX_WIDTH });
  const [operationFocus, setOperationFocus] = useState<OperationFocus | null>(null);
  const [actionHost, setActionHost] = useState<HTMLElement | null>(null);
  const [launchHost, setLaunchHost] = useState<HTMLElement | null>(null);
  const operationRef = useRef<HTMLElement | null>(null);
  const scrollByView = useRef<Record<string, number>>({});
  // Parent/child ownership links (Phase 4) are hideable: on dense graphs they
  // can reduce readability, and they carry no scheduling semantics to lose.
  const [showHierarchy, setShowHierarchy] = useState(true);
  const [activityPending, setActivityPending] = useState(0);
  const [activitySnapshot, setActivitySnapshot] = useState<ActivitySnapshot>(EMPTY_ACTIVITY);
  const [dagFailure, setDagFailure] = useState<{ runId: string; message: string } | null>(null);
  const config = useConfig();
  // The View menu's status legend and layout buttons are translated copy, so
  // this component subscribes to the UI language (useT) like every other
  // translated surface; the palette itself stays in STATUS_META.
  const t = useT();
  const runId = config.runId;
  const viewKey = `${runId}:${stageOpen ? `task:${selectedId}` : route.section}`;
  useLayoutEffect(() => {
    if (operationRef.current) operationRef.current.scrollTop = scrollByView.current[viewKey] ?? 0;
  }, [viewKey]);
  const connError = dagFailure?.runId === runId ? dagFailure.message : null;
  // Execution gate (Phase 2): when the server's readiness probe says this
  // Orca runtime can't execute (missing, or 1.4.160–1.4.204 view-only), the
  // mutation controls disable themselves with the reason. Reads stay live.
  const readiness = useReadiness();
  const execOff = readiness !== null && !readiness.executionEnabled;
  const layout: LayoutKind = config.layout || "layered-lr";
  // bump to force a fresh auto-layout (discarding manual drags)
  const [reorgNonce, setReorgNonce] = useState(0);
  const canvasFitNonce = 0;
  const [graphMountedRun, setGraphMountedRun] = useState<string | null>(null);
  const markGraphMounted = useCallback(() => setGraphMountedRun(runId), [runId]);
  const graphActive = mobilePane === "canvas" || !window.matchMedia("(max-width: 900px)").matches;
  const [retryingRead, setRetryingRead] = useState(false);
  const stageReturnFocus = useRef<HTMLElement | null>(null);
  const communicationRef = useRef<HTMLDivElement | null>(null);
  const communicationResize = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const timer = useRef<number | null>(null);
  const executionTimer = useRef<number | null>(null);
  // Worker accounting is durable, but any individual poll can briefly fail or
  // return an incomplete response while Orca reconnects. Keep evidence
  // monotonic per Run for this page session: once a Task has a Dispatch, no
  // later empty/error response may make its launch controls editable again.
  const startedByRun = useRef<Map<string, Set<string>>>(new Map());
  const [startedRevision, setStartedRevision] = useState(0);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  // Starting a Run has a deliberate blind window: the server sets its
  // coordinator to binding before it can report a bound runId. ExecControls
  // raises this synchronously before POST /api/run so launch controls freeze
  // during binding and recovery instead of waiting for the next poll.
  const [startingRunId, setStartingRunId] = useState<string | null>(null);
  const [workerHistoryLoading, setWorkerHistoryLoading] = useState(false);
  const [workerHistoryError, setWorkerHistoryError] = useState<string | null>(null);
  // Durable fleet rows for the selected Run (Phase 2). Kept monotonic within
  // this page session: a transient fleet-read failure keeps the last good
  // rows on screen next to the error instead of blanking the operations view.
  const [workerRows, setWorkerRows] = useState<WorkerRowView[]>([]);
  const [fleetRead, setFleetRead] = useState<{ runId: string; at: number } | null>(null);
  const [fleetExpired, setFleetExpired] = useState(true);
  useEffect(() => {
    if (!fleetRead || fleetRead.runId !== runId) {
      setFleetExpired(true);
      return;
    }
    setFleetExpired(false);
    const timeout = window.setTimeout(() => setFleetExpired(true), Math.max(0, 10000 - (Date.now() - fleetRead.at)));
    return () => window.clearTimeout(timeout);
  }, [fleetRead, runId]);
  const fleetFresh = Boolean(fleetRead?.runId === runId && !fleetExpired && !workerHistoryLoading && !workerHistoryError && Date.now() - fleetRead.at <= 10000);
  const selectedRunRef = useRef(runId);
  selectedRunRef.current = runId;
  const dagRequestSeq = useRef(0);
  const dagAppliedSeq = useRef(0);
  const executionPollSeq = useRef(0);
  const workersAppliedSeq = useRef(0);
  const statusAppliedSeq = useRef(0);
  // hydrate harness/concurrency/layout/run config from the server-side file
  // once; RunPicker must not auto-pick a Run until this has settled, or its
  // fallback would overwrite the stored choice with "newest"
  const [hydrated, setHydrated] = useState(false);
  const [runListRead, setRunListRead] = useState<RunListReadState>({ loaded: false, error: null });
  useEffect(() => {
    initConfig()
      .catch(() => {
        /* defaults + localStorage mirror still apply */
      })
      .finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    const restore = () => {
      const next = readRoute();
      setRoute(next);
      setOperationFocus(null);
      setMobilePane(window.location.hash ? "operations" : "canvas");
    };
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
    };
  }, []);

  function navigate(section: WorkbenchPage, focusHeading = true) {
    writeRoute(section, null);
    setRoute({ section, task: null });
    setOperationFocus(null);
    setMobilePane("operations");
    if (focusHeading) window.requestAnimationFrame(() => document.getElementById("workbench-page-title")?.focus());
  }


  function pickLayout(kind: LayoutKind) {
    setLayout(kind);
  }


  function openCommunication() {
    navigate("chat");
  }


  function clampCommunicationWidth(width: number): number {
    const workspaceWidth = communicationRef.current?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    const narrow = window.matchMedia("(max-width: 900px)").matches;
    const reserve = narrow ? 0 : CANVAS_MIN_WIDTH;
    const upper = Math.max(COMMUNICATION_MIN_WIDTH, Math.min(COMMUNICATION_MAX_WIDTH, workspaceWidth - reserve));
    const lower = Math.min(COMMUNICATION_MIN_WIDTH, upper);
    return Math.round(Math.min(Math.max(width, lower), upper));
  }

  useLayoutEffect(() => {
    const panel = communicationRef.current;
    const workspace = panel?.parentElement;
    if (!panel || !workspace) return;
    // Measure rendered geometry, not the last requested drag width: viewport
    // constraints and the default percentage also change the separator value.
    const observer = new ResizeObserver(() => {
      const width = Math.round(panel.getBoundingClientRect().width);
      const max = Math.max(COMMUNICATION_MIN_WIDTH, Math.min(COMMUNICATION_MAX_WIDTH, Math.floor(workspace.getBoundingClientRect().width - CANVAS_MIN_WIDTH)));
      setOperationsSize((previous) => previous.width === width && previous.max === max ? previous : { width, max });
    });
    observer.observe(panel);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  function beginCommunicationResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!communicationRef.current) return;
    communicationResize.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: communicationRef.current.getBoundingClientRect().width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setCommunicationResizing(true);
    event.preventDefault();
  }

  function moveCommunicationResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = communicationResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setCommunicationWidth(clampCommunicationWidth(resize.startWidth + resize.startX - event.clientX));
  }

  function endCommunicationResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = communicationResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    communicationResize.current = null;
    setCommunicationResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const refresh = useCallback(async () => {
    const requestedRun = runId;
    const seq = ++dagRequestSeq.current;
    if (!requestedRun) {
      setDag(EMPTY);
      return;
    }
    try {
      const next = await fetchDag(requestedRun);
      // A Run switch does not cancel an already-issued request. Also reject
      // older same-Run polls and any malformed response whose scope disagrees
      // with the request; neither may paint Run A over the selected Run B.
      if (
        selectedRunRef.current !== requestedRun ||
        seq < dagAppliedSeq.current ||
        next.runId !== requestedRun
      ) {
        return;
      }
      dagAppliedSeq.current = seq;
      // Preserve object identity on unchanged polls.
      setDag((prev) => (sameJson(prev, next) ? prev : next));
      setDagFailure(null);
    } catch (e) {
      if (selectedRunRef.current === requestedRun && seq >= dagAppliedSeq.current) {
        const msg = String((e as Error).message ?? e);
        setDagFailure({ runId: requestedRun, message: msg });
        const code = (e as { code?: string })?.code;
        const status = (e as { status?: number })?.status;
        const isMissing = code === "run_not_found" || status === 404 || status === 409 || /not_found|not found/i.test(msg);
        if (isMissing && hydrated) {
          pickRun("");
        }
      }
    }
  }, [runId]);

  // Pause polling while the page is hidden and refresh when it returns.
  const pageVisible = usePageVisible();

  useEffect(() => {
    if (!pageVisible) return;
    refresh();
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

    // A Run switch does not cancel an already-issued fetch. Ignore its result
    // rather than letting Run A's history or process status leak into Run B.
    if (selectedRunRef.current !== requestedRun) return;

    if (seq >= workersAppliedSeq.current) {
      workersAppliedSeq.current = seq;
      setWorkerHistoryLoading(false);
      if (workersResult.status === "fulfilled") {
        setFleetRead(workersResult.value.partialHostErrors.length ? null : { runId: requestedRun, at: Date.now() });
        const known = startedByRun.current.get(requestedRun) ?? new Set<string>();
        let changed = false;
        for (const worker of workersResult.value.workers) {
          if (!worker.taskId || known.has(worker.taskId)) continue;
          known.add(worker.taskId);
          changed = true;
        }
        startedByRun.current.set(requestedRun, known);
        if (changed) setStartedRevision((n) => n + 1);
        setWorkerHistoryError(workersResult.value.partialHostErrors.length
          ? `${t("worker.partialHostErrors")}: ${JSON.stringify(workersResult.value.partialHostErrors)}`
          : null);
        // Keep the previous array object on no-op polls — WorkerPanel and
        // the DAG canvas re-render per identity, and identical fleet rows
        // must not repaint anything.
        setWorkerRows((prev) => (sameJson(prev, workersResult.value.workers) ? prev : workersResult.value.workers));
      } else {
        setFleetRead(null);
        setWorkerHistoryError(String((workersResult.reason as Error)?.message ?? workersResult.reason));
        // keep the last good rows visible alongside the error
      }
    }

    // Status is process-local rather than Run-scoped at the endpoint. Store
    // the latest response, then apply it below only when its runId matches.
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
    setWorkerRows([]); // a Run switch must not show the previous Run's workers
    refreshExecutionState();
    executionTimer.current = window.setInterval(refreshExecutionState, POLL_MS);
    return () => {
      if (executionTimer.current) window.clearInterval(executionTimer.current);
    };
  }, [refreshExecutionState, runId, pageVisible]);

  // switching Run invalidates the current selection
  const pickRun = useCallback((id: string) => {
    setRunId(id);
    setGraphMountedRun(null);
    setOperationFocus(null);
    setActivityPending(0);
    setActivitySnapshot({ ...EMPTY_ACTIVITY, runId: id });
    // Do not leave the previous Run's graph visible during the new Run's
    // request. `visibleDag` below also guards the render in the same frame.
    setDag(EMPTY);
    setDagFailure(null);
    writeRoute(route.section, null);
    setRoute({ section: route.section, task: null });
  }, [route.section]);

  const closeStage = useCallback(() => {
    writeRoute(route.section, null);
    setRoute({ section: route.section, task: null });
    if (stageReturnFocus.current?.closest(".workbench-canvas")) setMobilePane("canvas");
    window.requestAnimationFrame(() => {
      if (stageReturnFocus.current?.isConnected) stageReturnFocus.current.focus();
    });
  }, [route.section]);

  const selectStage = useCallback((id: string | null) => {
    if (!id) {
      closeStage();
      return;
    }
    const active = document.activeElement;
    stageReturnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null;
    writeRoute(route.section, id);
    setRoute({ section: route.section, task: id });
    setMobilePane("operations");
  }, [closeStage, route.section]);

  const onRunStarting = useCallback((id: string) => {
    setStartingRunId(id);
  }, []);

  const onRunStartFinished = useCallback((id: string, status: RunStatus | null) => {
    setStartingRunId((current) => (current === id ? null : current));
    // A start can finish after the user has switched Runs. Do not let its
    // receipt become status for the newly selected Run; the normal poll will
    // reconcile that Run independently.
    if (status && selectedRunRef.current === id) setRunStatus(status);
  }, []);

  // App is the ONLY periodic owner of /api/run-status (ExecControls and
  // RecoveryPanel receive it as a prop). After an explicit Stop the 2s tick
  // would leave the stop report and running flag stale for up to one interval,
  // so ExecControls raises this callback instead of fetching itself: one
  // one-off reconciliation pass, guarded by the same Run/seq checks the
  // periodic path uses, and no second poller.
  const onRunStopped = useCallback(() => refreshExecutionState(), [refreshExecutionState]);

  // Until the selected Run's first scoped response arrives, an old Run's DAG
  // is not displayable under the new Run. This complements the request guards
  // above for the one render between setRunId and the effect cleanup.
  const visibleDag = dag.runId === runId ? dag : EMPTY;
  // A successful empty response is still a snapshot. Never infer "no tasks"
  // from EMPTY while the first request is loading or has failed.
  const hasDagSnapshot = Boolean(runId && dag.runId === runId);
  const readError = connError ?? (!runId ? runListRead.error : null);
  const connectionError = connError ?? runListRead.error;
  const waitingForData = !hydrated || (runId
    ? !hasDagSnapshot && !connError
    : !runListRead.loaded && !runListRead.error);

  async function retryRead() {
    if (retryingRead) return;
    setRetryingRead(true);
    try {
      // Reads only: retrying a projection never replays a launch or approval.
      await Promise.all([refresh(), refreshExecutionState()]);
    } finally {
      setRetryingRead(false);
    }
  }
  const counts = visibleDag.nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.status] = (acc[n.status] ?? 0) + 1;
    return acc;
  }, {});

  const selected = visibleDag.nodes.find((n) => n.id === selectedId) ?? null;
  // Labels by task id within THIS Run — lane member lists resolve through it
  // so a member that vanished from the graph still shows its raw id.
  const labelsById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const n of visibleDag.nodes) map[n.id] = n.label;
    return map;
  }, [visibleDag.nodes]);
  // Phase 4: the selected node's ownership + readiness context. Parent/child
  // labels resolve within THIS Run only; a dangling parent_id (parent not in
  // the Run) shows its raw id so the fact is not silently hidden.
  const selectedParentLabel = (() => {
    const pid = selected?.parentId;
    if (!pid) return null;
    return visibleDag.nodes.find((n) => n.id === pid)?.label ?? pid;
  })();
  const selectedChildLabels = selected
    ? visibleDag.nodes.filter((n) => n.parentId === selected.id).map((n) => n.label)
    : [];
  const selectedReadiness = selected ? visibleDag.readiness[selected.id] ?? null : null;
  const operationSnapshots = {
    runId,
    dag: visibleDag.runId === runId ? visibleDag : null,
    status: runStatus?.runId === runId ? runStatus : null,
    workers: workerHistoryLoading || workerHistoryError ? null : workerRows,
  };
  const actionableCount = countActionableOperations(operationSnapshots);
  const knownActionableCount = countKnownActionableOperations(operationSnapshots);

  function openOperation(target: OperationFocus) {
    const section = target.kind === "worker" ? "executions" : "decisions";
    navigate(section, false);
    setOperationFocus(target);
  }

  useEffect(() => {
    if (!stageOpen && operationFocus && focusOperation(operationRef.current, operationFocus)) setOperationFocus(null);
  }, [stageOpen, route.section, operationFocus, visibleDag, workerRows, runStatus]);
  const startedTaskIds = useMemo(
    () => new Set(runId ? startedByRun.current.get(runId) ?? [] : []),
    [runId, startedRevision],
  );
  const selectedRunExecuting = Boolean(runStatus?.running && runStatus.runId === runId);
  const selectedRunStarting = startingRunId === runId;
  const leadTaskId = runId ? config.leadTaskByRun[runId] ?? null : null;
  // Human-input and stop-event debt is presentation evidence to stop motion,
  // never authority to mutate or settle a Dispatch.
  const pendingDispatchIds = useMemo(() => {
    const ids = new Set<string>();
    if (runStatus?.runId === runId) {
      for (const item of runStatus.inbox.pending) if (item.dispatchId) ids.add(item.dispatchId);
    }
    if (activitySnapshot.runId === runId) {
      for (const event of activitySnapshot.events) {
        if (event.actionable && event.dispatchId) ids.add(event.dispatchId);
      }
    }
    return [...ids];
  }, [runId, runStatus, activitySnapshot]);
  // One string drives both the conn pill's tooltip and its accessible name:
  // the pill is focusable (role="status"), so a keyboard user tabbing to it
  // hears the same detail a mouse user sees on hover. The readiness `reason`
  // is the server's own wording and stays English, like other server strings.
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
    failedCount > 0 ? progressAria + t("topbar.progressFailedAria", { n: failedCount }) : progressAria;

  // Planning owns Run creation; the viewer exposes neither task reset nor a
  // second creation entry point. Navigation never grants mutation authority.
  const pageTitle = stageOpen ? t("workbench.section.tasks") : route.section === "home"
    ? t("workbench.home") : route.section === "chat" ? t("toolbar.chat")
    : t(`workbench.section.${route.section}`);

  return (
    <div className="workbench">
      <header className="workbench-header">
        <div className="workbench-brand">
          <strong>{t("topbar.title")}</strong>
          {readiness?.workspace && <span className="workbench-workspace" title={readiness.workspace}>{readiness.workspace.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || readiness.workspace}</span>}
        </div>
        <div className="workbench-run"><RunPicker runId={runId} onPick={pickRun} autoPick={hydrated} onReadStateChange={setRunListRead} /></div>
        <div className="workbench-progress">{hasDagSnapshot && <span aria-label={progressGroupAria}>{stageCount ? t("topbar.doneOf", { done: completedCount, total: stageCount }) : t("topbar.noStages")}</span>}</div>
        <div className="workbench-health"><RunHealthBadge runId={runId} /></div>
        <div className="workbench-connection"><div className={`conn ${connectionError ? "conn--bad" : execOff || !readiness ? "conn--warn" : "conn--ok"}`} role="status" tabIndex={0} title={connDetail} aria-label={connDetail}>
          {!connectionError && readiness ? <LinkIcon size={20} /> : <LinkOffIcon size={20} />}
        </div></div>
        <div className="workbench-action-host" ref={setActionHost} />
        <LangToggle />
      </header>
      <div className="workbench-mobile-switch" role="group" aria-label={t("workbench.panes")}>
        <button type="button" aria-pressed={mobilePane === "canvas"} onClick={() => setMobilePane("canvas")}><NetworkIcon size={16} />{t("taskView.graph")}</button>
        <button type="button" aria-pressed={mobilePane === "operations"} onClick={() => setMobilePane("operations")}><GridIcon size={16} />{t("workbench.home")}</button>
      </div>
      <div className={`workbench-body${mobilePane === "operations" ? " workbench-body--mobile-operations" : ""}`}>
        <section className="workbench-canvas" aria-label={t("taskView.graph")}>
          <header className="workbench-canvas-header">
            <div><strong>{t("taskView.graph")}</strong>{hasDagSnapshot && <small>{t("toolbar.taskDepCount", { tasks: visibleDag.nodes.length, deps: visibleDag.edges.length })}</small>}</div>
            <div className="workbench-canvas-actions">
            <div className="workbench-launch-host" ref={setLaunchHost} />
            <Popover.Root>
              <Popover.Trigger asChild><button type="button" className="btn btn--ghost view-menu">{t("toolbar.view")}</button></Popover.Trigger>
              <Popover.Portal><Popover.Content className="view-menu__panel" aria-label={t("toolbar.view")} align="end" sideOffset={8} collisionPadding={12}>
              <div className="legend" role="group" aria-label={t("toolbar.statusLegendAria")}>{(Object.keys(STATUS_META) as TaskStatus[]).map((s) => <span className="legend__item" key={s}><span className="legend__dot" style={{ background: STATUS_META[s].color }} />{t(`status.${s}`)} {counts[s] ?? 0}</span>)}</div>
              <div className="legend" role="group" aria-label={t("toolbar.relationLegendAria")}>
                <span title={t("toolbar.dependencyTitle")}>{t("toolbar.dependency")}</span>
                <span title={t("toolbar.parentTitle")}>{t("toolbar.parent")}</span>
                <button type="button" className="btn btn--ghost btn--icon-text" aria-pressed={showHierarchy} onClick={() => setShowHierarchy((v) => !v)}><GitForkIcon size={14} />{showHierarchy ? t("toolbar.hideParentLinks") : t("toolbar.showParentLinks")}</button>
              </div>
              <div className="layout-ctl"><span className="exec__label">{t("toolbar.layout")}</span>
                <div className="seg" role="group" aria-label={t("toolbar.layoutAria")}>{LAYOUTS.map((l) => <button key={l.kind} className={layout === l.kind ? "active" : ""} aria-pressed={layout === l.kind} title={t(`layout.title.${l.kind}`)} onClick={() => pickLayout(l.kind)}>{t(`layout.label.${l.kind}`)}</button>)}</div>
                <button className="btn btn--ghost btn--icon-text" onClick={() => setReorgNonce((n) => n + 1)}><RefreshIcon size={14} />{t("toolbar.relayout")}</button>
              </div>
              </Popover.Content></Popover.Portal>
            </Popover.Root>
            </div>
          </header>
          {hasDagSnapshot && connError && <div className="workbench-canvas-notice" role="status"><span>{t("read.staleTitle")} · {t("read.staleBody")}</span><button type="button" className="btn btn--ghost" disabled={retryingRead} onClick={() => void retryRead()}>{t(retryingRead ? "read.retrying" : "read.retry")}</button></div>}
          {hasDagSnapshot && (graphMountedRun === runId || graphActive) ? <div className="workbench-graph">
            <Suspense fallback={<p role="status">{t("workbench.loadingGraph")}</p>}><GraphMounted onMount={markGraphMounted}>
              <DagView dag={visibleDag} leadTaskId={leadTaskId} selectedId={stageOpen ? selectedId : null} onSelect={selectStage} layout={layout} reorgNonce={reorgNonce} fitNonce={canvasFitNonce} showHierarchy={showHierarchy} workerRows={workerRows} attempts={runStatus?.runId === runId ? runStatus.attempts : EMPTY_ATTEMPTS} active={graphActive} fleetFresh={fleetFresh} pendingDispatchIds={pendingDispatchIds} />
            </GraphMounted></Suspense>
          </div> : <div className="workbench-canvas-empty" role="status">{t(readError ? (runId ? "read.tasksFailed" : "read.runsFailed") : runId ? "workbench.loadingGraph" : "empty.pickRunTitle")}</div>}
        </section>
        <div id="workbench-operations" ref={communicationRef} className={`workbench-operations${communicationResizing ? " workbench-chat--resizing" : ""}`} style={{ width: communicationWidth === null ? undefined : `${communicationWidth}px` }}>
          <div className="workbench-chat-resize" role="separator" aria-label={t("toolbar.resizeCommunicationAria")} aria-controls="workbench-operations" aria-orientation="vertical" aria-valuemin={COMMUNICATION_MIN_WIDTH} aria-valuemax={operationsSize.max} aria-valuenow={operationsSize.width || undefined} tabIndex={0} title={t("toolbar.resizeCommunicationTitle")} onPointerDown={beginCommunicationResize} onPointerMove={moveCommunicationResize} onPointerUp={endCommunicationResize} onPointerCancel={endCommunicationResize} onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            const current = communicationRef.current?.getBoundingClientRect().width ?? COMMUNICATION_MIN_WIDTH;
            const requested = event.key === "Home" ? COMMUNICATION_MIN_WIDTH : event.key === "End" ? operationsSize.max
              : current + (event.key === "ArrowLeft" ? 32 : -32);
            setCommunicationWidth(clampCommunicationWidth(requested));
            event.preventDefault();
          }} />
          <header className="workbench-operations-header">
            {stageOpen ? <strong>{pageTitle}</strong> : <h1 id="workbench-page-title" tabIndex={-1}>{pageTitle}</h1>}
            {!operationHome && <button type="button" className="btn btn--ghost workbench-home-button" aria-label={t("workbench.backHomeAria")} title={t("workbench.backHomeAria")} onClick={() => navigate("home")}><HomeIcon size={18} /></button>}
          </header>
          {operationHome && <div className="workbench-home-summary">
            {hasDagSnapshot ? <>
              <span aria-label={progressGroupAria}>{stageCount ? t("topbar.doneOf", { done: completedCount, total: stageCount }) : t("topbar.noStages")}</span>
              {knownActionableCount > 0 && <button type="button" onClick={() => navigate("decisions")}>{t("workbench.attentionCount", { n: actionableCount === null ? `${knownActionableCount}+` : actionableCount })}</button>}
              {connError && <span role="status">{t("overview.stale")}</span>}
            </> : <p role="status">{t(readError ? (runId ? "read.tasksFailed" : "read.runsFailed") : waitingForData ? "read.loadingBody" : "empty.pickRunTitle")}</p>}
          </div>}
          <nav className={`workbench-nav${operationHome ? " workbench-nav--home" : " workbench-nav--dock"}`} aria-label={t("workbench.navigation")}>
            <button type="button" className="workbench-nav-btn" data-app="chat" data-primary="true" aria-current={communicationOpen ? "page" : undefined} onClick={openCommunication}><span className="workbench-nav-icon"><ChatBubbleIcon size={18} /></span><span className="workbench-nav-label">{t("toolbar.chat")}</span>{activityPending > 0 && <span className="workbench-nav-count">{activityPending}</span>}</button>
            {SECTIONS.map((section) => (
              <button
                key={section}
                type="button"
                className="workbench-nav-btn"
                data-app={section}
                data-primary={DOCK_PRIMARY[section] ? "true" : undefined}
                aria-label={t(`workbench.section.${section}`)}
                aria-description={section === "decisions" && knownActionableCount > 0 ? t("workbench.attentionCount", { n: actionableCount === null ? `${knownActionableCount}+` : actionableCount }) : undefined}
                aria-current={!operationHome && !communicationOpen && route.section === section && !stageOpen ? "page" : undefined}
                onClick={() => navigate(section)}
              >
                <span className="workbench-nav-icon">{SECTION_ICONS[section]}</span>
                <span className="workbench-nav-label">{t(operationHome ? `workbench.section.${section}` : `workbench.dock.${section}`)}</span>
                {section === "decisions" && knownActionableCount > 0 && (
                  <span className="workbench-nav-count">
                    {actionableCount === null ? `${knownActionableCount}+` : actionableCount}
                  </span>
                )}
              </button>
            ))}
            {!operationHome && <button type="button" className="workbench-nav-btn workbench-nav-all" aria-current={!stageOpen && !DOCK_PRIMARY[route.section] ? "true" : undefined} onClick={() => navigate("home")}><span className="workbench-nav-icon"><GridIcon size={18} /></span><span className="workbench-nav-label">{t("workbench.backHome")}</span></button>}
          </nav>
        <main className="workbench-main" hidden={operationHome || communicationOpen} ref={operationRef} onScroll={(event) => { scrollByView.current[viewKey] = event.currentTarget.scrollTop; }}>
          {!hasDagSnapshot && (waitingForData || readError) && <section className="dag-read-state" aria-labelledby="dag-read-title">
            <h2 id="dag-read-title">{readError ? t(runId ? "read.tasksFailed" : "read.runsFailed") : t(runId ? "read.loadingTasks" : "read.loadingRuns")}</h2>
            <p role="status">{t(readError ? "read.failedBody" : "read.loadingBody")}</p>
            {readError && (
              <>
                <div className="dag-read-actions">
                  <button className="btn" type="button" onClick={() => window.location.reload()}>{t("read.reload")}</button>
                  {runId && (
                    <button
                      className="btn btn--ghost"
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
                <details className="dag-read-details"><summary>{t("read.technicalDetails")}</summary><pre>{readError}</pre></details>
              </>
            )}
          </section>}
          {hasDagSnapshot && connError && <section className="dag-read-notice" aria-label={t("read.staleTitle")}><div><strong>{t("read.staleTitle")}</strong><p role="status">{t("read.staleBody")}</p><details className="dag-read-details"><summary>{t("read.technicalDetails")}</summary><pre>{connError}</pre></details></div><button className="btn btn--ghost" type="button" disabled={retryingRead} onClick={() => void retryRead()}>{t(retryingRead ? "read.retrying" : "read.retry")}</button></section>}
          {!runId && hydrated && runListRead.loaded && !runListRead.error && <div className="empty-run"><p className="empty-run__title">{t("empty.pickRunTitle")}</p><p className="empty-run__body">{t("empty.pickRunBody")} <code>orca orchestration run-create</code> {t("empty.pickRunBodyTail")}</p></div>}
          <section className="workbench-section" hidden={stageOpen || route.section !== "overview"} aria-label={t("workbench.section.overview")}>
            {hasDagSnapshot && <div className="workbench-statuses" role="group" aria-label={t("overview.title")}>{(Object.keys(STATUS_META) as TaskStatus[]).map((status) => <span key={status}><span className="legend__dot" style={{ background: STATUS_META[status].color }} />{t(`status.${status}`)} <b>{counts[status] ?? 0}</b></span>)}{connError && <span role="status">{t("overview.stale")}</span>}</div>}
            <OperationsAttention {...operationSnapshots} onFocus={openOperation} variant="summary" onOpenDecisions={() => navigate("decisions")} />
            {hasDagSnapshot && visibleDag.nodes.length > 0 && <SchedulerPanel dag={visibleDag} runStatus={runStatus} runId={runId} onSelectTask={selectStage} />}
          </section>
          <section className="workbench-section workbench-tasks" hidden={stageOpen || route.section !== "tasks"} aria-label={t("workbench.section.tasks")}>
            {hasDagSnapshot && <TaskList dag={visibleDag} selectedId={stageOpen ? selectedId : null} onSelect={selectStage} />}
          </section>
          <section className="workbench-section" hidden={stageOpen || route.section !== "decisions"} aria-label={t("workbench.section.decisions")}>
            <OperationsAttention {...operationSnapshots} onFocus={openOperation} />
            <GatePanel gates={visibleDag.gates} runId={runId} onResolved={refresh} disabled={execOff} disabledReason={readiness?.reason} />
            <RecoveryPanel runId={runId} status={runStatus} taskIds={visibleDag.nodes.map((node) => node.id)} blockedTaskIds={visibleDag.nodes.filter((node) => node.status === "blocked").map((node) => node.id)} onRunStarting={onRunStarting} onRunStartFinished={onRunStartFinished} onRetried={() => { void refresh(); void refreshExecutionState(); }} disabled={execOff} disabledReason={readiness?.reason} />
          </section>
          <section className="workbench-section" hidden={stageOpen || route.section !== "executions"} aria-label={t("workbench.section.executions")}>
            {!workerHistoryLoading && !workerHistoryError && workerRows.length === 0 && <p>{t("operations.noWorkers")}</p>}
            <WorkerPanel key={runId} labelsById={labelsById} focusId={operationFocus?.kind === "worker" ? operationFocus.id : null} runId={runId} rows={workerRows} rowsError={workerHistoryError} status={runStatus} disabled={execOff} disabledReason={readiness?.reason} />
          </section>
          <section className="workbench-section" hidden={stageOpen || (route.section !== "activity" && route.section !== "decisions")} aria-label={t("workbench.section.activity")}>
            <ActivityPanel actionableOnly={route.section === "decisions"} runId={runId} onSelectTask={selectStage} onResolved={refresh} onPendingCount={setActivityPending} onSnapshot={setActivitySnapshot} disabled={execOff} disabledReason={readiness?.reason} />
            <div hidden={route.section !== "activity"}><RequestAuditPanel labelsById={labelsById} runId={runId} active={!stageOpen && route.section === "activity"} /></div>
          </section>
          <section className="workbench-section" hidden={stageOpen || route.section !== "resources"} aria-label={t("workbench.section.resources")}>
            <LanesPanel runId={runId} active={!stageOpen && route.section === "resources"} disabled={execOff} disabledReason={readiness?.reason} />
            <CleanupPanel runId={runId} disabled={execOff} />
          </section>
          <section className="workbench-section" hidden={stageOpen || route.section !== "settings"} aria-label={t("workbench.section.settings")}>
            <ExecControls actionHost={actionHost} launchHost={launchHost} runId={runId} labelsById={labelsById} taskIds={visibleDag.nodes.map((n) => n.id)} edges={visibleDag.edges} readyCount={counts.ready ?? 0} startingRunId={startingRunId} status={runStatus} workerHistoryLoading={workerHistoryLoading} workerHistoryError={workerHistoryError} onRunStarting={onRunStarting} onRunStartFinished={onRunStartFinished} onRunStopped={onRunStopped} />
            <CapabilityPanel />
          </section>
          {stageOpen && !selected && hasDagSnapshot && <section className="workbench-detail"><p>{t("workbench.taskUnavailable")} <code>{selectedId}</code></p><button type="button" className="btn" onClick={closeStage}>{t("dialog.close")}</button></section>}
          {selected && stageOpen && <div className="workbench-detail"><NodePanel key={`${runId}:${selected.id}`} node={selected} runId={runId} isLead={selected.id === leadTaskId} parentLabel={selectedParentLabel} childLabels={selectedChildLabels} readiness={selectedReadiness} edges={visibleDag.edges} labelsById={labelsById} onLeadChange={(taskId) => setLeadTask(runId, taskId)} permanentlyLocked={startedTaskIds.has(selected.id)} temporarilyLocked={selectedRunExecuting} coordinatorStarting={selectedRunStarting} workerHistoryLoading={workerHistoryLoading} workerHistoryError={workerHistoryError} failedStart={Boolean(runStatus?.runId === runId && runStatus.attempts.some((attempt) => attempt.taskId === selected.id && attempt.settledVia === "start_failed" && attempt.startReceipt?.ok === false))} hasWorkerHistory={workerRows.some((row) => row.taskId === selected.id)} workerRows={workerRows} onRefresh={refresh} onOpenOperations={openOperation} onClose={closeStage} /></div>}
        </main>
        <aside className={`workbench-chat${communicationOpen ? "" : " workbench-chat--closed"}`} aria-label={t("toolbar.chat")} aria-hidden={!communicationOpen}>
          <ChatPanel active={communicationOpen} runId={runId} snapshot={activitySnapshot} tasks={visibleDag.nodes} leadTaskId={leadTaskId} onSelectTask={selectStage} onSelectWorker={(id) => openOperation({ kind: "worker", id })} onResolved={refresh} coordinatorActive={selectedRunExecuting} disabled={execOff} disabledReason={readiness?.reason} />
        </aside>
        </div>
      </div>
    </div>
  );
}
