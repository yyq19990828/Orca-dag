import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Translator } from "../i18n";
import type { ActivityEvent, DagNode, WorkerRowView } from "../types";

export type CanvasCommsMode = "live" | "pinned" | "off";
export type CommsDirection = "down" | "up";
export type PendingSignalKind = "reply" | "permission" | "stop";

export interface CanvasCommsPulse {
  id: string;
  taskId: string;
  direction: CommsDirection;
  color: string;
  dashed: boolean;
  pillText: string | null;
  durationMs: number;
  curveBias: number;
  createdAt: number;
}

export interface CanvasCommsPill {
  id: string;
  taskId: string;
  direction: CommsDirection;
  text: string;
  color: string;
  leaving: boolean;
}

export interface PendingTaskSignal {
  taskId: string;
  kind: PendingSignalKind;
  label: string;
  summary: string;
}

export interface RecentCommsLink {
  taskId: string;
  direction: CommsDirection;
  color: string;
  count: number;
  lastAt: number;
}

export interface OffscreenCommsAlert {
  taskId: string;
  label: string;
  direction: CommsDirection;
  text: string;
  color: string;
}

export interface LastTaskComm {
  direction: CommsDirection;
  text: string;
}

const MAX_CONCURRENT_PULSES = 6;
const STAGGER_MS = 110;
const FINGERPRINT_TTL_MS = 18_000;
const PILL_DWELL_MS = 2_900;
const PILL_EXIT_MS = 300;
const PULSE_FADE_MS = 460;
const HEARTBEAT_FLASH_MS = 950;
const ARRIVAL_FLASH_MS = 620;
const OFFSCREEN_ALERT_MS = 4_200;
const RECENT_WINDOW_MS = 10 * 60_000;

