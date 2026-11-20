import {
  AlertTriangle,
  CircleDashed,
  HelpCircle,
  MessageSquare,
  Terminal,
  UserCheck,
} from "lucide-react";
import type { RunCoordinationMode } from "../types";

/**
 * Distinct shape icon per orchestration mode so state is never conveyed by
 * color alone (WCAG 1.4.1). Always paired with visible text (`aria-hidden`).
 */
export function CoordinationModeIcon({
  mode,
  size = 13,
}: {
  mode: RunCoordinationMode;
  size?: number;
}) {
  switch (mode) {
    case "human_panel":
      return <UserCheck size={size} aria-hidden="true" style={{ flex: "none" }} />;
    case "agent_native_chat":
      return <MessageSquare size={size} aria-hidden="true" style={{ flex: "none" }} />;
    case "agent_terminal":
      return <Terminal size={size} aria-hidden="true" style={{ flex: "none" }} />;
    case "panel_mismatch":
      return <AlertTriangle size={size} aria-hidden="true" style={{ flex: "none" }} />;
    case "unbound":
      return <CircleDashed size={size} aria-hidden="true" style={{ flex: "none" }} />;
    default:
      return <HelpCircle size={size} aria-hidden="true" style={{ flex: "none" }} />;
  }
}
