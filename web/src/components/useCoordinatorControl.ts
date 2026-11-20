import { ApiError, fetchCoordinatorControl, type CoordinatorControl } from "../api";
import { classifyControlTargetMode } from "../coordinationMode";
import { useT } from "../i18n";
import { useDecisionDialog } from "./DecisionDialog";

/** A refusal is pre-effect; only a fresh binding and explicit consent allow retry. */
export function useCoordinatorControl() {
  const dialog = useDecisionDialog();
  const t = useT();
  return async function withControl<T>(runId: string, action: (control?: CoordinatorControl) => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "coordinator_control_required") throw error;
      const control = await fetchCoordinatorControl(runId);
      const targetKind = classifyControlTargetMode(control.coordinatorHandle);
      const modeLabel =
        targetKind === "native_chat"
          ? t("mode.agent_native_chat.label")
          : targetKind === "external_terminal"
            ? t("mode.agent_terminal.label")
            : t("mode.unbound.label");
      const accepted = await dialog.confirm({
        title: t("control.title"),
        message: t("control.messageTyped", {
          run: runId,
          mode: modeLabel,
          handle: control.coordinatorHandle ?? t("ide.runs.unbound"),
          generation: String(control.consumerGeneration ?? t("worker.unknown")),
        }),
        confirmLabel: t("control.confirm"),
        tone: "danger",
      });
      if (!accepted) throw error;
      return action(control);
    }
  };
}
