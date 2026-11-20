import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useReactFlow, useStore, useStoreApi } from "@xyflow/react";
import { COORDINATION_MODE_META } from "../coordinationMode";
import { NODE_H, NODE_W } from "../layout";
import { useT } from "../i18n";
import type { RunCoordinationMode } from "../types";
import { CoordinationModeIcon } from "./CoordinationModeIcon";
import type {
  CanvasCommsMode,
  CanvasCommsPill,
  CanvasCommsPulse,
  OffscreenCommsAlert,
  PendingTaskSignal,
  RecentCommsLink,
} from "./useCanvasComms";

interface ScreenPoint {
  x: number;
  y: number;
}

function buildCommsArcD(p1: ScreenPoint, p2: ScreenPoint, curveBias = 0): string {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const midX = (p1.x + p2.x) / 2 + dx * 0.14 + curveBias;
  const midY = Math.min(p1.y, p2.y) + Math.abs(dy) * 0.34 - 18;
  return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} Q ${midX.toFixed(1)} ${midY.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
}

interface PulseDomRefs {
  group: SVGGElement;
  arc: SVGPathElement;
  tail: SVGPathElement;
  head: SVGCircleElement;
  arrived: boolean;
  reportedOffscreen: boolean;
}

export interface CanvasCommsOverlayProps {
  wrapRef: RefObject<HTMLDivElement | null>;
  canvasWidth: number;
  commsMode: CanvasCommsMode;
  motionPaused: boolean;
  active: boolean;
  coordinatorRunning: boolean;
  coordinatorPhaseLabel: string;
  coordinatorAwaitingInput: boolean;
  coordinatorHandle: string | null;
  coordinationMode?: RunCoordinationMode | null;
  activeWorkerCount: number;
  maxConcurrency: number | null;
  activePulses: readonly CanvasCommsPulse[];
  activePills: readonly CanvasCommsPill[];
  pendingByTask: ReadonlyMap<string, PendingTaskSignal>;
  recentLinks: ReadonlyMap<string, RecentCommsLink>;
  hubPingNonce: number;
  hubBroadcastNonce: number;
  offscreenAlert: OffscreenCommsAlert | null;
  onArrival: (pulse: CanvasCommsPulse) => void;
  onReportOffscreen: (pulse: CanvasCommsPulse) => void;
  onDismissOffscreen: () => void;
  onSelectTask: (taskId: string) => void;
  onOpenCoordinator?: () => void;
}

const PULSE_FADE_MS = 460;

