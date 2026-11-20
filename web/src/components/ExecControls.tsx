import { fetchLaunchPreview, startRun, stopRun, type LaunchPlanRequest } from "../api";
import {
  classifyControlTargetMode,
  COORDINATION_MODE_META,
  resolveCoordinationMode,
} from "../coordinationMode";
import { useT, type TranslationKey } from "../i18n";
import { CoordinationModeIcon } from "./CoordinationModeIcon";
import { DoodleSelect } from "./DoodleSelect";
import { LaunchPreview } from "./LaunchPreview";
import { useDecisionDialog } from "./DecisionDialog";
import {
  effortMap,
  environmentMap,
  harnessMap,
  modelMap,
  placementMap,
  refreshConfig,
  retainMap,
  setDefaultHarness,
  setDefaultOpenCodeUi,
  openCodeUiMap,
  setMaxConcurrency,
  useConfig,
  useFlags,
  useReadiness,
  laneMap,
  lanesSpecMap,
} from "../harness";
import { HARNESSES, UNVERIFIED_HARNESSES, OPEN_CODE_UIS, isOpenCodeUi, type DagEdge, type RunCoordinationMode, type RunHealthView, type RunStatus } from "../types";
import { lanePlanProblems } from "../placement";
import { useState, useRef, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Eye, Play, RefreshCw, Square } from "lucide-react";
import { Tooltip } from "./Tooltip";
 

const CUSTOM = "__custom__";
const KNOWN = HARNESSES as readonly string[];

function ActionMount({ host, children }: { host?: HTMLElement | null; children: ReactNode }) {
  const content = <div className="workbench-exec-actions">{children}</div>;
  return host ? createPortal(content, host) : content;
}

/**
 * Short human label for the coordinator's §6.3 phase — a table of dictionary
 * keys, not copy, so each language supplies its own wording. The `| undefined`
 * value type keeps the raw-phase fallback in the renderer meaningful for a
 * server that reports a phase this viewer does not know.
 */
const PHASE_KEY: Record<string, TranslationKey | undefined> = {
  idle: "phase.idle",
  binding: "phase.binding",
  running: "phase.running",
  awaiting_input: "phase.awaitingInput",
  stopping: "phase.stopping",
  completed: "phase.completed",
  recovering: "phase.recovering",
  error: "phase.error",
};

/**
 * Custom harness commands are a server-side policy (see /api/session), so the
 * refusal copy lives in the dictionary (it carries an env-var name that must
 * survive translation verbatim). This const only names the key, keeping the
 * run() preflight throw and the inline hint on the same string.
 */
