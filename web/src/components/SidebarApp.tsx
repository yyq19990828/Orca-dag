import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowLeft,
  ChevronRight,
  Crosshair,
  ExternalLink,
  RotateCcw,
} from "lucide-react";
import {
  acknowledgeStopEvent,
  decideWorkerPermission,
  fetchActivity,
  fetchDag,
  fetchResumePreview,
  fetchRunStatus,
  fetchWorkers,
  focusWorker,
  openFullTab,
  replyToMessage,
  resolveGate,
  resumeWorkerSession,
} from "../api";
import { openActivityStream } from "../bridge/orcaBridge";
import {
  effectiveHarness,
  initConfig,
  setRunId as persistRunId,
  useConfig,
  useReadiness,
} from "../harness";
import { useT } from "../i18n";
import { useColorScheme } from "../theme";
import type {
  ActivityEvent,
  ActivitySnapshot,
  DagNode,
  DagResponse,
  NativeResumePreviewView,
  NativeResumeResultView,
  RunStatus,
  TaskStatus,
  WorkerRowView,
} from "../types";
import { usePageVisible } from "../visibility";
import { ChatPanel } from "./ChatPanel";
import { useDecisionDialog } from "./DecisionDialog";
import { EmptyRunState } from "./EmptyRunState";
import { ExecControls } from "./ExecControls";
import { HarnessAvatar } from "./HarnessAvatar";
import { NodeSessionPanel } from "./NodeSessionPanel";
import { RunPicker, type RunListReadState } from "./RunPicker";
import { StatusGlyph, isGatePending, statusTokenVars } from "./statusUi";
import { useCoordinatorControl } from "./useCoordinatorControl";
import { WorkerOutputDockView } from "./WorkerOutputDockView";
import "./sidebar-app.css";

type SidebarTab = "tasks" | "inbox" | "activity";
type DetailTab = "messages" | "session" | "output";
type TaskFilter = "all" | "dispatched" | "blocked" | "failed" | "completed";

const PRIMARY_TABS: readonly SidebarTab[] = ["tasks", "inbox", "activity"];
const DETAIL_TABS: readonly DetailTab[] = ["messages", "session", "output"];

function formatShortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function handleTablistKeyDown<T extends string>(
  event: ReactKeyboardEvent<HTMLDivElement>,
  tabs: readonly T[],
  current: T,
  onSelect: (next: T) => void,
): void {
  const idx = tabs.indexOf(current);
  if (idx < 0) return;
  let nextIdx: number | null = null;
  if (event.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
  else if (event.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") nextIdx = 0;
  else if (event.key === "End") nextIdx = tabs.length - 1;
  if (nextIdx === null) return;
  event.preventDefault();
  const next = tabs[nextIdx];
  onSelect(next);
  const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  buttons[nextIdx]?.focus();
}

/**
 * Streamlined companion UI designed for Orca's narrow right-sidebar panel
 * (320-450px). Provides a single-column Run progress strip, 3 flat tabs
 * (Tasks / Pending / Live), a drill-in single-task inspector (Session tool
 * cards / Output / Chat + native Resume + terminal Focus), and one-click
 * deep-links to open or reuse the full Orchestration Panel Tab.
 */
export default function SidebarApp() {
  const t = useT();
  const scheme = useColorScheme();
  const config = useConfig();
  const readiness = useReadiness();
  const visible = usePageVisible();
  const dialog = useDecisionDialog();
  const withControl = useCoordinatorControl();
  const idPrefix = useId();

  const [hydrated, setHydrated] = useState(false);
  const [runListRead, setRunListRead] = useState<RunListReadState>({ loaded: false, error: null });
  const runId = config.runId ?? "";
  const [dag, setDag] = useState<DagResponse | null>(null);
  const [workers, setWorkers] = useState<WorkerRowView[]>([]);
  const [workersLoading, setWorkersLoading] = useState(false);
  const [workersError, setWorkersError] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [activity, setActivity] = useState<ActivitySnapshot | null>(null);
  const [startingRunId, setStartingRunId] = useState<string | null>(null);
  const [tab, setTab] = useState<SidebarTab>("tasks");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("messages");
  const [selectedOutputDispatchId, setSelectedOutputDispatchId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [resumePreview, setResumePreview] = useState<NativeResumePreviewView | null>(null);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumePickedSession, setResumePickedSession] = useState("");
  const [resumeReceipt, setResumeReceipt] = useState<NativeResumeResultView | null>(null);
  const [execActionHost, setExecActionHost] = useState<HTMLDivElement | null>(null);

  const pollGen = useRef(0);

  // Apply light/dark attribute cleanly so scrollbar and status tokens stay synced.
  useEffect(() => {
    document.documentElement.dataset.theme = scheme.rendered;
  }, [scheme.rendered]);

  // Hydrate shared workspace config once on mount.
  useEffect(() => {
    let alive = true;
    void initConfig()
      .catch(() => {})
      .finally(() => {
        if (alive) setHydrated(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const pickRun = useCallback((next: string) => {
    setSelectedTaskId(null);
    setSelectedOutputDispatchId(null);
    setActionError(null);
    setResumePreview(null);
    setResumeReceipt(null);
    persistRunId(next);
  }, []);

  // Poll DAG, workers, and process-local coordinator status while visible.
  const refreshAll = useCallback(async () => {
    const gen = ++pollGen.current;
    try {
      const nextStatus = await fetchRunStatus().catch(() => null);
      if (gen !== pollGen.current) return;
      if (nextStatus) setStatus(nextStatus);
    } catch {
      // Ignore transient status fetch failure.
    }
    if (!runId) {
      setDag(null);
      setWorkers([]);
      setActivity(null);
      return;
    }
    try {
      const [nextDag, nextWorkers] = await Promise.all([
        fetchDag(runId),
        fetchWorkers(runId).catch((e) => {
          setWorkersError(String((e as Error)?.message ?? e));
          return null;
        }),
      ]);
      if (gen !== pollGen.current) return;
      setDag(nextDag);
      if (nextWorkers) {
        setWorkers(nextWorkers.workers);
        setWorkersError(null);
      }
      setWorkersLoading(false);
    } catch (e) {
      if (gen === pollGen.current) {
        setActionError(String((e as Error)?.message ?? e));
      }
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    setWorkersLoading(true);
    void refreshAll();
  }, [runId, refreshAll]);

  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => {
      void refreshAll();
    }, 2_500);
    return () => window.clearInterval(id);
  }, [visible, refreshAll]);

  // Live Activity Stream (SSE in browser preview, worker push in Orca plugin frame).
  useEffect(() => {
    if (!runId || !visible) return;
    let cancelled = false;
    void fetchActivity(runId)
      .then((snap) => {
        if (!cancelled) setActivity(snap);
      })
      .catch(() => {});
    const close = openActivityStream(runId, {
      onOpen: () => {},
      onSnapshot: (raw) => {
        if (!cancelled && raw && typeof raw === "object") {
          setActivity(raw as ActivitySnapshot);
        }
      },
      onError: () => {},
    });
    return () => {
      cancelled = true;
      close();
    };
  }, [runId, visible]);

  const nodes = useMemo(() => dag?.nodes ?? [], [dag]);
  const edges = useMemo(() => dag?.edges ?? [], [dag]);
  const gates = useMemo(() => dag?.gates ?? [], [dag]);

  const labelsById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const n of nodes) map[n.id] = n.label || n.id;
    return map;
  }, [nodes]);

  const taskIds = useMemo(() => nodes.map((n) => n.id), [nodes]);

  const counts = useMemo(() => {
    let running = 0;
    let blocked = 0;
    let failed = 0;
    let done = 0;
    let ready = 0;
    for (const n of nodes) {
      if (n.status === "dispatched") running++;
      else if (n.status === "blocked") blocked++;
      else if (n.status === "failed") failed++;
      else if (n.status === "completed") done++;
      else if (n.status === "ready") ready++;
    }
    return { total: nodes.length, running, blocked, failed, done, ready };
  }, [nodes]);

  const pendingGates = useMemo(() => gates.filter((g) => isGatePending(g)), [gates]);
  const pendingInbox = useMemo(
    () => (status?.runId === runId ? status.inbox.pending : []),
    [status, runId],
  );
  const failedWorkers = useMemo(
    () =>
      workers.filter(
        (w) =>
          w.projection?.liveness?.verdict === "exited" &&
          w.dispatchStatus !== "completed" &&
          w.workerState !== "succeeded",
      ),
    [workers],
  );
  const pendingCount = pendingGates.length + pendingInbox.length + failedWorkers.length;

  const workersByTask = useMemo(() => {
    const map = new Map<string, WorkerRowView[]>();
    for (const w of workers) {
      const list = map.get(w.taskId) ?? [];
      list.push(w);
      map.set(w.taskId, list);
    }
    return map;
  }, [workers]);

  const filteredNodes = useMemo(() => {
    if (filter === "all") return nodes;
    return nodes.filter((n) => n.status === filter);
  }, [nodes, filter]);

  const selectedTask: DagNode | null = useMemo(
    () => (selectedTaskId ? nodes.find((n) => n.id === selectedTaskId) ?? null : null),
    [nodes, selectedTaskId],
  );

  const selectedTaskWorkers = useMemo(
    () => (selectedTask ? workersByTask.get(selectedTask.id) ?? [] : []),
    [selectedTask, workersByTask],
  );

  const liveSelectedWorker = useMemo(
    () =>
      selectedTaskWorkers.find(
        (w) =>
          w.projection?.liveness?.verdict === "live" &&
          w.projection?.host?.kind === "local" &&
          Boolean(w.agentTerminalHandle) &&
          !w.agentTerminalHandle?.startsWith("orca_session_id:") &&
          !w.agentTerminalHandle?.startsWith("chat:"),
      ) ?? null,
    [selectedTaskWorkers],
  );

  const resumableWorker = useMemo(
    () =>
      selectedTaskWorkers.find(
        (w) =>
          w.projection?.liveness?.verdict === "exited" &&
          w.dispatchStatus !== "completed" &&
          w.workerState !== "succeeded",
      ) ?? null,
    [selectedTaskWorkers],
  );

  // Sync default selected output dispatch when entering a task.
  useEffect(() => {
    if (!selectedTask) return;
    if (selectedTaskWorkers.length > 0) {
      const preferred =
        (selectedTask.dispatchId &&
          selectedTaskWorkers.find((w) => w.dispatchId === selectedTask.dispatchId)?.dispatchId) ||
        selectedTaskWorkers[selectedTaskWorkers.length - 1]?.dispatchId ||
        null;
      setSelectedOutputDispatchId(preferred);
    } else {
      setSelectedOutputDispatchId(null);
    }
    setResumePreview(null);
    setResumePickedSession("");
    setResumeReceipt(null);
  }, [selectedTask, selectedTaskWorkers]);

  const handleOpenTab = useCallback(async (hash?: string) => {
    setActionError(null);
    try {
      await openFullTab(hash);
    } catch (e) {
      setActionError(String((e as Error)?.message ?? e));
    }
  }, []);

  const openTaskDetail = useCallback((taskId: string, initialTab: DetailTab = "messages") => {
    setSelectedTaskId(taskId);
    setDetailTab(initialTab);
    setActionError(null);
  }, []);

  const handleFocusTerminal = useCallback(
    async (dispatchId: string) => {
      if (!runId) return;
      setBusyKey(`focus:${dispatchId}`);
      setActionError(null);
      try {
        await focusWorker(dispatchId, runId);
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setBusyKey(null);
      }
    },
    [runId],
  );

  const handleCheckResume = useCallback(
    async (dispatchId: string) => {
      if (!runId) return;
      setResumeLoading(true);
      setActionError(null);
      setResumeReceipt(null);
      setResumePickedSession("");
      try {
        const preview = await fetchResumePreview(runId, dispatchId);
        setResumePreview(preview);
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setResumeLoading(false);
      }
    },
    [runId],
  );

  const handleExecuteResume = useCallback(
    async (dispatchId: string, preview: NativeResumePreviewView) => {
      if (!runId) return;
      const sessionId = preview.sessionId ?? (resumePickedSession || null);
      if (!sessionId) return;
      const confirmed = await dialog.confirm({
        title: t("worker.resumeConfirmTitle"),
        message: t("worker.resumeConfirmMessage", {
          id: dispatchId,
          harness: preview.harness ?? t("worker.unknown"),
          session: sessionId,
        }),
        confirmLabel: t("worker.resumeConfirm"),
      });
      if (!confirmed) return;
      setBusyKey(`resume:${dispatchId}`);
      setActionError(null);
      try {
        const receipt = await withControl(runId, (coordinatorControl) =>
          resumeWorkerSession(runId, dispatchId, { sessionId, coordinatorControl }),
        );
        setResumeReceipt(receipt);
        setResumePreview(null);
        void refreshAll();
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setBusyKey(null);
      }
    },
    [dialog, refreshAll, resumePickedSession, runId, t, withControl],
  );

  const handleResolveGate = useCallback(
    async (gateId: string, resolution: string) => {
      if (!runId) return;
      setBusyKey(`gate:${gateId}`);
      setActionError(null);
      try {
        await withControl(runId, (coordinatorControl) =>
          resolveGate(gateId, resolution, runId, coordinatorControl),
        );
        void refreshAll();
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setBusyKey(null);
      }
    },
    [refreshAll, runId, withControl],
  );

  const handleReplyInbox = useCallback(
    async (messageId: string) => {
      if (!runId) return;
      const body = (replyDrafts[messageId] ?? "").trim();
      if (!body) return;
      setBusyKey(`reply:${messageId}`);
      setActionError(null);
      try {
        await withControl(runId, (coordinatorControl) =>
          replyToMessage(messageId, body, runId, coordinatorControl),
        );
        setReplyDrafts((prev) => {
          const next = { ...prev };
          delete next[messageId];
          return next;
        });
        void refreshAll();
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setBusyKey(null);
      }
    },
    [refreshAll, replyDrafts, runId, withControl],
  );

  const handlePermissionDecision = useCallback(
    async (dispatchId: string, promptId: string, decision: "approve" | "deny") => {
      if (!runId) return;
      setBusyKey(`perm:${promptId}`);
      setActionError(null);
      try {
        const reason =
          decision === "approve"
            ? t("permission.approveDefaultReason")
            : "Denied by operator from Orchestration Panel sidebar";
        await withControl(runId, (coordinatorControl) =>
          decideWorkerPermission(runId, dispatchId, promptId, decision, reason, coordinatorControl),
        );
        void refreshAll();
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setBusyKey(null);
      }
    },
    [refreshAll, runId, t, withControl],
  );

  const handleAckStop = useCallback(
    async (messageId: string, dispatchId: string) => {
      if (!runId) return;
      setBusyKey(`ack:${messageId}`);
      setActionError(null);
      try {
        await acknowledgeStopEvent(runId, messageId, dispatchId);
        void refreshAll();
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setBusyKey(null);
      }
    },
    [refreshAll, runId],
  );

  const effectiveActivity: ActivitySnapshot = useMemo(
    () =>
      activity ?? {
        runId,
        events: [],
        presence: [],
        checks: [],
        pendingCount: 0,
        truncated: false,
        inboxWindow: null,
        generatedAt: 0,
      },
    [activity, runId],
  );

  const chatTaskSelection = useMemo(
    () => (selectedTask ? { taskId: selectedTask.id } : null),
    [selectedTask?.id],
  );

  const recentActivity: ActivityEvent[] = useMemo(() => {
    if (!activity) return [];
    return [...activity.events].reverse().slice(0, 80);
  }, [activity]);

  const taskSubtitle = (node: DagNode): string => {
    if (node.result) {
      const trimmed = node.result.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          for (const key of ["summary", "message", "detail", "reason"]) {
            if (typeof parsed[key] === "string" && parsed[key].trim()) return parsed[key].trim();
          }
          if (parsed.outcome === "succeeded") return t("report.outcome.succeeded");
          if (parsed.outcome === "failed") return t("report.outcome.failed");
        } catch {
          // Fall back to verbatim result text.
        }
      }
      return trimmed;
    }
    const taskW = workersByTask.get(node.id) ?? [];
    const live = taskW.find((w) => w.projection?.liveness?.verdict === "live");
    if (live) {
      const latestEv = activity?.events
        .slice()
        .reverse()
        .find((ev) => ev.taskId === node.id && ev.summary);
      if (latestEv) return latestEv.summary;
      return `${live.workerState || t("status.dispatched")} · ${live.dispatchId.slice(0, 12)}`;
    }
    const readInfo = dag?.readiness?.[node.id];
    if (readInfo?.reasons?.[0]) return readInfo.reasons[0];
    return t(`status.${node.status}` as Parameters<typeof t>[0]);
  };

  const progressAria = t("topbar.progressAria", { done: counts.done, total: counts.total });

  return (
    <div className="odag-sb">
      {/* Hidden ExecControls instance so ONLY its primary Run/Stop button portals into Row 1 */}
      <div hidden aria-hidden="true">
        <ExecControls
          runId={runId}
          labelsById={labelsById}
          taskIds={taskIds}
          edges={edges}
          readyCount={counts.ready}
          startingRunId={startingRunId}
          status={status}
          workerHistoryLoading={workersLoading}
          workerHistoryError={workersError}
          onRunStarting={(id) => setStartingRunId(id)}
          onRunStartFinished={(_id, next) => {
            setStartingRunId(null);
            if (next) setStatus(next);
            void refreshAll();
          }}
          onRunStopped={() => refreshAll()}
          actionHost={execActionHost}
          launchHost={execActionHost}
        />
      </div>

      {/* 1. Compact 2-row Header (single Open-Tab entry point) */}
      <header className="odag-sb__header">
        <div className="odag-sb__header-row">
          <div className="odag-sb__run">
            <RunPicker
              runId={runId}
              onPick={pickRun}
              autoPick={hydrated}
              onReadStateChange={setRunListRead}
            />
          </div>
          <div
            className="odag-sb__exec-host"
            ref={setExecActionHost}
            hidden={!runId && !status?.running}
          />
          <button
            type="button"
            className="odag-sb__tab-btn"
            onClick={() =>
              void handleOpenTab(
                selectedTask
                  ? `#section=chat&task=${encodeURIComponent(selectedTask.id)}`
                  : tab === "activity"
                    ? "#section=activity"
                    : undefined,
              )
            }
            title={t("sb.openTabTitle")}
          >
            <ExternalLink size={12} aria-hidden="true" />
            <span className="odag-sb__tab-btn-label">{t("sb.openTab")}</span>
          </button>
        </div>

        {runId && (
          <div className="odag-sb__progress-row">
            <div className="odag-sb__progress-meta">
              <progress
                className="odag-sb__progress"
                value={counts.done}
                max={Math.max(1, counts.total)}
                aria-label={progressAria}
              />
              <span className="odag-sb__progress-count">
                {counts.done}/{counts.total}
              </span>
            </div>
            {!selectedTask && (
              <div className="odag-sb__filters" role="group" aria-label={t("sb.tabTasks")}>
                {(
                  [
                    { key: "all", label: t("sb.filterAll"), count: counts.total, color: null },
                    { key: "dispatched", label: t("sb.filterRunning"), count: counts.running, color: "var(--st-dispatched)" },
                    { key: "blocked", label: t("sb.filterBlocked"), count: counts.blocked, color: "var(--st-blocked)" },
                    { key: "failed", label: t("sb.filterFailed"), count: counts.failed, color: "var(--st-failed)" },
                    { key: "completed", label: t("sb.filterDone"), count: counts.done, color: "var(--st-completed)" },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="odag-sb__chip"
                    aria-pressed={filter === item.key}
                    onClick={() => {
                      setFilter(item.key);
                      setTab("tasks");
                    }}
                  >
                    {item.color && <span className="odag-sb__dot" style={{ background: item.color }} />}
                    <span>{item.label}</span>
                    <span>{item.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </header>

      {actionError && (
        <div className="odag-sb__scroll" style={{ flex: "none", paddingBlock: "6px 0" }}>
          <div className="odag-sb__error" role="alert">
            {actionError}
          </div>
        </div>
      )}

      {/* 2. Either Drill-in Task Detail OR 3-Tab Main Surface */}
      {!runId ? (
        <EmptyRunState
          compact
          hasRuns={(runListRead.count ?? 0) > 0}
          cli={readiness?.cli ?? "orca"}
        />
      ) : selectedTask ? (
        <section className="odag-sb__detail" aria-label={selectedTask.label || selectedTask.id}>
          <div className="odag-sb__detail-head">
            <div className="odag-sb__detail-top">
              <button
                type="button"
                className="odag-sb__back"
                onClick={() => setSelectedTaskId(null)}
              >
                <ArrowLeft size={12} aria-hidden="true" />
                <span>{t("sb.back")}</span>
              </button>
              <span
                className="odag-sb__dot"
                style={{ background: statusTokenVars(selectedTask.status).fg }}
              />
              <span className="odag-sb__detail-title" title={selectedTask.label || selectedTask.id}>
                {selectedTask.label || selectedTask.id}
              </span>
            </div>

            <div className="odag-sb__detail-actions">
              {liveSelectedWorker && (
                <button
                  type="button"
                  className="odag-sb__mini-btn"
                  disabled={busyKey === `focus:${liveSelectedWorker.dispatchId}`}
                  onClick={() => void handleFocusTerminal(liveSelectedWorker.dispatchId)}
                >
                  <Crosshair size={12} aria-hidden="true" />
                  <span>{t("sb.focusTerminal")}</span>
                </button>
              )}
              {resumableWorker && (
                <button
                  type="button"
                  className="odag-sb__mini-btn"
                  disabled={resumeLoading || busyKey === `resume:${resumableWorker.dispatchId}`}
                  onClick={() => void handleCheckResume(resumableWorker.dispatchId)}
                >
                  <RotateCcw size={12} aria-hidden="true" />
                  <span>{resumeLoading ? t("sb.resumeLoading") : t("sb.resumeAction")}</span>
                </button>
              )}
            </div>

            {resumeReceipt && (
              <div className="odag-sb__resume-box" role="status">
                {t("worker.resumeReceipt", {
                  dispatch: resumeReceipt.dispatchId,
                  terminal: resumeReceipt.resumedTerminalId,
                  session: resumeReceipt.sessionId,
                })}
              </div>
            )}

            {resumePreview && resumableWorker && (
              <div className="odag-sb__resume-box">
                {resumePreview.eligible ? (
                  <>
                    <span>
                      {t("worker.resumeReady", {
                        harness: resumePreview.harness ?? t("worker.unknown"),
                        session: resumePreview.sessionId ?? "",
                      })}
                    </span>
                    <button
                      type="button"
                      className="odag-sb__mini-btn odag-sb__mini-btn--primary"
                      disabled={busyKey === `resume:${resumableWorker.dispatchId}`}
                      onClick={() => void handleExecuteResume(resumableWorker.dispatchId, resumePreview)}
                    >
                      <RotateCcw size={12} aria-hidden="true" />
                      <span>{t("worker.resumeButton")}</span>
                    </button>
                  </>
                ) : resumePreview.code === "session_id_required" &&
                  resumePreview.candidateSessions.some((s) => !s.running) ? (
                  <>
                    <label htmlFor={`${idPrefix}-resume-pick`}>{t("worker.resumePickSession")}</label>
                    <select
                      id={`${idPrefix}-resume-pick`}
                      className="odag-sb__select"
                      value={resumePickedSession}
                      onChange={(e) => setResumePickedSession(e.target.value)}
                    >
                      <option value="">{t("worker.resumePickPlaceholder")}</option>
                      {resumePreview.candidateSessions
                        .filter((s) => !s.running)
                        .map((s) => (
                          <option key={s.sessionId} value={s.sessionId}>
                            {s.title ? `${s.title.slice(0, 36)} · ` : ""}
                            {s.sessionId.slice(0, 14)}
                          </option>
                        ))}
                    </select>
                    {resumePickedSession && (
                      <button
                        type="button"
                        className="odag-sb__mini-btn odag-sb__mini-btn--primary"
                        disabled={busyKey === `resume:${resumableWorker.dispatchId}`}
                        onClick={() => void handleExecuteResume(resumableWorker.dispatchId, resumePreview)}
                      >
                        <RotateCcw size={12} aria-hidden="true" />
                        <span>{t("worker.resumeButton")}</span>
                      </button>
                    )}
                  </>
                ) : (
                  <span>
                    {t("worker.resumeUnavailable", {
                      reason: resumePreview.reason ?? t("worker.unknown"),
                    })}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Detail Sub-Tabs: Messages / Session / Output (aligned with full workbench naming) */}
          <div
            className="odag-sb__tablist"
            role="tablist"
            aria-label={t("chat.view.label")}
            {...({ focusgroup: "tablist nomemory" } as Record<string, string>)}
            onKeyDown={(e) => handleTablistKeyDown(e, DETAIL_TABS, detailTab, setDetailTab)}
          >
            {(
              [
                { id: "messages", label: t("chat.view.messages") },
                { id: "session", label: t("ide.inspector.tabSession") },
                { id: "output", label: t("sb.detailOutput") },
              ] as const
            ).map((item) => {
              const selected = detailTab === item.id;
              return (
                <button
                  key={item.id}
                  id={`${idPrefix}-dtab-${item.id}`}
                  type="button"
                  role="tab"
                  className="odag-sb__tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  {...(selected ? ({ focusgroupstart: "" } as Record<string, string>) : {})}
                  onClick={() => setDetailTab(item.id)}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          <div
            className="odag-sb__detail-body"
            role="tabpanel"
            aria-labelledby={`${idPrefix}-dtab-${detailTab}`}
          >
            {detailTab === "messages" && (
              <div className="odag-inspector--compact-chat odag-sb__chat-host">
                <ChatPanel
                  embeddedMessagesOnly
                  active={visible && detailTab === "messages"}
                  runId={runId}
                  snapshot={effectiveActivity}
                  tasks={nodes}
                  taskSelection={chatTaskSelection}
                  leadTaskId={config.leadTaskByRun[runId] ?? null}
                  onSelectTask={(id) => {
                    if (id) openTaskDetail(id, "messages");
                  }}
                  onSelectWorker={(dispatchId) => {
                    setSelectedOutputDispatchId(dispatchId);
                    setDetailTab("output");
                  }}
                  onResolved={() => {
                    void refreshAll();
                  }}
                  coordinatorActive={Boolean(status?.running && status.runId === runId)}
                  disabled={readiness !== null && !readiness.executionEnabled}
                  disabledReason={readiness?.reason}
                  renderTask={() => null}
                />
              </div>
            )}
            {detailTab === "session" && (
              <NodeSessionPanel
                runId={runId}
                task={selectedTask}
                workerRows={selectedTaskWorkers}
                active={visible && detailTab === "session"}
                onOpenOutput={(dispatchId) => {
                  setSelectedOutputDispatchId(dispatchId);
                  setDetailTab("output");
                }}
              />
            )}
            {detailTab === "output" && (
              <WorkerOutputDockView
                runId={runId}
                workerRows={selectedTaskWorkers}
                labelsById={labelsById}
                selectedDispatchId={selectedOutputDispatchId}
                onSelectDispatchId={setSelectedOutputDispatchId}
                active={visible && detailTab === "output"}
              />
            )}
          </div>
        </section>
      ) : (
        <>
          {/* Primary 3-Tab Navigation: Tasks / Pending / Live */}
          <div
            className="odag-sb__tablist"
            role="tablist"
            aria-label={t("sb.tabsAria")}
            {...({ focusgroup: "tablist nomemory" } as Record<string, string>)}
            onKeyDown={(e) => handleTablistKeyDown(e, PRIMARY_TABS, tab, setTab)}
          >
            <button
              id={`${idPrefix}-ptab-tasks`}
              type="button"
              role="tab"
              className="odag-sb__tab"
              aria-selected={tab === "tasks"}
              tabIndex={tab === "tasks" ? 0 : -1}
              {...(tab === "tasks" ? ({ focusgroupstart: "" } as Record<string, string>) : {})}
              onClick={() => setTab("tasks")}
            >
              <span>{t("sb.tabTasks")}</span>
              <span className="odag-sb__tab-badge">{counts.total}</span>
            </button>
            <button
              id={`${idPrefix}-ptab-inbox`}
              type="button"
              role="tab"
              className="odag-sb__tab"
              aria-selected={tab === "inbox"}
              tabIndex={tab === "inbox" ? 0 : -1}
              {...(tab === "inbox" ? ({ focusgroupstart: "" } as Record<string, string>) : {})}
              onClick={() => setTab("inbox")}
            >
              <span>{t("sb.tabInbox")}</span>
              {pendingCount > 0 && (
                <span className="odag-sb__tab-badge odag-sb__tab-badge--warn">{pendingCount}</span>
              )}
            </button>
            <button
              id={`${idPrefix}-ptab-activity`}
              type="button"
              role="tab"
              className="odag-sb__tab"
              aria-selected={tab === "activity"}
              tabIndex={tab === "activity" ? 0 : -1}
              {...(tab === "activity" ? ({ focusgroupstart: "" } as Record<string, string>) : {})}
              onClick={() => setTab("activity")}
            >
              <span>{t("sb.tabActivity")}</span>
            </button>
          </div>

          <div
            className="odag-sb__panel"
            role="tabpanel"
            aria-labelledby={`${idPrefix}-ptab-${tab}`}
          >
            {tab === "tasks" && (
              <div className="odag-sb__scroll">
                {pendingCount > 0 && (
                  <div className="odag-sb__banner">
                    <span>{t("sb.pendingBanner", { n: pendingCount })}</span>
                    <button
                      type="button"
                      className="odag-sb__banner-btn"
                      onClick={() => setTab("inbox")}
                    >
                      {t("sb.pendingBannerAction")} →
                    </button>
                  </div>
                )}

                {filteredNodes.length === 0 ? (
                  <div className="odag-sb__empty">{t("sb.noTasks")}</div>
                ) : (
                  filteredNodes.map((node) => {
                    const harness = effectiveHarness(node.id);
                    const tokens = statusTokenVars(node.status);
                    const isLive = (workersByTask.get(node.id) ?? []).some(
                      (w) => w.projection?.liveness?.verdict === "live",
                    );
                    return (
                      <button
                        key={node.id}
                        type="button"
                        className="odag-sb__card"
                        onClick={() => openTaskDetail(node.id, "messages")}
                      >
                        <div className="odag-sb__card-top">
                          <span style={{ color: tokens.fg, display: "inline-flex" }}>
                            <StatusGlyph status={node.status} executing={isLive} size={13} />
                          </span>
                          <span className="odag-sb__card-title" title={node.label || node.id}>
                            {node.label || node.id}
                          </span>
                          <span className="odag-sb__card-harness">
                            <HarnessAvatar harness={harness} size={11} />
                            <span>{harness}</span>
                          </span>
                        </div>
                        <div className="odag-sb__card-sub">
                          <span className="odag-sb__card-summary">{taskSubtitle(node)}</span>
                          <ChevronRight size={13} className="odag-sb__card-chevron" aria-hidden="true" />
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            )}

            {tab === "inbox" && (
              <div className="odag-sb__scroll">
                {pendingCount === 0 && <div className="odag-sb__empty">{t("sb.noPending")}</div>}

                {pendingGates.length > 0 && (
                  <>
                    <div className="odag-sb__section-label">{t("sb.gateSection")}</div>
                    {pendingGates.map((gate) => (
                      <div key={gate.id} className="odag-sb__item-card">
                        <div className="odag-sb__item-head">
                          <span>{gate.taskId ? labelsById[gate.taskId] ?? gate.taskId : gate.id}</span>
                          <span className="odag-sb__wide-only">{gate.id}</span>
                        </div>
                        <div className="odag-sb__item-title">{gate.question || gate.id}</div>
                        <div className="odag-sb__detail-actions">
                          {(gate.options.length > 0 ? gate.options : ["approved", "rejected"]).map((opt) => (
                            <button
                              key={opt}
                              type="button"
                              className={`odag-sb__mini-btn${
                                opt.toLowerCase().includes("approve")
                                  ? " odag-sb__mini-btn--primary"
                                  : opt.toLowerCase().includes("reject")
                                    ? " odag-sb__mini-btn--danger"
                                    : ""
                              }`}
                              disabled={busyKey === `gate:${gate.id}`}
                              onClick={() => void handleResolveGate(gate.id, opt)}
                            >
                              {opt === "approved"
                                ? t("sb.approve")
                                : opt === "rejected"
                                  ? t("sb.reject")
                                  : opt}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {pendingInbox.length > 0 && (
                  <>
                    <div className="odag-sb__section-label">{t("sb.inboxSection")}</div>
                    {pendingInbox.map((item) => {
                      const perm = item.permissionPrompt;
                      return (
                        <div key={item.messageId} className="odag-sb__item-card">
                          <div className="odag-sb__item-head">
                            <span>{item.taskId ? labelsById[item.taskId] ?? item.taskId : item.from}</span>
                            <span>{formatShortTime(item.createdAt)}</span>
                          </div>
                          <div className="odag-sb__item-title">
                            {item.subject || item.stopReason || item.kind}
                          </div>
                          {item.body && <p className="odag-sb__item-body">{item.body}</p>}
                          {perm && item.dispatchId ? (
                            <div className="odag-sb__detail-actions">
                              <button
                                type="button"
                                className="odag-sb__mini-btn odag-sb__mini-btn--primary"
                                disabled={perm.allowSupported === false || busyKey === `perm:${perm.id}`}
                                title={perm.allowSupported === false ? t("permission.allowDisabledTitle") : undefined}
                                onClick={() =>
                                  void handlePermissionDecision(item.dispatchId!, perm.id, "approve")
                                }
                              >
                                {t("permission.allowOnce")}
                              </button>
                              <button
                                type="button"
                                className="odag-sb__mini-btn odag-sb__mini-btn--danger"
                                disabled={busyKey === `perm:${perm.id}`}
                                onClick={() =>
                                  void handlePermissionDecision(item.dispatchId!, perm.id, "deny")
                                }
                              >
                                {t("sb.reject")}
                              </button>
                            </div>
                          ) : item.kind === "stop_event" && item.dispatchId ? (
                            <div className="odag-sb__detail-actions">
                              <button
                                type="button"
                                className="odag-sb__mini-btn"
                                disabled={busyKey === `ack:${item.messageId}`}
                                onClick={() => void handleAckStop(item.messageId, item.dispatchId!)}
                              >
                                {t("sb.acknowledge")}
                              </button>
                              {item.taskId && (
                                <button
                                  type="button"
                                  className="odag-sb__mini-btn"
                                  onClick={() => openTaskDetail(item.taskId!, "session")}
                                >
                                  {t("sb.inspect")}
                                </button>
                              )}
                            </div>
                          ) : (
                            <form
                              className="odag-sb__reply-row"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void handleReplyInbox(item.messageId);
                              }}
                            >
                              <input
                                className="odag-sb__input"
                                value={replyDrafts[item.messageId] ?? ""}
                                onChange={(e) =>
                                  setReplyDrafts((prev) => ({ ...prev, [item.messageId]: e.target.value }))
                                }
                                placeholder={t("sb.replyPlaceholder")}
                              />
                              <button
                                type="submit"
                                className="odag-sb__mini-btn odag-sb__mini-btn--primary"
                                disabled={
                                  !(replyDrafts[item.messageId] ?? "").trim() ||
                                  busyKey === `reply:${item.messageId}`
                                }
                              >
                                {t("sb.send")}
                              </button>
                            </form>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}

                {failedWorkers.length > 0 && (
                  <>
                    <div className="odag-sb__section-label">{t("sb.failedSection")}</div>
                    {failedWorkers.map((w) => (
                      <div key={w.dispatchId} className="odag-sb__item-card">
                        <div className="odag-sb__item-head">
                          <span>{labelsById[w.taskId] ?? w.taskId}</span>
                          <span>{w.dispatchId.slice(0, 14)}</span>
                        </div>
                        <div className="odag-sb__item-body">
                          {w.workerState || w.dispatchStatus}
                        </div>
                        <div className="odag-sb__detail-actions">
                          <button
                            type="button"
                            className="odag-sb__mini-btn"
                            onClick={() => openTaskDetail(w.taskId, "session")}
                          >
                            <RotateCcw size={12} aria-hidden="true" />
                            <span>{t("sb.inspect")} / {t("sb.resumeAction")}</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            {tab === "activity" && (
              <div className="odag-sb__scroll">
                {recentActivity.length === 0 ? (
                  <div className="odag-sb__empty">{t("sb.noActivity")}</div>
                ) : (
                  recentActivity.map((ev) => {
                    const statusTone: TaskStatus =
                      ev.severity === "error"
                        ? "failed"
                        : ev.severity === "success"
                          ? "completed"
                          : ev.severity === "warning"
                            ? "dispatched"
                            : "pending";
                    return (
                      <button
                        key={ev.id}
                        type="button"
                        className="odag-sb__activity-row"
                        onClick={() => {
                          if (ev.taskId) openTaskDetail(ev.taskId, "session");
                        }}
                      >
                        <div className="odag-sb__activity-meta">
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                            <span
                              className="odag-sb__dot"
                              style={{ background: statusTokenVars(statusTone).fg }}
                            />
                            <span>
                              {ev.taskId ? labelsById[ev.taskId] ?? ev.taskId : ev.actor.label}
                            </span>
                          </span>
                          <span>{formatShortTime(ev.createdAt)}</span>
                        </div>
                        <div className="odag-sb__activity-text">{ev.summary || ev.title}</div>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
