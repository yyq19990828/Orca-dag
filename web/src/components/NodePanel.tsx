import { useEffect, useState } from "react";
import { fetchEnvironments, fetchModels, fetchWorkerDetail } from "../api";
import { formatDateTime } from "../format";
import { useT, type Translator } from "../i18n";
import { lanePlanProblems, laneLabel, laneProblemPrefix } from "../placement";
import { workerWorkspaceLabel } from "../workerWorkspace";
import {
  effectiveHarness,
  allLaneIds,
  getDefaultHarness,
  getLaneSpec,
  getNodeHarness,
  getNodeModel,
  getNodeEffort,
  getNodeRetain,
  getNodeEnvironment,
  getNodePlacement,
  getTaskLane,
  setLaneSpec,
  setNodeHarness,
  setNodeModel,
  setNodeEffort,
  setNodeRetain,
  setNodeEnvironment,
  setNodePlacement,
  setTaskLane,
  useConfig,
  useFlags,
} from "../harness";
import {
  HARNESSES,
  EFFORT_LEVELS,
  EFFORT_SUPPORTED,
  MODEL_PICKER,
  STATUS_META,
  type DagEdge,
  type DagNode,
  type DagNodeReadiness,
  type OrcaEnvironmentView,
  type PlacementSpec,
  type WorkerRowView,
} from "../types";
import { DoodleSelect } from "./DoodleSelect";
import { PlacementEditor } from "./PlacementEditor";
import "../node-actions.css";

const INHERIT = "__inherit__";
const CUSTOM = "__custom__";
const NEW_LANE = "__new_lane__";
const KNOWN = HARNESSES as readonly string[];

/** Short seed summary for a lane picker row (never the raw placement JSON). */
function laneSpecOf(laneId: string, t: Translator): string {
  const spec = getLaneSpec(laneId);
  return spec ? laneLabel(spec) : t("node.laneNoSeed");
}

interface WorkerReportResult {
  provenance?: string;
  outcome?: string;
  subject?: string;
  body?: string;
  completedAt?: string;
  reportedBy?: string;
  completedBy?: string;
  messageId?: string;
  filesModified?: string[];
  reportPath?: string | null;
}

function parseWorkerReport(raw: string): WorkerReportResult | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as WorkerReportResult;
  } catch {
    return null;
  }
}

function resultExcerpt(body: string): { text: string; clipped: boolean } {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length <= 420) return { text: normalized, clipped: false };
  const candidate = normalized.slice(0, 420);
  const sentenceEnd = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf("。"));
  const text = sentenceEnd > 180 ? candidate.slice(0, sentenceEnd + 1) : candidate.trimEnd();
  return { text, clipped: true };
}

/**
 * A worker result's completion stamp, or null when absent/unparseable — the
 * caller renders nothing rather than a fabricated date. Formatting itself is
 * delegated to the shared `formatDateTime` so the label can't drift from the
 * other panels.
 */
function resultTime(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatDateTime(value);
}

function ResultSummary({ raw }: { raw: string }) {
  const t = useT();
  const report = parseWorkerReport(raw);
  if (!report) return <p className="node-panel__result-text">{raw}</p>;

  const outcome = report.outcome?.trim() || "reported";
  const body = typeof report.body === "string" ? resultExcerpt(report.body) : null;
  const files = Array.isArray(report.filesModified)
    ? report.filesModified.filter((file): file is string => typeof file === "string" && Boolean(file.trim()))
    : [];
  const completedAt = resultTime(report.completedAt);
  return (
    <section className="node-result" data-outcome={outcome} aria-label={t("report.resultAria")}>
      <div className="node-result__head">
        <span className="node-result__outcome">{outcome.replaceAll("_", " ")}</span>
        {completedAt && <time dateTime={report.completedAt}>{completedAt}</time>}
      </div>
      <strong>{report.subject?.trim() || t("report.workerReport")}</strong>
      {body?.text && <p>{body.text}</p>}
      {files.length > 0 && (
        <div className="node-result__files">
          <span>
            {files.length === 1
              ? t("report.filesModifiedOne", { n: files.length })
              : t("report.filesModifiedMany", { n: files.length })}
          </span>
          <ul>
            {files.map((file) => <li key={file}><code>{file}</code></li>)}
          </ul>
        </div>
      )}
      {report.reportPath && (
        <p className="node-result__report">{t("report.reportLabel")} <code>{report.reportPath}</code></p>
      )}
      <details className="node-result__details">
        <summary>{t(body?.clipped ? "report.fullDetails" : "report.details")}</summary>
        {body?.clipped && <p>{report.body}</p>}
        <dl>
          {report.reportedBy && <><dt>{t("report.reportedBy")}</dt><dd><code>{report.reportedBy}</code></dd></>}
          {!report.reportedBy && report.completedBy && <><dt>{t("report.completedBy")}</dt><dd><code>{report.completedBy}</code></dd></>}
          {report.messageId && <><dt>{t("report.message")}</dt><dd><code>{report.messageId}</code></dd></>}
          {report.provenance && <><dt>{t("report.provenance")}</dt><dd>{report.provenance.replaceAll("_", " ")}</dd></>}
        </dl>
        <pre>{JSON.stringify(report, null, 2)}</pre>
      </details>
    </section>
  );
}

