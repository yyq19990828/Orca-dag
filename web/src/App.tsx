import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { DagView } from "./components/DagView";
import { ExecControls } from "./components/ExecControls";
import { ActivityPanel } from "./components/ActivityPanel";
import { ChatPanel } from "./components/ChatPanel";
import { GatePanel } from "./components/GatePanel";
import { NodePanel } from "./components/NodePanel";
import { RecoveryPanel } from "./components/RecoveryPanel";
import { WorkerPanel } from "./components/WorkerPanel";
import { RunPicker } from "./components/RunPicker";
import { RunHealthBadge } from "./components/RunHealthBadge";
import { CapabilityPanel } from "./components/CapabilityPanel";
import { useDecisionDialog } from "./components/DecisionDialog";
import { fetchDag, fetchRunStatus, fetchWorkers, resetTasks } from "./api";
import { initConfig, setLayout, setLeadTask, setRunId, useConfig, useReadiness } from "./harness";
import {
  LAYOUTS,
  STATUS_META,
  type ActivitySnapshot,
  type DagResponse,
  type LayoutKind,
  type RunStatus,
  type TaskStatus,
  type WorkerRowView,
} from "./types";

const EMPTY: DagResponse = { runId: "", nodes: [], edges: [], gates: [], generatedAt: 0 };
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
const POLL_MS = 2000;
const COMMUNICATION_MIN_WIDTH = 380;
const COMMUNICATION_MAX_WIDTH = 820;
const CANVAS_MIN_WIDTH = 320;

/**
 * Hand-drawn wobble filters — the whole "drawn with a crayon" illusion.
 *  - #crayon(-b/-c): a coarse waxy waver for node outlines, fills and stamps
 *    (objectBoundingBox — fine for boxes, breaks on zero-height lines). Three
 *    seeds of the same filter; flipping between them on a `steps(1)` keyframe
 *    loop is the classic hand-animation "boiling line". In doodle mode EVERY
 *    outline boils, phase-staggered per node so the flicks don't sync up.
 *  - #pencil-edge(-b/-c): same idea for edges, but in userSpaceOnUse with a
 *    deliberately oversized region so a perfectly horizontal edge (zero-height
 *    bbox) doesn't collapse the filter to nothing. All edges wear it — a DAG
 *    of clean beziers reads as software, a DAG of scrawls reads as a sketch.
 */
function HandDrawnDefs() {
  return (
    <svg className="crayon-defs" aria-hidden="true" focusable="false">
      <defs>
        {[
          ["crayon", 7],
          ["crayon-b", 23],
          ["crayon-c", 41],
        ].map(([id, seed]) => (
          <filter key={id} id={String(id)} x="-18%" y="-18%" width="136%" height="136%">
            {/* two frequencies: a slow bend (wonky hand) + a fine scratch (wax grain) */}
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.013 0.021"
              numOctaves="3"
              seed={seed}
              result="n"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="n"
              scale="9.5"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        ))}
        {/* fine grain for small glyphs (the whale) — the coarse #crayon moves
            lines by ~9px, which turns a 44px drawing into mush */}
        {[
          ["crayon-fine", 5],
          ["crayon-fine-b", 17],
          ["crayon-fine-c", 31],
        ].map(([id, seed]) => (
          <filter key={id} id={String(id)} x="-12%" y="-12%" width="124%" height="124%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.06"
              numOctaves="2"
              seed={seed}
              result="n"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="n"
              scale="2.6"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        ))}
        {/* wax grain for the running node's scribble: a slow wobble warps the
            stroke, then a fine tooth noise bites translucent pits into it, so
            the stroke reads as crayon dragged over paper texture */}
        <filter id="crayon-fill" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.012 0.02"
            numOctaves="3"
            seed={13}
            result="wobble"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="wobble"
            scale="6"
            xChannelSelector="R"
            yChannelSelector="G"
            result="warped"
          />
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.5"
            numOctaves="2"
            seed={13}
            result="tooth"
          />
          <feColorMatrix
            in="tooth"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.1 0 0 0 0.3"
            result="toothAlpha"
          />
          <feComposite in="warped" in2="toothAlpha" operator="in" />
        </filter>
        {[
          ["pencil-edge", 11],
          ["pencil-edge-b", 29],
          ["pencil-edge-c", 53],
        ].map(([id, seed]) => (
          <filter
            key={id}
            id={String(id)}
            filterUnits="userSpaceOnUse"
            x="-8000"
            y="-8000"
            width="24000"
            height="24000"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.024"
              numOctaves="2"
              seed={seed}
              result="n"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="n"
              scale="4.5"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        ))}
      </defs>
    </svg>
  );
}

