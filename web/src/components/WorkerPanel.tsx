import { useCallback, useEffect, useState } from "react";
import {
  abandonWorker,
  fetchEnvironments,
  fetchWorkerDetail,
  fetchWorkerOutput,
  focusWorker,
  releaseWorker,
  retainWorker,
  stopWorker,
} from "../api";
import { useDecisionDialog } from "./DecisionDialog";
import type {
  RunStatus,
  WorkerControlReceiptView,
  WorkerDetailView,
  WorkerOutputView,
  WorkerRowView,
  WorkerTerminalReceiptView,
} from "../types";

/**
 * Durable worker operations (Phase 2): the panel renders the Run-scoped,
 * fully paginated `worker-list` inventory passed down from App, so historical
 * and active workers stay visible even when this viewer is not coordinating
 * the Run. Expanding a row fetches `worker-show` evidence on demand — exact
 * observation, agent-wait, requested/effective launch preferences, the
 * runtime's prescribed next action — while `worker-read` output stays a
 * bounded, explicitly sourced surface with cursor paging and source-change
 * warnings.
 *
 * Everything here is evidence-backed: fleet liveness is the authoritative
 * verdict and is never upgraded from PTY facts. The one exception is the
 * runtime-documented capability gaps (`missing_status` /
 * `capability_unsupported`) where the server merges a positively exact
 * observation into a QUALIFIED working label that keeps both evidence layers
 * visible. Release/retain controls appear only when a lifecycle decision is
 * positively proven — by Orca's own `release_pending` accounting or the
 * viewer coordinator's settled-undecided attempt — never inferred.
 */

/** Terminal states the fleet can report; unknown states render verbatim. */
const TERMINAL_STATES = [
  "active",
  "release_pending",
  "retained",
  "reclaimable",
  "release_unknown",
  "released",
] as const;

/** Viewer-local post-settlement decisions that mean "nothing owed anymore". */
const DECIDED = new Set(["released", "retained", "closed", "reused", "not_needed"]);

/** The exact label the plan prescribes for a qualified capability-gap row. */
const QUALIFIED_LABEL = "Agent working · terminal live · supervised liveness unavailable";

