import type { TranslationKey } from "./i18n";
import type { OrcaRun, RunCoordinationMode, RunHealthView, RunStatus } from "./types";

export type CoordinationModeTone = "ok" | "chat" | "term" | "warn" | "muted" | "bad";

export interface CoordinationModeMeta {
  shortLabel: TranslationKey;
  label: TranslationKey;
  hubLabel: TranslationKey;
  carrier: TranslationKey;
  panelRole: TranslationKey;
  brief: TranslationKey;
  tone: CoordinationModeTone;
  isExternal: boolean;
}

const VALID_MODES = new Set<string>([
  "human_panel",
  "panel_mismatch",
  "agent_native_chat",
  "agent_terminal",
  "unbound",
  "unknown",
]);

/** True when a coordinator handle names an Orca Native Chat session (non-PTY). */
export function isChatCoordinatorHandle(handle: string | null | undefined): boolean {
  if (typeof handle !== "string") return false;
  const trimmed = handle.trim();
  return (
    trimmed.startsWith("orca_session_id:") ||
    trimmed.startsWith("session:") ||
    trimmed.startsWith("chat:")
  );
}

/** Resolve the fine-grained coordination mode from a RunHealthView (with fallback for older backends). */
export function resolveCoordinationMode(
  health: Pick<RunHealthView, "ownership" | "coordinatorHandle" | "coordinationMode"> | null | undefined,
): RunCoordinationMode {
  if (!health) return "unknown";
  if (health.coordinationMode && VALID_MODES.has(health.coordinationMode)) {
    return health.coordinationMode;
  }
  switch (health.ownership) {
    case "viewer_coordinator":
      return "human_panel";
    case "viewer_coordinator_other_run":
      return "panel_mismatch";
    case "external_coordinator":
      return isChatCoordinatorHandle(health.coordinatorHandle)
        ? "agent_native_chat"
        : "agent_terminal";
    case "unbound":
      return "unbound";
    default:
      return "unknown";
  }
}

/** Classify a Run ledger row against the live viewer coordinator status. */
export function classifyRunRowMode(
  run: Pick<OrcaRun, "id" | "coordinator_handle">,
  viewerStatus: Pick<RunStatus, "running" | "runId" | "coordinatorHandle"> | null | undefined,
): RunCoordinationMode {
  const bound = typeof run.coordinator_handle === "string" ? run.coordinator_handle.trim() : "";
  if (!bound) return "unbound";
  const ourHandle = viewerStatus?.coordinatorHandle?.trim() ?? "";
  if (viewerStatus?.running && ourHandle && bound === ourHandle) {
    return viewerStatus.runId === run.id ? "human_panel" : "panel_mismatch";
  }
  return isChatCoordinatorHandle(bound) ? "agent_native_chat" : "agent_terminal";
}

/** Classify a bound handle during a takeover or one-off control confirmation. */
export function classifyControlTargetMode(
  coordinatorHandle: string | null | undefined,
): "native_chat" | "external_terminal" | "unbound" {
  const bound = typeof coordinatorHandle === "string" ? coordinatorHandle.trim() : "";
  if (!bound) return "unbound";
  return isChatCoordinatorHandle(bound) ? "native_chat" : "external_terminal";
}

/** Compact display form for long coordinator handles; full handle belongs in `title`. */
export function formatCoordinatorHandleShort(handle: string | null | undefined, max = 26): string {
  if (!handle) return "";
  const trimmed = handle.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

export const COORDINATION_MODE_META: Record<RunCoordinationMode, CoordinationModeMeta> = {
  human_panel: {
    shortLabel: "mode.human_panel.short",
    label: "mode.human_panel.label",
    hubLabel: "mode.human_panel.hub",
    carrier: "mode.human_panel.carrier",
    panelRole: "mode.human_panel.role",
    brief: "mode.human_panel.brief",
    tone: "ok",
    isExternal: false,
  },
  panel_mismatch: {
    shortLabel: "mode.panel_mismatch.short",
    label: "mode.panel_mismatch.label",
    hubLabel: "mode.panel_mismatch.hub",
    carrier: "mode.panel_mismatch.carrier",
    panelRole: "mode.panel_mismatch.role",
    brief: "mode.panel_mismatch.brief",
    tone: "warn",
    isExternal: false,
  },
  agent_native_chat: {
    shortLabel: "mode.agent_native_chat.short",
    label: "mode.agent_native_chat.label",
    hubLabel: "mode.agent_native_chat.hub",
    carrier: "mode.agent_native_chat.carrier",
    panelRole: "mode.agent_native_chat.role",
    brief: "mode.agent_native_chat.brief",
    tone: "chat",
    isExternal: true,
  },
  agent_terminal: {
    shortLabel: "mode.agent_terminal.short",
    label: "mode.agent_terminal.label",
    hubLabel: "mode.agent_terminal.hub",
    carrier: "mode.agent_terminal.carrier",
    panelRole: "mode.agent_terminal.role",
    brief: "mode.agent_terminal.brief",
    tone: "term",
    isExternal: true,
  },
  unbound: {
    shortLabel: "mode.unbound.short",
    label: "mode.unbound.label",
    hubLabel: "mode.unbound.hub",
    carrier: "mode.unbound.carrier",
    panelRole: "mode.unbound.role",
    brief: "mode.unbound.brief",
    tone: "muted",
    isExternal: false,
  },
  unknown: {
    shortLabel: "mode.unknown.short",
    label: "mode.unknown.label",
    hubLabel: "mode.unknown.hub",
    carrier: "mode.unknown.carrier",
    panelRole: "mode.unknown.role",
    brief: "mode.unknown.brief",
    tone: "bad",
    isExternal: false,
  },
};