export default function App() {
  const dialog = useDecisionDialog();
  const [dag, setDag] = useState<DagResponse>(EMPTY);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stageOpen, setStageOpen] = useState(false);
  const [communicationOpen, setCommunicationOpen] = useState(false);
  const [communicationWidth, setCommunicationWidth] = useState<number | null>(null);
  const [communicationResizing, setCommunicationResizing] = useState(false);
  const [communicationTab, setCommunicationTab] = useState<"activity" | "chat">("activity");
  const [activityPending, setActivityPending] = useState(0);
  const [activitySnapshot, setActivitySnapshot] = useState<ActivitySnapshot>(EMPTY_ACTIVITY);
  const [connError, setConnError] = useState<string | null>(null);
  const config = useConfig();
  const runId = config.runId;
  // Execution gate (Phase 2): when the server's readiness probe says this
  // Orca runtime can't execute (missing, or 1.4.160–1.4.204 view-only), the
  // mutation controls disable themselves with the reason. Reads stay live.
  const readiness = useReadiness();
  const execOff = readiness !== null && !readiness.executionEnabled;
  const layout: LayoutKind = config.layout || "layered-lr";
  // bump to force a fresh auto-layout (discarding manual drags)
  const [reorgNonce, setReorgNonce] = useState(0);
  // Unlike reorgNonce, this asks React Flow to reframe the current positions
  // without discarding nodes the user has manually dragged.
  const [canvasFitNonce, setCanvasFitNonce] = useState(0);
  const communicationRef = useRef<HTMLElement | null>(null);
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
  useEffect(() => {
    initConfig()
      .catch(() => {
        /* defaults + localStorage mirror still apply */
      })
      .finally(() => setHydrated(true));
  }, []);

  function pickLayout(kind: LayoutKind) {
    setLayout(kind);
  }

  function requestCanvasFit() {
    setCanvasFitNonce((nonce) => nonce + 1);
  }

  function openCommunication() {
    if (!communicationOpen) {
      if (communicationWidth === null) setCommunicationWidth(clampCommunicationWidth(620));
      requestCanvasFit();
    }
    setCommunicationOpen(true);
  }

  function closeCommunication() {
    if (communicationOpen) requestCanvasFit();
    setCommunicationOpen(false);
  }

  function clampCommunicationWidth(width: number): number {
    const workspaceWidth = communicationRef.current?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    // Below the overlay breakpoint the graph no longer needs a permanent
    // reserve beside the panel; leave only the paper margin used by CSS.
    const reserve = window.matchMedia("(max-width: 900px)").matches ? 18 : CANVAS_MIN_WIDTH;
    const upper = Math.max(280, Math.min(COMMUNICATION_MAX_WIDTH, workspaceWidth - reserve));
    const lower = Math.min(COMMUNICATION_MIN_WIDTH, upper);
    return Math.round(Math.min(Math.max(width, lower), upper));
  }

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
    setCommunicationWidth(clampCommunicationWidth(resize.startWidth + event.clientX - resize.startX));
  }

  function endCommunicationResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = communicationResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    communicationResize.current = null;
    setCommunicationResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    requestCanvasFit();
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
      setDag(next);
      setConnError(null);
    } catch (e) {
      if (selectedRunRef.current === requestedRun && seq >= dagAppliedSeq.current) {
        setConnError(String((e as Error).message ?? e));
      }
    }
  }, [runId]);

  useEffect(() => {
    refresh();
    timer.current = window.setInterval(refresh, POLL_MS);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [refresh]);

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
        const known = startedByRun.current.get(requestedRun) ?? new Set<string>();
        let changed = false;
        for (const worker of workersResult.value) {
          if (!worker.taskId || known.has(worker.taskId)) continue;
          known.add(worker.taskId);
          changed = true;
        }
        startedByRun.current.set(requestedRun, known);
        if (changed) setStartedRevision((n) => n + 1);
        setWorkerHistoryError(null);
        setWorkerRows(workersResult.value);
      } else {
        setWorkerHistoryError(String((workersResult.reason as Error)?.message ?? workersResult.reason));
        // keep the last good rows visible alongside the error
      }
    }

    // Status is process-local rather than Run-scoped at the endpoint. Store
    // the latest response, then apply it below only when its runId matches.
    if (statusResult.status === "fulfilled" && seq >= statusAppliedSeq.current) {
      statusAppliedSeq.current = seq;
      setRunStatus(statusResult.value);
    }
  }, [runId]);

  useEffect(() => {
    setWorkerHistoryLoading(Boolean(runId));
    setWorkerHistoryError(null);
    setWorkerRows([]); // a Run switch must not show the previous Run's workers
    refreshExecutionState();
    executionTimer.current = window.setInterval(refreshExecutionState, POLL_MS);
    return () => {
      if (executionTimer.current) window.clearInterval(executionTimer.current);
    };
  }, [refreshExecutionState, runId]);

  // switching Run invalidates the current selection
  const pickRun = useCallback((id: string) => {
    setRunId(id);
    setSelectedId(null);
    setStageOpen(false);
    setActivityPending(0);
    setActivitySnapshot({ ...EMPTY_ACTIVITY, runId: id });
    // Do not leave the previous Run's graph visible during the new Run's
    // request. `visibleDag` below also guards the render in the same frame.
    setDag(EMPTY);
    setConnError(null);
  }, []);

  const selectStage = useCallback((id: string | null) => {
    setSelectedId(id);
    setStageOpen(Boolean(id));
  }, []);

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

  // Until the selected Run's first scoped response arrives, an old Run's DAG
  // is not displayable under the new Run. This complements the request guards
  // above for the one render between setRunId and the effect cleanup.
  const visibleDag = dag.runId === runId ? dag : EMPTY;
  const counts = visibleDag.nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.status] = (acc[n.status] ?? 0) + 1;
    return acc;
  }, {});

  const selected = visibleDag.nodes.find((n) => n.id === selectedId) ?? null;
  const startedTaskIds = useMemo(
    () => new Set(runId ? startedByRun.current.get(runId) ?? [] : []),
    [runId, startedRevision],
  );
  const selectedRunExecuting = Boolean(runStatus?.running && runStatus.runId === runId);
  const selectedRunStarting = startingRunId === runId;
  const leadTaskId = runId ? config.leadTaskByRun[runId] ?? null : null;

  // the toolbar's bottom edge doubles as a crayon progress strip
  const total = visibleDag.nodes.length || 1;
  const pctDone = ((counts.completed ?? 0) / total) * 100;
  const pctFail = ((counts.failed ?? 0) / total) * 100;
  const pctRun = ((counts.dispatched ?? 0) / total) * 100;

  async function onReset() {
    // Mirror the readiness gate for a clear message; the server enforces it
    // (503 execution_disabled) regardless.
    if (execOff) {
      await dialog.alert({
        title: "Execution unavailable",
        message: readiness?.reason ?? "Execution is unavailable on this Orca runtime.",
      });
      return;
    }
    // `orca orchestration reset` has no --run flag: it clears the whole local
    // orchestration database, not just the Run on screen. Say so plainly.
    const ok = await dialog.confirm({
      title: "Clear tasks in every local Run?",
      message:
        "Orca's reset command has no Run scope. It deletes tasks in every local Run, " +
        "not only the graph on screen. This cannot be undone.",
      confirmLabel: "Clear all tasks",
      cancelLabel: "Keep tasks",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await resetTasks();
      setSelectedId(null);
      setStageOpen(false);
      refresh();
    } catch (err) {
      await dialog.alert({
        title: "Task reset failed",
        message: String(err),
        tone: "danger",
      });
    }
  }

  return (
    <div className="app">
      <HandDrawnDefs />
      <header className="topbar">
        <div className="topbar__brand">
          {/* the mascot is drawn, not typeset — and it's an ORCA, not a whale:
              black body with the tall dorsal fin drawn into the outline, white
              belly, the signature white eye patch. Separate strokes like any
              doodle. */}
          <svg className="topbar__logo" viewBox="0 0 78 62" aria-hidden="true" focusable="false">
            <path
              className="orca__body"
              d="M7 36 C8 26 16 18 28 17 C30 12 33 7 38 4 C38 10 40 14 44 16 C52 18 56 24 57 30 C58 34 56 38 53 41 C44 49 22 51 13 46 C9 44 7 40 7 36 Z"
            />
            <path
              className="orca__tail"
              d="M54 38 C59 36 63 32 64 26 C65 30 65 34 63 37 C67 39 70 43 70 48 C65 46 59 44 53 42"
            />
            <path
              className="orca__belly"
              d="M9 37 C16 43 30 46 44 44 C49 43 52 42 53 41 C44 49 22 51 13 46 C10 44 8.7 40.5 9 37 Z"
            />
            <ellipse className="orca__patch" cx="20" cy="26.5" rx="6" ry="3" transform="rotate(-16 20 26.5)" />
            <circle className="orca__eye" cx="19" cy="27" r="1.8" />
            <path className="orca__flipper" d="M30 41 C33 44.5 37 45.5 41 44.5" />
            <path className="orca__smile" d="M10 39 C13 41.2 16 41.6 19 41" />
            <g className="orca__spout">
              <path d="M24 12 C24 8 24 5 23 2" />
              <path d="M22 12 C20 8 17 6 14 5" />
              <path d="M26 12 C29 8 31 7 33 6" />
            </g>
          </svg>
          <div>
            <div className="topbar__title">Orca DAG Viewer</div>
            <div className="topbar__subtitle">Chat with your agent to build the graph · pick harnesses, let Orca run it in parallel</div>
          </div>
        </div>
        <span className="topbar__tape" aria-hidden="true" />
        <div className="topbar__right">
          <RunPicker runId={runId} onPick={pickRun} autoPick={hydrated} />
          <RunHealthBadge runId={runId} />
          <div
            className={`conn ${connError ? "conn--bad" : execOff ? "conn--warn" : "conn--ok"}`}
            title={
              connError ??
              (execOff
                ? readiness?.reason ?? "Execution unavailable — view-only"
                : readiness
                  ? `Connected to Orca ${readiness.version ?? ""} · ${readiness.cli} (execution enabled)`
                  : "Connected to Orca")
            }
          >
            {connError ? "Fetch failed" : execOff ? "View-only" : "Orca connected"}
          </div>
          <button
            className="btn btn--ghost"
            onClick={onReset}
            disabled={execOff}
            title={
              execOff
                ? readiness?.reason ?? "Execution is unavailable"
                : "Clear tasks in all local Runs"
            }
          >
            Clear tasks
          </button>
        </div>
      </header>

      <div className="layout">
        <section className="pane pane--dag">
          <div className="dag-toolbar">
            <div className="dag-toolbar__left">
              <button
                type="button"
                className={`btn btn--activity${communicationOpen ? " active" : ""}`}
                aria-pressed={communicationOpen}
                onClick={openCommunication}
              >
                Activity / Chat
                {activityPending > 0 && <span className="activity-badge">{activityPending}</span>}
              </button>
              <div className="legend">
                {(Object.keys(STATUS_META) as TaskStatus[]).map((s) => (
                  <span
                    key={s}
                    className={`legend__item${counts[s] ? " legend__item--live" : ""}`}
                    data-status={s}
                  >
                    <span className="legend__dot" style={{ background: STATUS_META[s].color }} />
                    {STATUS_META[s].label}
                    {/* keyed by value so the badge re-pops each time it changes */}
                    {counts[s] ? (
                      <b className="legend__n" key={counts[s]}>
                        {counts[s]}
                      </b>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
            <div className="dag-toolbar__right">
              <div className="layout-ctl">
                <span className="exec__label">Layout</span>
                <div className="seg" role="group" aria-label="Layout algorithm">
                  {LAYOUTS.map((l) => (
                    <button
                      key={l.kind}
                      className={layout === l.kind ? "active" : ""}
                      aria-pressed={layout === l.kind}
                      title={l.title}
                      onClick={() => pickLayout(l.kind)}
                    >
                      <span aria-hidden="true">{l.icon}</span> {l.label}
                    </button>
                  ))}
                </div>
                <button
                  className="btn btn--ghost"
                  title="Re-run auto-layout (discards manual drags)"
                  onClick={() => setReorgNonce((n) => n + 1)}
                >
                  ↻ Re-layout
                </button>
              </div>
              <span className="dag-toolbar__meta">
                {visibleDag.nodes.length} tasks · {visibleDag.edges.length} deps
              </span>
              <ExecControls
                runId={runId}
                taskIds={visibleDag.nodes.map((n) => n.id)}
                readyCount={counts.ready ?? 0}
                startingRunId={startingRunId}
                workerHistoryLoading={workerHistoryLoading}
                workerHistoryError={workerHistoryError}
                onRunStarting={onRunStarting}
                onRunStartFinished={onRunStartFinished}
              />
            </div>

            {/* the toolbar's bottom rule fills in with crayon as work lands */}
            <div className="dag-progress" aria-hidden="true">
              <span className="dag-progress__seg dag-progress__seg--done" style={{ width: `${pctDone}%` }} />
              <span className="dag-progress__seg dag-progress__seg--run" style={{ width: `${pctRun}%` }} />
              <span className="dag-progress__seg dag-progress__seg--fail" style={{ width: `${pctFail}%` }} />
            </div>
          </div>

          <div className="dag-workspace">
            {/* Activity and Chat are two readings of the same live snapshot.
                Keep this mounted while closed so unread counts and the Chat
                conversation list stay warm without opening a second stream.
                The communication surface is a real left rail, not a canvas
                overlay, so the graph always receives its own usable area. */}
            <aside
              ref={communicationRef}
              className={`communication-center${communicationOpen ? "" : " communication-center--closed"}${communicationResizing ? " communication-center--resizing" : ""}`}
              aria-label="Run communication center"
              aria-hidden={!communicationOpen}
              style={{ width: communicationWidth === null ? undefined : `${communicationWidth}px` }}
            >
                <header className="communication-center__header">
                  <div className="communication-center__tabs" role="tablist" aria-label="Communication view">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={communicationTab === "activity"}
                      className={communicationTab === "activity" ? "active" : ""}
                      onClick={() => setCommunicationTab("activity")}
                    >
                      Activity
                      {activityPending > 0 && <span className="activity-badge">{activityPending}</span>}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={communicationTab === "chat"}
                      className={communicationTab === "chat" ? "active" : ""}
                      onClick={() => setCommunicationTab("chat")}
                    >
                      Chat
                      {activityPending > 0 && <span className="activity-badge">{activityPending}</span>}
                    </button>
                  </div>
                  <button
                    type="button"
                    className="communication-center__close"
                    aria-label="Close communication center"
                    onClick={closeCommunication}
                  >
                    ✕
                  </button>
                </header>

                <div className="communication-center__body">
                  <div hidden={communicationTab !== "activity"}>
                    <ActivityPanel
                        runId={runId}
                        onSelectTask={(taskId) => selectStage(taskId)}
                        onResolved={refresh}
                        onPendingCount={setActivityPending}
                        onSnapshot={setActivitySnapshot}
                        disabled={execOff}
                        disabledReason={readiness?.reason}
                      />
                    <details className="communication-center__operations">
                        <summary>Operational details</summary>
                        <GatePanel
                          gates={visibleDag.gates}
                          runId={runId}
                          onResolved={refresh}
                          disabled={execOff}
                          disabledReason={readiness?.reason}
                        />
                        <RecoveryPanel
                          runId={runId}
                          onRetried={refresh}
                          disabled={execOff}
                          disabledReason={readiness?.reason}
                        />
                        <WorkerPanel
                          runId={runId}
                          rows={workerRows}
                          rowsError={workerHistoryError}
                          status={runStatus}
                          disabled={execOff}
                          disabledReason={readiness?.reason}
                        />
                        <CapabilityPanel />
                    </details>
                  </div>
                  <div hidden={communicationTab !== "chat"} className="communication-center__chat">
                    <ChatPanel
                      runId={runId}
                      snapshot={activitySnapshot}
                      tasks={visibleDag.nodes}
                      leadTaskId={leadTaskId}
                      onSelectTask={(taskId) => selectStage(taskId)}
                      onResolved={refresh}
                      coordinatorActive={selectedRunExecuting}
                      disabled={execOff}
                      disabledReason={readiness?.reason}
                    />
                  </div>
                </div>
                <div
                  className="communication-center__resize"
                  role="separator"
                  aria-label="Resize communication panel"
                  aria-orientation="vertical"
                  aria-valuemin={280}
                  aria-valuemax={COMMUNICATION_MAX_WIDTH}
                  aria-valuenow={communicationWidth ?? undefined}
                  tabIndex={0}
                  title="Drag or use Left/Right arrow keys to resize"
                  onPointerDown={beginCommunicationResize}
                  onPointerMove={moveCommunicationResize}
                  onPointerUp={endCommunicationResize}
                  onPointerCancel={endCommunicationResize}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    const current = communicationWidth ?? communicationRef.current?.getBoundingClientRect().width ?? 440;
                    setCommunicationWidth(clampCommunicationWidth(current + (event.key === "ArrowRight" ? 32 : -32)));
                    requestCanvasFit();
                    event.preventDefault();
                  }}
                />
            </aside>

            <div className="dag-canvas">
              <DagView
                dag={visibleDag}
                leadTaskId={leadTaskId}
                selectedId={selectedId}
                onSelect={selectStage}
                layout={layout}
                reorgNonce={reorgNonce}
                fitNonce={canvasFitNonce}
              />

              {!runId && (
                <div className="empty-run">
                  <p className="empty-run__title">Pick a Run first</p>
                  <p className="empty-run__body">
                    Since Orca 1.4.160 tasks belong to a Run — they are no longer global. Pick one with
                    the Run dropdown in the top-right, or have your agent run{" "}
                    <code>orca orchestration run-create</code> to start a new one.
                  </p>
                </div>
              )}

              {selected && stageOpen && (
                <NodePanel
                  key={selected.id}
                  node={selected}
                  runId={runId}
                  isLead={selected.id === leadTaskId}
                  onLeadChange={(taskId) => setLeadTask(runId, taskId)}
                  permanentlyLocked={startedTaskIds.has(selected.id)}
                  temporarilyLocked={selectedRunExecuting}
                  coordinatorStarting={selectedRunStarting}
                  workerHistoryLoading={workerHistoryLoading}
                  workerHistoryError={workerHistoryError}
                  onClose={() => setStageOpen(false)}
                />
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
