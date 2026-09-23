import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchProviderSessionBindings,
  fetchWorkers,
  probeProviderSession,
  resolveBlockedWorker,
  retryWorker,
  saveProviderSessionBinding,
  startRun,
} from "../api";
import {
  effortMap, environmentMap, getMaxConcurrency, harnessMap, laneMap,
  lanesSpecMap, modelMap, placementMap, retainMap, useConfig,
} from "../harness";
import { useDecisionDialog } from "./DecisionDialog";
import type {
  ProviderSessionBindingView,
  ProviderSessionObservationView,
  RunAttempt,
  RunStatus,
  WorkerRowView,
} from "../types";
import { workerWorkspaceLabel } from "../workerWorkspace";

/**
 * Restart-recovery surface (Phase 4): what the coordinator found when it bound
 * the Run, what it still cannot verify, and the explicit retry action for
 * positively failed starts. Everything here is evidence-backed — receipts,
 * adoption summaries, Orca's literal prescribed nextAction — never a guess.
 *
 * The panel renders only when there is something recovery-shaped to show; a
 * boring healthy run renders nothing at all. It no longer polls the
 * coordinator status itself: App owns the single visibility-gated
 * /api/run-status poll and passes the snapshot down, so a backgrounded page
 * never hears a second caller of that endpoint.
 */