function compactPreview(raw: string | null | undefined, max = 36): string {
  const cleaned = raw?.replace(/\s+/g, " ").trim() ?? "";
  if (!cleaned) return "";
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

function eventFingerprint(event: ActivityEvent): string {
  const scope = event.audience ?? event.taskId ?? event.dispatchId ?? "";
  const body = event.summary.replace(/\s+/g, " ").trim().slice(0, 80);
  return `${event.direction}|${scope}|${event.kind}|${body}`;
}

function resolveEventTone(event: ActivityEvent): {
  direction: CommsDirection;
  color: string;
  durationMs: number;
  pillText: string | null;
} | null {
  if (event.direction === "system") return null;

  if (event.direction === "coordinator_to_agent") {
    if (event.kind === "dispatch_started") {
      return {
        direction: "down",
        color: "var(--st-dispatched)",
        durationMs: 1_240,
        pillText: null,
      };
    }
    if (event.kind === "reply" || event.kind === "status" || event.kind === "question") {
      return {
        direction: "down",
        color: "var(--odag-beam-accent)",
        durationMs: 1_260,
        pillText: compactPreview(event.summary || event.title),
      };
    }
    return null;
  }

  // agent_to_coordinator
  if (event.kind === "heartbeat") return null;

  if (event.kind === "status") {
    // Low-noise progress update: subtle beam without floating text pill
    return {
      direction: "up",
      color: "var(--odag-beam-progress)",
      durationMs: 1_050,
      pillText: null,
    };
  }

  if (event.kind === "question" || event.kind === "gate") {
    return {
      direction: "up",
      color: "var(--st-dispatched)",
      durationMs: 1_280,
      pillText: compactPreview(event.summary || event.title),
    };
  }

  if (event.kind === "escalation" || event.kind === "stop_event") {
    return {
      direction: "up",
      color: event.permissionPrompt ? "var(--st-dispatched)" : "var(--st-failed)",
      durationMs: 1_300,
      pillText: compactPreview(event.summary || event.title),
    };
  }

  if (event.kind === "worker_done") {
    const failed = event.severity === "error";
    return {
      direction: "up",
      color: failed ? "var(--st-failed)" : "var(--st-completed)",
      durationMs: 1_320,
      pillText: compactPreview(event.summary || event.title),
    };
  }

  return null;
}

function formatEventPillText(event: ActivityEvent, rawText: string | null, t: Translator): string | null {
  if (event.audience) {
    return t("ide.canvas.commBroadcast", { audience: event.audience });
  }
  if (event.direction === "coordinator_to_agent") {
    if (event.kind === "dispatch_started") return t("ide.canvas.commDispatch");
    if (!rawText) return null;
    if (event.kind === "reply") return t("ide.canvas.commReply", { text: rawText });
    return t("ide.canvas.commGuidance", { text: rawText });
  }
  if (!rawText) return null;
  if (event.permissionPrompt) return t("ide.canvas.commPermission", { text: rawText });
  if (event.kind === "question" || event.kind === "gate") return t("ide.canvas.commQuestion", { text: rawText });
  if (event.kind === "escalation" || event.kind === "stop_event") return t("ide.canvas.commEscalation", { text: rawText });
  if (event.kind === "worker_done") {
    return event.severity === "error"
      ? t("ide.canvas.commDoneFail", { text: rawText })
      : t("ide.canvas.commDoneOk", { text: rawText });
  }
  return rawText;
}

/**
 * Estimate visible/active tasks matching a group broadcast audience (`@all`,
 * `@idle`, `@worktree:<id>`, `@<harness>`). Deliberately preview-only: Orca
 * exposes no exact per-worker group delivery receipt, so the UI renders dashed
 * preview arcs and explicitly labels them as broadcast previews.
 */
function estimateAudienceTaskIds(
  audience: string,
  nodes: readonly DagNode[],
  workerRows: readonly WorkerRowView[],
): string[] {
  const dispatched = nodes.filter((node) => node.status === "dispatched");
  if (dispatched.length === 0) return [];
  const lower = audience.trim().toLowerCase();
  if (lower === "@all") {
    return dispatched.slice(0, MAX_CONCURRENT_PULSES).map((node) => node.id);
  }

  const workerByTask = new Map<string, WorkerRowView>();
  for (const row of workerRows) {
    if (!row.taskId || workerByTask.has(row.taskId)) continue;
    if (row.dispatchStatus === "dispatched") workerByTask.set(row.taskId, row);
  }

  if (lower === "@idle") {
    return dispatched
      .filter((node) => {
        const act = workerByTask.get(node.id)?.projection?.stage?.activity?.toLowerCase();
        return act === "idle";
      })
      .slice(0, MAX_CONCURRENT_PULSES)
      .map((node) => node.id);
  }

  if (lower.startsWith("@worktree:")) {
    const targetWs = audience.slice("@worktree:".length).trim();
    return dispatched
      .filter((node) => {
        const ws = workerByTask.get(node.id)?.projection?.workspace;
        const wsId = typeof ws === "string" ? ws : ws?.id ?? "";
        const launchWs = workerByTask.get(node.id)?.projection?.launch?.worktree ?? "";
        return wsId === targetWs || launchWs === targetWs;
      })
      .slice(0, MAX_CONCURRENT_PULSES)
      .map((node) => node.id);
  }

  const harnessName = lower.slice(1);
  return dispatched
    .filter((node) => {
      const row = workerByTask.get(node.id);
      const agent = (
        row?.launchEvidence?.agent ??
        row?.projection?.launch?.agent ??
        row?.projection?.provider?.id ??
        ""
      ).toLowerCase();
      return agent === harnessName;
    })
    .slice(0, MAX_CONCURRENT_PULSES)
    .map((node) => node.id);
}

export function useCanvasComms({
  runId,
  events,
  activityReady,
  nodes,
  workerRows,
  active,
  motionPaused,
  commsMode,
  t,
}: {
  runId: string;
  events: readonly ActivityEvent[];
  activityReady: boolean;
  nodes: readonly DagNode[];
  workerRows: readonly WorkerRowView[];
  active: boolean;
  motionPaused: boolean;
  commsMode: CanvasCommsMode;
  t: Translator;
}) {
  const [activePulses, setActivePulses] = useState<CanvasCommsPulse[]>([]);
  const [activePills, setActivePills] = useState<CanvasCommsPill[]>([]);
  const [heartbeatTaskIds, setHeartbeatTaskIds] = useState<Set<string>>(() => new Set());
  const [arrivalByTask, setArrivalByTask] = useState<Map<string, { color: string; nonce: number }>>(
    () => new Map(),
  );
  const [hubPingNonce, setHubPingNonce] = useState(0);
  const [hubBroadcastNonce, setHubBroadcastNonce] = useState(0);
  const [offscreenAlert, setOffscreenAlert] = useState<OffscreenCommsAlert | null>(null);

  const seededRunRef = useRef<string | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const seenHeartbeatsRef = useRef<Map<string, { id: string; count: number }>>(new Map());
  const fingerprintsRef = useRef<Map<string, number>>(new Map());
  const timersRef = useRef<Set<number>>(new Set());
  const offscreenTimerRef = useRef<number | null>(null);
  const seqRef = useRef(0);

  const taskIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  const taskLabels = useMemo(() => new Map(nodes.map((node) => [node.id, node.label])), [nodes]);

  const schedule = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timersRef.current.delete(id);
      fn();
    }, ms);
    timersRef.current.add(id);
    return id;
  }, []);

  const clearTimers = useCallback(() => {
    for (const id of timersRef.current) window.clearTimeout(id);
    timersRef.current.clear();
    if (offscreenTimerRef.current !== null) {
      window.clearTimeout(offscreenTimerRef.current);
      offscreenTimerRef.current = null;
    }
  }, []);

  // Reset state cleanly when switching Runs or unmounting
  useEffect(() => {
    clearTimers();
    seededRunRef.current = null;
    seenIdsRef.current.clear();
    seenHeartbeatsRef.current.clear();
    fingerprintsRef.current.clear();
    setActivePulses([]);
    setActivePills([]);
    setHeartbeatTaskIds(new Set());
    setArrivalByTask(new Map());
    setOffscreenAlert(null);
  }, [runId, clearTimers]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  // Clear transient motion immediately if paused or comms layer hidden
  useEffect(() => {
    if (motionPaused || commsMode === "off" || !active) {
      setActivePulses([]);
      if (commsMode === "off") setActivePills([]);
    }
  }, [motionPaused, commsMode, active]);

  // Durable pending attention badges per task
  const pendingByTask = useMemo(() => {
    const map = new Map<string, PendingTaskSignal>();
    for (const event of events) {
      if (event.runId !== runId || !event.taskId || !taskIds.has(event.taskId)) continue;
      if (!event.actionable) continue;
      if (event.actionable.kind !== "reply" && event.actionable.kind !== "acknowledge_stop") continue;
      if (map.has(event.taskId)) continue;
      const kind: PendingSignalKind = event.permissionPrompt
        ? "permission"
        : event.actionable.kind === "acknowledge_stop"
          ? "stop"
          : "reply";
      const label =
        kind === "permission"
          ? t("ide.canvas.pendingPermission")
          : kind === "stop"
            ? t("ide.canvas.pendingStop")
            : t("ide.canvas.pendingReply");
      map.set(event.taskId, {
        taskId: event.taskId,
        kind,
        label,
        summary: compactPreview(event.summary || event.title, 48),
      });
    }
    return map;
  }, [events, runId, taskIds, t]);

  // Recent task-scoped communications for Hub hover preview, pinned mode & static fallback
  const { recentLinks, lastCommByTask } = useMemo(() => {
    const links = new Map<string, RecentCommsLink>();
    const last = new Map<string, LastTaskComm>();
    const now = Date.now();
    for (const event of events) {
      if (event.runId !== runId || !event.taskId || !taskIds.has(event.taskId)) continue;
      const resolved = resolveEventTone(event);
      if (!resolved) continue;

      if (!last.has(event.taskId)) {
        const formatted = formatEventPillText(event, resolved.pillText, t);
        if (formatted) {
          last.set(event.taskId, { direction: resolved.direction, text: formatted });
        }
      }

      const ts = Date.parse(event.createdAt);
      const isRecent = Number.isFinite(ts) ? now - ts <= RECENT_WINDOW_MS : links.size < 8;
      if (!isRecent && links.size >= 8) continue;

      const existing = links.get(event.taskId);
      if (existing) {
        existing.count += 1;
      } else if (links.size < 12) {
        links.set(event.taskId, {
          taskId: event.taskId,
          direction: resolved.direction,
          color: resolved.color,
          count: 1,
          lastAt: Number.isFinite(ts) ? ts : now,
        });
      }
    }
    return { recentLinks: links, lastCommByTask: last };
  }, [events, runId, taskIds, t]);

  const spawnPill = useCallback(
    (taskId: string, direction: CommsDirection, text: string, color: string) => {
      const pillId = `pill-${++seqRef.current}`;
      setActivePills((prev) => [
        ...prev.filter((item) => item.taskId !== taskId),
        { id: pillId, taskId, direction, text, color, leaving: false },
      ]);
      schedule(() => {
        setActivePills((prev) =>
          prev.map((item) => (item.id === pillId ? { ...item, leaving: true } : item)),
        );
        schedule(() => {
          setActivePills((prev) => prev.filter((item) => item.id !== pillId));
        }, PILL_EXIT_MS);
      }, PILL_DWELL_MS);
    },
    [schedule],
  );

  const triggerArrival = useCallback(
    (pulse: CanvasCommsPulse) => {
      if (pulse.direction === "down") {
        setArrivalByTask((prev) => {
          const next = new Map(prev);
          next.set(pulse.taskId, { color: pulse.color, nonce: ++seqRef.current });
          return next;
        });
        schedule(() => {
          setArrivalByTask((prev) => {
            const next = new Map(prev);
            next.delete(pulse.taskId);
            return next;
          });
        }, ARRIVAL_FLASH_MS);
      } else {
        setHubPingNonce((n) => n + 1);
      }

      if (pulse.pillText) {
        spawnPill(pulse.taskId, pulse.direction, pulse.pillText, pulse.color);
      }
    },
    [schedule, spawnPill],
  );

  const reportOffscreen = useCallback(
    (pulse: CanvasCommsPulse) => {
      if (!pulse.pillText) return;
      const label = taskLabels.get(pulse.taskId) ?? pulse.taskId;
      setOffscreenAlert({
        taskId: pulse.taskId,
        label,
        direction: pulse.direction,
        text: pulse.pillText,
        color: pulse.color,
      });
      if (offscreenTimerRef.current !== null) {
        window.clearTimeout(offscreenTimerRef.current);
      }
      offscreenTimerRef.current = window.setTimeout(() => {
        offscreenTimerRef.current = null;
        setOffscreenAlert(null);
      }, OFFSCREEN_ALERT_MS);
    },
    [taskLabels],
  );

  const dismissOffscreen = useCallback(() => {
    if (offscreenTimerRef.current !== null) {
      window.clearTimeout(offscreenTimerRef.current);
      offscreenTimerRef.current = null;
    }
    setOffscreenAlert(null);
  }, []);

  // Incremental diff over Run-scoped ActivityEvents
  useEffect(() => {
    if (!runId) return;
    const runEvents = events.filter((event) => event.runId === runId);

    // Seed once per Run on the first loaded snapshot (even if empty, so the
    // very first dispatch on a brand-new Run still animates cleanly).
    if (seededRunRef.current !== runId) {
      if (!activityReady && runEvents.length === 0) return;
      seededRunRef.current = runId;
      const seedNow = Date.now();
      for (const ev of runEvents) {
        seenIdsRef.current.add(ev.id);
        const evAt = Date.parse(ev.createdAt);
        if (Number.isFinite(evAt) && seedNow - evAt <= FINGERPRINT_TTL_MS) {
          fingerprintsRef.current.set(eventFingerprint(ev), evAt);
        }
        if (ev.kind === "heartbeat" && ev.taskId) {
          seenHeartbeatsRef.current.set(ev.taskId, { id: ev.id, count: ev.groupedCount });
        }
      }
      return;
    }

    const now = Date.now();
    // Prune expired semantic fingerprints
    for (const [fp, ts] of fingerprintsRef.current) {
      if (now - ts > FINGERPRINT_TTL_MS) fingerprintsRef.current.delete(fp);
    }

    const newlyObserved: ActivityEvent[] = [];
    const heartbeatHits: string[] = [];

    // Events arrive newest-first; scan oldest-first for natural playback order
    for (let i = runEvents.length - 1; i >= 0; i--) {
      const ev = runEvents[i];
      if (ev.kind === "heartbeat" && ev.taskId && taskIds.has(ev.taskId)) {
        const prev = seenHeartbeatsRef.current.get(ev.taskId);
        if (!prev || prev.id !== ev.id || prev.count !== ev.groupedCount) {
          seenHeartbeatsRef.current.set(ev.taskId, { id: ev.id, count: ev.groupedCount });
          if (prev) heartbeatHits.push(ev.taskId);
        }
        seenIdsRef.current.add(ev.id);
        continue;
      }

      if (seenIdsRef.current.has(ev.id)) continue;
      seenIdsRef.current.add(ev.id);

      // Guard against double-firing when durable `orca_message` supersedes
      // optimistic `viewer_journal` within the 15s deduplication window.
      const fp = eventFingerprint(ev);
      const prevFpAt = fingerprintsRef.current.get(fp);
      fingerprintsRef.current.set(fp, now);
      if (prevFpAt !== undefined && now - prevFpAt <= FINGERPRINT_TTL_MS) continue;

      newlyObserved.push(ev);
    }

    // Never queue animations while hidden, paused, or comms disabled
    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!active || motionPaused || commsMode === "off" || reducedMotion) return;

    // 1. Quiet local heartbeat flashes (never emit cross-canvas arcs)
    if (heartbeatHits.length > 0) {
      const uniqueBeats = [...new Set(heartbeatHits)];
      setHeartbeatTaskIds((prev) => {
        const next = new Set(prev);
        for (const id of uniqueBeats) next.add(id);
        return next;
      });
      schedule(() => {
        setHeartbeatTaskIds((prev) => {
          const next = new Set(prev);
          for (const id of uniqueBeats) next.delete(id);
          return next;
        });
      }, HEARTBEAT_FLASH_MS);
    }

    if (newlyObserved.length === 0) return;

    // 2. Build coalesced pulse queue (merge same task+direction in one tick)
    const pendingPulses: Omit<CanvasCommsPulse, "id" | "createdAt">[] = [];
    const byKey = new Map<string, { idx: number; count: number; basePill: string | null }>();
    let broadcastTriggered = false;

    for (const ev of newlyObserved) {
      if (ev.audience && ev.direction === "coordinator_to_agent") {
        broadcastTriggered = true;
        const targets = estimateAudienceTaskIds(ev.audience, nodes, workerRows);
        const pill = formatEventPillText(ev, null, t);
        targets.forEach((targetTaskId, idx) => {
          pendingPulses.push({
            taskId: targetTaskId,
            direction: "down",
            color: "var(--fg-secondary)",
            dashed: true,
            pillText: idx === 0 ? pill : null,
            durationMs: 1_180,
            curveBias: (idx - (targets.length - 1) / 2) * 14,
          });
        });
        continue;
      }

      if (!ev.taskId || !taskIds.has(ev.taskId)) continue;
      const resolved = resolveEventTone(ev);
      if (!resolved) continue;

      const formattedPill = formatEventPillText(ev, resolved.pillText, t);
      const key = `${ev.taskId}|${resolved.direction}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
        const entry = pendingPulses[existing.idx];
        const base = formattedPill ?? existing.basePill;
        entry.pillText = base ? t("ide.canvas.commBatchMore", { text: base, n: existing.count }) : null;
        entry.color = resolved.color;
        continue;
      }

      const idx = pendingPulses.length;
      pendingPulses.push({
        taskId: ev.taskId,
        direction: resolved.direction,
        color: resolved.color,
        dashed: false,
        pillText: formattedPill,
        durationMs: resolved.durationMs,
        curveBias: resolved.direction === "down" ? -16 : 16,
      });
      byKey.set(key, { idx, count: 1, basePill: formattedPill });
    }

    if (broadcastTriggered) {
      setHubBroadcastNonce((n) => n + 1);
    }

    if (pendingPulses.length === 0) return;

    // 3. Stagger launches and enforce concurrent cap
    pendingPulses.slice(0, MAX_CONCURRENT_PULSES).forEach((spec, idx) => {
      schedule(() => {
        const pulse: CanvasCommsPulse = {
          ...spec,
          id: `pulse-${++seqRef.current}`,
          createdAt: performance.now(),
        };
        if (pulse.direction === "down") {
          setHubPingNonce((n) => n + 1);
        }
        setActivePulses((prev) => [...prev.slice(-(MAX_CONCURRENT_PULSES - 1)), pulse]);
        schedule(() => {
          setActivePulses((prev) => prev.filter((item) => item.id !== pulse.id));
        }, pulse.durationMs + PULSE_FADE_MS + 80);
      }, idx * STAGGER_MS);
    });
  }, [active, activityReady, commsMode, events, motionPaused, nodes, runId, schedule, t, taskIds, workerRows]);

  return {
    activePulses,
    activePills,
    pendingByTask,
    recentLinks,
    lastCommByTask,
    heartbeatTaskIds,
    arrivalByTask,
    hubPingNonce,
    hubBroadcastNonce,
    offscreenAlert,
    triggerArrival,
    reportOffscreen,
    dismissOffscreen,
  };
}
