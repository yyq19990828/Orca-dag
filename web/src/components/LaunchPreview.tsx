import { useState } from "react";
import type { LaunchPlanRequest, LaunchPreviewResponse } from "../api";
import { useT, type TranslationKey } from "../i18n";
import "./launch-preview.css";

const ROUTE_LABEL: Record<string, TranslationKey> = {
  "native-default": "exec.previewNativeDefault",
  "native-model": "exec.previewNativeModel",
  "api-mini": "exec.previewMini",
  "api-tui": "exec.previewTui",
  "cli-run": "exec.previewCliRun",
  "custom-command": "exec.previewCustomCommand",
  unsupported: "exec.previewUnsupported",
  supervised: "exec.previewSupervised",
};

const REASON_LABEL: Record<string, TranslationKey> = {
  placementUnsupported: "exec.routeReason.placementUnsupported",
  nativeDefault: "exec.routeReason.nativeDefault",
  nativeModel: "exec.routeReason.nativeModel",
  apiTui: "exec.routeReason.apiTui",
  apiUnsupportedPlacement: "exec.routeReason.apiUnsupportedPlacement",
  apiRuntimeTooOld: "exec.routeReason.apiRuntimeTooOld",
  capabilityMissing: "exec.routeReason.capabilityMissing",
  runtimeUnknown: "exec.routeReason.runtimeUnknown",
  runtimeOld: "exec.routeReason.runtimeOld",
  variantCli: "exec.routeReason.variantCli",
  effortCli: "exec.routeReason.effortCli",
  cliCompatibility: "exec.routeReason.cliCompatibility",
  supervisedCaveat: "exec.routeReason.supervisedCaveat",
  customCommandCaveat: "exec.routeReason.customCommandCaveat",
  customCommandPlacementUnsupported: "exec.routeReason.customCommandPlacementUnsupported",
};

const LIMITATION_LABEL: Record<string, TranslationKey> = {
  cliNoFleetHooks: "exec.routeLimitation.cliNoFleetHooks",
  providerEvidenceSeparate: "exec.routeLimitation.providerEvidenceSeparate",
  noFallback: "exec.routeLimitation.noFallback",
  apiNeedsPreparedRuntime: "exec.routeLimitation.apiNeedsPreparedRuntime",
};

const STATUS_LABEL: Record<string, TranslationKey> = {
  pending: "status.pending",
  ready: "status.ready",
  dispatched: "status.dispatched",
  completed: "status.completed",
  failed: "status.failed",
  blocked: "status.blocked",
};

