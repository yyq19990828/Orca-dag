import type { CSSProperties } from "react";
import { AlertOctagon, CheckCircle2, Clock, Lock, PlayCircle } from "lucide-react";
import type { Gate, TaskStatus } from "../types";

const INTEGRATION_OPTIONS = new Set(["integrated"]);

export function statusTokenVars(status: TaskStatus): { fg: string; bg: string } {
  switch (status) {
    case "completed":
      return { fg: "var(--st-completed)", bg: "var(--st-completed-bg)" };
    case "dispatched":
      return { fg: "var(--st-dispatched)", bg: "var(--st-dispatched-bg)" };
    case "failed":
      return { fg: "var(--st-failed)", bg: "var(--st-failed-bg)" };
    case "ready":
      return { fg: "var(--st-ready)", bg: "var(--st-ready-bg)" };
    case "blocked":
      return { fg: "var(--st-blocked)", bg: "var(--st-blocked-bg)" };
    case "pending":
    default:
      return { fg: "var(--st-pending)", bg: "var(--st-pending-bg)" };
  }
}

export function StatusGlyph({
  status,
  executing = false,
  size = 12,
}: {
  status: TaskStatus;
  executing?: boolean;
  size?: number;
}) {
  switch (status) {
    case "completed":
      return <CheckCircle2 size={size} aria-hidden="true" />;
    case "dispatched":
      return (
        <span
          className={executing ? "odag-pulse-dot odag-pulse-dot--live" : "odag-pulse-dot"}
          style={{ "--dot-color": "var(--st-dispatched)" } as CSSProperties}
          aria-hidden="true"
        />
      );
    case "failed":
      return <AlertOctagon size={size} aria-hidden="true" />;
    case "ready":
      return <PlayCircle size={size} aria-hidden="true" />;
    case "blocked":
      return <Lock size={size} aria-hidden="true" />;
    case "pending":
    default:
      return <Clock size={size} aria-hidden="true" />;
  }
}

export function isIntegrationGate(g: Gate): boolean {
  return g.options.length > 0 && g.options.every((o) => INTEGRATION_OPTIONS.has(o.trim().toLowerCase()));
}

export function isGatePending(g: Gate): boolean {
  return g.status === "pending" || g.status === "open" || !g.resolution;
}
