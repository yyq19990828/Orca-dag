import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRunStatus, startRun, stopRun } from "../api";
import { DoodleSelect } from "./DoodleSelect";
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
}: {
  /** Run to execute. Mutations are Run-scoped since Orca 1.4.160. */
  runId: string;
  taskIds: string[];
  /** ready-but-unfired tasks — the Run button nudges itself when there are any */
  readyCount?: number;
}) {
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

  const running = status?.running ?? false;
  const phase = status?.phase ?? "idle";
  const resolvedDefault = defHarness === CUSTOM ? custom.trim() : defHarness;
  // Dispatch.failure_count > 0 means Orca already retried this attempt.
  const retrying = (status?.attempts ?? []).filter((a) => !a.settled && a.failureCount > 0).length;
  // Settlement/ownership bookkeeping worth surfacing while the loop runs.
  const settled = (status?.attempts ?? []).filter((a) => a.settled).length;
  const released = (status?.attempts ?? []).filter((a) =>
    ["released", "retained", "closed"].includes(a.terminalDecision),
  ).length;
  const stopReport = status?.lastStopReport ?? null;
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
    const ok = confirm(
      "Starting execution binds this Run's coordinator to the viewer.\n\n" +
        "Any agent terminal currently coordinating the Run gets fenced (its orchestration " +
        "mutations start failing with consumer_fenced). It can take the Run back anytime with " +
        "orca orchestration run-use --id " +
        runId +
        ".\n\nContinue?",
    );
    if (!ok) return;

    if (defHarness === CUSTOM) setDefaultHarness(resolvedDefault);
    setBusy(true);
    setErr(null);
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
      setStatus(s);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
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
          disabled={running}
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
            onChange={(e) => setCustom(e.target.value)}
            disabled={running || !customOk}
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
          onChange={(e) => setMaxConcurrency(Number(e.target.value) || 1)}
          disabled={running}
        />
      </label>

      {running ? (
        <div className="exec__live">
          <button className="btn btn--stop-run" onClick={stop} disabled={busy}>
            ⏹ Stop
          </button>
          <span className="exec__running">
            <span className="exec__pulse" /> {PHASE_LABEL[phase] ?? phase} · {status?.busy ?? 0} worker
            {(status?.busy ?? 0) === 1 ? "" : "s"}
            {/* one bead per in-flight Dispatch, breathing out of phase */}
            <span className="exec__beads" aria-hidden="true">
              {Array.from({ length: Math.min(status?.busy ?? 0, 8) }, (_, i) => (
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
      ) : phase === "completed" ? (
        <div className="exec__live">
          <button className="btn btn--run" onClick={run} disabled={busy || !runId || execOff} title="Run again">
            ▶ Run again
          </button>
          <span className="exec__running exec__done" title={status?.completedAt ? `Completed at ${new Date(status.completedAt).toLocaleTimeString()}` : undefined}>
            ✓ Completed · {status?.attempts.length ?? 0} worker
            {(status?.attempts.length ?? 0) === 1 ? "" : "s"} released
          </span>
        </div>
      ) : (
        <button
          className={`btn btn--run${readyCount > 0 && !busy && !execOff ? " btn--attract" : ""}`}
          onClick={run}
          disabled={busy || taskIds.length === 0 || !runId || execOff}
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

      {(err || status?.error) && <span className="exec__err">⚠️ {err || status?.error}</span>}
    </div>
  );
}