export function WorkerPanel({
  runId,
  rows,
  rowsError,
  status,
  disabled = false,
  disabledReason,
}: {
  runId: string;
  /** Durable, Run-scoped fleet rows (fully paginated server-side). */
  rows: WorkerRowView[];
  /** Last fleet-read error — kept visible while stale rows remain on screen. */
  rowsError: string | null;
  /** Process-local coordinator state (requested launch prefs, decisions). */
  status: RunStatus | null;
  disabled?: boolean;
  disabledReason?: string | null;
}) {
  const [openDispatch, setOpenDispatch] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkerDetailView | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [output, setOutput] = useState<WorkerOutputView | null>(null);
  const [outputErr, setOutputErr] = useState<string | null>(null);
  // Phase 5: in-loaded-rows search — deliberately client-side only. It can
  // NEVER fetch more transcript than the user already paged in.
  const [outputFilter, setOutputFilter] = useState("");
  // Phase 5: the receipt of the last manual release/retain on this panel,
  // including Orca's archive facts (evidence — not settlement).
  const [decision, setDecision] = useState<{
    dispatchId: string;
    kind: "release" | "retain";
    receipt: WorkerTerminalReceiptView;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Phase 7: receipts of the per-Dispatch interventions (stop/abandon/focus),
  // kept next to the release/retain decision receipt so the row shows Orca's
  // verdict verbatim instead of silently swallowing an ambiguous outcome.
  const [control, setControl] = useState<{
    dispatchId: string;
    action: WorkerControlReceiptView["action"];
    receipt: WorkerControlReceiptView;
  } | null>(null);
  const dialog = useDecisionDialog();
  const [terminalFilter, setTerminalFilter] = useState<string>("all");
  const [attentionFilter, setAttentionFilter] = useState<string>("all");
  // Structured-read source picker + the environment capability list it is
  // gated on (cached in api.ts; one fetch, not one per render).
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

  // The status endpoint describes the one process-local coordinator, so its
  // attempts (requested launch prefs, viewer decisions) merge only under the
  // same selected Run. Rows render regardless — that is the point of Phase 2.
  const attempts = status?.runId === runId ? status.attempts : [];

  const loadOutput = useCallback(
    async (dispatchId: string, cursor?: string, src?: string) => {
      setOutputErr(null);
      try {
        const page = await fetchWorkerOutput(dispatchId, {
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

  const loadDetail = useCallback(
    async (dispatchId: string) => {
      setDetailLoading(true);
      setDetailErr(null);
      setDetail(null);
      setOutput(null);
      setOutputErr(null);
      setOutputFilter("");
      setDecision(null);
      setControl(null);
      setSource("auto");
      try {
        setDetail(await fetchWorkerDetail(runId, dispatchId));
      } catch (e) {
        setDetailErr(String((e as Error).message ?? e));
      } finally {
        setDetailLoading(false);
      }
    },
    [runId],
  );

  function toggle(row: WorkerRowView) {
    const open = openDispatch === row.dispatchId;
    setOpenDispatch(open ? null : row.dispatchId);
    setDetail(null);
    setDetailErr(null);
    if (!open && row.dispatchId) void loadDetail(row.dispatchId);
  }

  /** Bounded client-side summary of a receipt's archive facts (≤400 chars). */
  function archiveSummary(archive: Record<string, unknown> | null): string | null {
    if (!archive || typeof archive !== "object") return null;
    try {
      const json = JSON.stringify(archive);
      return json.length > 400 ? `${json.slice(0, 397)}...` : json;
    } catch {
      return null;
    }
  }

  /** Export ONLY the rows already read — a local Blob, no server round-trip. */
  function downloadLoaded(output: WorkerOutputView) {
    const blob = new Blob([output.lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `worker-output-${output.dispatchId}-${output.source}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function decide(dispatchId: string, kind: "release" | "retain") {
    setBusyId(dispatchId);
    setErr(null);
    try {
      const receipt = await (kind === "release" ? releaseWorker(dispatchId) : retainWorker(dispatchId));
      setDecision({ dispatchId, kind, receipt });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusyId(null);
    }
  }

  // --- Phase 7: one-worker stop / abandon / focus ---------------------------
  //
  // Evidence gates (PRD): stop needs a positively ACTIVE dispatch; abandon
  // needs a positively EXITED dispatch or Orca's own prescribed next action
  // (outcome unknown); focus needs a local terminal with positive fresh
  // `agentWait` observation. Missing, stale, remote, or unverifiable
  // evidence authorizes no action — the buttons stay disabled with the
  // reason in their tooltip, and every fired action confirms first with the
  // evidence summary that justified it.

  type Evidence = {
    canStop: boolean;
    canAbandon: boolean;
    canFocus: boolean;
    stopWhy: string;
    abandonWhy: string;
    focusWhy: string;
  };

  function evidenceFor(row: WorkerRowView, detail: WorkerDetailView | null): Evidence {
    const liveness = detail?.liveness;
    const fleetLive = liveness?.verdict === "live" || (liveness?.qualifiedWorking ?? false);
    const fleetExited = liveness?.verdict === "exited";
    const prescribed = detail?.fleet?.projection?.nextAction;
    const hasPrescribed = Boolean(prescribed && prescribed.argv.length > 0);
    const local = detail?.fleet?.projection?.host?.kind === "local";
    // Tri-state: an OBJECT is positive wait evidence; null = looked, none;
    // undefined = this host never looked (unknown — never "waiting").
    const wait = detail?.observation?.agentWait;
    const waitPositive = wait != null;
    const notSettled = !(attemptSettledFor(row));
    return {
      canStop: fleetLive && notSettled,
      canAbandon: fleetExited || hasPrescribed,
      canFocus: Boolean(local && waitPositive && row.agentTerminalHandle),
      stopWhy: notSettled
        ? fleetLive
          ? `positive live evidence${liveness?.fleetReason ? ` (${liveness.fleetReason})` : ""}`
          : "no positive live evidence — the fleet verdict is not “live”"
        : "this dispatch is already settled",
      abandonWhy: hasPrescribed
        ? "Orca prescribes a next action (outcome unknown)"
        : fleetExited
          ? `positive exit evidence${liveness?.fleetReason ? ` (${liveness.fleetReason})` : ""}`
          : "no positive exit evidence and no Orca-prescribed action",
      focusWhy: !local
        ? "focus is local-only — this worker is not on this server"
        : !waitPositive
          ? "no positive agent-wait observation (unknown or none detected)"
          : row.agentTerminalHandle
            ? `agent-wait: ${wait?.kind ?? "observed"}${wait?.detail ? ` — ${wait.detail}` : ""}`
            : "no worker terminal handle reported",
    };
  }

  function attemptSettledFor(row: WorkerRowView): boolean {
    const attempt = attempts.find(
      (candidate) =>
        (row.dispatchId && candidate.dispatchId === row.dispatchId) || candidate.taskId === row.taskId,
    );
    return attempt?.settled ?? false;
  }

  async function intervene(
    row: WorkerRowView,
    action: WorkerControlReceiptView["action"],
    why: string,
  ) {
    const dispatchId = row.dispatchId;
    const titles: Record<typeof action, string> = {
      stop: "Stop this worker?",
      abandon: "Abandon this dispatch?",
      focus: "Focus this worker's terminal?",
    };
    const messages: Record<typeof action, string> = {
      stop:
        `worker-stop on ${dispatchId}.\n\nEvidence: ${why}.\n\n` +
        "The dispatch is stopped through Orca; the task stays in the Run and can be retried safely.",
      abandon:
        `worker abandon on ${dispatchId}.\n\nEvidence: ${why}.\n\n` +
        "Abandoning closes a positively-exited (or runtime-prescribed outcome-unknown) attempt " +
        "without touching anything live.",
      focus:
        `Focus the local terminal for ${dispatchId}.\n\nEvidence: ${why}.\n\n` +
        "Orca brings the worker terminal to the front — nothing about the dispatch changes.",
    };
    const ok = await dialog.confirm({
      title: titles[action],
      message: messages[action],
      confirmLabel: action === "stop" ? "Stop worker" : action === "abandon" ? "Abandon" : "Focus terminal",
      tone: action === "abandon" ? "danger" : "default",
    });
    if (!ok) return;
    setBusyId(dispatchId);
    setErr(null);
    try {
      // The runId rides along: the server positively re-scopes the evidence
      // re-read (worker-show) to THIS Run before any mutation is minted.
      const receipt = await (action === "stop"
        ? stopWorker(dispatchId, row.runId)
        : action === "abandon"
          ? abandonWorker(dispatchId, row.runId)
          : focusWorker(dispatchId, row.runId));
      setControl({ dispatchId, action, receipt });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusyId(null);
    }
  }

  // --- filters: terminal/accounting state + attention categories ------------
  const attentionCategories = new Set<string>();
  for (const row of rows) {
    for (const category of row.projection?.attention?.categories ?? []) {
      attentionCategories.add(category);
    }
  }
  const filtered = rows.filter((row) => {
    if (terminalFilter !== "all" && row.terminalState !== terminalFilter) return false;
    if (attentionFilter === "needs_action") {
      if (!row.projection?.attention?.requiresAction) return false;
    } else if (attentionFilter !== "all") {
      if (!(row.projection?.attention?.categories ?? []).includes(attentionFilter)) return false;
    }
    return true;
  });

  if (!runId || (rows.length === 0 && !rowsError)) return null;

  return (
    <div className="gates inbox workers" data-testid="worker-panel">
      <div className="gate inbox__item">
        <div className="gate__badge">Workers · durable fleet view</div>
        {rows.length > 0 && (
          <div className="workers__filters">
            <select
              className="workers__source"
              value={terminalFilter}
              onChange={(e) => setTerminalFilter(e.target.value)}
              aria-label="Filter by terminal state"
            >
              <option value="all">state: all</option>
              {TERMINAL_STATES.map((state) => (
                <option key={state} value={state}>
                  state: {state}
                </option>
              ))}
            </select>
            <select
              className="workers__source"
              value={attentionFilter}
              onChange={(e) => setAttentionFilter(e.target.value)}
              aria-label="Filter by attention"
            >
              <option value="all">attention: all</option>
              <option value="needs_action">attention: needs action</option>
              {[...attentionCategories].map((category) => (
                <option key={category} value={category}>
                  attention: {category}
                </option>
              ))}
            </select>
            <span className="inbox__meta">
              {filtered.length} of {rows.length} worker{rows.length === 1 ? "" : "s"}
            </span>
          </div>
        )}
        {filtered.map((row) => {
          const open = openDispatch === row.dispatchId;
          const projection = row.projection;
          const liveness = projection?.liveness ?? null;
          const verdict = liveness?.verdict === "live" || liveness?.verdict === "exited" ? liveness.verdict : "unverifiable";
          const attempt = attempts.find(
            (candidate) =>
              (row.dispatchId && candidate.dispatchId === row.dispatchId) ||
              candidate.taskId === row.taskId,
          );
          // Evidence gates only matter on the expanded row — the one whose
          // worker-show detail is on screen.
          const evidence = open ? evidenceFor(row, detail) : null;
          const host = projection?.host ?? null;
          const hostLabel =
            host == null
              ? "unknown"
              : host.kind === "local"
                ? "local (this server)"
                : `environment ${host.id}`;
          const provider =
            projection?.provider?.model ??
            projection?.provider?.id ??
            projection?.launch?.model ??
            projection?.launch?.agent ??
            null;
          // Structured transcript reads are a peer capability (Phase 6):
          // offered for local workers always, for remote workers only when
          // their environment advertises it. Unknown host → auto only.
          const hostEnv = host ? envs.find((e) => e.id === host.id) : undefined;
          const canTranscript =
            host?.kind === "local" ||
            (host?.kind != null && host.kind !== "local" && (hostEnv?.peer.transcriptRead ?? false));
          // Lifecycle decisions appear only on positive proof: Orca's own
          // accounting says a decision is owed (release_pending), or this
          // viewer's coordinator settled the attempt without a decision yet.
          const decisionOwed =
            row.terminalState === "release_pending" ||
            (attempt?.settled === true && !DECIDED.has(attempt.terminalDecision));
          return (
            <div key={row.dispatchId || row.taskId} className="workers__row">
              <button className="workers__toggle" onClick={() => toggle(row)}>
                <span
                  className="workers__liveness"
                  data-verdict={verdict}
                  title={liveness?.reason ? `${verdict} (${liveness.reason})` : verdict}
                >
                  {verdict}
                </span>
                <code className="workers__task">{row.taskId}</code>
                <span className="inbox__meta">
                  <code className="workers__dispatch">{row.dispatchId || "no dispatch"}</code>
                  {projection?.outcome ? ` · ${projection.outcome}` : ""}
                  {row.workerState === "unsupervised" ? " · unsupervised" : ""}
                  {` · ${hostLabel}`}
                  {provider ? ` · ${provider}` : ""}
                  {` · ${row.terminalState}`}
                  {(projection?.attention?.categories ?? []).length > 0
                    ? ` · ⚑ ${(projection?.attention?.categories ?? []).join(", ")}`
                    : ""}
                </span>
              </button>

              {open && (
                <div className="workers__detail">
                  {/* --- Liveness: both evidence layers, never merged away --- */}
                  {detail?.liveness.qualifiedWorking ? (
                    <div className="inbox__body workers__qualified" data-testid="qualified-working">
                      <b>{QUALIFIED_LABEL}</b>
                      <span className="inbox__meta">
                        {" "}— fleet: unverifiable ({detail.liveness.fleetReason}); exact observation:{" "}
                        {detail.liveness.observationStatus ?? "unknown"}. Both layers shown; the fleet
                        verdict is not overridden.
                      </span>
                    </div>
                  ) : (
                    <div className="inbox__body">
                      Liveness: <b>{verdict}</b>
                      {liveness?.reason ? ` — ${liveness.reason}` : ""}
                      {detail?.liveness.observationStatus
                        ? ` · observed: ${detail.liveness.observationStatus}${
                            detail.observation?.exactWorker === false ? " (not exact-worker — not merged)" : ""
                          }`
                        : ""}
                    </div>
                  )}
                  <div className="inbox__body">
                    Host: <b>{hostLabel}</b>
                    {projection?.launch?.on ? ` · placed via --on ${projection.launch.on}` : ""}
                    {host?.kind != null && host.kind !== "local" && verdict === "unverifiable"
                      ? " · contact lost is NOT exit — the Dispatch is preserved"
                      : ""}
                  </div>
                  <div className="inbox__body">
                    Provider/model:{" "}
                    <b>
                      {provider ??
                        (attempt
                          ? `${attempt.requested.agent}${attempt.requested.model ? ` · ${attempt.requested.model}` : ""} (requested)`
                          : "unknown")}
                    </b>
                  </div>
                  <div className="inbox__body">
                    Terminal: <code>{row.agentTerminalHandle ?? "unknown"}</code> · Orca:{" "}
                    <code>{row.terminalState}</code>
                    {attempt ? ` · viewer: ${attempt.terminalDecision}` : " · viewer: n/a (not coordinated here)"}
                  </div>
                  {attempt?.terminalArchive && (
                    <div className="inbox__body">
                      Release archive: <code>{attempt.terminalArchive}</code>
                      <span className="inbox__meta">
                        {" "}— archive evidence is not settlement; Orca's terminal state above stays authoritative
                      </span>
                    </div>
                  )}
                  {projection?.attention && projection.attention.categories.length > 0 && (
                    <div className="inbox__body">
                      Attention: {projection.attention.categories.join(", ")}
                      {projection.attention.requiresAction ? " · needs action" : ""}
                    </div>
                  )}
                  {projection?.stage && projection.stage.activity !== "unknown" && (
                    <div className="inbox__body">Agent stage: {projection.stage.activity}</div>
                  )}

                  {/* --- worker-show evidence (fetched on expand) --- */}
                  {detailLoading && <div className="inbox__body">Loading worker evidence…</div>}
                  {detailErr && <div className="exec__err inbox__err">⚠️ {detailErr}</div>}
                  {detail && (
                    <>
                      {detail.observation && (
                        <div className="inbox__body">
                          Observation: <b>{detail.observation.status ?? "unknown"}</b>
                          {detail.observation.exactWorker === true
                            ? " · exact worker"
                            : detail.observation.exactWorker === false
                              ? " · not provably this worker"
                              : ""}
                          {detail.observation.agentWait === undefined
                            ? " · agent-wait: unknown (this host never looked)"
                            : detail.observation.agentWait === null
                              ? " · agent-wait: none detected"
                              : ` · agent-wait: waiting on a human prompt${
                                  detail.observation.agentWait.kind ? ` (${detail.observation.agentWait.kind})` : ""
                                }${detail.observation.agentWait.detail ? ` — ${detail.observation.agentWait.detail}` : ""}`}
                        </div>
                      )}
                      {detail.worker && (detail.worker.state || detail.worker.stage) && (
                        <div className="inbox__body">
                          Worker record: {detail.worker.state ?? "unknown"}
                          {detail.worker.stage ? ` · stage ${detail.worker.stage}` : ""}
                          {detail.dispatch?.status ? ` · dispatch ${detail.dispatch.status}` : ""}
                          {detail.dispatch?.failureCount ? ` · failures ${detail.dispatch.failureCount}` : ""}
                        </div>
                      )}
                      {/* Requested vs effective launch preferences: requested
                          only exists when this viewer started the attempt;
                          effective comes only from the runtime echo. */}
                      {(attempt || detail.fleet?.projection?.launch) && (
                        <div className="inbox__body">
                          Launch —{" "}
                          {attempt
                            ? `requested ${attempt.requested.agent ?? "?"}${
                                attempt.requested.model ? ` · ${attempt.requested.model}` : ""
                              }${attempt.requested.effort ? ` · effort ${attempt.requested.effort}` : ""}`
                            : "requested unknown (not started here)"}
                          {" → effective "}
                          {detail.fleet?.projection?.launch
                            ? [
                                detail.fleet.projection.launch.agent ?? "unknown agent",
                                detail.fleet.projection.launch.model ?? "unknown model",
                                ...(detail.fleet.projection.launch.effort
                                  ? [`effort ${detail.fleet.projection.launch.effort}`]
                                  : []),
                              ].join(", ")
                            : detail.fleet?.projection?.provider
                              ? [detail.fleet.projection.provider.id, detail.fleet.projection.provider.model]
                                  .filter(Boolean)
                                  .join(" · ") || "unknown"
                              : "unknown (no receipt echo)"}
                        </div>
                      )}
                      {detail.fleet?.projection?.nextAction && detail.fleet.projection.nextAction.argv.length > 0 && (
                        <div className="inbox__body">
                          Orca prescribes: <code>{detail.fleet.projection.nextAction.argv.join(" ")}</code>
                        </div>
                      )}
                      {/* Requested vs effective WORKSPACE facts (Phase 7):
                          where the viewer asked this worker to run vs what
                          the runtime receipt echoed. Null stays "unknown" —
                          the effective side only ever comes from Orca. */}
                      {(attempt?.requested.worktree ||
                        attempt?.requested.on ||
                        detail?.fleet?.projection?.launch?.worktree ||
                        detail?.fleet?.projection?.launch?.on ||
                        detail?.fleet?.projection?.workspace) && (
                        <div className="inbox__body">
                          Workspace —{" "}
                          <b>
                            {attempt?.requested.worktree ??
                              attempt?.requested.on ??
                              "unknown (not started here)"}
                          </b>
                          {" → effective "}
                          <b>
                            {detail?.fleet?.projection?.launch?.worktree ??
                              detail?.fleet?.projection?.workspace ??
                              detail?.fleet?.projection?.launch?.on ??
                              "unknown (no receipt echo)"}
                          </b>
                        </div>
                      )}
                      {/* Raw receipts live ONLY in this collapsed diagnostic section. */}
                      <details className="workers__raw">
                        <summary>Diagnostic receipt</summary>
                        <pre className="workers__rawpre">
                          {JSON.stringify(
                            {
                              dispatch: detail.dispatch,
                              worker: detail.worker,
                              terminal: detail.terminal,
                              observation: detail.observation,
                              fleet: detail.fleet?.projection ?? null,
                            },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    </>
                  )}

                  {/* --- bounded output (worker-read), explicitly sourced --- */}
                  {output?.dispatchId === row.dispatchId && output.lines.length > 0 && (
                    <>
                      {(() => {
                        // Search runs ONLY over rows already loaded on this
                        // page stack — it can never fetch or render an
                        // unbounded transcript.
                        const q = outputFilter.trim().toLowerCase();
                        const visible = q
                          ? output.lines.filter((line) => line.toLowerCase().includes(q))
                          : output.lines;
                        return (
                          <>
                            <div className="workers__outputmeta" data-testid="output-meta">
                              <span className="workers__srcbadge" data-source={output.source}>
                                {output.source}
                              </span>
                              {output.clipped && (
                                <span className="workers__flag" data-flag="clipped">
                                  clipped by runtime
                                </span>
                              )}
                              <span className="workers__flag" data-flag={output.contentComplete ? "complete" : "more"}>
                                {output.contentComplete ? "complete" : "more available"}
                              </span>
                              {output.sourceChanged && (
                                <span className="workers__flag" data-flag="changed">
                                  source changed
                                </span>
                              )}
                            </div>
                            <input
                              className="workers__search"
                              type="search"
                              value={outputFilter}
                              onChange={(e) => setOutputFilter(e.target.value)}
                              placeholder="Filter loaded rows… (never fetches more)"
                              aria-label="Filter loaded output rows"
                            />
                            <pre className="workers__output" data-testid="output-pre">
                              {visible.length > 0 ? visible.join("\n") : "(no loaded rows match)"}
                              {!q && !output.contentComplete && "\n…"}
                              {!q && output.clipped ? "\n[clipped by the runtime]" : ""}
                            </pre>
                            <div className="inbox__meta">
                              {q
                                ? `${visible.length} of ${output.lines.length} loaded rows match — search covers loaded rows only`
                                : `${output.lines.length} loaded row${output.lines.length === 1 ? "" : "s"}`}
                              {" · "}
                              <button
                                type="button"
                                className="workers__download"
                                onClick={() => downloadLoaded(output)}
                                title="Save the rows already read to a local file — nothing more is fetched"
                              >
                                Download loaded rows
                              </button>
                            </div>
                          </>
                        );
                      })()}
                    </>
                  )}
                  {output?.dispatchId === row.dispatchId && output.warnings.map((w, i) => (
                    <div key={i} className="inbox__body workers__warn">
                      ⚠ {w}
                    </div>
                  ))}
                  {outputErr && <div className="exec__err inbox__err">⚠️ {outputErr}</div>}

                  {decision && decision.dispatchId === row.dispatchId && (
                    <div className="inbox__body workers__decision" data-testid="decision-receipt">
                      Terminal decision receipt: <b>{decision.receipt.state}</b>
                      {decision.receipt.requestId && (
                        <>
                          {" "}· request <code>{decision.receipt.requestId.slice(0, 8)}…</code>
                        </>
                      )}
                      {" · archive: "}
                      {decision.receipt.archive ? (
                        <code>{archiveSummary(decision.receipt.archive)}</code>
                      ) : (
                        "none reported"
                      )}
                      <div className="inbox__meta">
                        Archive presence is evidence, not settlement — the fleet state above stays
                        authoritative. The request id is recorded in the audit ledger.
                      </div>
                    </div>
                  )}

                  {control && control.dispatchId === row.dispatchId && (
                    <div className="inbox__body workers__decision" data-testid="control-receipt">
                      {control.action} receipt: <b>{control.receipt.state ?? "unknown"}</b>
                      {control.receipt.reason ? ` — ${control.receipt.reason}` : ""}
                      {control.receipt.requestId && (
                        <>
                          {" "}· request <code>{control.receipt.requestId.slice(0, 8)}…</code>
                        </>
                      )}
                      {control.receipt.detail && <div className="inbox__meta">{control.receipt.detail}</div>}
                      <div className="inbox__meta">
                        Orca's verdict verbatim — an ambiguous outcome stays auditable in the request
                        ledger and is never retried with a new request id.
                      </div>
                    </div>
                  )}

                  <div className="gate__actions">
                    {output?.dispatchId !== row.dispatchId && (
                      <button
                        className="btn btn--gate"
                        onClick={() => row.dispatchId && void loadOutput(row.dispatchId, undefined, "auto")}
                      >
                        Read output
                      </button>
                    )}
                    {output?.dispatchId === row.dispatchId && output.cursor && (
                      <button
                        className="btn btn--gate"
                        onClick={() =>
                          row.dispatchId && void loadOutput(row.dispatchId, output.cursor ?? undefined, source)
                        }
                      >
                        Load more
                      </button>
                    )}
                    {output?.dispatchId === row.dispatchId && (
                      <select
                        className="workers__source"
                        value={source}
                        onChange={(e) => {
                          setSource(e.target.value);
                          if (row.dispatchId) void loadOutput(row.dispatchId, undefined, e.target.value);
                        }}
                      >
                        <option value="auto">source: auto</option>
                        {canTranscript && <option value="transcript">source: transcript</option>}
                      </select>
                    )}
                    {decisionOwed && row.dispatchId && (
                      <>
                        <button
                          className="btn btn--gate btn--ok"
                          disabled={disabled || busyId === row.dispatchId}
                          onClick={() => void decide(row.dispatchId, "release")}
                          title="worker-release — the default post-settlement decision"
                        >
                          Release
                        </button>
                        <button
                          className="btn btn--gate"
                          disabled={disabled || busyId === row.dispatchId}
                          onClick={() => void decide(row.dispatchId, "retain")}
                          title="worker-retain — keep this terminal alive for inspection"
                        >
                          Retain for debugging
                        </button>
                      </>
                    )}
                    {/* Phase 7: one-worker intervention. Each button is
                        enabled only on its own positive evidence, says what
                        that evidence is, and confirms before it fires. */}
                    {evidence && row.dispatchId && (
                      <>
                        <button
                          className="btn btn--gate workers__ctl"
                          disabled={!evidence.canFocus || disabled || busyId === row.dispatchId}
                          title={
                            evidence.canFocus
                              ? `Focus — evidence: ${evidence.focusWhy}`
                              : `Focus unavailable — ${evidence.focusWhy}`
                          }
                          onClick={() => row.dispatchId && void intervene(row, "focus", evidence.focusWhy)}
                        >
                          ◎ Focus
                        </button>
                        <button
                          className="btn btn--gate btn--danger workers__ctl"
                          disabled={!evidence.canStop || disabled || busyId === row.dispatchId}
                          title={
                            evidence.canStop
                              ? `Stop — evidence: ${evidence.stopWhy}`
                              : `Stop unavailable — ${evidence.stopWhy}`
                          }
                          onClick={() => row.dispatchId && void intervene(row, "stop", evidence.stopWhy)}
                        >
                          ⏹ Stop worker
                        </button>
                        <button
                          className="btn btn--gate workers__ctl"
                          disabled={!evidence.canAbandon || disabled || busyId === row.dispatchId}
                          title={
                            evidence.canAbandon
                              ? `Abandon — evidence: ${evidence.abandonWhy}`
                              : `Abandon unavailable — ${evidence.abandonWhy}`
                          }
                          onClick={() => row.dispatchId && void intervene(row, "abandon", evidence.abandonWhy)}
                        >
                          Abandon
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {rows.length > 0 && filtered.length === 0 && (
          <div className="inbox__body">No workers match the current filters.</div>
        )}
        {(rowsError || err) && (
          <div className="exec__err inbox__err">⚠️ {rowsError ?? ""}{rowsError && err ? " · " : ""}{err ?? ""}</div>
        )}
        {disabled && disabledReason && <div className="exec__hint">🔒 {disabledReason}</div>}
      </div>
    </div>
  );
}
