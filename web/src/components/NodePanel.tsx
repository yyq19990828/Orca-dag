import { useEffect, useRef, useState } from "react";
import { Lock, Star } from "lucide-react";
import { createGate, fetchEnvironments, fetchModels, fetchWorkerDetail, type ModelDiscoveryResult } from "../api";
import { useT, type Translator } from "../i18n";
import { lanePlanProblems, laneLabel, laneProblemPrefix } from "../placement";
import { workerWorkspaceLabel } from "../workerWorkspace";
import { useDecisionDialog } from "./DecisionDialog";
import { useCoordinatorControl } from "./useCoordinatorControl";
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
  setNodeOpenCodeUi,
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
  UNVERIFIED_HARNESSES,
  OPEN_CODE_UIS,
  isOpenCodeUi,
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
import { ResultSummary } from "./ResultSummary";
import { PlacementEditor } from "./PlacementEditor";

const INHERIT = "__inherit__";
const CUSTOM = "__custom__";
const NEW_LANE = "__new_lane__";
const KNOWN = HARNESSES as readonly string[];
const OPEN_CODE_MODEL = /^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}(?:#[A-Za-z0-9._-]{1,128})?$/;

/** Short seed summary for a lane picker row (never the raw placement JSON). */
function laneSpecOf(laneId: string, t: Translator): string {
  const spec = getLaneSpec(laneId);
  return spec ? laneLabel(spec) : t("node.laneNoSeed");
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
  onRefresh: () => void;
  /** Split overview facts (`任务`) from launch/workspace controls (`启动配置`). */
  mode?: "all" | "overview" | "config";
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
  onRefresh,
  mode = "all",
}: NodePanelProps) {
  const showOverview = mode !== "config";
  const showConfig = mode !== "overview";
  // Status copy is translated; STATUS_META keeps owning only the palette.
  const t = useT();
  const dialog = useDecisionDialog();
  const withControl = useCoordinatorControl();
  const [gateBusy, setGateBusy] = useState(false);
  const [gateResult, setGateResult] = useState<string | null>(null);
  async function addGate() {
    const question = await dialog.prompt({
      title: t("node.createGateTitle"), message: t("node.createGateMessage"),
      fieldLabel: t("node.createGateQuestion"), required: true, confirmLabel: t("node.createGate"),
    });
    if (!question?.trim()) return;
    setGateBusy(true);
    setGateResult(null);
    try {
      const receipt = await withControl(runId, (control) => createGate(runId, node.id, question.trim(), control));
      setGateResult(JSON.stringify(receipt));
      onRefresh();
    } catch (error) {
      setGateResult(String((error as Error).message ?? error));
    } finally {
      setGateBusy(false);
    }
  }
  const meta = STATUS_META[node.status];
  const config = useConfig();
  const { customCommandsAllowed: customOk, platform } = useFlags();
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
  const defaultHarness = getDefaultHarness();
  const defaultIsUnverified = UNVERIFIED_HARNESSES[defaultHarness] === true;
  const storedIsUnverified = stored !== null && UNVERIFIED_HARNESSES[stored] === true;
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
    if (!customOk || launchLocked || storedIsUnverified) return;
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
    if (!showConfig) return;
    let alive = true;
    fetchEnvironments()
      .then((e) => alive && setEnvs(e))
      .catch(() => alive && setEnvs([]));
    return () => {
      alive = false;
    };
  }, [showConfig]);
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

  // Placement is launch intent. The worker's terminal observation + launch
  // receipt carry the actual agent/model/effort/worktree once dispatched.
  // Never fall back to the viewer's current global defaultHarness (e.g.
  // `opencode`) when displaying a locked stage that actually ran under `omp`.
  const taskWorkers = workerRows.filter((row) => row.runId === runId && row.taskId === node.id);
  const worker = taskWorkers.find((row) => row.dispatchId === node.dispatchId) ?? taskWorkers[0];
  const dispatchId = worker?.dispatchId ?? null;
  const [workerWorktree, setWorkerWorktree] = useState<{
    dispatchId: string;
    path: string | null;
    branch: string | null;
    agent: string | null;
    model: string | null;
    effort: string | null;
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
          path:
            detail.terminal?.worktreePath ??
            detail.launch?.resolvedWorktreeId ??
            workerWorkspaceLabel(detail.fleet?.projection?.workspace),
          branch: detail.terminal?.branch ?? null,
          agent: detail.launch?.agent ?? detail.requestedLaunch?.agent ?? null,
          model: detail.launch?.model ?? detail.requestedLaunch?.model ?? null,
          effort: detail.launch?.effort ?? detail.requestedLaunch?.effort ?? null,
          error: false,
        });
      })
      .catch(() => {
        // The fleet row can still carry a usable workspace identity; a
        // failed detail read must never turn launch intent into actual fact.
        if (alive) {
          setWorkerWorktree({
            dispatchId,
            path: null,
            branch: null,
            agent: null,
            model: null,
            effort: null,
            error: true,
          });
        }
      });
    return () => { alive = false; };
  }, [runId, dispatchId]);
  const detailMatch = workerWorktree?.dispatchId === dispatchId ? workerWorktree : null;
  const actualWorktree =
    detailMatch?.path ??
    worker?.launchEvidence?.worktree ??
    workerWorkspaceLabel(worker?.projection?.workspace) ??
    worker?.projection?.launch?.worktree ?? null;
  const actualBranch = detailMatch?.branch ?? worker?.launchEvidence?.branch ?? null;
  const worktreeLoading = dispatchId && !detailMatch;
  const worktreeError = Boolean(detailMatch?.error);

  const recordedAgent = permanentLock
    ? detailMatch?.agent ??
      worker?.launchEvidence?.agent ??
      worker?.projection?.launch?.agent ??
      worker?.projection?.provider?.id ??
      null
    : null;
  const recordedModel = permanentLock
    ? detailMatch?.model ??
      worker?.projection?.launch?.model ??
      worker?.projection?.provider?.model ??
      worker?.launchEvidence?.model ??
      null
    : null;
  const recordedEffort = permanentLock
    ? detailMatch?.effort ??
      worker?.projection?.launch?.effort ??
      worker?.launchEvidence?.effort ??
      null
    : null;

  // --- per-node model ------------------------------------------------
  // Discovery is advisory and scoped to the local viewer workspace. The
  // editable value remains local draft state until it is a complete model ID.
  const effHarness = recordedAgent ?? effectiveHarness(node.id);
  const effectiveSel = recordedAgent
    ? (KNOWN.includes(recordedAgent) ? recordedAgent : CUSTOM)
    : sel;
  const effectiveCustom = recordedAgent
    ? (KNOWN.includes(recordedAgent) ? "" : recordedAgent)
    : custom;
  const nativeAgent = effHarness === "omp" || effHarness === "antigravity";
  const picker = MODEL_PICKER[effHarness] ?? "none";
  const storedModel = getNodeModel(node.id);
  const storedEffort = getNodeEffort(node.id);
  const model = recordedAgent
    ? (recordedModel ?? (stored === recordedAgent ? storedModel : null))
    : storedModel;
  const effort = recordedAgent
    ? (recordedEffort ?? (stored === recordedAgent ? storedEffort : null))
    : storedEffort;
  const [openCodeDiscovery, setOpenCodeDiscovery] = useState<ModelDiscoveryResult | null>(null);
  const [modelDraft, setModelDraft] = useState(model ?? "");
  useEffect(() => setModelDraft(model ?? ""), [model, node.id, effHarness]);
  const [manualModel, setManualModel] = useState(false);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const invalidModelDraft = !launchLocked && effHarness === "opencode" && Boolean(modelDraft.trim()) &&
    !OPEN_CODE_MODEL.test(modelDraft.trim());
  useEffect(() => setManualModel(false), [node.id, effHarness]);
  useEffect(() => {
    if (manualModel && !launchLocked) modelInputRef.current?.focus();
  }, [manualModel, launchLocked]);
  useEffect(() => {
    if (!showConfig || launchLocked || (effHarness !== "opencode" && effHarness !== "omp")) {
      setOpenCodeDiscovery(null);
      return;
    }
    let alive = true;
    setOpenCodeDiscovery(null);
    fetchModels(effHarness).then(
      (result) => { if (alive) setOpenCodeDiscovery(result); },
      () => { if (alive) setOpenCodeDiscovery({ status: "unavailable", models: [], diagnostic: "Model discovery request failed", scope: "local-workspace" }); },
    );
    return () => { alive = false; };
  }, [effHarness, launchLocked, showConfig]);

  const showReadinessReasons = Boolean(
    readiness && readiness.reasons.length > 0 && node.status !== "completed",
  );
  const showSchedulerSection = Boolean(
    parentLabel ||
      childLabels.length > 0 ||
      showReadinessReasons ||
      (readiness && readiness.runnable && readiness.reasons.length === 0),
  );

  return (
    <section className="node-panel" aria-label={t(mode === "config" ? "ide.inspector.tabConfig" : "chat.view.task")}>
      {showOverview && (
        <>
      <div className="node-panel__topline">
        <div className="node-panel__status-group">
          <span className="node-panel__status">
            <span className="dot" style={{ background: meta.color }} />
            {t(`status.${node.status}`)}
          </span>
          <code className="node-panel__code-id">{node.id}</code>
        </div>
        {isLead ? (
          <button
            type="button"
            className="node-panel__lead-clear is-active"
            onClick={() => onLeadChange(null)}
            title={t("node.leadStageHint", { id: runId })}
            aria-label={t("node.clearLeadAria", { label: node.label })}
          >
            <Star size={12} fill="currentColor" aria-hidden="true" />
            <span>{t("node.leadStage")}</span>
          </button>
        ) : (
          <button
            type="button"
            className="node-panel__lead-mark"
            onClick={() => onLeadChange(node.id)}
            aria-pressed="false"
            title={t("node.markLeadTitle")}
          >
            <Star size={12} aria-hidden="true" />
            <span>{t("node.markLead")}</span>
          </button>
        )}
      </div>

      {(node.status === "pending" || node.status === "ready") && !node.dispatchId && !permanentlyLocked && !hasWorkerHistory && (
        <div className="node-panel__actions">
          <button type="button" className="node-panel__action" disabled={gateBusy || historyLocked || coordinatorStarting} onClick={() => void addGate()}>
            {t("node.createGate")}
          </button>
          {gateResult && <div role="status" className="inbox__body">{gateResult}</div>}
        </div>
      )}

      {onOpenOperations && (readiness?.pendingGateIds.length || failedStart) ? (
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
        </nav>
      ) : null}

      {showSchedulerSection && (
        <div className="node-panel__field node-panel__scheduler">
          {parentLabel && (
            <p className="node-panel__relation">
              {t("node.subStageOf")} <strong>{parentLabel}</strong>
              <span className="node-panel__hint"> {t("node.subStageHint")}</span>
            </p>
          )}
          {childLabels.length > 0 && (
            <p className="node-panel__relation">
              {childLabels.length === 1
                ? t("node.parentOfOne", { n: childLabels.length, list: childLabels.join(", ") })
                : t("node.parentOfMany", { n: childLabels.length, list: childLabels.join(", ") })}
            </p>
          )}
          {showReadinessReasons && readiness && (
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

      {node.result && (
        <section className="node-panel__group">
          <h3 className="node-panel__group-title">{t("node.resultKey")}</h3>
          <ResultSummary raw={node.result} />
        </section>
      )}

      {(dispatchId || node.dispatchId) && (
        <section className="node-panel__group">
          <dl className="record-facts node-panel__facts">
            {dispatchId && (
              <>
                <dt>{t("node.actualWorktreeKey")}</dt>
                <dd>
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
                      {" · "}{actualBranch.replace(/^refs\/heads\//, "")}
                    </span>
                  )}
                </dd>
              </>
            )}
            {node.dispatchId && (
              <>
                <dt>{t("node.currentDispatch")}</dt>
                <dd><code>{node.dispatchId}</code></dd>
              </>
            )}
            {node.assigneeHandle && (
              <>
                <dt>{t("node.workerTerminal")}</dt>
                <dd><code>{node.assigneeHandle}</code></dd>
              </>
            )}
          </dl>
        </section>
      )}

      <section className="node-panel__group">
        <div className="node-panel__spec-head">
          <h3 className="node-panel__group-title" style={{ margin: 0 }}>{t("node.specKey")}</h3>
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
      </section>

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
        </>
      )}

      {showConfig && (
        <div className="node-panel__config-pane">
          {lockReason && (
            <div className="node-panel__lock-banner" role="note">
              <Lock size={12} style={{ flexShrink: 0, marginBlockStart: 2 }} aria-hidden="true" />
              <span>{lockReason}</span>
            </div>
          )}

          <section className="node-panel__group node-panel__group--first" aria-label={t("node.agentGroupAria")}>
            <h3 className="node-panel__group-title">{t("node.agentGroup")}</h3>
            <div className="node-panel__config-body">
              <div className="node-panel__field">
                <span className="node-panel__key">{t("node.harnessKey")}</span>
          <DoodleSelect
            searchable={false}
            value={effectiveSel}
            onChange={pick}
            disabled={launchLocked}
            ariaLabel={t("node.harnessKey")}
            title={launchLocked ? lockReason ?? t("node.launchLockedTitle") : undefined}
            options={[
              {
                value: INHERIT,
                label: t("node.defaultHarnessOption", {
                  harness: defaultIsUnverified
                    ? t("exec.unverifiedHarness", { harness: defaultHarness }) : defaultHarness,
                }),
                disabled: defaultIsUnverified,
              },
              ...HARNESSES.map((h) => ({ value: h, label: h })),
              // Same policy as the toolbar: no "Custom…" unless the server allows
              // it — but a stored/recorded custom value stays visible while off.
              ...(customOk || effectiveSel === CUSTOM || (stored !== null && !KNOWN.includes(stored))
                ? [
                    {
                      value: CUSTOM,
                      label: storedIsUnverified
                        ? t("exec.unverifiedHarness", { harness: stored! })
                        : effectiveCustom && !customOk
                          ? effectiveCustom
                          : customOk ? t("exec.custom") : t("exec.customDisabled"),
                      disabled: !customOk || storedIsUnverified,
                      hint: storedIsUnverified ? undefined : customOk ? undefined : "ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1",
                    },
                  ]
                : []),
            ]}
          />
          {effectiveSel === CUSTOM && (
            <input
              className="node-panel__custom"
              value={effectiveCustom}
              placeholder={t("node.customPlaceholder")}
              onChange={(e) => pickCustom(e.target.value)}
              disabled={!customOk || launchLocked || storedIsUnverified}
              aria-label={t("node.harnessKey")}
            />
          )}
          {UNVERIFIED_HARNESSES[effHarness] === true && (
            <span className="node-panel__hint">{t("exec.unverifiedHarnessHint", { harness: effHarness })}</span>
          )}
          {effectiveSel === CUSTOM && !recordedAgent && !customOk && !storedIsUnverified && (
            <span className="node-panel__hint">{t("exec.customOffHint")}</span>
          )}
        </div>

        {/* A model belongs to the harness above. Remote forwarding controls
            require peer support. The Linux-only native presets keep their
            saved model visible even on an unsupported placement; preflight
            rejects that plan rather than silently erasing its preferences. */}
        {picker !== "none" && (peerModelEffort || nativeAgent) && (
          <div className="node-panel__field">
            <span className="node-panel__key">
              {t("node.modelKey", { harness: effHarness })}
            </span>
            {picker === "select" && (
              <DoodleSelect
                ariaLabel={t("node.modelKey", { harness: effHarness })}
                value={manualModel ? CUSTOM : model ?? ""}
                onChange={(value) => {
                  if (launchLocked) return;
                  setManualModel(value === CUSTOM);
                  if (value === CUSTOM) return;
                  setNodeModel(node.id, value || null);
                  setModelDraft(value);
                }}
                disabled={launchLocked}
                options={[
                  { value: "", label: t("node.defaultModel") },
                  ...((model && !openCodeDiscovery?.models.includes(model)) ? [{ value: model, label: model, hint: recordedModel ? undefined : t("node.savedModel") }] : []),
                  ...(openCodeDiscovery?.models ?? []).map((entry) => ({ value: entry, label: entry })),
                  { value: CUSTOM, label: t("node.customModel") },
                ]}
              />
            )}
            {(picker !== "select" || manualModel) && <input
              ref={modelInputRef}
              id={`node-model-${node.id}`}
              className="node-panel__custom"
              value={modelDraft}
              aria-label={picker === "select" ? t("node.customModel") : t("node.modelKey", { harness: effHarness })}
              aria-describedby={`node-model-hint-${node.id}${invalidModelDraft ? ` node-model-error-${node.id}` : ""}`}
              placeholder={t("node.modelPlaceholder", { example: effHarness === "opencode" ? "provider/model[#variant]" : effHarness === "omp" ? "@smol or provider/model" : effHarness === "claude" ? "opus" : effHarness === "codex" ? "o3" : "<model>" })}
              onChange={(event) => {
                const value = event.target.value;
                setModelDraft(value);
                if (launchLocked) return;
                const normalized = value.trim();
                if (!normalized) setNodeModel(node.id, null);
                else if (effHarness !== "opencode" || OPEN_CODE_MODEL.test(normalized)) setNodeModel(node.id, normalized);
              }}
              disabled={launchLocked}
              aria-invalid={invalidModelDraft}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />}
            {!launchLocked && (picker !== "select" || manualModel) && (
              <span id={`node-model-hint-${node.id}`} className="node-panel__hint">{t("node.modelInputHint")}</span>
            )}
            {invalidModelDraft && (
              <span id={`node-model-error-${node.id}`} className="node-panel__hint node-panel__model-error">
                {t("node.modelInvalid", { model: model ?? t("node.defaultModel") })}
              </span>
            )}
            {!launchLocked && (effHarness === "opencode" || effHarness === "omp") && (openCodeDiscovery === null || openCodeDiscovery.status === "unavailable") && (
              <span className="node-panel__hint" role="status">
                {openCodeDiscovery === null ? t("node.modelDiscoveryLoading")
                  : t("node.modelDiscoveryUnavailable", { diagnostic: openCodeDiscovery.diagnostic ?? "" })}
              </span>
            )}
          </div>
        )}

        {/* Unsupported saved effort is evidence, not a migration opportunity.
            Keep it visible for Antigravity (or unpaired OMP effort), with explicit removal. */}
        {((effHarness === "antigravity" && effort) || (effHarness === "omp" && effort && !model)) && (
          <div className="node-panel__field">
            <label className="node-panel__key" htmlFor={`node-effort-${node.id}`}>
              {t("node.effortKey", { harness: effHarness })}
            </label>
            <input id={`node-effort-${node.id}`} className="node-panel__custom" value={effort} readOnly aria-invalid />
            <span className="node-panel__hint">{t("nativeAgent.effortUnsupported", { harness: effHarness, effort, task: node.id })}</span>
            <button type="button" className="btn" disabled={launchLocked}
              onClick={() => { if (!launchLocked) setNodeEffort(node.id, null); }}>
              {t("node.clearEffort")}
            </button>
          </div>
        )}

        {/* worker-start accepts effort only alongside a model, and only for
            supported harnesses. Clearing the model clears stored effort. */}
        {model && EFFORT_SUPPORTED[effHarness] === true && (peerModelEffort || effHarness === "omp") && (() => {
          const effortChoices: readonly string[] =
            effHarness === "omp" && openCodeDiscovery?.effortsByModel?.[model]?.length
              ? openCodeDiscovery.effortsByModel[model]
              : EFFORT_LEVELS;
          return (
          <div className="node-panel__field">
            <span className="node-panel__key">{t("node.effortKey", { harness: effHarness })}</span>
            <DoodleSelect
              searchable={false}
              value={effort ?? ""}
              onChange={(v) => {
                if (!launchLocked) setNodeEffort(node.id, v || null);
              }}
              disabled={launchLocked}
              ariaLabel={t("node.effortKey", { harness: effHarness })}
              options={[
                { value: "", label: t("node.defaultEffort") },
                ...((effort && !effortChoices.includes(effort)) ? [{ value: effort, label: effort }] : []),
                ...effortChoices.map((e) => ({ value: e, label: e })),
              ]}
            />
            {!launchLocked && <span className="node-panel__hint">{t("node.effortHint")}</span>}
          </div>
          );
        })()}
        {effHarness === "opencode" && (
          <div className="node-panel__field">
            <span className="node-panel__key">{t("openCode.uiLabel")}</span>
            <DoodleSelect searchable={false} value={config.openCodeUiByTask[node.id] ?? INHERIT} disabled={launchLocked}
              ariaLabel={t("openCode.uiLabel")}
              onChange={value => { if (!launchLocked) setNodeOpenCodeUi(node.id, isOpenCodeUi(value) ? value : null); }}
              options={[
                { value: INHERIT, label: t("openCode.uiInherit", { mode: t(`openCode.ui.${config.defaultOpenCodeUi}`) }) },
                ...OPEN_CODE_UIS.map(value => ({ value, label: t(`openCode.ui.${value}`),
                  disabled: value !== "auto" && Boolean(platform && platform !== "linux" || config.environmentByTask[node.id] ||
                    config.laneByTask[node.id] || ["new-child", "new-top-level"].includes(config.placementByTask[node.id]?.kind ?? "current")),
                  hint: value === "auto" ? undefined : t("openCode.uiRequirements") })),
              ]} />
            {!launchLocked && (config.openCodeUiByTask[node.id] ?? config.defaultOpenCodeUi) === "mini" && (
              <span className="node-panel__hint">{t("openCode.miniPermissions")}</span>
            )}
          </div>
        )}
        {!launchLocked && (effHarness === "opencode" || nativeAgent) && (
          <details className="node-panel__launch-notes">
            <summary>{t("node.launchNotes")}</summary>
            <div>
              {effHarness === "opencode" ? (
                <>
                  <p>{t("openCode.uiRequirements")}</p>
                  <p>{t("node.modelDiscoveryScope")}</p>
                  {openCodeDiscovery && openCodeDiscovery.status !== "unavailable" && <p>
                    {openCodeDiscovery.models.length === 0 ? t("node.modelDiscoveryEmpty") : t("node.modelDiscoveryReady")}
                  </p>}
                  {model && <p>{t("node.openCodeModelLaunchHint")}</p>}
                </>
              ) : (
                <>
                  <p>{t("nativeAgent.requirements")}</p>
                  <p>{t("nativeAgent.surfaceHint")}</p>
                  <p>{t("nativeAgent.modelHint")}</p>
                </>
              )}
            </div>
          </details>
        )}

            </div>
          </section>

          <section className="node-panel__group" aria-label={t("node.workspaceGroupAria")}>
            <h3 className="node-panel__group-title">{t("node.workspaceGroup")}</h3>
            <div className="node-panel__config-body">
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
          {!launchLocked && !laneId && (
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
            {!launchLocked && placement === null && (
              <span className="node-panel__hint">{t("node.remotePlacementHint")}</span>
            )}
          </div>
        )}

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
            </div>
          </section>
        </div>
      )}

    </section>
  );
}