export const CanvasCommsOverlay = memo(function CanvasCommsOverlay({
  wrapRef,
  canvasWidth,
  commsMode,
  motionPaused,
  active,
  coordinatorRunning,
  coordinatorPhaseLabel,
  coordinatorAwaitingInput,
  coordinatorHandle,
  coordinationMode = null,
  activeWorkerCount,
  maxConcurrency,
  activePulses,
  activePills,
  pendingByTask,
  recentLinks,
  hubPingNonce,
  hubBroadcastNonce,
  offscreenAlert,
  onArrival,
  onReportOffscreen,
  onDismissOffscreen,
  onSelectTask,
  onOpenCoordinator,
}: CanvasCommsOverlayProps) {
  const t = useT();
  const rf = useReactFlow();
  const storeApi = useStoreApi();
  const glowFilterId = `odag-packet-glow-${useId().replace(/:/g, "")}`;

  const hubRef = useRef<HTMLButtonElement>(null);
  const pulseLayerRef = useRef<SVGGElement>(null);
  const pulseRefs = useRef<Map<string, PulseDomRefs>>(new Map());
  const [hubReady, setHubReady] = useState(false);
  const [hubHovered, setHubHovered] = useState(false);
  const [hubPingActive, setHubPingActive] = useState(false);
  const [hubBroadcastActive, setHubBroadcastActive] = useState(false);

  useEffect(() => {
    setHubReady(true);
  }, []);

  // Subscribe to React Flow viewport transform & node positions for static arcs + micro-pills
  const transform = useStore((state) => state.transform);
  const nodeLookup = useStore((state) => state.nodeLookup);

  // Brief Hub port ping flash
  useEffect(() => {
    if (hubPingNonce === 0 || motionPaused) return;
    setHubPingActive(true);
    const id = window.setTimeout(() => setHubPingActive(false), 420);
    return () => window.clearTimeout(id);
  }, [hubPingNonce, motionPaused]);

  // Brief Hub broadcast ripple
  useEffect(() => {
    if (hubBroadcastNonce === 0 || motionPaused) return;
    setHubBroadcastActive(true);
    const id = window.setTimeout(() => setHubBroadcastActive(false), 920);
    return () => window.clearTimeout(id);
  }, [hubBroadcastNonce, motionPaused]);

  const getHubPortScreen = useCallback((): ScreenPoint | null => {
    const wrap = wrapRef.current;
    const hub = hubRef.current;
    if (!wrap || !hub) return null;
    const wrapRect = wrap.getBoundingClientRect();
    const hubRect = hub.getBoundingClientRect();
    if (!wrapRect.width || !hubRect.width) return null;
    return {
      x: hubRect.left - wrapRect.left + hubRect.width / 2,
      y: hubRect.bottom - wrapRect.top + 1,
    };
  }, [wrapRef]);

  const projectNodePort = useCallback(
    (
      taskId: string,
      tx: number,
      ty: number,
      zoom: number,
      lookup: ReturnType<typeof storeApi.getState>["nodeLookup"],
    ): { port: ScreenPoint; visible: boolean } | null => {
      const wrap = wrapRef.current;
      const internal = lookup.get(taskId);
      if (!wrap || !internal) return null;
      const w = internal.measured?.width ?? NODE_W;
      const h = internal.measured?.height ?? NODE_H;
      const worldX = internal.internals.positionAbsolute.x;
      const worldY = internal.internals.positionAbsolute.y;
      const sx = worldX * zoom + tx;
      const sy = worldY * zoom + ty;
      const sw = w * zoom;
      const sh = h * zoom;
      const visible =
        sx + sw > 24 &&
        sx < wrap.clientWidth - 24 &&
        sy + sh > 52 &&
        sy < wrap.clientHeight - 24;
      return {
        port: { x: sx + sw / 2, y: sy - 1 },
        visible,
      };
    },
    [storeApi, wrapRef],
  );

  // Static / waiting / hover-preview arcs (rendered BEHIND nodes so they never cut across card text)
  const staticArcs = useMemo(() => {
    if (commsMode === "off" || !active) return [];
    const hubPt = getHubPortScreen();
    if (!hubPt) return [];
    const [tx, ty, zoom] = transform;
    const showRecent = commsMode === "pinned" || hubHovered;
    const candidateIds = new Set<string>();
    for (const id of pendingByTask.keys()) candidateIds.add(id);
    if (showRecent) {
      for (const id of recentLinks.keys()) candidateIds.add(id);
    }
    const arcs: {
      id: string;
      d: string;
      stroke: string;
      dash: string;
      width: number;
      opacity: number;
    }[] = [];

    for (const taskId of candidateIds) {
      const projected = projectNodePort(taskId, tx, ty, zoom, nodeLookup);
      if (!projected || !projected.visible) continue;
      const isPending = pendingByTask.has(taskId);
      const recent = recentLinks.get(taskId);
      arcs.push({
        id: taskId,
        d: buildCommsArcD(hubPt, projected.port, isPending ? -14 : 10),
        stroke: isPending ? "var(--st-dispatched)" : (recent?.color ?? "var(--fg-tertiary)"),
        dash: isPending ? "4 4" : "2 4",
        width: isPending ? 1.25 : 1.1,
        opacity: isPending ? 0.42 : hubHovered ? 0.46 : 0.25,
      });
    }
    return arcs;
  }, [
    active,
    canvasWidth,
    commsMode,
    getHubPortScreen,
    hubHovered,
    hubReady,
    nodeLookup,
    pendingByTask,
    projectNodePort,
    recentLinks,
    transform,
  ]);

  // Keep imperative SVG nodes synchronized with `activePulses` and drive 60fps flight only while pulses exist
  useEffect(() => {
    const layer = pulseLayerRef.current;
    if (!layer) return;

    const currentIds = new Set(activePulses.map((p) => p.id));
    // Remove expired pulses
    for (const [id, dom] of pulseRefs.current) {
      if (!currentIds.has(id)) {
        dom.group.remove();
        pulseRefs.current.delete(id);
      }
    }

    if (activePulses.length === 0 || motionPaused || commsMode === "off" || !active) {
      return;
    }

    // Create SVG elements for any newly added pulses
    const svgNs = "http://www.w3.org/2000/svg";
    for (const pulse of activePulses) {
      if (pulseRefs.current.has(pulse.id)) continue;
      const group = document.createElementNS(svgNs, "g");

      const arc = document.createElementNS(svgNs, "path");
      arc.setAttribute("fill", "none");
      arc.style.stroke = pulse.color;
      arc.setAttribute("stroke-width", pulse.dashed ? "1.15" : "1.35");
      if (pulse.dashed) arc.setAttribute("stroke-dasharray", "4 4");
      arc.setAttribute("stroke-linecap", "round");
      arc.setAttribute("opacity", "0");

      const tail = document.createElementNS(svgNs, "path");
      tail.setAttribute("fill", "none");
      tail.style.stroke = pulse.color;
      tail.setAttribute("stroke-width", "2.4");
      tail.setAttribute("stroke-linecap", "round");
      tail.setAttribute("opacity", "0");

      const head = document.createElementNS(svgNs, "circle");
      head.setAttribute("r", pulse.dashed ? "2.6" : "3.2");
      head.style.fill = pulse.color;
      head.setAttribute("filter", `url(#${glowFilterId})`);
      head.setAttribute("opacity", "0");

      group.append(arc, tail, head);
      layer.appendChild(group);
      pulseRefs.current.set(pulse.id, {
        group,
        arc,
        tail,
        head,
        arrived: false,
        reportedOffscreen: false,
      });
    }

    let rafId = 0;
    const tick = (now: number) => {
      const hubPt = getHubPortScreen();
      const state = storeApi.getState();
      const [tx, ty, zoom] = state.transform;

      for (const pulse of activePulses) {
        const dom = pulseRefs.current.get(pulse.id);
        if (!dom) continue;

        const projected = projectNodePort(pulse.taskId, tx, ty, zoom, state.nodeLookup);
        if (!hubPt || !projected || !projected.visible) {
          dom.arc.setAttribute("opacity", "0");
          dom.tail.setAttribute("opacity", "0");
          dom.head.setAttribute("opacity", "0");
          if (projected && !projected.visible && !dom.reportedOffscreen) {
            dom.reportedOffscreen = true;
            onReportOffscreen(pulse);
          }
          continue;
        }

        const from = pulse.direction === "down" ? hubPt : projected.port;
        const to = pulse.direction === "down" ? projected.port : hubPt;
        const d = buildCommsArcD(from, to, pulse.curveBias);
        dom.arc.setAttribute("d", d);

        const elapsed = Math.max(0, now - pulse.createdAt);
        const travelT = Math.min(1, elapsed / pulse.durationMs);
        const eased =
          travelT < 0.5
            ? 4 * travelT * travelT * travelT
            : 1 - Math.pow(-2 * travelT + 2, 3) / 2;

        const totalLen = dom.arc.getTotalLength();
        if (totalLen > 1 && travelT < 1) {
          const arcAlpha = travelT < 0.16 ? (travelT / 0.16) * 0.42 : 0.42;
          dom.arc.setAttribute("opacity", arcAlpha.toFixed(3));

          const pt = dom.arc.getPointAtLength(eased * totalLen);
          dom.head.setAttribute("cx", pt.x.toFixed(1));
          dom.head.setAttribute("cy", pt.y.toFixed(1));
          dom.head.setAttribute("opacity", "0.95");

          const tailSpan = Math.min(54, totalLen * 0.22);
          const tStart = Math.max(0, eased * totalLen - tailSpan);
          const pA = dom.arc.getPointAtLength(tStart);
          const pMid = dom.arc.getPointAtLength((tStart + eased * totalLen) / 2);
          dom.tail.setAttribute(
            "d",
            `M ${pA.x.toFixed(1)} ${pA.y.toFixed(1)} Q ${pMid.x.toFixed(1)} ${pMid.y.toFixed(1)} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`,
          );
          dom.tail.setAttribute("opacity", (0.68 * Math.min(1, travelT * 5)).toFixed(3));
        } else {
          if (!dom.arrived) {
            dom.arrived = true;
            dom.head.setAttribute("opacity", "0");
            dom.tail.setAttribute("opacity", "0");
            onArrival(pulse);
          }
          const fadeP = Math.min(1, (elapsed - pulse.durationMs) / PULSE_FADE_MS);
          dom.arc.setAttribute("opacity", ((1 - fadeP) * 0.42).toFixed(3));
        }
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [
    active,
    activePulses,
    commsMode,
    getHubPortScreen,
    glowFilterId,
    motionPaused,
    onArrival,
    onReportOffscreen,
    projectNodePort,
    storeApi,
  ]);

  // Clean up SVG elements on unmount
  useEffect(() => {
    const refs = pulseRefs.current;
    return () => {
      for (const dom of refs.values()) dom.group.remove();
      refs.clear();
    };
  }, []);

  const locateTask = useCallback(
    (taskId: string) => {
      const internal = storeApi.getState().nodeLookup.get(taskId);
      if (internal) {
        const w = internal.measured?.width ?? NODE_W;
        const h = internal.measured?.height ?? NODE_H;
        const cx = internal.internals.positionAbsolute.x + w / 2;
        const cy = internal.internals.positionAbsolute.y + h / 2;
        const reduced = motionPaused || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        void rf.setCenter(cx, cy, {
          zoom: Math.max(rf.getZoom(), 0.9),
          duration: reduced ? 0 : 280,
        });
      }
      onDismissOffscreen();
      onSelectTask(taskId);
    },
    [motionPaused, onDismissOffscreen, onSelectTask, rf, storeApi],
  );

  // Compute screen coordinates for visible transient micro-pills
  const positionedPills = useMemo(() => {
    if (commsMode === "off" || !active || activePills.length === 0) return [];
    const [tx, ty, zoom] = transform;
    const list: { pill: CanvasCommsPill; x: number; y: number }[] = [];
    for (const pill of activePills) {
      const projected = projectNodePort(pill.taskId, tx, ty, zoom, nodeLookup);
      if (!projected || !projected.visible) continue;
      const offsetX = pendingByTask.has(pill.taskId) ? -24 : 0;
      list.push({
        pill,
        x: projected.port.x + offsetX,
        y: projected.port.y - 8,
      });
    }
    return list;
  }, [active, activePills, commsMode, nodeLookup, pendingByTask, projectNodePort, transform]);

  const hasWaiting = coordinatorAwaitingInput || pendingByTask.size > 0;
  const hubSecondRow = canvasWidth > 0 && canvasWidth < 1260;
  const modeMeta = coordinationMode ? COORDINATION_MODE_META[coordinationMode] : null;
  const isExternalChat = coordinationMode === "agent_native_chat";
  const isExternalTerm = coordinationMode === "agent_terminal";
  const hubTitleText = modeMeta ? t(modeMeta.hubLabel) : t("ide.canvas.hubTitle");
  const hubBadgeText = isExternalChat || isExternalTerm
    ? t("ide.coord.readOnly")
    : coordinationMode === "unbound" && !coordinatorRunning
      ? t("mode.unbound.short")
      : coordinatorPhaseLabel;
  const hubBadgeClass = hasWaiting
    ? " is-waiting"
    : coordinatorRunning
      ? " is-running"
      : isExternalChat
        ? " is-chat"
        : isExternalTerm
          ? " is-term"
          : "";
  const hubDotColor = hasWaiting
    ? "var(--st-dispatched)"
    : coordinatorRunning
      ? "var(--st-completed)"
      : isExternalChat
        ? "var(--st-blocked)"
        : isExternalTerm
          ? "var(--st-dispatched)"
          : "var(--fg-tertiary)";
  const hubTooltipText = modeMeta
    ? t("ide.canvas.hubTooltipMode", {
        mode: t(modeMeta.label),
        role: t(modeMeta.panelRole),
      })
    : t("ide.canvas.hubTooltip");
  const slotsText =
    maxConcurrency !== null
      ? t("ide.canvas.hubSlots", { active: activeWorkerCount, max: maxConcurrency })
      : t("ide.canvas.hubActiveOnly", { active: activeWorkerCount });

  return (
    <>
      {/* Static / Waiting / Hover-Preview Comms Tethers (behind node cards, z-index: 1) */}
      {staticArcs.length > 0 && (
        <svg className="odag-comms-svg odag-comms-svg--static" aria-hidden="true">
          {staticArcs.map((arc) => (
            <path
              key={arc.id}
              d={arc.d}
              fill="none"
              stroke={arc.stroke}
              strokeWidth={arc.width}
              strokeDasharray={arc.dash}
              opacity={arc.opacity}
            />
          ))}
        </svg>
      )}

      {/* Transient Signal Packets (above cards during 1.3s flight, z-index: 9) */}
      <svg className="odag-comms-svg odag-comms-svg--pulse" aria-hidden="true">
        <defs>
          <filter id={glowFilterId} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="2.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g ref={pulseLayerRef} />
      </svg>

      {/* Transient Clickable Comms Micro-Pills (z-index: 11) */}
      {positionedPills.length > 0 && (
        <div className="odag-comms-pills">
          {positionedPills.map(({ pill, x, y }) => (
            <button
              key={pill.id}
              type="button"
              className={`odag-comms-pill${pill.leaving ? " is-leaving" : ""}`}
              style={
                {
                  left: `${x}px`,
                  top: `${y}px`,
                  "--pill-tone": pill.color,
                } as CSSProperties
              }
              aria-label={t("ide.canvas.openCommThread", { label: pill.text })}
              onClick={(event) => {
                event.stopPropagation();
                onSelectTask(pill.taskId);
              }}
            >
              <span className="odag-comms-pill__dir" aria-hidden="true">
                {pill.direction === "down" ? "→" : "←"}
              </span>
              <span className="odag-comms-pill__text">{pill.text}</span>
            </button>
          ))}
        </div>
      )}

      {/* Top-Center Docked Coordinator Hub (z-index: 12) */}
      <button
        ref={hubRef}
        type="button"
        className={`odag-coord-hub${hubSecondRow ? " is-second-row" : ""}${
          hubPingActive ? " is-ping" : ""
        }${hubBroadcastActive ? " is-broadcast" : ""}`}
        title={
          coordinatorHandle
            ? `${hubTooltipText} (${coordinatorHandle})`
            : hubTooltipText
        }
        onMouseEnter={() => setHubHovered(true)}
        onMouseLeave={() => setHubHovered(false)}
        onFocus={() => setHubHovered(true)}
        onBlur={() => setHubHovered(false)}
        onClick={() => onOpenCoordinator?.()}
      >
        <span className="odag-coord-hub__broadcast-ring" aria-hidden="true" />
        <span className="odag-coord-hub__title">
          <span
            className={`odag-pulse-dot${
              coordinatorRunning && active && !motionPaused ? " odag-pulse-dot--live" : ""
            }`}
            style={{ "--dot-color": hubDotColor } as CSSProperties}
            aria-hidden="true"
          />
          {coordinationMode && <CoordinationModeIcon mode={coordinationMode} size={12} />}
          {hubTitleText}
        </span>
        <span className={`odag-coord-hub__badge${hubBadgeClass}`}>
          {hubBadgeText}
        </span>
        <span className="odag-coord-hub__meta mono">{slotsText}</span>
        <span className="odag-coord-hub__port" aria-hidden="true" />
      </button>

      {/* Off-screen Signal Quick-Locate Notice */}
      {offscreenAlert && commsMode !== "off" && (
        <button
          type="button"
          className={`odag-offscreen-toast${hubSecondRow ? " is-second-row" : ""}`}
          aria-label={t("ide.canvas.offscreenAria", {
            label: offscreenAlert.label,
            summary: offscreenAlert.text,
          })}
          onClick={() => locateTask(offscreenAlert.taskId)}
        >
          <span style={{ color: offscreenAlert.color, fontWeight: 700 }} aria-hidden="true">
            {offscreenAlert.direction === "down" ? "→" : "←"}
          </span>
          <span className="truncate" style={{ maxInlineSize: 220 }}>
            {offscreenAlert.label} · {offscreenAlert.text}
          </span>
          <span className="mono" style={{ color: "var(--st-dispatched)", fontWeight: 600 }}>
            {t("ide.canvas.offscreenLocate")} ↗
          </span>
        </button>
      )}
    </>
  );
});