export function LaunchPreview({
  preview,
  plan,
  labelsById,
}: {
  preview: LaunchPreviewResponse;
  plan: LaunchPlanRequest;
  labelsById: Record<string, string>;
}) {
  const t = useT();
  const [copyState, setCopyState] = useState<{ taskId: string; ok: boolean } | null>(null);
  const commonLimitations = preview.tasks[0]?.limitations.filter((code) =>
    preview.tasks.every((task) => task.limitations.includes(code)),
  ) ?? [];
  const commonLimits = new Set(commonLimitations);

  async function copyId(taskId: string) {
    try {
      await navigator.clipboard.writeText(taskId);
      setCopyState({ taskId, ok: true });
    } catch {
      setCopyState({ taskId, ok: false });
    }
  }
  const placementLabel = (task: LaunchPreviewResponse["tasks"][number]) => {
    const kind = task.placement.kind === "existing"
      ? t("exec.previewWorkspaceExisting", { selector: task.placement.selector ?? "" })
      : task.placement.kind === "new-child"
        ? t("exec.previewWorkspaceNewChild")
        : task.placement.kind === "new-top-level"
          ? t("exec.previewWorkspaceNewTopLevel")
          : task.placement.kind === "current"
            ? t("exec.previewWorkspaceCurrent")
            : task.placement.kind;
    return [task.placement.environment ?? t("exec.previewLocal"), task.placement.laneId ?? t("exec.previewNoLane"), kind].join(" · ");
  };

  return (
    <div className="launch-preview">
      <section className="launch-preview__shared" aria-labelledby="launch-preview-shared-title">
        <h3 id="launch-preview-shared-title">{t("exec.previewSharedSettings")}</h3>
        <dl>
          <div><dt>{t("exec.defaultHarness")}</dt><dd>{plan.defaultHarness}</dd></div>
          <div><dt>{t("exec.maxParallel")}</dt><dd>{plan.maxConcurrency}</dd></div>
          {(plan.defaultHarness === "opencode" || preview.tasks.some((task) => task.harness === "opencode")) && (
            <div><dt>{t("exec.previewOpenCodeUi")}</dt><dd>{t(`openCode.ui.${plan.defaultOpenCodeUi}`)}</dd></div>
          )}
        </dl>
      </section>
      {commonLimitations.length > 0 && (
        <section className="launch-preview__limitations" aria-labelledby="launch-preview-limits-title">
          <h3 id="launch-preview-limits-title">{t("exec.previewCommonLimits")}</h3>
          <ul>{commonLimitations.map((code, index) => (
            <li key={`${code}-${index}`}>{LIMITATION_LABEL[code] ? t(LIMITATION_LABEL[code]) : code}</li>
          ))}</ul>
        </section>
      )}

      <section className="launch-preview__tasks" aria-labelledby="launch-preview-tasks-title">
        <h3 id="launch-preview-tasks-title">{t("exec.previewTasks", { n: preview.tasks.length })}</h3>
        <ul className="launch-preview__task-list">
          {preview.tasks.map((task) => {
            const label = labelsById[task.taskId] || task.taskId;
            const reasonKey = REASON_LABEL[task.reasonCode];
            const limitations = task.limitations.filter((code) => !commonLimits.has(code));
            const needsReview = task.route === "unsupported" || !ROUTE_LABEL[task.route]
              || !reasonKey || limitations.length > 0
              || task.limitations.some((code) => !LIMITATION_LABEL[code]);
            const hasModelOverride = Object.prototype.hasOwnProperty.call(plan.modelByTask, task.taskId);
            const hasEffortOverride = Object.prototype.hasOwnProperty.call(plan.effortByTask, task.taskId);
            const hasRetentionOverride = Object.prototype.hasOwnProperty.call(plan.retainByTask, task.taskId);
            const hasHarnessOverride = Object.prototype.hasOwnProperty.call(plan.harnessByTask, task.taskId)
              && plan.harnessByTask[task.taskId] !== plan.defaultHarness;
            const hasPlacementOverride = Object.prototype.hasOwnProperty.call(plan.placementByTask, task.taskId);
            const hasEnvironmentOverride = Object.prototype.hasOwnProperty.call(plan.environmentByTask, task.taskId);
            const hasLaneOverride = Object.prototype.hasOwnProperty.call(plan.laneByTask, task.taskId);
            const hasOpenCodeUiOverride = Object.prototype.hasOwnProperty.call(plan.openCodeUiByTask, task.taskId)
              && plan.openCodeUiByTask[task.taskId] !== plan.defaultOpenCodeUi;
            const hasRequestedOverrides = hasHarnessOverride || hasModelOverride || hasEffortOverride
              || hasRetentionOverride || hasPlacementOverride || hasEnvironmentOverride
              || hasLaneOverride || hasOpenCodeUiOverride;
            return (
              <li key={task.taskId}>
                <details open={needsReview || undefined}>
                  <summary data-attention={needsReview || undefined}>
                    <span className="launch-preview__task-name">{label}</span>
                    <span className="launch-preview__task-route">
                      {ROUTE_LABEL[task.route] ? t(ROUTE_LABEL[task.route]) : task.route}
                      {needsReview && <strong>{t("exec.previewReviewTask")}</strong>}
                    </span>
                    <svg className="launch-preview__chevron" viewBox="0 0 14 9" aria-hidden="true" focusable="false">
                      <path d="M1.5 1.5 C3.5 4 5 5.8 7 7.2 C9 5.8 10.5 4 12.5 1.5" />
                    </svg>
                  </summary>
                  <div className="launch-preview__task-body">
                    <div className="launch-preview__identity">
                      <span><strong>{t("exec.previewTaskId")}</strong> <code>{task.taskId}</code></span>
                      <button type="button" className="launch-preview__copy" onClick={() => void copyId(task.taskId)}>
                        {t(copyState?.taskId === task.taskId && copyState.ok ? "exec.previewCopiedId" : "exec.previewCopyId")}
                      </button>
                    </div>
                    {copyState?.taskId === task.taskId && (
                      <p className="launch-preview__copy-status" role="status">
                        {t(copyState.ok ? "exec.previewCopiedId" : "exec.previewCopyFailed")}
                      </p>
                    )}
                    <dl>
                      <div><dt>{t("exec.previewStatus")}</dt><dd>{STATUS_LABEL[task.status] ? t(STATUS_LABEL[task.status]) : task.status}</dd></div>
                      <div><dt>{t("exec.previewResolvedHarness")}</dt><dd>{task.harness}</dd></div>
                      <div><dt>{t("exec.previewResolvedModel")}</dt><dd>{task.model ?? t("exec.previewDefaultModel")}</dd></div>
                      <div><dt>{t("exec.previewPlacementLabel")}</dt><dd>{placementLabel(task)}</dd></div>
                      <div><dt>{t("exec.previewRoute")}</dt><dd>{ROUTE_LABEL[task.route] ? t(ROUTE_LABEL[task.route]) : task.route}</dd></div>
                      <div><dt>{t("exec.previewReason")}</dt><dd>{reasonKey ? t(reasonKey) : task.reasonCode}{task.reason && task.reason !== task.reasonCode ? ` · ${task.reason}` : ""}</dd></div>
                    </dl>
                    {hasRequestedOverrides && (
                      <div className="launch-preview__requested">
                        <h4>{t("exec.previewRequestedOverrides")}</h4>
                        <dl>
                          {hasHarnessOverride && <div><dt>{t("exec.previewRequestedHarness")}</dt><dd>{plan.harnessByTask[task.taskId]}</dd></div>}
                          {hasModelOverride && <div><dt>{t("exec.previewRequestedModel")}</dt><dd>{plan.modelByTask[task.taskId]}</dd></div>}
                          {hasEffortOverride && <div><dt>{t("exec.previewRequestedEffort")}</dt><dd>{plan.effortByTask[task.taskId]}</dd></div>}
                          {hasRetentionOverride && <div><dt>{t("exec.previewRequestedRetention")}</dt><dd>{t(plan.retainByTask[task.taskId] ? "data.yes" : "data.no")}</dd></div>}
                          {hasPlacementOverride && <div><dt>{t("exec.previewRequestedPlacement")}</dt><dd><code>{JSON.stringify(plan.placementByTask[task.taskId])}</code></dd></div>}
                          {hasEnvironmentOverride && <div><dt>{t("exec.previewRequestedEnvironment")}</dt><dd>{plan.environmentByTask[task.taskId]}</dd></div>}
                          {hasLaneOverride && <div><dt>{t("exec.previewRequestedLane")}</dt><dd>{plan.laneByTask[task.taskId]}</dd></div>}
                          {hasOpenCodeUiOverride && <div><dt>{t("exec.previewRequestedOpenCodeUi")}</dt><dd>{plan.openCodeUiByTask[task.taskId]}</dd></div>}
                        </dl>
                      </div>
                    )}
                    {limitations.length > 0 && (
                      <div className="launch-preview__limitations">
                        <h4>{t("exec.previewLimitations")}</h4>
                        <ul>{limitations.map((code, index) => <li key={`${code}-${index}`}>{LIMITATION_LABEL[code] ? t(LIMITATION_LABEL[code]) : code}</li>)}</ul>
                      </div>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="launch-preview__caveat">{preview.caveat}</p>
      <p className="launch-preview__notice">{t("exec.previewNotProof")}</p>
      <p className="launch-preview__notice">{t("exec.previewExternalRuntime")}</p>
    </div>
  );
}