const CUSTOM_OFF_HINT_KEY = "exec.customOffHint";

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
  labelsById,
  taskIds,
  edges = [],
  readyCount = 0,
  startingRunId = null,
  status = null,
  runHealth = null,
  workerHistoryLoading = false,
  workerHistoryError = null,
  onRunStarting,
  onRunStartFinished,
  onRunStopped,
  actionHost,
  launchHost,
}: {
  /** Run to execute. Mutations are Run-scoped since Orca 1.4.160. */
  runId: string;
  /** Display-only DAG names; preview falls back to the exact task ID. */
  labelsById: Record<string, string>;
  taskIds: string[];
  /** Dependency edges — the lane-plan preflight reads them (Phase 7). */
  edges?: DagEdge[];
  /** ready-but-unfired tasks — the Run button nudges itself when there are any */
  readyCount?: number;
  /** Local App signal raised before POST /api/run can report a bound runId. */
  startingRunId?: string | null;
  /**
   * The process-local /api/run-status snapshot, owned by App — the ONLY
   * periodic caller of that endpoint. This panel used to poll it itself,
   * which duplicated every 2s request and kept firing while the tab was
   * hidden; it now renders whatever App's (visibility-gated) poll provides.
   */
  status?: RunStatus | null;
  /** Shared RunHealth snapshot so Settings & Run confirmation show exact coordination mode. */
  runHealth?: RunHealthView | null;
  /** Worker history is the durable launch-lock source; uncertainty fails closed. */
  workerHistoryLoading?: boolean;
  workerHistoryError?: string | null;
  onRunStarting?: (runId: string) => void;
  onRunStartFinished?: (runId: string, status: RunStatus | null) => void;
  /**
   * Raised once after an explicit Stop succeeds so App can run a one-off
   * reconciliation pass. A second fetch here would re-create the second
   * poller this component just lost — receipts flow up, state flows down.
   */
  onRunStopped?: () => void | Promise<void>;
  actionHost?: HTMLElement | null;
  /** Keep Run on the canvas without mounting a second execution controller. */
  launchHost?: HTMLElement | null;
}) {
  const dialog = useDecisionDialog();
  // Every user-visible string in this panel is translated — the settings
  // summary, the phase label, the lock notices, the dialog copy and the stop
  // report — so subscribe to the UI language here.
  const t = useT();
  const config = useConfig();
  const { customCommandsAllowed: customOk, platform } = useFlags();
  // Execution gate (Phase 2): the server probes the resolved Orca CLI once.
  // null = probe still in flight (controls stay live); false = view-only.
  const readiness = useReadiness();
  const execOff = readiness !== null && !readiness.executionEnabled;
  const storedIsCustom = !KNOWN.includes(config.defaultHarness);
  const storedIsUnverified = UNVERIFIED_HARNESSES[config.defaultHarness] === true;
  // "Custom…" selected but not yet typed — a UI-only state until run()
  const [forceCustom, setForceCustom] = useState(false);
  const [custom, setCustom] = useState(storedIsCustom ? config.defaultHarness : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const previewGeneration = useRef(0);
  const taskIdsRef = useRef(taskIds);
  taskIdsRef.current = taskIds;

  // a custom default arriving from the config file (initial load) fills the input
  useEffect(() => {
    if (storedIsCustom) setCustom(config.defaultHarness);
  }, [storedIsCustom, config.defaultHarness]);

  useEffect(() => {
    previewGeneration.current++;
  }, [runId, config, forceCustom, custom]);

  const defHarness = forceCustom || storedIsCustom ? CUSTOM : config.defaultHarness;
  // `status` is App state fed by its single visibility-gated /api/run-status
  // poll (plus the start receipt and post-stop reconciliation callbacks) — no
  // interval lives in this component.

  // The status endpoint is process-local and can describe another selected
  // Run. Only a matching runId grants this panel running/stop authority.
  const ownStatus = status?.runId === runId ? status : null;
  const otherRunStatus =
    status?.running && status.runId && status.runId !== runId ? status : null;
  const running = ownStatus?.running ?? false;
  const starting = startingRunId === runId;
  const anotherRunStarting = Boolean(startingRunId && startingRunId !== runId);
  const phase = ownStatus?.phase ?? (starting ? "binding" : "idle");
  const phaseKey = PHASE_KEY[phase];
  const historyLockReason = workerHistoryError
    ? t("exec.lockHistoryError")
    : workerHistoryLoading
      ? t("exec.lockHistoryLoading")
      : null;
  const launchLockReason = running
    ? t("exec.lockRunning")
    : starting
      ? t("exec.lockStarting")
      : historyLockReason;
  const launchLocked = running || starting || Boolean(historyLockReason);
  const resolvedDefault = defHarness === CUSTOM ? custom.trim() : defHarness;
  // Settlement/ownership bookkeeping worth surfacing while the loop runs.
  const settled = (ownStatus?.attempts ?? []).filter((a) => a.settled).length;
  const released = (ownStatus?.attempts ?? []).filter((a) =>
    ["released", "retained", "closed"].includes(a.terminalDecision),
  ).length;
  const stopReport = ownStatus?.lastStopReport ?? null;
  const stopUncertain = stopReport?.results.filter((r) => r.result === "unknown") ?? [];

  function pickDefault(h: string) {
    if (launchLocked) return;
    if (h === CUSTOM) {
      setForceCustom(true);
      return;
    }
    setForceCustom(false);
    setDefaultHarness(h);
  }

  async function prepareLaunchPlan(refresh: boolean): Promise<LaunchPlanRequest> {
    if (forceCustom && !custom.trim()) throw new Error(t("err.pickDefaultHarness"));
    if (refresh && forceCustom) setDefaultHarness(custom.trim());
    const launchConfig = refresh ? await refreshConfig() : config;
    const launchDefault = forceCustom ? custom.trim() : launchConfig.defaultHarness;
    if (!launchDefault) throw new Error(t("err.pickDefaultHarness"));
    const harnessByTask = harnessMap(taskIdsRef.current);
    const unverified = [launchDefault, ...Object.values(harnessByTask)]
      .find((harness) => UNVERIFIED_HARNESSES[harness] === true);
    if (unverified) throw new Error(t("exec.unverifiedHarnessHint", { harness: unverified }));
    if (!customOk && [launchDefault, ...Object.values(harnessByTask)].some((harness) => !KNOWN.includes(harness))) {
      throw new Error(t(CUSTOM_OFF_HINT_KEY));
    }
    // effortMap historically pairs effort with a model. Check raw saved intent
    // first so these native agents cannot silently lose an unsupported effort
    // when the model override is absent. The server repeats this boundary.
    for (const id of taskIdsRef.current) {
      const harness = harnessByTask[id] ?? launchDefault;
      const effort = launchConfig.effortByTask[id];
      if ((harness === "omp" || harness === "antigravity") && effort) {
        throw new Error(t("nativeAgent.effortUnsupported", { harness, effort, task: id }));
      }
    }
    const laneProblems = lanePlanProblems(
      launchConfig.laneByTask, launchConfig.worktreeLanes, launchConfig.placementByTask,
      launchConfig.environmentByTask, edges,
    );
    if (laneProblems.length > 0) throw new Error(t("err.placementFix", { detail: laneProblems[0] }));
    return {
      runId,
      harnessByTask,
      defaultHarness: launchDefault,
      maxConcurrency: launchConfig.maxConcurrency,
      modelByTask: modelMap(taskIdsRef.current),
      effortByTask: effortMap(taskIdsRef.current),
      retainByTask: retainMap(taskIdsRef.current),
      environmentByTask: environmentMap(taskIdsRef.current),
      placementByTask: placementMap(taskIdsRef.current),
      worktreeLanes: lanesSpecMap(),
      laneByTask: laneMap(taskIdsRef.current),
      defaultOpenCodeUi: launchConfig.defaultOpenCodeUi,
      openCodeUiByTask: openCodeUiMap(taskIdsRef.current),
    };
  }

  async function inspectPlan() {
    if (!runId || taskIds.length === 0 || busy) return;
    const generation = previewGeneration.current;
    setBusy(true);
    setErr(null);
    try {
      // The standalone control reads the editor snapshot without flushing
      // config writes; Run repeats preview after refreshing the saved plan.
      const plan = await prepareLaunchPlan(false);
      const next = await fetchLaunchPreview(plan);
      if (generation !== previewGeneration.current) return;
      await dialog.alert({
        title: t("exec.previewTitle"),
        message: t("exec.previewDescription"),
        content: <LaunchPreview preview={next} plan={plan} labelsById={labelsById} />,
      });
    } catch (error) {
      setErr(String((error as Error).message ?? error));
    } finally {
      setBusy(false);
    }
  }


  async function run() {
    if (busy) return;
    if (!runId) {
      setErr(t("err.pickRunFirst"));
      return;
    }
    if (execOff) {
      setErr(readiness?.reason ?? t("err.executionUnavailable"));
      return;
    }
    if (forceCustom && !custom.trim()) {
      setErr(t("err.pickDefaultHarness"));
      return;
    }
    if (launchLocked) {
      setErr(launchLockReason ?? t("err.launchLocked"));
      return;
    }
    if (anotherRunStarting) {
      setErr(t("err.runStarting", { id: String(startingRunId) }));
      return;
    }
    if (otherRunStatus) {
      setErr(t("err.runExecuting", { id: String(otherRunStatus.runId) }));
      return;
    }
    setBusy(true);
    setErr(null);
    let startedStatus: RunStatus | null = null;
    let startRequested = false;
    try {
      const plan = await prepareLaunchPlan(true);
      const latestPreview = await fetchLaunchPreview(plan);
      const currentMode = runHealth ? resolveCoordinationMode(runHealth) : null;
      const targetKind = classifyControlTargetMode(runHealth?.coordinatorHandle);
      const confirmCopy =
        currentMode === "unbound"
          ? t("dialog.confirmRunUnbound")
          : currentMode === "agent_native_chat" || currentMode === "agent_terminal"
            ? t("dialog.confirmRunExternal", {
                id: runId,
                mode: t(COORDINATION_MODE_META[currentMode].label),
                handle: runHealth?.coordinatorHandle ?? t("worker.unknown"),
                carrier: t(
                  targetKind === "native_chat"
                    ? "dialog.carrier.chat"
                    : "dialog.carrier.terminal",
                ),
              })
            : t("dialog.confirmRunMessage", { id: runId });
      const ok = await dialog.confirm({
        title: t("exec.previewTitle"),
        message: t("exec.previewConfirmDescription"),
        content: (
          <>
            <p className="launch-preview__coordinator-copy">{confirmCopy}</p>
            <p className="launch-preview__notice">{t("exec.previewReady")}</p>
            <p className="launch-preview__notice">{t("exec.previewWarning")}</p>
            <LaunchPreview preview={latestPreview} plan={plan} labelsById={labelsById} />
          </>
        ),
        confirmLabel: t("dialog.startRun"),
        cancelLabel: t("dialog.notNow"),
      });
      if (!ok) return;
      // The same flushed/refreshed plan used for preview is submitted to start.
      onRunStarting?.(runId);
      startRequested = true;
      startedStatus = await startRun(
        plan.runId,
        plan.harnessByTask,
        plan.defaultHarness,
        plan.maxConcurrency,
        plan.modelByTask,
        plan.effortByTask,
        plan.retainByTask,
        plan.environmentByTask,
        plan.placementByTask,
        plan.worktreeLanes,
        plan.laneByTask,
        undefined,
        { defaultOpenCodeUi: plan.defaultOpenCodeUi, openCodeUiByTask: plan.openCodeUiByTask },
      );
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
      if (startRequested) onRunStartFinished?.(runId, startedStatus);
    }
  }

  async function stop() {
    if (!running) return;
    setBusy(true);
    setErr(null);
    try {
      await stopRun();
      // One-off reconciliation through App (which owns run-status), so the
      // stop report and running flag settle immediately without this panel
      // ever owning a fetch loop of its own.
      await onRunStopped?.();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const activeMode: RunCoordinationMode | null = runId && runHealth
    ? resolveCoordinationMode(runHealth)
    : running
      ? "human_panel"
      : null;
  const activeModeMeta = activeMode ? COORDINATION_MODE_META[activeMode] : null;
  const modeReferenceCards: readonly {
    mode: RunCoordinationMode;
    title: TranslationKey;
    desc: TranslationKey;
  }[] = [
    {
      mode: "human_panel",
      title: "mode.card.humanTitle",
      desc: "mode.card.humanDesc",
    },
    {
      mode: "agent_native_chat",
      title: "mode.card.chatTitle",
      desc: "mode.card.chatDesc",
    },
    {
      mode: "agent_terminal",
      title: "mode.card.termTitle",
      desc: "mode.card.termDesc",
    },
  ];

  return (
    <div className="exec">
      <section className="exec__section odag-modes-section" aria-label={t("mode.card.sectionTitle")}>
        <div className="odag-modes-head">
          <div>
            <h4 className="cap__title">{t("mode.card.sectionTitle")}</h4>
            <p className="cap__note">{t("mode.card.sectionNote")}</p>
          </div>
          {activeMode && activeModeMeta && (
            <span
              className={`odag-mode-pill odag-mode-pill--${activeModeMeta.tone}`}
              title={t(activeModeMeta.brief)}
            >
              <CoordinationModeIcon mode={activeMode} size={12} />
              <span>{t(activeModeMeta.label)}</span>
            </span>
          )}
        </div>

        {runId && activeMode && activeModeMeta && (
          <div className="odag-modes-active">
            <div className="odag-modes-active__row">
              <span className="odag-modes-active__key">{t("mode.card.currentRun", { id: runId })}</span>
              <span className="odag-modes-active__val">{t(activeModeMeta.panelRole)}</span>
            </div>
            <div className="odag-modes-active__row">
              <span className="odag-modes-active__key">{t("health.carrierKey")}</span>
              <span className="odag-modes-active__val">
                {t(activeModeMeta.carrier)}
                {runHealth?.coordinatorHandle ? (
                  <>
                    {" · "}
                    <code>{runHealth.coordinatorHandle}</code>
                  </>
                ) : null}
                {runHealth && runHealth.consumerGeneration !== null
                  ? t("health.generation", { n: runHealth.consumerGeneration })
                  : ""}
              </span>
            </div>
          </div>
        )}

        <div className="odag-modes-grid">
          {modeReferenceCards.map((card) => {
            const meta = COORDINATION_MODE_META[card.mode];
            const isCurrent = activeMode === card.mode;
            return (
              <div
                key={card.mode}
                className={`odag-modes-card odag-modes-card--${meta.tone}${isCurrent ? " is-active" : ""}`}
              >
                <div className="odag-modes-card__head">
                  <span className="odag-modes-card__title">
                    <CoordinationModeIcon mode={card.mode} size={14} />
                    <span>{t(card.title)}</span>
                  </span>
                  {isCurrent && (
                    <span className={`odag-mode-pill odag-mode-pill--${meta.tone}`}>
                      {t("mode.card.current")}
                    </span>
                  )}
                </div>
                <p className="odag-modes-card__desc">{t(card.desc)}</p>
              </div>
            );
          })}
        </div>

        {runId && (
          <div className="odag-modes-handover">
            <span>{t("mode.card.handoverHint")}</span>
            <code>{`orca orchestration run-use --id ${runId}`}</code>
          </div>
        )}
      </section>

      <section className="exec__section" aria-label={t("exec.groupAria")}>
        <h4 className="cap__title">{t("exec.groupAria")}</h4>
        <p className="cap__note">{t("exec.settingsTitle")}</p>
        {launchLockReason && (
          <p className="exec__lock-note" role="note">
            {launchLockReason}
          </p>
        )}

        <div className="exec__rows">
          <div className="exec__row">
            <div className="exec__row-copy">
              <span className="exec__label">{t("exec.defaultHarness")}</span>
              {storedIsUnverified ? (
                <span className="exec__hint">{t("exec.unverifiedHarnessHint", { harness: config.defaultHarness })}</span>
              ) : defHarness === CUSTOM && !customOk ? (
                <span className="exec__hint">{t(CUSTOM_OFF_HINT_KEY)}</span>
              ) : (resolvedDefault === "omp" || resolvedDefault === "antigravity") ? (
                <span className="exec__hint">{t("nativeAgent.requirements")}</span>
              ) : null}
            </div>
            <div className="exec__row-control">
              <DoodleSelect
                searchable={false}
                size="sm"
                value={defHarness}
                onChange={pickDefault}
                disabled={launchLocked}
                ariaLabel={t("exec.defaultHarness")}
                options={[
                  ...HARNESSES.map((h) => ({ value: h, label: h })),
                  ...(customOk || storedIsCustom
                    ? [
                        {
                          value: CUSTOM,
                          label: storedIsUnverified
                            ? t("exec.unverifiedHarness", { harness: config.defaultHarness })
                            : customOk ? t("exec.custom") : t("exec.customDisabled"),
                          disabled: !customOk || storedIsUnverified,
                          hint: storedIsUnverified ? undefined : customOk ? undefined : "ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1",
                        },
                      ]
                    : []),
                ]}
              />
              {defHarness === CUSTOM && (
                <input
                  className="exec__custom"
                  value={custom}
                  placeholder={t("exec.commandPlaceholder")}
                  aria-label={t("exec.customCommandAria")}
                  onChange={(e) => {
                    if (!launchLocked) setCustom(e.target.value);
                  }}
                  disabled={launchLocked || !customOk || storedIsUnverified}
                />
              )}
            </div>
          </div>

          {resolvedDefault === "opencode" && (
            <div className="exec__row">
              <div className="exec__row-copy">
                <span className="exec__label">{t("openCode.uiLabel")}</span>
                <span className="exec__hint">{t("openCode.uiRequirements")}</span>
                {config.defaultOpenCodeUi === "mini" && (
                  <span className="exec__hint">{t("openCode.miniPermissions")}</span>
                )}
              </div>
              <div className="exec__row-control">
                <DoodleSelect
                  searchable={false}
                  size="sm"
                  value={config.defaultOpenCodeUi}
                  disabled={launchLocked}
                  ariaLabel={t("openCode.uiLabel")}
                  onChange={(value) => {
                    if (!launchLocked && isOpenCodeUi(value)) setDefaultOpenCodeUi(value);
                  }}
                  options={OPEN_CODE_UIS.map((value) => ({
                    value,
                    label: t(`openCode.ui.${value}`),
                    disabled: value !== "auto" && Boolean(platform && platform !== "linux"),
                    hint: value === "auto" ? undefined : t("openCode.uiRequirements"),
                  }))}
                />
              </div>
            </div>
          )}

          <label className="exec__row">
            <div className="exec__row-copy">
              <span className="exec__label">{t("exec.maxParallel")}</span>
            </div>
            <div className="exec__row-control">
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
            </div>
          </label>
        </div>
      </section>
      <ActionMount host={actionHost}>
      {/* Hard-disabling a busy trigger blurs it before the dialog can remember
          it. Handlers reject repeat clicks; policy locks stay native-disabled. */}
      <Tooltip className="workbench-exec-preview" content={t("exec.previewButton")}>
        <button
          type="button"
          className="btn btn--icon"
          onClick={inspectPlan}
          disabled={!runId || taskIds.length === 0}
          aria-disabled={busy}
          aria-busy={busy}
          aria-label={t("exec.previewButton")}
        >
          <Eye size={16} />
        </button>
      </Tooltip>

      {running ? (
        <div className="exec__live">
          <Tooltip className="workbench-exec-stop" content={t("exec.stop")}>
            <button
              className="btn btn--stop-run btn--icon"
              onClick={stop}
              disabled={busy}
              aria-label={t("exec.stop")}
            >
              <Square size={12} fill="currentColor" />
            </button>
          </Tooltip>
          <span className="exec__running">
            <span className="exec__pulse" /> {phaseKey ? t(phaseKey) : phase} ·{" "}
            {(ownStatus?.busy ?? 0) === 1
              ? t("exec.busyWorkersOne", { n: ownStatus?.busy ?? 0 })
              : t("exec.busyWorkersMany", { n: ownStatus?.busy ?? 0 })}
            {/* one bead per in-flight Dispatch, breathing out of phase */}
            <span className="exec__beads" aria-hidden="true">
              {Array.from({ length: Math.min(ownStatus?.busy ?? 0, 8) }, (_, i) => (
                <i key={i} style={{ animationDelay: `${i * 0.14}s` }} />
              ))}
            </span>
            {/* settled workers that reached an explicit ownership decision */}
            {settled > 0 && (
              <b className="exec__settled" title={t("exec.settledTitle")}>
                {t("exec.settledCount", { released, settled })}
              </b>
            )}
          </span>
        </div>
      ) : starting ? (
        <div className="exec__live">
          <Tooltip className="workbench-exec-stop" content={t("exec.stop")}>
            <button
              type="button"
              className="btn btn--stop-run btn--icon"
              disabled
              title={t("exec.stopPendingTitle")}
              aria-label={t("exec.stop")}
            >
              <Square size={12} fill="currentColor" />
            </button>
          </Tooltip>
          <span className="exec__running">
            <span className="exec__pulse" /> {t("exec.bindingRecovering")}
          </span>
        </div>
      ) : phase === "completed" ? (
        <div className="exec__live">
          <ActionMount host={launchHost}>
          <Tooltip className="workbench-exec-launch" content={t("exec.runAgain")}>
            <button
              className="btn btn--run btn--icon"
              onClick={run}
              disabled={busy || launchLocked || anotherRunStarting || Boolean(otherRunStatus) || !runId || execOff}
              aria-label={t("exec.runAgain")}
            >
              <RefreshCw size={16} aria-hidden="true" />
            </button>
          </Tooltip>
          </ActionMount>
          <span
            className="exec__running exec__done"
            title={ownStatus?.completedAt ? t("exec.completedAt", { time: new Date(ownStatus.completedAt).toLocaleTimeString() }) : undefined}
          >
            <span className="exec__done-long">
              {(ownStatus?.attempts.length ?? 0) === 1
                ? t("exec.completedReleasedOne", { n: ownStatus?.attempts.length ?? 0 })
                : t("exec.completedReleasedMany", { n: ownStatus?.attempts.length ?? 0 })}
            </span>
            <span className="exec__done-short">{t("exec.doneShort")}</span>
          </span>
        </div>
      ) : (
        <ActionMount host={launchHost}>
        <Tooltip
          className="workbench-exec-launch"
          content={
            execOff
              ? readiness?.reason ?? t("exec.execUnavailableTitle")
              : runId
                ? t("exec.bindRunTitle")
                : t("err.pickRunFirst")
          }
        >
          <button
            className={`btn btn--run btn--icon${readyCount > 0 && !busy && !execOff ? " btn--attract" : ""}`}
            onClick={run}
            aria-disabled={busy}
            aria-busy={busy}
            disabled={
              launchLocked || anotherRunStarting || Boolean(otherRunStatus) || taskIds.length === 0 || !runId || execOff
            }
            aria-label={t("exec.runWithOrca")}
          >
            <Play size={16} fill="currentColor" aria-hidden="true" />
          </button>
        </Tooltip>
        </ActionMount>
      )}

      {/* explicit Stop must report every uncertain teardown, never swallow it */}
      {stopReport && !running && (
        stopReport.clean ? (
          <span className="exec__notice exec__notice--ok" role="status">
            {stopReport.results.length === 1
              ? t("exec.stopCleanOne", { n: stopReport.results.length })
              : t("exec.stopCleanMany", { n: stopReport.results.length })}
          </span>
        ) : (
          <details className="exec__stop-report exec__stop-report--warn">
            <summary role="status">
              {stopReport.results.length === 1
                ? t("exec.stopUncertainOne", { uncertain: stopUncertain.length, n: stopReport.results.length })
                : t("exec.stopUncertainMany", { uncertain: stopUncertain.length, n: stopReport.results.length })}
            </summary>
            <ul className="exec__stop-unknowns">
              {stopUncertain.map((r, i) => (
                <li key={`${r.target}-${i}`}>
                  <code>{r.target}</code> ({r.kind}) — {r.detail ?? t("exec.outcomeUnknown")}
                </li>
              ))}
            </ul>
          </details>
        )
      )}

      {(execOff || launchLockReason || otherRunStatus || (anotherRunStarting && !otherRunStatus) || err || ownStatus?.error || Object.keys(ownStatus?.stageGit?.errors ?? {}).length > 0) && (
        <div className="exec__notices" aria-live="polite">
          {execOff && <span className="exec__hint">🔒 {readiness?.reason}</span>}
          {launchLockReason && <span className="exec__hint">🔒 {launchLockReason}</span>}
          {otherRunStatus && (
            <span className="exec__hint">
              🔒 {t("exec.runPrefix")}{" "}
              <code>{otherRunStatus.runId}</code>{" "}
              {t("exec.otherRunExecSuffix")}
            </span>
          )}
          {anotherRunStarting && !otherRunStatus && (
            <span className="exec__hint">
              🔒 {t("exec.runPrefix")}{" "}
              <code>{startingRunId}</code>{" "}
              {t("exec.otherRunStartingSuffix")}
            </span>
          )}
          {(err || ownStatus?.error) && (
            <span className="exec__err" role="alert" title={err || ownStatus?.error || undefined}>
              ⚠️ {err || ownStatus?.error}
            </span>
          )}
          {Object.entries(ownStatus?.stageGit?.errors ?? {}).map(([taskId, detail]) => (
            <span className="exec__err" role="alert" key={taskId}>
              ⚠️ <code>{taskId}</code>: {detail}
            </span>
          ))}
        </div>
      )}
      </ActionMount>
    </div>
  );
}
