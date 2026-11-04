import { useT } from "../i18n";
import type { NativeLaunchMode } from "../types";

/** Preserve native receipts, including contradictory reused-chat mode/detail fields. */
export function NativeLaunchEvidence({ launchMode }: { launchMode: NativeLaunchMode }) {
  const t = useT();
  const label = (mode: string | null) => mode === "structured"
    ? t("worker.nativeModeStructured")
    : mode === "terminal" ? t("worker.nativeModeTerminal") : mode ?? t("worker.unknown");
  return (
    <div className="inbox__body" data-testid="native-launch-evidence">
      {t("worker.nativeSurface")} {t("worker.nativePreferred")} <b>{label(launchMode.preferred)}</b>
      {t("worker.nativeReported")}<b>{label(launchMode.mode)}</b>
      {launchMode.reason && <div className="inbox__meta">{t("worker.nativeReason")} {launchMode.reason}</div>}
      {launchMode.detail && <div className="inbox__meta">{t("worker.nativeDetail")} {launchMode.detail}</div>}
    </div>
  );
}