export const RecoveryPanel = memo(function RecoveryPanel({
  runId,
  status = null,
  onRetried,
  taskIds = [],
  blockedTaskIds = [],
  onRunStarting,
  onRunStartFinished,
  disabled = false,
  disabledReason,
}: {
  runId: string;
  /** The process-local run-status snapshot from App (see ExecControls). */
  status?: RunStatus | null;
  /** Called after a successful retry so the parent can refresh. */
  onRetried: () => void;
  taskIds?: string[];
  blockedTaskIds?: string[];
  onRunStarting?: (runId: string) => void;
  onRunStartFinished?: (runId: string, status: RunStatus | null) => void;
  /** Execution disabled (readiness gate) — inputs render but stay off. */
  disabled?: boolean;
  disabledReason?: string | null;
}) {
  const dialog = useDecisionDialog();
  const config = useConfig();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [sessionBindings, setSessionBindings] = useState<ProviderSessionBindingView[]>([]);
  const [workerRows, setWorkerRows] = useState<WorkerRowView[]>([]);
  const [sessionDrafts, setSessionDrafts] = useState<Record<string, string>>({});
  const [sessionProbes, setSessionProbes] = useState<Record<string, ProviderSessionObservationView>>({});
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const [sessionBusyId, setSessionBusyId] = useState<string | null>(null);
  const [probeBusyId, setProbeBusyId] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [showActiveSessionCandidates, setShowActiveSessionCandidates] = useState(false);
  const sessionLoadSequence = useRef(0);

  const loadSessionRecovery = useCallback(async () => {
    if (!runId) return;
    const sequence = ++sessionLoadSequence.current;
    setSessionLoading(true);
    setSessionLoadError(null);
    const [bindingsResult, workersResult] = await Promise.allSettled([
      fetchProviderSessionBindings(runId),
      fetchWorkers(runId),
    ]);
    if (sequence !== sessionLoadSequence.current) return;
    const loadErrors: string[] = [];
    if (bindingsResult.status === "fulfilled") {
      setSessionBindings(bindingsResult.value);
      setSessionDrafts((drafts) => {
        const next = { ...drafts };
        for (const binding of bindingsResult.value) {
          next[binding.dispatchId] = binding.sessionId;
        }
        return next;
      });
    } else {
      loadErrors.push(String((bindingsResult.reason as Error)?.message ?? bindingsResult.reason));
    }
    if (workersResult.status === "fulfilled") setWorkerRows(workersResult.value);
    else loadErrors.push(String((workersResult.reason as Error)?.message ?? workersResult.reason));
    if (loadErrors.length > 0) setSessionLoadError(loadErrors.join(" · "));
    setSessionLoading(false);
  }, [runId]);

  // The list read is passive; provider status is probed only from an explicit
  // per-session button. A Run change also discards observations from the old Run.
  useEffect(() => {
    setSessionBindings([]);
    setWorkerRows([]);
    setSessionDrafts({});
    setSessionProbes({});
    setShowActiveSessionCandidates(false);
    void loadSessionRecovery();
    return () => {
      sessionLoadSequence.current += 1;
    };
  }, [loadSessionRecovery]);

  // `/api/run-status` is process-local. Never render Run A's recovery while
  // the inspector is showing Run B.
  const scopedStatus = status?.runId === runId ? status : null;
  const recovery = scopedStatus?.recovery ?? null;
  const attempts = scopedStatus?.attempts ?? [];
  const recoverySessions = useMemo(() => [
    ...(recovery?.providerSessions ?? []),
    ...(scopedStatus?.recoverySessions ?? []),
  ], [recovery?.providerSessions, scopedStatus?.recoverySessions]);
  const discoveredSessionIds = recoverySessions
    .filter((item) => item.source === "provider-evidence")
    .map((item) => item.dispatchId)
    .sort()
    .join("|");

  // The coordinator can bind a provider session after this panel's initial
  // read. Refresh the durable rows when its run-status snapshot first reports
  // new exact evidence; manual controls then become read-only automatically.
  useEffect(() => {
    if (discoveredSessionIds) void loadSessionRecovery();
  }, [discoveredSessionIds, loadSessionRecovery]);

  // Failed starts whose receipt is the release/retry evidence.
  const failedStarts = attempts.filter(
    (a) => a.settledVia === "start_failed" && a.startReceipt && !dismissed.has(a.taskId),
  );
  // Starts still carrying a durable retry-request id — the outcome is not
  // known yet and the id is what makes the eventual replay safe.
  const pendingStarts = attempts.filter((a) => a.startRequestId);
  // Orca prescribes a literal action (argv) — shown verbatim, never invented.
  const prescribed = attempts.filter((a) => (a.nextAction?.argv?.length ?? 0) > 0);
  const adoptedActive = attempts.filter((a) => a.adopted && !a.settled);
  const retryBlockedIds = useMemo(() => new Set([
    ...(recovery?.retryBlocked ?? []),
    ...(recovery?.retryBlockedDetails ?? []).map((entry) => entry.dispatchId),
  ]), [recovery?.retryBlocked, recovery?.retryBlockedDetails]);
  const retryBlockedDetails = useMemo(() => new Map(
    (recovery?.retryBlockedDetails ?? []).map((entry) => [entry.dispatchId, entry]),
  ), [recovery?.retryBlockedDetails]);
  const retryBlockedRows = useMemo(() => [...retryBlockedIds].map((dispatchId) => {
    const detail = retryBlockedDetails.get(dispatchId);
    const worker = workerRows.find((row) => row.dispatchId === dispatchId);
    const attempt = attempts.find((item) => item.dispatchId === dispatchId);
    const recovered = recoverySessions.find((item) => item.dispatchId === dispatchId);
    return {
      dispatchId,
      taskId: detail?.taskId ?? worker?.taskId ?? attempt?.taskId ?? recovered?.taskId ?? "unknown Stage",
      reason: detail?.reason ?? "The exact provider session has not been confirmed exited, so requeue remains blocked.",
    };
  }), [retryBlockedIds, retryBlockedDetails, workerRows, attempts, recoverySessions]);
  const blockedHistory = useMemo(() => {
    const blocked = new Set(blockedTaskIds);
    return workerRows.filter((row) =>
      blocked.has(row.taskId) && row.dispatchStatus === "failed"
    );
  }, [blockedTaskIds, workerRows]);

  const activeSessionCandidates = useMemo(() => {
    const bindingsByDispatch = new Set(sessionBindings.map((binding) => binding.dispatchId));
    const workersByDispatch = new Map(workerRows.map((worker) => [worker.dispatchId, worker]));
    const candidates = new Map<string, { dispatchId: string; taskId: string; harness: string }>();
    for (const worker of workerRows) {
      if (worker.dispatchStatus !== "dispatched" || bindingsByDispatch.has(worker.dispatchId)) continue;
      const attempt = attempts.find((item) => item.dispatchId === worker.dispatchId);
      const recovered = recoverySessions.find((item) => item.dispatchId === worker.dispatchId);
      const harness = worker.projection?.launch?.agent ?? attempt?.harness ?? recovered?.harness ?? "unknown";
      if (harness === "claude" || harness === "codex" || harness === "opencode") {
        candidates.set(worker.dispatchId, { dispatchId: worker.dispatchId, taskId: worker.taskId, harness });
      }
    }
    for (const attempt of attempts) {
      if (!attempt.dispatchId || attempt.settled || bindingsByDispatch.has(attempt.dispatchId)) continue;
      const worker = workersByDispatch.get(attempt.dispatchId);
      if (worker && worker.dispatchStatus !== "dispatched") continue;
      const recovered = recoverySessions.find((item) => item.dispatchId === attempt.dispatchId);
      const harness = worker?.projection?.launch?.agent ?? attempt.harness ?? recovered?.harness ?? "unknown";
      if (harness === "claude" || harness === "codex" || harness === "opencode") {
        candidates.set(attempt.dispatchId, { dispatchId: attempt.dispatchId, taskId: attempt.taskId, harness });
      }
    }
    return [...candidates.values()];
  }, [workerRows, sessionBindings, attempts, recoverySessions]);
  const unownedDispatchIds = useMemo(() => new Set(
    (scopedStatus?.unownedDispatches ?? [])
      .map((entry) => entry.match(/\(([^()]*)\)$/)?.[1])
      .filter((dispatchId): dispatchId is string => Boolean(dispatchId)),
  ), [scopedStatus?.unownedDispatches]);
  const recoveryCandidateIds = useMemo(() => new Set([
    ...recoverySessions.map((item) => item.dispatchId),
    ...retryBlockedIds,
    ...attempts
      .filter((attempt) => attempt.dispatchId && attempt.adopted && !attempt.settled)
      .map((attempt) => attempt.dispatchId!),
    ...workerRows
      .filter((row) => row.dispatchStatus === "dispatched" && (
        row.workerState === "unsupervised" ||
        row.projection?.liveness?.verdict === "unverifiable" ||
        unownedDispatchIds.has(row.dispatchId)
      ))
      .map((row) => row.dispatchId),
  ]), [recoverySessions, retryBlockedIds, attempts, workerRows, unownedDispatchIds]);
  const optionalActiveSessionCandidates = activeSessionCandidates.filter(
    (candidate) => !recoveryCandidateIds.has(candidate.dispatchId),
  );
  const activeSessionCandidateIds = useMemo(
    () => new Set(optionalActiveSessionCandidates.map((candidate) => candidate.dispatchId)),
    [optionalActiveSessionCandidates],
  );

  const sessionRows = useMemo(() => {
    const attemptsByDispatch = new Map(
      attempts.filter((attempt) => attempt.dispatchId).map((attempt) => [attempt.dispatchId!, attempt]),
    );
    const recoveryByDispatch = new Map(recoverySessions.map((item) => [item.dispatchId, item]));
    const workersByDispatch = new Map(workerRows.map((row) => [row.dispatchId, row]));
    const bindingsByDispatch = new Map(sessionBindings.map((binding) => [binding.dispatchId, binding]));
    const activeAttemptIds = attempts
      .filter((attempt) => attempt.dispatchId && attempt.adopted && !attempt.settled)
      .map((attempt) => attempt.dispatchId!);
    const workerRecoveryIds = workerRows
      .filter((row) => row.dispatchStatus === "dispatched" && (
        row.workerState === "unsupervised" ||
        row.projection?.liveness?.verdict === "unverifiable" ||
        unownedDispatchIds.has(row.dispatchId) ||
        retryBlockedIds.has(row.dispatchId)
      ))
      .map((row) => row.dispatchId);
    const ids = new Set([
      ...activeAttemptIds,
      ...recoveryCandidateIds,
      ...recoveryByDispatch.keys(),
      ...workerRecoveryIds,
      ...bindingsByDispatch.keys(),
      ...retryBlockedIds,
      ...(showActiveSessionCandidates ? activeSessionCandidateIds : []),
    ]);

    return [...ids].map((dispatchId) => {
      const attempt = attemptsByDispatch.get(dispatchId);
      const recovered = recoveryByDispatch.get(dispatchId);
      const worker = workersByDispatch.get(dispatchId);
      const binding = bindingsByDispatch.get(dispatchId);
      const taskId = binding?.taskId ?? recovered?.taskId ?? worker?.taskId ?? attempt?.taskId ?? "unknown task";
      const harness = binding?.harness ?? recovered?.harness ?? attempt?.harness ?? worker?.projection?.launch?.agent ?? "unknown";
      const dispatchStatus = worker?.dispatchStatus ?? (
        attempt?.settled
          ? `settled${attempt.outcome ? ` (${attempt.outcome})` : ""}`
          : attempt
            ? "tracked by coordinator"
            : "unknown"
      );
      const dispatchLiveness = worker?.projection?.liveness?.verdict ?? attempt?.liveness ?? null;
      return { dispatchId, taskId, harness, dispatchStatus, dispatchLiveness, attempt, recovered, worker, binding };
    }).sort((a, b) => a.taskId.localeCompare(b.taskId) || a.dispatchId.localeCompare(b.dispatchId));
  }, [attempts, recoverySessions, workerRows, sessionBindings, retryBlockedIds, recoveryCandidateIds, unownedDispatchIds, activeSessionCandidateIds, showActiveSessionCandidates]);

  const recoverySessionRows = sessionRows.filter((row) => !activeSessionCandidateIds.has(row.dispatchId));
  const expandedActiveSessionRows = showActiveSessionCandidates
    ? sessionRows.filter((row) => activeSessionCandidateIds.has(row.dispatchId))
    : [];

  const anythingToShow =
    (recovery !== null &&
      (recovery.activeAdopted.length > 0 ||
        recovery.settledAdopted.length > 0 ||
        recovery.unverifiable.length > 0 ||
        recovery.leftDecided > 0 ||
    retryBlockedRows.length > 0)) ||
    blockedHistory.length > 0 ||
    failedStarts.length > 0 ||
    pendingStarts.length > 0 ||
    prescribed.length > 0 ||
    adoptedActive.length > 0 ||
    recoverySessionRows.length > 0 ||
    optionalActiveSessionCandidates.length > 0 ||
    sessionLoadError !== null;

  const busy = useCallback((id: string) => busyId === id, [busyId]);

  async function retry(attempt: RunAttempt) {
    if (disabled || busy(attempt.taskId)) return;
    setBusyId(attempt.taskId);
    setErr(null);
    try {
      await retryWorker(attempt.startReceipt?.dispatchId ?? attempt.dispatchId ?? attempt.taskId);
      setDismissed((d) => new Set(d).add(attempt.taskId));
      onRetried();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusyId(null);
    }
  }

  async function resolveBlocked(row: WorkerRowView) {
    if (disabled || busyId || status?.running) return;
    const result = await dialog.prompt({
      title: "Record reviewed Stage result",
      message: `Stage ${row.taskId} was left blocked after Dispatch ${row.dispatchId} failed. Review the worker output first. This marks the Task completed while its historical Dispatch stays failed.`,
      fieldLabel: "Result and evidence",
      placeholder: "Describe the verified outcome and where you checked it",
      required: true,
      confirmLabel: "Continue",
    });
    if (!result || result.trim().length < 8) return;
    const confirmed = await dialog.prompt({
      title: "Confirm manual completion",
      message: "The provider session may be unknown even though Orca reports the worker exited. The Viewer will briefly bind this Run to update its Task, fencing another coordinator if one owns it. Enter the exact Task ID to confirm that you reviewed the result and accept this decision.",
      fieldLabel: "Task ID",
      confirmLabel: "Mark completed",
      tone: "danger",
    });
    if (confirmed?.trim() !== row.taskId) return;
    setBusyId(row.dispatchId);
    setErr(null);
    try {
      await resolveBlockedWorker(row.dispatchId, runId, result.trim());
      await loadSessionRecovery();
      onRetried();
    } catch (error) {
      setErr(String((error as Error).message ?? error));
    } finally {
      setBusyId(null);
    }
  }

  async function resumeBlocked(row: WorkerRowView) {
    if (disabled || busyId || status?.running) return;
    const binding = sessionBindings.find((item) => item.dispatchId === row.dispatchId);
    let sessionStatus = sessionProbes[row.dispatchId]?.status ?? null;
    if (binding) {
      try {
        const observation = await probeProviderSession(row.dispatchId, runId);
        sessionStatus = observation.status;
        setSessionProbes((current) => ({ ...current, [row.dispatchId]: observation }));
      } catch (error) {
        setErr(String((error as Error).message ?? error));
        return;
      }
    }
    if (sessionStatus === "active" || sessionStatus === "idle") {
      setErr("The exact provider session is still active or idle. Finish or stop that work before retrying.");
      return;
    }
    const decision = await dialog.prompt({
      title: "Retry blocked Stage",
      message: `Orca reports Dispatch ${row.dispatchId} exited, but the provider session is ${sessionStatus ?? "unbound"}. A detached task might still run. This starts the Run, retries this Stage in its original workspace and model, and may also dispatch other ready Stages.${row.launchEvidence?.agent === "codex" ? " If Orca still omits --dispatch-capability, Codex worker_done may be rejected again." : ""} Enter the exact Dispatch ID to accept that risk.`,
      fieldLabel: "Dispatch ID",
      confirmLabel: "Retry Stage",
      tone: "danger",
    });
    if (decision?.trim() !== row.dispatchId) return;
    setBusyId(row.dispatchId);
    setErr(null);
    onRunStarting?.(runId);
    let started: RunStatus | null = null;
    try {
      started = await startRun(
        runId, harnessMap(taskIds), config.defaultHarness, getMaxConcurrency(),
        modelMap(taskIds), effortMap(taskIds), retainMap(taskIds),
        environmentMap(taskIds), placementMap(taskIds), lanesSpecMap(),
        laneMap(taskIds),
        { dispatchId: row.dispatchId, allowUnknownProvider: sessionStatus !== "exited" },
      );
      onRetried();
    } catch (error) {
      setErr(String((error as Error).message ?? error));
    } finally {
      setBusyId(null);
      onRunStartFinished?.(runId, started);
    }
  }

  async function saveSession(row: (typeof sessionRows)[number]) {
    const sessionId = (sessionDrafts[row.dispatchId] ?? row.binding?.sessionId ?? row.recovered?.sessionId ?? "").trim();
    if (!sessionId || row.binding || sessionBusyId || probeBusyId === row.dispatchId) return;
    setSessionBusyId(row.dispatchId);
    setSessionActionError(null);
    try {
      const binding = await saveProviderSessionBinding(row.dispatchId, {
        runId,
        taskId: row.taskId,
        harness: row.harness,
        sessionId,
      });
      setSessionBindings((current) => [
        ...current.filter((item) => item.dispatchId !== binding.dispatchId),
        binding,
      ]);
      setSessionDrafts((current) => ({ ...current, [row.dispatchId]: binding.sessionId }));
      setSessionProbes((current) => {
        const next = { ...current };
        delete next[row.dispatchId];
        return next;
      });
    } catch (e) {
      setSessionActionError(String((e as Error).message ?? e));
    } finally {
      setSessionBusyId(null);
    }
  }

  async function probeSession(dispatchId: string) {
    if (probeBusyId || !sessionBindings.some((binding) => binding.dispatchId === dispatchId)) return;
    setProbeBusyId(dispatchId);
    setSessionActionError(null);
    try {
      const observation = await probeProviderSession(dispatchId, runId);
      setSessionProbes((current) => ({ ...current, [dispatchId]: observation }));
    } catch (e) {
      setSessionActionError(String((e as Error).message ?? e));
    } finally {
      setProbeBusyId(null);
    }
  }

  function providerStatusLabel(status: ProviderSessionObservationView["status"] | null | undefined) {
    switch (status) {
      case "active": return "Active";
      case "idle": return "Idle";
      case "exited": return "Exited";
      case "unavailable": return "Unavailable";
      case "unknown": return "Unknown";
      default: return "Not probed";
    }
  }

  function renderSessionRow(row: (typeof sessionRows)[number]) {
    const observation = sessionProbes[row.dispatchId];
    const startup = row.recovered;
    const binding = row.binding;
    const sessionId = binding?.sessionId ?? startup?.sessionId ?? "";
    const startupMatchesSession = Boolean(startup && startup.sessionId === sessionId);
    const status = observation?.status ?? (startupMatchesSession ? startup?.status : null) ?? null;
    const detail = observation?.detail ?? (startupMatchesSession ? startup?.detail : null) ?? null;
    const observedAt = observation?.observedAt ?? (startupMatchesSession ? startup?.observedAt : null) ?? null;
    const draftSessionId = (sessionDrafts[row.dispatchId] ?? sessionId).trim();
    const bindingMatchesDraft = Boolean(binding && draftSessionId === binding.sessionId);
    const supportedHarness = row.harness === "claude" || row.harness === "codex" || row.harness === "opencode";
    const host = binding?.host ?? startup?.host ?? (
      row.worker?.projection?.host
        ? `${row.worker.projection.host.kind}:${row.worker.projection.host.id}`
        : null
    );
    const workspace = binding?.workspace ?? startup?.workspace ??
      workerWorkspaceLabel(row.worker?.projection?.workspace);
    return (
      <div key={row.dispatchId} className="gate inbox__item inbox__debt" data-operation-kind="session-recovery">
        <div className="gate__badge">{row.harness} provider session</div>
        <div className="gate__question">
          <code>{row.taskId}</code> · Dispatch <code>{row.dispatchId}</code>
        </div>
        <div className="inbox__body">
          <div><strong>Orca Dispatch:</strong> {row.dispatchStatus}</div>
          <div><strong>Orca liveness:</strong> {row.dispatchLiveness ?? "unknown"}</div>
          <div><strong>Provider session:</strong> {providerStatusLabel(status)}{startupMatchesSession && !observation ? " (coordinator snapshot)" : ""}</div>
          {detail && <div>{detail}</div>}
          {observedAt && <div>Observed at {new Date(observedAt).toLocaleString()}</div>}
          {(host || workspace) && (
            <div>
              Identity context: {host ?? "host unknown"}
              {workspace ? ` · ${workspace}` : ""}
            </div>
          )}
          {startup && <div>Recovery decision: {startup.decision}{startup.source ? ` · evidence: ${startup.source}` : ""}</div>}
        </div>
        <div className="inbox__reply recovery__session-form">
          <input
            className="inbox__input"
            aria-label={`Provider session ID for Dispatch ${row.dispatchId}`}
            placeholder={supportedHarness ? `Exact ${row.harness} session ID` : "Session binding unsupported for this harness"}
            value={sessionDrafts[row.dispatchId] ?? sessionId}
            readOnly={Boolean(binding) || !supportedHarness}
            onChange={(event) => setSessionDrafts((current) => ({ ...current, [row.dispatchId]: event.target.value }))}
          />
          <button
            className="btn btn--gate btn--ok"
            disabled={Boolean(binding) || !supportedHarness || sessionBusyId !== null || probeBusyId === row.dispatchId || !draftSessionId}
            title={!supportedHarness ? "Session probing currently supports Claude, Codex and OpenCode." : undefined}
            onClick={() => void saveSession(row)}
          >
            {sessionBusyId === row.dispatchId ? "Saving…" : binding ? "Already bound" : "Bind session"}
          </button>
          <button
            className="btn btn--gate"
            disabled={probeBusyId !== null || sessionBusyId !== null || !bindingMatchesDraft}
            title={!binding ? "Save an exact session ID binding before probing" : !bindingMatchesDraft ? "Save the changed ID before probing this session" : "Read provider status for this exact session ID"}
            onClick={() => void probeSession(row.dispatchId)}
          >
            {probeBusyId === row.dispatchId ? "Probing…" : "Probe status"}
          </button>
        </div>
      </div>
    );
  }

  if (!runId || !anythingToShow) return null;

  return (
    <div className="gates inbox recovery" data-testid="recovery-panel">
      {recovery && recovery.activeAdopted.length > 0 && (
        <div className="gate inbox__item">
          <div className="gate__badge">Restart recovery</div>
          <div className="gate__question">
            Adopted {recovery.activeAdopted.length} running Dispatch
            {recovery.activeAdopted.length === 1 ? "" : "es"} from before the restart
          </div>
          <div className="inbox__body">
            {recovery.activeAdopted.map((id) => (
              <div key={id}>
                <code>{id}</code> — counted against concurrency, never double-placed
              </div>
            ))}
          </div>
        </div>
      )}

      {recovery && recovery.settledAdopted.length > 0 && (
        <div className="gate inbox__item">
          <div className="gate__badge">Restart recovery</div>
          <div className="gate__question">
            {recovery.settledAdopted.length} settled Dispatch
            {recovery.settledAdopted.length === 1 ? "" : "es"} awaiting cleanup
          </div>
          <div className="inbox__body">
            {recovery.settledAdopted.map((id) => (
              <div key={id}>
                <code>{id}</code> — released (or surfaced as debt) from Orca's own records
              </div>
            ))}
          </div>
        </div>
      )}

      {recovery && recovery.unverifiable.length > 0 && (
        <div className="gate inbox__item inbox__debt">
          <div className="gate__badge">Unverifiable Dispatch</div>
          <div className="gate__question">{recovery.unverifiable.length} Dispatch{recovery.unverifiable.length === 1 ? "" : "es"} without verifiable state</div>
          <div className="inbox__body">
            {recovery.unverifiable.map((id) => (
              <div key={id}>
                <code>{id}</code> — left untouched: missing/unverifiable status is never acted on
              </div>
            ))}
          </div>
        </div>
      )}

      {retryBlockedRows.length > 0 && (
        <div className="gate inbox__item inbox__debt" data-operation-kind="session-recovery-blocked">
          <div className="gate__badge">Stage resume blocked</div>
          <div className="gate__question">
            {retryBlockedRows.length} stopped Stage{retryBlockedRows.length === 1 ? " is" : "s are"} held from requeue until its exact provider session is confirmed exited
          </div>
          <div className="inbox__body">
            {retryBlockedRows.map((entry) => (
              <div key={entry.dispatchId}>
                <strong>Stage <code>{entry.taskId}</code></strong> · Dispatch <code>{entry.dispatchId}</code>
                <div>{entry.reason}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {blockedHistory.length > 0 && (
        <div className="gate inbox__item inbox__debt" data-operation-kind="blocked-stage-resolution">
          <div className="gate__badge">Blocked Stage recovery</div>
          <div className="gate__question">Review an exited worker before resolving or retrying its Stage</div>
          <div className="inbox__body">
            Abandon settles the Dispatch only; it does not change a blocked Task. A reviewed result can complete the Task without rerunning work. Retry reuses the historical model and workspace. Both actions recheck Orca state.
          </div>
          {blockedHistory.map((row) => {
            const exited = row.projection?.liveness?.verdict === "exited";
            const unavailable = disabled || Boolean(busyId) || Boolean(status?.running) || !exited;
            return (
              <div key={row.dispatchId} className="inbox__body">
                <strong>Stage <code>{row.taskId}</code></strong> · Dispatch <code>{row.dispatchId}</code>
                <div>Fleet liveness: {row.projection?.liveness?.verdict ?? "unknown"}</div>
                {row.launchEvidence?.agent === "codex" && (
                  <div>Review Codex output before retrying: a preamble without <code>--dispatch-capability</code> can reject <code>worker_done</code> again.</div>
                )}
                <div className="gate__actions">
                  <button className="btn btn--gate" disabled={unavailable} onClick={() => void resolveBlocked(row)}>
                    {busyId === row.dispatchId ? "Working…" : "Record reviewed completion"}
                  </button>
                  <button className="btn btn--gate" disabled={unavailable} onClick={() => void resumeBlocked(row)}>
                    Retry original launch
                  </button>
                </div>
              </div>
            );
          })}
          {disabledReason && disabled && <div className="inbox__body">{disabledReason}</div>}
        </div>
      )}

      {optionalActiveSessionCandidates.length > 0 && (
        <details
          className="gate inbox__item recovery__active-session-candidates"
          open={showActiveSessionCandidates}
          onToggle={(event) => setShowActiveSessionCandidates(event.currentTarget.open)}
        >
          <summary>
            Bind active session · {optionalActiveSessionCandidates.length} eligible Dispatch{optionalActiveSessionCandidates.length === 1 ? "" : "es"}
          </summary>
          {showActiveSessionCandidates && (
            <>
              <div className="inbox__body">
                Exact sessions are bound automatically when the provider exposes a unique Dispatch match. If discovery has not succeeded, enter a known session ID here before stopping the coordinator.
              </div>
              {expandedActiveSessionRows.map(renderSessionRow)}
              {sessionActionError && <div className="exec__err inbox__err">⚠️ {sessionActionError}</div>}
            </>
          )}
        </details>
      )}

      {(recoverySessionRows.length > 0 || sessionLoadError !== null) && (
        <section className="recovery__sessions" aria-label="Provider session recovery">
          <div className="gate inbox__item">
            <div className="gate__badge">Provider session recovery</div>
            <div className="gate__question">Provider sessions stay separate from Orca Dispatch lifecycle</div>
            <div className="inbox__body">
              A session ID binds one provider session to one exact Run, Task, harness, and Dispatch. Existing bindings are immutable; changing one needs a verified handoff path. Probes run only when requested. An Orca message being queued confirms enqueue only; it does not confirm delivery or that the provider read it.
            </div>
            <div className="gate__actions">
              <button className="btn btn--gate" disabled={sessionLoading} onClick={() => void loadSessionRecovery()}>
                {sessionLoading ? "Refreshing…" : "Refresh bindings and Dispatch state"}
              </button>
            </div>
            {sessionLoadError && <div className="exec__err inbox__err">⚠️ {sessionLoadError}</div>}
          </div>

          {recoverySessionRows.map(renderSessionRow)}
          {sessionActionError && <div className="exec__err inbox__err">⚠️ {sessionActionError}</div>}
        </section>
      )}

      {pendingStarts.map((a) => (
        <div key={`pending-${a.taskId}`} className="gate inbox__item">
          <div className="gate__badge">Start outcome pending</div>
          <div className="gate__question">
            <code>{a.taskId}</code> — worker-start response lost, resolving idempotently
          </div>
          <div className="inbox__body">
            Durable request id <code>{a.startRequestId}</code>: the coordinator asks Orca whether the
            start landed and replays the SAME id — never a second Dispatch.
          </div>
        </div>
      ))}

      {failedStarts.map((a) => (
        <div
          key={`failed-${a.taskId}`}
          className="gate inbox__item inbox__debt"
          data-operation-kind="recovery"
          data-operation-id={a.taskId}
          tabIndex={-1}
        >
          <div className="gate__badge">Start failed{a.startReceipt?.failedStage ? ` at ${a.startReceipt.failedStage}` : ""}</div>
          <div className="gate__question">
            <code>{a.taskId}</code>
            {a.startReceipt?.requestId ? ` · request ${a.startReceipt.requestId.slice(0, 8)}…` : ""}
          </div>
          {a.terminalDetail && <div className="inbox__body">{a.terminalDetail}</div>}
          {a.startReceipt && a.startReceipt.recoveryCommands.length > 0 && (
            <div className="inbox__body">
              Prescribed: {a.startReceipt.recoveryCommands.map((c) => <code key={c}>{c}</code>)}
            </div>
          )}
          <div className="gate__actions">
            <button
              className="btn btn--gate btn--ok"
              disabled={disabled || busy(a.taskId) || !status?.running}
              title={
                !status?.running
                  ? "Start the coordinator first — the retry needs its bound terminal"
                  : "Re-place this attempt with the same harness/model/placement (worker-start --retry-of)"
              }
              onClick={() => void retry(a)}
            >
              {busy(a.taskId) ? "…" : "Retry"}
            </button>
          </div>
        </div>
      ))}

      {prescribed.map((a) => (
        <div key={`next-${a.taskId}`} className="gate inbox__item">
          <div className="gate__badge">Orca prescribes</div>
          <div className="gate__question">
            <code>{a.taskId}</code> — {a.nextAction!.kind}
          </div>
          <div className="inbox__body">
            <code>{a.nextAction!.argv.join(" ")}</code>
          </div>
        </div>
      ))}

      {err && <div className="exec__err inbox__err">⚠️ {err}</div>}
      {disabled && disabledReason && <div className="exec__hint">🔒 {disabledReason}</div>}
    </div>
  );
});
