import { useCallback, useEffect, useState } from "react";
import { fetchEnvironments, fetchRunStatus, fetchWorkerOutput, releaseWorker, retainWorker } from "../api";
import type { RunAttempt, RunStatus, WorkerOutputView } from "../types";

/**
 * Worker observability (Phase 5): per-attempt fleet liveness (+ the runtime's
 * own reason), attention categories, agent-wait stage, terminal accounting,
 * requested vs effective launch preferences, Orca's literal prescribed next
 * action, and bounded output reading with cursor paging. Also hosts the
 * explicit retain-for-debugging / release controls for settled workers.
 *
 * Everything here is evidence-backed: effective preferences come only from
 * runtime echoes (unechoed → "unknown", never assumed applied), liveness
 * renders only live/unverifiable/exited, and a `source_changed` answer
 * restarts the read with a visible warning instead of silently jumping.
 */
export function WorkerPanel({
  runId,
  disabled = false,
  disabledReason,
  pollMs = 2000,
}: {
  runId: string;
  disabled?: boolean;
  disabledReason?: string | null;
  pollMs?: number;
}) {
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [output, setOutput] = useState<WorkerOutputView | null>(null);
  const [outputErr, setOutputErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Phase 6: structured-read source picker + the environment capability list
  // it is gated on (cached in api.ts; one fetch, not one per poll tick).
  const [source, setSource] = useState<string>("auto");
  const [envs, setEnvs] = useState<Awaited<ReturnType<typeof fetchEnvironments>>>([]);
  useEffect(() => {
    let alive = true;
    fetchEnvironments()
      .then((e) => alive && setEnvs(e))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await fetchRunStatus();
        if (alive) setStatus(s);
      } catch {
        /* transient — keep the last known state */
      }
    };
    void load();
    const t = window.setInterval(load, pollMs);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [pollMs]);

  const loadOutput = useCallback(
    async (a: RunAttempt, cursor?: string, src?: string) => {
      if (!a.dispatchId) return;
      setOutputErr(null);
      try {
        const page = await fetchWorkerOutput(a.dispatchId, {
          cursor,
          limit: 40,
          source: src && src !== "auto" ? src : undefined,
        });
        setOutput((prev) => {
          // A cursor page CONTINUES the previous read; a fresh read replaces it.
          if (cursor && prev && prev.dispatchId === page.dispatchId && !page.sourceChanged) {
            return { ...page, lines: [...prev.lines, ...page.lines] };
          }
          return page;
        });
      } catch (e) {
        setOutputErr(String((e as Error).message ?? e));
      }
    },
    [],
  );

  async function decide(a: RunAttempt, kind: "release" | "retain") {
    if (!a.dispatchId) return;
    setBusyId(a.dispatchId);
    setErr(null);
    try {
      await (kind === "release" ? releaseWorker(a.dispatchId) : retainWorker(a.dispatchId));
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusyId(null);
    }
  }

  const attempts = status?.attempts ?? [];
  if (!runId || attempts.length === 0) return null;

  return (
    <div className="gates inbox workers" data-testid="worker-panel">
      <div className="gate inbox__item">
        <div className="gate__badge">Workers · fleet view</div>
        {attempts.map((a) => {
          const open = openTask === a.taskId;
          const settledDecided = ["released", "retained", "closed", "reused", "not_needed"].includes(
            a.terminalDecision,
          );
          const modelMismatch =
            a.effective?.model != null && a.requested.model != null && a.effective.model !== a.requested.model;
          const effortMismatch =
            a.effective?.effort != null && a.requested.effort != null && a.effective.effort !== a.requested.effort;
          // Phase 6: the execution host that owns this worker's process and
          // transcript. Null = never reported — shown as unknown, never as a
          // synthesized "local".
          const hostLabel =
            a.host == null
              ? "unknown"
              : a.host.kind === "local"
                ? "local (this server)"
                : `environment ${a.host.id}`;
          const hostEnv = a.host ? envs.find((e) => e.id === a.host!.id) : undefined;
          // Structured transcript reads are a peer capability: offered for
          // local workers always, for remote workers only when their
          // environment advertises it. Unknown host → auto only (never guess).
          const canTranscript =
            a.host?.kind === "local" ||
            (a.host?.kind != null && a.host.kind !== "local" && (hostEnv?.peer.transcriptRead ?? false));
          return (
            <div key={`${a.taskId}-${a.dispatchId ?? "pending"}`} className="workers__row">
              <button
                className="workers__toggle"
                onClick={() => {
                  const next = open ? null : a.taskId;
                  setOpenTask(next);
                  setOutput(null);
                  setOutputErr(null);
                  setSource("auto"); // per-attempt read state resets on switch
                  if (next) void loadOutput(a);
                }}
              >
                <span className="workers__liveness" data-verdict={a.liveness ?? "unverifiable"}>
                  {a.liveness ?? "unverifiable"}
                </span>
                <code className="workers__task">{a.taskId}</code>
                <span className="inbox__meta">
                  {a.harness}
                  {a.reuseOf ? " · reused terminal" : ""}
                  {a.settled ? ` · ${a.terminalDecision}` : " · running"}
                </span>
              </button>

              {open && (
                <div className="workers__detail">
                  <div className="inbox__body">
                    Liveness: <b>{a.liveness ?? "unverifiable"}</b>
                    {a.livenessReason ? ` — ${a.livenessReason}` : ""}
                    {a.stage && a.stage.activity !== "unknown" ? ` · agent: ${a.stage.activity}` : ""}
                  </div>
                  <div className="inbox__body">
                    Execution host: <b>{hostLabel}</b>
                    {a.requested.on ? ` · placed via --on ${a.requested.on}` : ""}
                    {a.host?.kind != null && a.host.kind !== "local" && a.liveness === "unverifiable"
                      ? " · contact lost is NOT exit — the Dispatch is preserved"
                      : ""}
                  </div>
                  {a.attention && a.attention.categories.length > 0 && (
                    <div className="inbox__body">
                      Attention: {a.attention.categories.join(", ")}
                      {a.attention.requiresAction ? " · needs action" : ""}
                    </div>
                  )}
                  <div className="inbox__body">
                    Terminal: <code>{a.agentTerminalHandle ?? "unknown"}</code> · Orca:{" "}
                    <code>{a.fleetTerminalState ?? "unknown"}</code> · viewer: {a.terminalDecision}
                  </div>
                  <div className="inbox__body">
                    Launch — agent {a.requested.agent ?? "?"}
                    {a.requested.model ? ` · model ${a.requested.model}` : ""}
                    {a.requested.effort ? ` · effort ${a.requested.effort}` : ""}
                    {" → effective "}
                    {a.effective
                      ? [
                          a.effective.agent ?? "unknown agent",
                          a.effective.model ?? "unknown model",
                          ...(a.effective.effort ? [`effort ${a.effective.effort}`] : []),
                        ].join(", ")
                      : "unknown (no receipt echo)"}
                    {(modelMismatch || effortMismatch) && (
                      <b className="workers__mismatch"> · requested ≠ effective</b>
                    )}
                  </div>
                  {a.nextAction && a.nextAction.argv.length > 0 && (
                    <div className="inbox__body">
                      Orca prescribes: <code>{a.nextAction.argv.join(" ")}</code>
                    </div>
                  )}

                  {output?.dispatchId === a.dispatchId && output.lines.length > 0 && (
                    <pre className="workers__output">
                      {output.lines.join("\n")}
                      {!output.contentComplete && "\n…"}
                    </pre>
                  )}
                  {output?.dispatchId === a.dispatchId && output.sourceChanged && (
                    <div className="inbox__body workers__warn">Output source changed — read restarted from the start.</div>
                  )}
                  {output?.dispatchId === a.dispatchId &&
                    output.warnings.map((w, i) => (
                      <div key={i} className="inbox__body workers__warn">
                        ⚠ {w}
                      </div>
                    ))}
                  {outputErr && <div className="exec__err inbox__err">⚠️ {outputErr}</div>}
                  <div className="gate__actions">
                    {/* Structured reads: `transcript` appears only where the
                        execution host's peer advertises it (auto always works
                        — the runtime picks whatever source it can). */}
                    {canTranscript && (
                      <select
                        className="workers__source"
                        value={source}
                        onChange={(e) => {
                          setSource(e.target.value);
                          if (a.dispatchId) void loadOutput(a, undefined, e.target.value);
                        }}
                      >
                        <option value="auto">source: auto</option>
                        <option value="transcript">source: transcript</option>
                      </select>
                    )}
                    {output && output.cursor && (
                      <button
                        className="btn btn--gate"
                        onClick={() => a.dispatchId && void loadOutput(a, output.cursor ?? undefined, source)}
                      >
                        Load more
                      </button>
                    )}
                    {a.settled && a.dispatchId && !settledDecided && (
                      <>
                        <button
                          className="btn btn--gate btn--ok"
                          disabled={disabled || busyId === a.dispatchId}
                          onClick={() => void decide(a, "release")}
                          title="worker-release — the default post-settlement decision"
                        >
                          Release
                        </button>
                        <button
                          className="btn btn--gate"
                          disabled={disabled || busyId === a.dispatchId}
                          onClick={() => void decide(a, "retain")}
                          title="worker-retain — keep this terminal alive for inspection"
                        >
                          Retain for debugging
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {err && <div className="exec__err inbox__err">⚠️ {err}</div>}
        {disabled && disabledReason && <div className="exec__hint">🔒 {disabledReason}</div>}
      </div>
    </div>
  );
}