interface NodePanelProps {
  node: DagNode;
  runId: string;
  isLead: boolean;
  /** Resolved parent Task label, when the node's parent_id is in this Run. */
  parentLabel: string | null;
  /** Labels of Tasks in this Run whose parent_id is this node. */
  childLabels: string[];
  /** Server-projected readiness explanation for this node (Phase 4). */
  readiness: DagNodeReadiness | null;
  /** This Run's dependency edges — the lane ordering preflight reads them. */
  edges: DagEdge[];
  /** Labels for task ids in this Run (lane member lists, warnings). */
  labelsById: Record<string, string>;
  onLeadChange: (taskId: string | null) => void;
  /** Evidence accumulated from worker-list for this Run during this page session. */
  permanentlyLocked: boolean;
  /** The selected Run's coordinator has an immutable launch-plan snapshot. */
  temporarilyLocked: boolean;
  /** The selected Run is binding/recovering before its status has a runId. */
  coordinatorStarting: boolean;
  workerHistoryLoading: boolean;
  workerHistoryError: string | null;
  /** Open the existing Operations control for this stage; mutations stay there. */
  onOpenOperations?: (focus: { kind: "gate" | "worker" | "recovery"; id: string }) => void;
  /** A retry is offered only when the coordinator has a failed-start receipt. */
  failedStart?: boolean;
  /** A durable Worker row for this Task is available in the Operations fleet. */
  hasWorkerHistory?: boolean;
  /** Run-scoped Dispatch rows; the selected worker's actual worktree comes from worker-show. */
  workerRows: WorkerRowView[];
  onClose: () => void;
}

/**
 * Node detail + per-node harness. The description/deps are read-only (Orca can't
 * rewrite a stored spec — to change the plan, ask your agent to redraw the DAG).
 * The harness is this node's choice of agent when the coordinator fires it.
 */
