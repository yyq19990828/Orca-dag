import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRunStatus, startRun, stopRun } from "../api";
import { DoodleSelect } from "./DoodleSelect";
import { useDecisionDialog } from "./DecisionDialog";
import {
  getMaxConcurrency,
  effortMap,
  environmentMap,
  harnessMap,
  modelMap,
  placementMap,
  retainMap,
  setDefaultHarness,
  setMaxConcurrency,
  useConfig,
  useFlags,
  useReadiness,
} from "../harness";
import { HARNESSES, type RunStatus } from "../types";

const CUSTOM = "__custom__";
const KNOWN = HARNESSES as readonly string[];

/** Custom harness commands are a server-side policy (see /api/session). */
const CUSTOM_OFF_HINT = "Custom commands are disabled — start the viewer with ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1";

/**
 * Execution controls. The coordinator is DAG-driven: click Run and it dispatches
 * every ready task in parallel (up to a concurrency cap), each on its own node's
 * harness — no manual worker count. Here you only set the fallback harness for
 * nodes without an explicit choice, and the parallelism cap. Both persist to the
 * server-side config file.
 *
 * Starting binds an Orca terminal as the Run's coordinator, which fences any
 * agent terminal currently coordinating that Run — so we confirm first.
 */
export function ExecControls({
  runId,
  taskIds,
  readyCount = 0,
  startingRunId = null,
  workerHistoryLoading = false,
  workerHistoryError = null,
  onRunStarting,
  onRunStartFinished,
}: {
  /** Run to execute. Mutations are Run-scoped since Orca 1.4.160. */
  runId: string;
  taskIds: string[];
  /** ready-but-unfired tasks — the Run button nudges itself when there are any */
  readyCount?: number;
  /** Local App signal raised before POST /api/run can report a bound runId. */
  startingRunId?: string | null;
  /** Worker history is the durable launch-lock source; uncertainty fails closed. */
  workerHistoryLoading?: boolean;
  workerHistoryError?: string | null;
  onRunStarting?: (runId: string) => void;
  onRunStartFinished?: (runId: string, status: RunStatus | null) => void;
}) {
  const dialog = useDecisionDialog();
  const config = useConfig();
  const { customCommandsAllowed: customOk } = useFlags();
  // Execution gate (Phase 2): the server probes the resolved Orca CLI once.
  // null = probe still in flight (controls stay live); false = view-only.
  const readiness = useReadiness();
  const execOff = readiness !== null && !readiness.executionEnabled;
  const storedIsCustom = !KNOWN.includes(config.defaultHarness);
  // "Custom…" selected but not yet typed — a UI-only state until run()
  const [forceCustom, setForceCustom] = useState(false);
  const [custom, setCustom] = useState(storedIsCustom ? config.defaultHarness : "");
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const taskIdsRef = useRef(taskIds);
  taskIdsRef.current = taskIds;

  // a custom default arriving from the config file (initial load) fills the input
  useEffect(() => {
    if (storedIsCustom) setCustom(config.defaultHarness);
  }, [storedIsCustom, config.defaultHarness]);

  const defHarness = forceCustom || storedIsCustom ? CUSTOM : config.defaultHarness;

  const poll = useCallback(async () => {
    try {
      setStatus(await fetchRunStatus());
    } catch {
      /* ignore transient */
    }
  }, []);

  useEffect(() => {
    poll();
    const t = window.setInterval(poll, 2000);
    return () => window.clearInterval(t);
  }, [poll]);

  // The status endpoint is process-local and can describe another selected
  // Run. Only a matching runId grants this panel running/stop authority.
  const ownStatus = status?.runId === runId ? status : null;
  const otherRunStatus =
    status?.running && status.runId && status.runId !== runId ? status : null;
  const running = ownStatus?.running ?? false;
  const starting = startingRunId === runId;
  const anotherRunStarting = Boolean(startingRunId && startingRunId !== runId);
  const phase = ownStatus?.phase ?? (starting ? "binding" : "idle");
  const historyLockReason = workerHistoryError
    ? "Launch settings are locked while Dispatch history could not be verified. Wait for worker history to recover before editing."
    : workerHistoryLoading
      ? "Launch settings are locked while Dispatch history is loading. Wait for worker history to finish before editing."
      : null;
  const launchLockReason = running
    ? "Launch settings are frozen while this Run is executing. Stop the coordinator to edit Tasks that have not started."
    : starting
      ? "Launch settings are frozen while this Run is starting. Wait for coordinator binding and recovery to finish before editing."
      : historyLockReason;
  const launchLocked = running || starting || Boolean(historyLockReason);
  const resolvedDefault = defHarness === CUSTOM ? custom.trim() : defHarness;
  // Dispatch.failure_count > 0 means Orca already retried this attempt.
  const retrying = (ownStatus?.attempts ?? []).filter((a) => !a.settled && a.failureCount > 0).length;
  // Settlement/ownership bookkeeping worth surfacing while the loop runs.
  const settled = (ownStatus?.attempts ?? []).filter((a) => a.settled).length;
  const released = (ownStatus?.attempts ?? []).filter((a) =>
    ["released", "retained", "closed"].includes(a.terminalDecision),
  ).length;
  const stopReport = ownStatus?.lastStopReport ?? null;
  const stopUncertain = stopReport?.results.filter((r) => r.result === "unknown") ?? [];

  /** Short human label for the coordinator's §6.3 phase. */
  const PHASE_LABEL: Record<string, string> = {
    idle: "Idle",
    binding: "Binding…",
    running: "Running",
    awaiting_input: "Waiting for you",
    stopping: "Stopping…",
    completed: "Completed",
    recovering: "Recovering",
    error: "Error",
  };

  function pickDefault(h: string) {
    if (launchLocked) return;
    if (h === CUSTOM) {
      setForceCustom(true);
      return;
    }
    setForceCustom(false);
    setDefaultHarness(h);
  }

  async function run() {
    if (!runId) {
      setErr("Pick a Run first");
      return;
    }
    // Mirror the server's execution gate for a fast, clear error — the server
    // re-checks (503) regardless, so this is UX, not the real gate.
    if (execOff) {
      setErr(readiness?.reason ?? "Execution is unavailable on this Orca runtime.");
      return;
    }
    if (!resolvedDefault) {
      setErr("Pick a default harness");
      return;
    }
    if (launchLocked) {
      setErr(launchLockReason ?? "Launch settings are temporarily locked.");
      return;
    }
    if (anotherRunStarting) {
      setErr(`Run ${startingRunId} is already starting in this viewer.`);
      return;
    }
    if (otherRunStatus) {
      setErr(`Run ${otherRunStatus.runId} is already executing in this viewer. Pick that Run to stop it.`);
      return;
    }
    // Mirror the server's custom-command policy for a fast, clear error — the
    // server re-checks (403) regardless, so this is UX, not the real gate.
    if (!customOk) {
      const customs = [resolvedDefault, ...Object.values(harnessMap(taskIdsRef.current))].some(
        (h) => !KNOWN.includes(h),
      );
      if (customs) {
        setErr(CUSTOM_OFF_HINT);
        return;
      }
    }
    // Binding is the only way to get mutation authority on a Run, and it fences
    // whoever held it — usually the agent terminal that drew this DAG.
    const ok = await dialog.confirm({
      title: "Let Viewer coordinate this Run?",
      message:
        "Starting execution transfers coordinator authority to the Viewer. Any agent terminal " +
        "currently coordinating this Run will be fenced, so its orchestration mutations will fail " +
        "with consumer_fenced. It can take authority back with:\n\n" +
        `orca orchestration run-use --id ${runId}`,
      confirmLabel: "Start Run",
      cancelLabel: "Not now",
    });
    if (!ok) return;

    if (defHarness === CUSTOM) setDefaultHarness(resolvedDefault);
    // Raise the App-level lock before the request: the server's binding and
    // recovery phases intentionally precede the first status with runId.
    onRunStarting?.(runId);
    setBusy(true);
    setErr(null);
    let startedStatus: RunStatus | null = null;
    try {
      const s = await startRun(
        runId,
        harnessMap(taskIdsRef.current),
        resolvedDefault,
        getMaxConcurrency(),
        modelMap(taskIdsRef.current),
        effortMap(taskIdsRef.current),
        retainMap(taskIdsRef.current),
        // Phase 6: per-node saved environment + exact placement, sent
        // explicitly (same reason as effort/retain — avoids the 250 ms
        // config-write debounce racing the run request).
        environmentMap(taskIdsRef.current),
        placementMap(taskIdsRef.current),
      );
      startedStatus = s;
      setStatus(s);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
      onRunStartFinished?.(runId, startedStatus);
    }
  }

  async function stop() {
    if (!running) return;
    setBusy(true);
    setErr(null);
    try {
      await stopRun();
      await poll();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="exec">
      <div className="exec__field">
        <span className="exec__label">Default harness</span>
        <DoodleSelect
          size="sm"
          value={defHarness}
          onChange={pickDefault}
          disabled={launchLocked}
          options={[
            ...HARNESSES.map((h) => ({ value: h, label: h })),
            // "Custom…" only exists while the server allows custom commands —
            // but a *stored* custom default must stay visible (and switchable
            // away from) even when the flag is off, so it's never hidden data.
            ...(customOk || storedIsCustom
              ? [
                  {
                    value: CUSTOM,
                    label: customOk ? "Custom…" : "Custom (disabled)",
                    disabled: !customOk,
                    hint: customOk ? undefined : "ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1",
                  },
                ]
              : []),
          ]}
        />
        {defHarness === CUSTOM && (
          <input
            className="exec__custom"
            value={custom}
            placeholder="command"
            onChange={(e) => {
              if (!launchLocked) setCustom(e.target.value);
            }}
            disabled={launchLocked || !customOk}
          />
        )}
        {defHarness === CUSTOM && !customOk && <span className="exec__hint">{CUSTOM_OFF_HINT}</span>}
      </div>

      <label className="exec__field">
        <span className="exec__label">Max parallel</span>
        <input
          className="exec__num"
          type="number"
          min={1}
          max={16}
          value={config.maxConcurrency}
          onChange={(e) => {
            if (!launchLocked) setMaxConcurrency(Number(e.target.value) || 1);
          }}
          disabled={launchLocked}
        />
      </label>

      {running ? (
        <div className="exec__live">
          <button className="btn btn--stop-run" onClick={stop} disabled={busy}>
            ⏹ Stop
          </button>
          <span className="exec__running">
            <span className="exec__pulse" /> {PHASE_LABEL[phase] ?? phase} · {ownStatus?.busy ?? 0} worker
            {(ownStatus?.busy ?? 0) === 1 ? "" : "s"}
            {/* one bead per in-flight Dispatch, breathing out of phase */}
            <span className="exec__beads" aria-hidden="true">
              {Array.from({ length: Math.min(ownStatus?.busy ?? 0, 8) }, (_, i) => (
                <i key={i} style={{ animationDelay: `${i * 0.14}s` }} />
              ))}
            </span>
            {/* settled workers that reached an explicit ownership decision */}
            {settled > 0 && (
              <b className="exec__settled" title="Settled workers released/retained/closed">
                ✓ {released}/{settled} settled
              </b>
            )}
            {/* Orca circuit-breaks a task after 3 failed attempts — surface it early */}
            {retrying > 0 && <b className="exec__retry">↻ {retrying} retrying</b>}
          </span>
        </div>
      ) : starting ? (
        <div className="exec__live">
          <span className="exec__running">
            <span className="exec__pulse" /> Binding and recovering…
          </span>
        </div>
      ) : phase === "completed" ? (
        <div className="exec__live">
          <button
            className="btn btn--run"
            onClick={run}
            disabled={busy || launchLocked || anotherRunStarting || Boolean(otherRunStatus) || !runId || execOff}
            title="Run again"
          >
            ▶ Run again
          </button>
          <span
            className="exec__running exec__done"
            title={ownStatus?.completedAt ? `Completed at ${new Date(ownStatus.completedAt).toLocaleTimeString()}` : undefined}
          >
            ✓ Completed · {ownStatus?.attempts.length ?? 0} worker
            {(ownStatus?.attempts.length ?? 0) === 1 ? "" : "s"} released
          </span>
        </div>
      ) : (
        <button
          className={`btn btn--run${readyCount > 0 && !busy && !execOff ? " btn--attract" : ""}`}
          onClick={run}
          disabled={
            busy || launchLocked || anotherRunStarting || Boolean(otherRunStatus) || taskIds.length === 0 || !runId || execOff
          }
          title={
            execOff
              ? readiness?.reason ?? "Execution is unavailable on this Orca runtime"
              : runId
                ? "Bind this Run and execute in dependency order"
                : "Pick a Run first"
          }
        >
          {execOff ? "View-only" : "▶ Run with Orca"}
        </button>
      )}

      {/* explicit Stop must report every uncertain teardown, never swallow it */}
      {stopReport && !running && (
        <div className={`exec__stop-report${stopReport.clean ? "" : " exec__stop-report--warn"}`}>
          {stopReport.clean ? "Stop clean" : `Stop finished with ${stopUncertain.length} uncertain`} ·{" "}
          {stopReport.results.length} action{stopReport.results.length === 1 ? "" : "s"}
          {stopUncertain.length > 0 && (
            <ul className="exec__stop-unknowns">
              {stopUncertain.map((r, i) => (
                <li key={`${r.target}-${i}`}>
                  <code>{r.target}</code> ({r.kind}) — {r.detail ?? "outcome unknown"}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {execOff && <span className="exec__hint">🔒 {readiness?.reason}</span>}

      {launchLockReason && <span className="exec__hint">🔒 {launchLockReason}</span>}
      {workerHistoryError && (
        <span className="exec__hint">
          ⚠️ Dispatch history could not be verified; launch settings remain locked until verification recovers.
        </span>
      )}
      {otherRunStatus && (
        <span className="exec__hint">
          🔒 Run <code>{otherRunStatus.runId}</code> is executing; its Stop control appears when you select that Run.
        </span>
      )}
      {anotherRunStarting && !otherRunStatus && (
        <span className="exec__hint">
          🔒 Run <code>{startingRunId}</code> is binding in this viewer; select it after startup to inspect or stop it.
        </span>
      )}

      {(err || ownStatus?.error) && <span className="exec__err">⚠️ {err || ownStatus?.error}</span>}
    </div>
  );
}
