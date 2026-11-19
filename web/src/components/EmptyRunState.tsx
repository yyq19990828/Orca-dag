import { useEffect, useId } from "react";
import { Check, Copy, History, SlidersHorizontal, Sparkles, Terminal } from "lucide-react";
import { useT } from "../i18n";
import { DagBrandMark } from "./DagBrandMark";
import "./empty-run-state.css";

const copyTimers = new WeakMap<HTMLButtonElement, number>();
let lastCopyAnnouncement = "";

function legacyCopy(text: string): boolean {
  const field = Object.assign(document.createElement("textarea"), { value: text });
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;inset-block-start:0;opacity:0";
  document.body.append(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

function reportCopy(button: HTMLButtonElement, ok: boolean, copiedLabel: string, failedLabel: string): void {
  const tip = button.nextElementSibling as HTMLElement | null;
  const prev = copyTimers.get(button);
  if (prev !== undefined) window.clearTimeout(prev);
  button.removeAttribute("data-copied");
  button.removeAttribute("data-failed");
  let message = ok ? copiedLabel : failedLabel;
  if (message === lastCopyAnnouncement) message += "\u00A0";
  lastCopyAnnouncement = message;
  if (tip) tip.textContent = "";
  void button.offsetWidth;
  button.setAttribute(ok ? "data-copied" : "data-failed", "");
  window.requestAnimationFrame(() => {
    if (tip) tip.textContent = message;
  });
  copyTimers.set(
    button,
    window.setTimeout(() => {
      button.removeAttribute("data-copied");
      button.removeAttribute("data-failed");
      if (tip) tip.textContent = "";
    }, 2000),
  );
}

async function performCopy(button: HTMLButtonElement, target: HTMLElement): Promise<void> {
  const text =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target.value
      : target.innerText.trim();
  if (!text) return;
  const copiedLabel = button.dataset.copiedLabel || "Copied";
  const failedLabel = button.dataset.failedLabel || "Copy failed";
  try {
    await navigator.clipboard.writeText(text);
    reportCopy(button, true, copiedLabel, failedLabel);
  } catch {
    if (legacyCopy(text)) {
      reportCopy(button, true, copiedLabel, failedLabel);
    } else {
      reportCopy(button, false, copiedLabel, failedLabel);
    }
  }
}

let copyListenersRegistered = false;

function ensureCopyListeners(): void {
  if (copyListenersRegistered || typeof window === "undefined") return;
  copyListenersRegistered = true;
  // Use native Invoker Commands (`command` + `commandfor`) when available;
  // otherwise register a single click-delegation fallback so clicks never fire twice.
  if ("CommandEvent" in window) {
    document.addEventListener(
      "command",
      (event: Event) => {
        const cmdEvent = event as Event & { command?: string; source?: Element | null };
        if (
          typeof cmdEvent.command === "string" &&
          cmdEvent.command.startsWith("--copy") &&
          cmdEvent.source instanceof HTMLButtonElement &&
          cmdEvent.target instanceof HTMLElement
        ) {
          void performCopy(cmdEvent.source, cmdEvent.target);
        }
      },
      true,
    );
  } else {
    document.addEventListener("click", (event) => {
      const targetEl = event.target instanceof Element ? event.target : null;
      const button = targetEl?.closest<HTMLButtonElement>('button[command^="--copy"]');
      if (!button) return;
      const targetId = button.getAttribute("commandfor");
      if (!targetId) return;
      const target = document.getElementById(targetId);
      if (target) void performCopy(button, target);
    });
  }
}

function CopyButton({
  targetId,
  ariaLabel,
}: {
  targetId: string;
  ariaLabel: string;
}) {
  const t = useT();
  useEffect(() => {
    ensureCopyListeners();
  }, []);

  return (
    <span className="odag-copy">
      <button
        type="button"
        className="odag-copy-btn"
        aria-label={ariaLabel}
        title={ariaLabel}
        data-copied-label={t("empty.copied")}
        data-failed-label={t("empty.copyFailed")}
        {...({ command: "--copy", commandfor: targetId } as Record<string, string>)}
      >
        <Copy size={13} className="odag-copy-btn__icon-copy" aria-hidden="true" />
        <Check size={13} className="odag-copy-btn__icon-check" aria-hidden="true" />
      </button>
      <span className="odag-copy-tip" role="status" />
    </span>
  );
}

/**
 * Calm, centered onboarding empty state shown when no Run is active.
 * Shared across the full 4-zone workbench (`App.tsx`) and the narrow Orca
 * right-sidebar panel (`SidebarApp.tsx`, `compact={true}`).
 */
export function EmptyRunState({
  compact = false,
  hasRuns = false,
  cli = "orca",
  onOpenRuns,
  onOpenSettings,
}: {
  compact?: boolean;
  hasRuns?: boolean;
  cli?: string;
  onOpenRuns?: () => void;
  onOpenSettings?: () => void;
}) {
  const t = useT();
  const idPrefix = useId();
  const promptId = `${idPrefix}-skill-prompt`;
  const cliId = `${idPrefix}-cli-cmd`;

  const resolvedCli = cli.trim() || "orca";
  const cliSnippet = `${resolvedCli} orchestration run-create --objective "<goal>"`;

  return (
    <div className={`odag-empty-stage${compact ? " odag-empty-stage--compact" : ""}`}>
      <section className="odag-empty-card" aria-labelledby={`${idPrefix}-title`}>
        <div className="odag-empty-card__head">
          <span className="odag-empty-card__emblem" aria-hidden="true">
            <DagBrandMark size={compact ? 20 : 26} />
          </span>
          <h2 id={`${idPrefix}-title`} className="odag-empty-card__title">
            {hasRuns ? t("empty.selectRunTitle") : t("empty.noRunsTitle")}
          </h2>
          <p className="odag-empty-card__desc">
            {hasRuns ? t("empty.selectRunDesc") : t("empty.noRunsDesc")}
          </p>
        </div>

        <div className="odag-empty-steps">
          <div className="odag-empty-step">
            <div className="odag-empty-step__label">
              <Sparkles size={13} aria-hidden="true" />
              <span>{t("empty.stepSkillTitle")}</span>
              <span className="odag-empty-step__badge">{t("empty.recommended")}</span>
            </div>
            <div className="odag-empty-snippet">
              <code id={promptId}>{t("empty.skillPrompt")}</code>
              <CopyButton targetId={promptId} ariaLabel={t("empty.copyPromptAria")} />
            </div>
          </div>

          <div className="odag-empty-step">
            <div className="odag-empty-step__label">
              <Terminal size={13} aria-hidden="true" />
              <span>{t("empty.stepCliTitle")}</span>
            </div>
            <div className="odag-empty-snippet">
              <code id={cliId}>{cliSnippet}</code>
              <CopyButton targetId={cliId} ariaLabel={t("empty.copyCliAria")} />
            </div>
          </div>
        </div>

        {!compact && (onOpenRuns || onOpenSettings) && (
          <div className="odag-empty-actions">
            {onOpenRuns && (
              <button type="button" className="odag-btn" onClick={onOpenRuns}>
                <History size={13} aria-hidden="true" />
                <span>{t("ide.nav.runs")}</span>
              </button>
            )}
            {onOpenSettings && (
              <button type="button" className="odag-btn" onClick={onOpenSettings}>
                <SlidersHorizontal size={13} aria-hidden="true" />
                <span>{t("ide.nav.settings")}</span>
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