export function NodePanel({
  node,
  runId,
  isLead,
  parentLabel,
  childLabels,
  readiness,
  edges,
  labelsById,
  onLeadChange,
  permanentlyLocked,
  temporarilyLocked,
  coordinatorStarting,
  workerHistoryLoading,
  workerHistoryError,
  onOpenOperations,
  failedStart = false,
  hasWorkerHistory = false,
  workerRows,
  onClose,
}: NodePanelProps) {
  // Status copy is translated; STATUS_META keeps owning only the palette.
  const t = useT();
  const meta = STATUS_META[node.status];
  useConfig(); // re-render when the default harness (or this node's) changes
  const { customCommandsAllowed: customOk } = useFlags(); // gates the "Custom…" option
  // A current Dispatch, completed Task, or failed Task is a conservative
  // session-local fallback while worker-list is loading. The durable worker
  // set supplied by App covers settled history after a viewer restart.
  const fallbackPermanentLock =
    node.dispatchId !== null || node.status === "completed" || node.status === "failed";
  const historyLocked = workerHistoryLoading || Boolean(workerHistoryError);
  const launchLocked =
    permanentlyLocked || fallbackPermanentLock || temporarilyLocked || coordinatorStarting || historyLocked;
  const permanentLock = permanentlyLocked || fallbackPermanentLock;
  const lockReason = permanentLock
    ? t("node.lockAfterDispatch")
    : temporarilyLocked
      ? t("exec.lockRunning")
      : coordinatorStarting
        ? t("exec.lockStarting")
        : workerHistoryError
          ? t("exec.lockHistoryError")
          : workerHistoryLoading
            ? t("exec.lockHistoryLoading")
      : null;
  const stored = getNodeHarness(node.id);
  const [sel, setSel] = useState(stored === null ? INHERIT : KNOWN.includes(stored) ? stored : CUSTOM);
  const [custom, setCustom] = useState(stored && !KNOWN.includes(stored) ? stored : "");
  const [specExpanded, setSpecExpanded] = useState(false);

  useEffect(() => {
    const s = getNodeHarness(node.id);
    setSel(s === null ? INHERIT : KNOWN.includes(s) ? s : CUSTOM);
    setCustom(s && !KNOWN.includes(s) ? s : "");
    // A newly selected stage starts compact even if the previous stage's
    // description was expanded. The explicit button preserves accessibility.
    setSpecExpanded(false);
  }, [node.id]);

  function pick(v: string) {
    if (launchLocked) return;
    setSel(v);
    if (v === INHERIT) setNodeHarness(node.id, null);
    else if (v !== CUSTOM) setNodeHarness(node.id, v);
  }
  function pickCustom(v: string) {
    if (!customOk || launchLocked) return; // keep the stored value intact while locked
    setCustom(v);
    setNodeHarness(node.id, v.trim() || null);
  }

  // --- per-node environment + exact placement + workspace lanes (Phase 6/7)
  // The environment picker lists ONLY what `orca environment list` discovered
  // (Local default + saved environments) — the viewer never invents a target.
  // Local placement offers the full four-choice matrix through PlacementEditor;
  // a saved environment swaps it for the two remote-safe choices. A workspace
  // lane overrides both: its members take placement from the lane's seed.
  const [envs, setEnvs] = useState<OrcaEnvironmentView[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetchEnvironments()
      .then((e) => alive && setEnvs(e))
      .catch(() => alive && setEnvs([]));
    return () => {
      alive = false;
    };
  }, []);
  const config = useConfig();
  const envId = getNodeEnvironment(node.id);
  const placement = getNodePlacement(node.id);
  const selectedEnv = envs?.find((e) => e.id === envId) ?? null;
  // Peer capability gates: an unadvertised capability is treated as absent —
  // the matching controls hide rather than mislead (mixed-version peers).
  const peerModelEffort = !envId || (selectedEnv?.peer.modelEffort ?? false);

  const laneId = getTaskLane(node.id);
  const laneSpec = laneId ? getLaneSpec(laneId) : null;
  const laneMembers = laneId
    ? Object.entries(config.laneByTask)
        .filter(([, memberOf]) => memberOf === laneId)
        .map(([taskId]) => taskId)
    : [];
  // The lane ordering preflight runs over the whole plan but only THIS
  // lane's problems are this panel's business.
  const laneProblems = lanePlanProblems(
    config.laneByTask,
    config.worktreeLanes,
    config.placementByTask,
    config.environmentByTask,
    edges,
  ).filter((p) => laneId && p.startsWith(laneProblemPrefix(laneId)));

  function pickEnvironment(v: string) {
    if (launchLocked) return;
    // "" = Local. setNodeEnvironment clears a stale placement (and lane
    // membership — lanes are local) with the environment.
    setNodeEnvironment(node.id, v || null);
  }

  function pickPlacement(p: PlacementSpec | null) {
    if (launchLocked) return;
    setNodePlacement(node.id, p);
  }

  function pickLane(v: string) {
    if (launchLocked) return;
    if (v === NEW_LANE) {
      // Mint a viewer-local lane id. It is launch intent only — the server
      // derives Orca worktree names from the Run and this id deterministically.
      const fresh = `lane-${Date.now().toString(36)}`;
      setLaneSpec(fresh, { placement: { kind: "new-child", setup: "run" } });
      setTaskLane(node.id, fresh);
      return;
    }
    setTaskLane(node.id, v || null);
  }

  // --- per-node model ------------------------------------------------
  // The model picker depends on the node's EFFECTIVE harness (its own override,
  // else the inherited default), not the {sel,custom} transient state — so it
  // reacts correctly even when the node just inherits. opencode → dropdown from
  // `opencode models`; claude/codex/cursor → free-text (no enumerable list);
  // anything else → no model control.
  const effHarness = effectiveHarness(node.id);
  const picker = MODEL_PICKER[effHarness] ?? "none";
  const model = getNodeModel(node.id);
  const [openCodeModels, setOpenCodeModels] = useState<string[] | null>(null);
  useEffect(() => {
    if (effHarness !== "opencode") return;
    let alive = true;
    fetchModels("opencode")
      .then((m) => {
        if (alive) setOpenCodeModels(m);
      })
      .catch(() => {
        if (alive) setOpenCodeModels([]);
      });
    return () => {
      alive = false;
    };
  }, [effHarness]);

  // Placement is launch intent. The worker's terminal observation is the
  // actual worktree, including legacy starts whose fleet projection has no
  // workspace (such as OpenCode tracking Dispatches). Keep the two distinct.
  const taskWorkers = workerRows.filter((row) => row.runId === runId && row.taskId === node.id);
  const worker = taskWorkers.find((row) => row.dispatchId === node.dispatchId) ?? taskWorkers[0];
  const dispatchId = worker?.dispatchId ?? null;
  const [workerWorktree, setWorkerWorktree] = useState<{
    dispatchId: string;
    path: string | null;
    branch: string | null;
    error: boolean;
  } | null>(null);
  useEffect(() => {
    if (!dispatchId) return;
    let alive = true;
    fetchWorkerDetail(runId, dispatchId)
      .then((detail) => {
        if (!alive) return;
        setWorkerWorktree({
          dispatchId,
          path: detail.terminal?.worktreePath ?? workerWorkspaceLabel(detail.fleet?.projection?.workspace),
          branch: detail.terminal?.branch ?? null,
          error: false,
        });
      })
      .catch(() => {
        // The fleet row can still carry a usable workspace identity; a
        // failed detail read must never turn launch intent into actual fact.
        if (alive) setWorkerWorktree({ dispatchId, path: null, branch: null, error: true });
      });
    return () => { alive = false; };
  }, [runId, dispatchId]);
  const actualWorktree =
    (workerWorktree?.dispatchId === dispatchId ? workerWorktree.path : null) ??
    workerWorkspaceLabel(worker?.projection?.workspace) ??
    worker?.projection?.launch?.worktree ?? null;
  const actualBranch = workerWorktree?.dispatchId === dispatchId ? workerWorktree.branch : null;
  const worktreeLoading = dispatchId && workerWorktree?.dispatchId !== dispatchId;
  const worktreeError = workerWorktree?.dispatchId === dispatchId && workerWorktree.error;

  return (
    <aside className="node-panel">
      <button className="node-panel__close" onClick={onClose} aria-label={t("dialog.close")}>
        ✕
      </button>

      <div className="node-panel__status" style={{ color: meta.ink }}>
        <span className="dot" style={{ background: meta.color }} />
        {t(`status.${node.status}`)}
      </div>
      <h3 className="node-panel__title">{node.label}</h3>
      <div className="node-panel__id">
        <code>{node.id}</code>
      </div>

      {onOpenOperations && (readiness?.pendingGateIds.length || failedStart || hasWorkerHistory) ? (
        <nav className="node-panel__actions" aria-label={t("node.operationsAria")}>
          {readiness?.pendingGateIds.map((gateId) => (
            <button
              key={gateId}
              type="button"
              className="node-panel__action"
              onClick={() => onOpenOperations({ kind: "gate", id: gateId })}
            >
              {t("node.reviewGate")}
            </button>
          ))}
          {failedStart && (
            <button
              type="button"
              className="node-panel__action"
              onClick={() => onOpenOperations({ kind: "recovery", id: node.id })}
            >
              {t("node.reviewFailedStart")}
            </button>
          )}
          {hasWorkerHistory && (
            <button
              type="button"
              className="node-panel__action"
              onClick={() => onOpenOperations({ kind: "worker", id: node.id })}
            >
              {t("node.viewWorkerHistory")}
            </button>
          )}
        </nav>
      ) : null}

      {/* Phase 4: scheduler state + ownership, derived from Run-scoped
          task/gate/coordinator facts the server projected onto /api/dag.
          A parent relation is ownership, never a dependency — the copy says
          so explicitly so nobody reads order into it. */}
      {(parentLabel || childLabels.length > 0 || (readiness && readiness.reasons.length > 0)) && (
        <div className="node-panel__field node-panel__scheduler">
          {parentLabel && (
            <p className="node-panel__relation">
              <span aria-hidden="true">┄</span> {t("node.subStageOf")} <strong>{parentLabel}</strong>
              <span className="node-panel__hint"> {t("node.subStageHint")}</span>
            </p>
          )}
          {childLabels.length > 0 && (
            <p className="node-panel__relation">
              <span aria-hidden="true">┄</span>{" "}
              {childLabels.length === 1
                ? t("node.parentOfOne", { n: childLabels.length, list: childLabels.join(", ") })
                : t("node.parentOfMany", { n: childLabels.length, list: childLabels.join(", ") })}
            </p>
          )}
          {readiness && readiness.reasons.length > 0 && (
            <ul className="node-panel__readiness" aria-label={t("node.readinessAria")}>
              {readiness.reasons.map((reason, i) => (
                <li key={readiness.codes[i] ?? i} data-code={readiness.codes[i] ?? "unknown"}>
                  {reason}
                </li>
              ))}
            </ul>
          )}
          {readiness && readiness.runnable && readiness.reasons.length === 0 && (
            <p className="node-panel__relation node-panel__relation--ready">{t("node.readyDispatchable")}</p>
          )}
        </div>
      )}

      <div className="node-panel__lead" aria-live="polite">
        {isLead ? (
          <>
            <div className="node-panel__lead-state">
              <span aria-hidden="true">★</span>
              <span>
                <strong>{t("node.leadStage")}</strong>
                <small>{t("node.leadStageHint", { id: runId })}</small>
              </span>
            </div>
            <button
              type="button"
              className="node-panel__lead-clear"
              onClick={() => onLeadChange(null)}
              aria-label={t("node.clearLeadAria", { label: node.label })}
            >
              {t("node.clear")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="node-panel__lead-mark"
            onClick={() => onLeadChange(node.id)}
            aria-pressed="false"
            title={t("node.markLeadTitle")}
          >
            <span aria-hidden="true">☆</span> {t("node.markLead")}
          </button>
        )}
      </div>

      {workerHistoryLoading && (
        <div className="node-panel__history" role="status">
          {t("node.checkingHistory")}
        </div>
      )}
      {workerHistoryError && (
        <div className="node-panel__history node-panel__history--warn" role="status">
          {t("node.historyUnverified")}
        </div>
      )}

      {lockReason && (
        <div className="node-panel__lock" role="note">
          <span aria-hidden="true">🔒</span>
          <span>{lockReason}</span>
        </div>
      )}

      <section className="node-panel__group" aria-label={t("node.agentGroupAria")}>
        <h4 className="node-panel__group-title">{t("node.agentGroup")}</h4>
        <div className="node-panel__field">
          <span className="node-panel__key">{t("node.harnessKey")}</span>
          <DoodleSelect
            value={sel}
            onChange={pick}
            disabled={launchLocked}
            title={launchLocked ? lockReason ?? t("node.launchLockedTitle") : undefined}
            options={[
              { value: INHERIT, label: t("node.defaultHarnessOption", { harness: getDefaultHarness() }) },
              ...HARNESSES.map((h) => ({ value: h, label: h })),
              // Same policy as the toolbar: no "Custom…" unless the server allows
              // it — but a stored custom value stays visible (and clearable via
              // "Inherit") while the flag is off.
              ...(customOk || (stored !== null && !KNOWN.includes(stored))
                ? [
                    {
                      value: CUSTOM,
                      label: customOk ? t("exec.custom") : t("exec.customDisabled"),
                      disabled: !customOk,
                      hint: customOk ? undefined : "ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1",
                    },
                  ]
                : []),
            ]}
          />
          {sel === CUSTOM && (
            <input
              className="node-panel__custom"
              value={custom}
              placeholder={t("node.customPlaceholder")}
              onChange={(e) => pickCustom(e.target.value)}
              disabled={!customOk || launchLocked}
            />
          )}
          {sel === CUSTOM && !customOk && (
            <span className="node-panel__hint">{t("exec.customOffHint")}</span>
          )}
        </div>

        {/* A model belongs to the harness above. A remote peer that does not
            advertise model/effort forwarding cannot accept either control. */}
        {picker !== "none" && peerModelEffort && (
          <div className="node-panel__field">
            <span className="node-panel__key">
              {t("node.modelKey", { harness: effHarness })}
              {model ? null : t("node.modelDefaultSuffix")}
            </span>
            {picker === "select" ? (
              <DoodleSelect
                value={model ?? ""}
                onChange={(v) => {
                  if (!launchLocked) setNodeModel(node.id, v || null);
                }}
                disabled={launchLocked}
                loading={openCodeModels === null}
                options={[
                  { value: "", label: t("node.defaultModel") },
                  ...(openCodeModels ?? []).map((m) => ({ value: m, label: m })),
                ]}
              />
            ) : (
              <input
                className="node-panel__custom"
                value={model ?? ""}
                placeholder={t("node.modelPlaceholder", {
                  example: effHarness === "claude" ? "opus" : effHarness === "codex" ? "o3" : "<model>",
                })}
                onChange={(e) => setNodeModel(node.id, e.target.value.trim() || null)}
                disabled={launchLocked}
              />
            )}
          </div>
        )}

        {/* worker-start accepts effort only alongside a model, and only for
            supported harnesses. Clearing the model clears stored effort. */}
        {model && EFFORT_SUPPORTED.has(effHarness) && peerModelEffort && (
          <div className="node-panel__field">
            <span className="node-panel__key">{t("node.effortKey", { harness: effHarness })}</span>
            <DoodleSelect
              value={getNodeEffort(node.id) ?? ""}
              onChange={(v) => {
                if (!launchLocked) setNodeEffort(node.id, v || null);
              }}
              disabled={launchLocked}
              options={[
                { value: "", label: t("node.defaultEffort") },
                ...EFFORT_LEVELS.map((e) => ({ value: e, label: e })),
              ]}
            />
            <span className="node-panel__hint">{t("node.effortHint")}</span>
          </div>
        )}
      </section>

      <section className="node-panel__group" aria-label={t("node.workspaceGroupAria")}>
        <h4 className="node-panel__group-title">{t("node.workspaceGroup")}</h4>
        {dispatchId && (
          <div className="node-panel__field node-panel__actual-worktree">
            <span className="node-panel__key">{t("node.actualWorktreeKey")}</span>
            {actualWorktree ? <code>{actualWorktree}</code> : (
              <span>
                {worktreeLoading
                  ? t("node.worktreeLoading")
                  : worktreeError
                    ? t("node.worktreeError")
                    : t("node.worktreeNotReported")}
              </span>
            )}
            {actualBranch && (
              <span className="node-panel__hint">
                {t("node.branchLabel", { branch: actualBranch.replace(/^refs\/heads\//, "") })}
              </span>
            )}
            {taskWorkers.length > 1 && (
              <span className="node-panel__hint">
                {t("node.dispatchOtherAttempts", { id: dispatchId })}
              </span>
            )}
          </div>
        )}

        {/* Phase 6: run this node on a saved environment (or keep it local —
            the zero-configuration default). List contents come only from
            `orca environment list`; nothing is ever invented client-side. */}
        <div className="node-panel__field">
          <span className="node-panel__key">{t("node.environmentKey")}</span>
          <DoodleSelect
            value={envId ?? ""}
            onChange={pickEnvironment}
            disabled={launchLocked || Boolean(laneId)}
            title={laneId ? t("node.environmentLaneTitle") : undefined}
            loading={envs === null}
            options={[
              { value: "", label: t("node.environmentLocal") },
              ...(envs ?? []).map((e) => ({
                value: e.id,
                label: e.name === e.id ? e.id : `${e.name} (${e.id})`,
              })),
            ]}
          />
          {envId && envs !== null && !selectedEnv && (
            <span className="node-panel__hint">{t("node.environmentMissing", { id: envId })}</span>
          )}
          {envId && selectedEnv && !selectedEnv.peer.modelEffort && (
            <span className="node-panel__hint">{t("node.environmentNoModelEffort")}</span>
          )}
        </div>

        {/* Phase 7: durable workspace lanes. A lane is ONE shared local
            non-current workspace for a dependency-ordered task chain. The seed
            editor is the same placement grammar minus `current` (`current` is
            no lane), and the ordering preflight explains — before any mutation
            — why an unordered set of tasks cannot share a lane. */}
        <div className="node-panel__field">
          <span className="node-panel__key">{t("node.laneKey")}</span>
          <DoodleSelect
            value={laneId ?? ""}
            onChange={pickLane}
            disabled={launchLocked}
            options={[
              { value: "", label: t("node.laneNone") },
              ...allLaneIds().map((id) => ({
                value: id,
                label: `${id} · ${laneSpecOf(id, t)}`,
                hint: id,
              })),
              { value: NEW_LANE, label: t("node.newLane"), disabled: launchLocked },
            ]}
          />
          {laneId && laneSpec && (
            <>
              <PlacementEditor
                scope="lane"
                envId={null}
                title={t("node.lanePlacementTitle")}
                value={laneSpec.placement}
                onChange={(p) => {
                  if (launchLocked || !laneId || p === null || p.kind === "current") return;
                  setLaneSpec(laneId, { placement: p });
                }}
                disabled={launchLocked}
              />
              {laneMembers.length > 1 && (
                <span className="node-panel__hint">
                  {t("node.laneMembers", {
                    members: laneMembers.map((id) => labelsById[id] ?? id).join(" → "),
                  })}
                </span>
              )}
              {laneProblems.map((p) => (
                <span key={p} className="node-panel__hint placement__warn">
                  ⚠ {p}
                </span>
              ))}
              {!launchLocked && (
                <button
                  type="button"
                  className="node-panel__lane-remove"
                  onClick={() => pickLane("")}
                  title={t("node.laneRemoveTitle")}
                >
                  {t("node.removeFromLane")}
                </button>
              )}
            </>
          )}
          {!laneId && (
            <span className="node-panel__hint">{t("node.laneHint")}</span>
          )}
        </div>

        {/* Per-task placement editor — skipped while the task is in a lane (the
            lane owns its members' placement). Local offers the full four-choice
            matrix; a saved environment offers the two remote-safe choices. */}
        {!laneId && !envId && (
          <div className="node-panel__field">
            <PlacementEditor
              scope="local"
              envId={null}
              title={t("node.requestedPlacementLocal")}
              value={placement}
              onChange={pickPlacement}
              disabled={launchLocked}
            />
          </div>
        )}
        {!laneId && envId && (
          <div className="node-panel__field">
            <PlacementEditor
              scope="remote"
              envId={envId}
              title={t("node.requestedPlacementRemote", { env: selectedEnv?.name ?? envId })}
              value={placement}
              onChange={pickPlacement}
              disabled={launchLocked}
            />
            {placement === null && (
              <span className="node-panel__hint">{t("node.remotePlacementHint")}</span>
            )}
          </div>
        )}

      </section>

      {/* Phase 5: retain-for-debugging — the settled worker's terminal stays
          alive and visible (in the Workers panel) until manually released. */}
      <label className="node-panel__field node-panel__retain">
        <input
          type="checkbox"
          checked={getNodeRetain(node.id)}
          onChange={(e) => setNodeRetain(node.id, e.target.checked)}
        />
        <span className="node-panel__key">{t("node.retainLabel")}</span>
      </label>

      {/* Orca tracks the running attempt as a Dispatch; task-list only carries
          these while the task is dispatched. */}
      {node.dispatchId && (
        <div className="node-panel__field">
          <span className="node-panel__key">{t("node.currentDispatch")}</span>
          <div className="node-panel__id">
            <code>{node.dispatchId}</code>
          </div>
          {node.assigneeHandle && (
            <span className="node-panel__hint">
              {t("node.workerTerminal")} <code>{node.assigneeHandle}</code>
              {t("node.inspectOutputWith")}{" "}
              <code>orca orchestration worker-read --dispatch {node.dispatchId}</code>
            </span>
          )}
        </div>
      )}

      <div className="node-panel__field">
        <div className="node-panel__spec-head">
          <span className="node-panel__key">{t("node.specKey")}</span>
          <button
            type="button"
            className="node-panel__spec-toggle"
            aria-expanded={specExpanded}
            aria-controls={`stage-spec-${node.id}`}
            onClick={() => setSpecExpanded((open) => !open)}
          >
            {specExpanded ? t("node.collapse") : t("node.expand")}
          </button>
        </div>
        <p
          id={`stage-spec-${node.id}`}
          className={`node-panel__spec-ro${specExpanded ? " node-panel__spec-ro--expanded" : ""}`}
          title={specExpanded ? undefined : node.spec}
        >
          {node.spec}
        </p>
        <span className="node-panel__hint">{t("node.specHint")}</span>
      </div>

      {node.result && (
        <div className="node-panel__field">
          <span className="node-panel__key">{t("node.resultKey")}</span>
          <ResultSummary raw={node.result} />
        </div>
      )}
    </aside>
  );
}
