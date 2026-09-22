import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  getBezierPath,
  getSmoothStepPath,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useUpdateNodeInternals,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { applyLayout } from "../layout";
import { effectiveHarness, useConfig } from "../harness";
import { STATUS_META, type DagResponse, type LayoutKind, type RunAttempt, type TaskStatus, type WorkerRowView } from "../types";

/** Deterministic PRNG so each node's scribble stays stable across polls. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Clip the infinite line through (px,py) along (dx,dy) to the box, returning
 * the [t0,t1] parameter span inside it (null when the line misses entirely).
 */
function clipSpan(
  px: number,
  py: number,
  dx: number,
  dy: number,
  box: { x: number; y: number; w: number; h: number },
): [number, number] | null {
  let lo = -Infinity;
  let hi = Infinity;
  const slabs: [number, number, number, number][] = [
    [px, dx, box.x, box.x + box.w],
    [py, dy, box.y, box.y + box.h],
  ];
  for (const [p, d, min, max] of slabs) {
    if (Math.abs(d) < 1e-6) {
      if (p < min || p > max) return null;
      continue;
    }
    const a = (min - p) / d;
    const b = (max - p) / d;
    lo = Math.max(lo, Math.min(a, b));
    hi = Math.min(hi, Math.max(a, b));
  }
  return hi - lo > 1 ? [lo, hi] : null;
}

type ScribbleLeg = { d: string; width: number; opacity: number };

/**
 * One continuous colouring pass across the box, chopped into legs: diagonal
 * strokes chained end-to-end, alternating direction, each bowed a little and
 * overshooting the edges like a crayon that never lifts. Seeded by the node
 * id, so every task gets its own "handwriting". Opacities stay translucent
 * and widths vary per leg, so overlapping passes build up wax.
 */
function scribbleLegs(seedId: string, w = 210, h = 72): ScribbleLeg[] {
  const rand = mulberry32(hashId(seedId));
  const box = { x: 0, y: 0, w, h };
  // seeded per node, so every task colours in at its own slant, density and
  // pressure — same hand, never the same page twice
  const angle = 45 + (rand() - 0.5) * 16;
  const spacing = 10.5 * (0.88 + rand() * 0.24);
  const baseWidth = 10.5 * (0.9 + rand() * 0.2);
  const bleed = 6;
  const th = (angle * Math.PI) / 180;
  const dx = Math.cos(th);
  const dy = -Math.sin(th);
  const ax = -dy;
  const ay = dx;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const half = (Math.abs(box.w * ax) + Math.abs(box.h * ay)) / 2;
  const over = () => bleed * (0.15 + rand() * rand() * 1.9) + (rand() < 0.12 ? bleed * (1.5 + rand()) : 0);
  const legs: ScribbleLeg[] = [];
  let prev: { x: number; y: number } | null = null;
  let t = -half - spacing * 0.5;
  let i = 0;
  while (t < half + spacing * 0.5) {
    const px = cx + t * ax;
    const py = cy + t * ay;
    const span = clipSpan(px, py, dx, dy, box);
    t += spacing * (0.86 + rand() * 0.3);
    if (!span) continue;
    const uA = span[0] - over();
    const uB = span[1] + over();
    const at = (u: number) => ({ x: px + dx * u, y: py + dy * u });
    const forward = i % 2 === 0;
    let s = at(forward ? uA : uB);
    let e = at(forward ? uB : uA);
    const piv = (rand() - 0.5) * 0.075;
    const px0 = (s.x + e.x) / 2;
    const py0 = (s.y + e.y) / 2;
    const spin = (p: { x: number; y: number }) => {
      const vx = p.x - px0;
      const vy = p.y - py0;
      return { x: px0 + vx * Math.cos(piv) - vy * Math.sin(piv), y: py0 + vx * Math.sin(piv) + vy * Math.cos(piv) };
    };
    s = spin(s);
    e = spin(e);
    const bow = (rand() - 0.5) * 4.5;
    const mx = px0 + ax * bow + (rand() - 0.5) * 3;
    const my = py0 + ay * bow + (rand() - 0.5) * 3;
    const n1f = (v: number) => v.toFixed(1);
    let d = `M${n1f(s.x)},${n1f(s.y)}`;
    if (prev) {
      const out = (forward ? -1 : 1) * (1.5 + rand() * 4.5);
      const kx = (prev.x + s.x) / 2 + dx * out;
      const ky = (prev.y + s.y) / 2 + dy * out;
      d = `M${n1f(prev.x)},${n1f(prev.y)} Q${n1f(kx)},${n1f(ky)} ${n1f(s.x)},${n1f(s.y)}`;
    }
    d += ` Q${n1f(mx)},${n1f(my)} ${n1f(e.x)},${n1f(e.y)}`;
    legs.push({ d, width: baseWidth * (0.82 + rand() * 0.36), opacity: 0.68 * (0.75 + rand() * 0.5) });
    prev = e;
    i++;
  }
  return legs;
}

// No scribble timing lives here (and none in styles.css either): the pass is
// rendered once, fully drawn, for dispatched/completed/failed alike. Seeded by
// the node id it is identical on every poll — a static crayon texture, never a
// loop — which is exactly what keeps `document.getAnimations()` empty inside
// the canvas once the entrance settles.

type TaskNodeData = {  label: string;
  status: TaskStatus;
  selected: boolean;
  /** Viewer-only semantic ownership; never changes DAG or Orca authority. */
  lead: boolean;
  harness: string;
  /** True when `harness` is what Orca durably recorded as launched, not the plan. */
  harnessActual: boolean;
  dir: "LR" | "TB";
  /** paint order on first draw — staggers the entrance so the DAG "grows" */
  index: number;
  /** deterministic sticker tilt in degrees — pasted, not aligned */
  tilt: number;
  /** the status changed on this poll — play the one-shot celebration */
  pop: boolean;
};

function TaskNode({ id, data }: NodeProps<Node<TaskNodeData>>) {
  const meta = STATUS_META[data.status];
  const isTB = data.dir === "TB";
  const alive = data.status === "ready" || data.status === "dispatched";
  const updateNodeInternals = useUpdateNodeInternals();
  // one unbroken colouring pass, chopped into back-and-forth zigzag legs.
  // Deterministic in the node id, so it renders once and never redraws: there
  // is deliberately NO cycle timer and no `key`-driven remount here — a
  // dispatched task used to re-scrawl itself forever, which meant a timer
  // incrementing a dispatched node and a permanent animation in the canvas.
  const legs = useMemo(() => scribbleLegs(id), [id]);
  const dispatched = data.status === "dispatched";
  return (
    <div
      role="group"
      className={[
        "task-node",
        data.selected ? "task-node--selected" : "",
        data.lead ? "task-node--lead" : "",
        data.pop ? "task-node--pop" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-status={data.status}
      title={
        data.lead
          ? "Lead stage — semantic main-agent ownership; Orca coordinator authority is shown separately"
          : undefined
      }
      aria-label={`${data.label}. ${meta.label}. Harness ${data.harness}.${
        data.lead ? " Lead stage: semantic main-agent ownership." : ""
      }`}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && event.animationName === "node-in") {
          // React Flow may take its first handle measurement while the card is
          // still scaled down by `node-in`. Transforms do not trigger its
          // ResizeObserver when they settle, so explicitly replace those
          // temporary, inset handle coordinates with the final geometry.
          updateNodeInternals(id);
        }
      }}
      style={
        {
          "--crayon": meta.color,
          "--crayon-ink": meta.ink,
          "--wash": meta.bg,
          "--i": data.index,
          "--tilt": `${data.tilt}deg`,
        } as CSSProperties
      }
    >
      {data.lead && (
        <>
          <span className="task-node__lead-ring" aria-hidden="true" />
          <span
            className="task-node__lead-badge"
            title="Semantic main-agent ownership; not Orca coordinator authority"
          >
            <span aria-hidden="true">★</span> Lead
          </span>
        </>
      )}
      {/* a real hand scrawl, coloured in and frozen: dispatched nodes show the
          pass mid-run, completed/failed keep it at its final frame — fully
          drawn, no animation, still their own hand */}
      {(dispatched || data.status === "completed" || data.status === "failed") && (
        <svg
          className="task-node__scribble"
          viewBox="0 0 210 72"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {legs.map((leg, i) => (
            <path
              key={i}
              pathLength={100}
              d={leg.d}
              strokeWidth={leg.width.toFixed(1)}
              strokeOpacity={leg.opacity.toFixed(3)}
            />
          ))}
        </svg>
      )}
      {/* static dashed ring (ready) / static solid ring (dispatched) — status
          stays legible from the border alone, with nothing pulsing */}
      {alive && <div className="task-node__aura" aria-hidden="true" />}
      <Handle type="target" position={isTB ? Position.Top : Position.Left} />
      <div className="task-node__title">{data.label}</div>
      <div className="task-node__row">
        <div className="task-node__status" style={{ color: meta.ink }}>
          <span className="dot" style={{ background: meta.color }} />
          {meta.label}
        </div>
        <span
          className="task-node__harness"
          title={
            data.harnessActual
              ? "Harness recorded for this stage's actual launch"
              : data.status === "pending" || data.status === "ready"
                ? "Planned harness — nothing launched here yet"
                : "No launch record found — showing the planned harness"
          }
        >
          {data.harness}
        </span>
      </div>
      {/* hand-drawn sign-off: a tick that draws itself, or a scribbled-out cross */}
      {data.status === "completed" && (
        <svg className="task-node__stamp task-node__stamp--ok" viewBox="0 0 46 36" aria-hidden="true">
          <path d="M5 20 C10 22.5 13 26 17 32 C23 20 32 9 42 4" />
        </svg>
      )}
      {data.status === "failed" && (
        <svg className="task-node__stamp task-node__stamp--bad" viewBox="0 0 46 36" aria-hidden="true">
          <path d="M8 6 C17 13 28 22 38 30" />
          <path d="M38 6 C29 14 18 23 8 30" />
        </svg>
      )}
      {/* selection = circled with a red marker, the way you'd flag it on paper.
          pathLength=100 lets CSS draw it in without knowing the true length. */}
      {data.selected && (
        <svg
          className="task-node__lasso"
          viewBox="0 0 232 94"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            pathLength={100}
            d="M10 48 C7 16 44 5 116 6 C193 7 227 20 225 46 C223 79 182 90 112 88 C46 86 13 79 10 48 Z"
          />
        </svg>
      )}
      {/* one-shot ring that flicks outward the moment the status flips */}
      {data.pop && <span className="task-node__ripple" aria-hidden="true" />}
      {/* a burst of crayon sparks the moment work lands done */}
      {data.pop && data.status === "completed" && (
        <svg className="task-node__sparks" viewBox="0 0 64 64" aria-hidden="true">
          <path d="M32 14 L32 3" />
          <path d="M48 20 L56 11" />
          <path d="M54 34 L64 32" />
          <path d="M16 20 L8 11" />
          <path d="M10 34 L0 32" />
        </svg>
      )}
      <Handle type="source" position={isTB ? Position.Bottom : Position.Right} />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

/**
 * Edge leaving a running node: a faint dashed pencil sketch with a solid
 * pencil stroke inked over it, source → target — the "hand went over the
 * dashes" look, held still. Two stacked paths share one geometry; the wobble
 * lives in the #pencil-edge filter (userSpaceOnUse, with a 24000² region so
 * nothing clips).
 *
 * The trace used to be driven by the Web Animations API (element.animate) with
 * the measured per-edge length baked into keyframes, looping draw → hold →
 * fade forever. Continuous canvas motion is now out of contract, so there is
 * NO animation, NO measurement and NO ref here: the solid stroke simply renders
 * at full length. The dashed sketch underneath still distinguishes "being
 * worked on" from the idle/done dependency strokes, so the edge keeps its
 * scheduling meaning without anything moving.
 */
function PencilEdge(props: EdgeProps) {
  const [path] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  return (
    <g className="pencil-edge">
      <path className="pencil-edge__sketch" d={path} fill="none" />
      <path className="pencil-edge__draw" d={path} fill="none" />
    </g>
  );
}

const edgeTypes = { pencil: PencilEdge, hierarchy: HierarchyEdge };

/**
 * Parent → child OWNERSHIP edge (Phase 4) — a deliberately different visual
 * grammar from the dependency pencils above:
 *
 *   dependency  = hand-wobbling bezier, pencil sketch under solid ink (still)
 *   ownership   = calm rounded bracket (smooth step), fine dotted graphite,
 *                 a small open ring resting on the child, no animation
 *
 * The stillness is the point: nothing about a parent relation moves work
 * forward, so nothing on it may look like flow. These edges are never fed to
 * the layout algorithms (see the layout effect below) and can be hidden from
 * the toolbar toggle when they hurt readability.
 */
function HierarchyEdge(props: EdgeProps) {
  const [path] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    borderRadius: 14,
  });
  return (
    <g className="hierarchy-edge" aria-label="Parent-child ownership link (not a dependency)">
      <path className="hierarchy-edge__link" d={path} fill="none" />
      {/* the open ring marks the CHILD end: who something belongs to, drawn
          like a little hoop resting on the owned stage */}
      <circle className="hierarchy-edge__ring" cx={props.targetX} cy={props.targetY} r={4} />
    </g>
  );
}

// The all-tasks-done confetti rain used to live here. It was decorative
// continuous motion (a 48-bit CSS fall, replaying whenever the DAG re-rendered
// while everything stayed completed), so it is gone: a finished Run reads from
// the green stamps, the inked edges and the progress strip instead.

function Flow({
  dag,
  leadTaskId,
  selectedId,
  onSelect,
  layout,
  reorgNonce,
  fitNonce,
  showHierarchy,
  workerRows,
  attempts,
}: {
  dag: DagResponse;
  leadTaskId: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  layout: LayoutKind;
  reorgNonce: number;
  fitNonce: number;
  showHierarchy: boolean;
  /** Durable fleet rows — the authority on what actually launched per Task. */
  workerRows: WorkerRowView[];
  /** Viewer-coordinator attempt records — the only launch evidence for
   *  legacy/tracking starts (opencode, custom commands), whose fleet rows
   *  carry no launch facts at all. Scoped to the selected Run by the caller. */
  attempts: RunAttempt[];
}) {
  const rf = useReactFlow();
  const config = useConfig();
  const prevCount = useRef(-1);
  // positions the user has explicitly dragged — preserved across status polls
  const dragged = useRef<Map<string, { x: number; y: number }>>(new Map());
  // id of the node under an active drag gesture (keep its live position)
  const draggingId = useRef<string | null>(null);
  // status seen on the previous poll, and the ids whose status just flipped —
  // recomputed only when the DAG object itself changes (Stage 2 below), so a
  // reconciliation re-run for a selection/config change never cuts a
  // celebration short.
  const prevStatus = useRef<Map<string, TaskStatus>>(new Map());
  const popped = useRef<Set<string>>(new Set());
  const seenDag = useRef<DagResponse | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TaskNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const handledFitNonce = useRef(fitNonce);

  // --- Stage 1 · topology → positioned geometry ----------------------------
  //
  // The layout is derived ONLY from what the algorithms actually consume: the
  // node id sequence (order seeds the force layout's circle and breaks dagre
  // ties) and the dependency edges. It sits behind a string signature instead
  // of `dag` identity because every 2s poll re-fetches the DAG and hands us
  // fresh objects and arrays even when nothing changed — memoizing on those
  // would re-solve (a 320-iteration Fruchterman–Reingold pass per poll) and
  // keep yanking the graph out from under the cursor. Statuses, labels,
  // selection, lead, harness picks, worker rows: none of them move a node, so
  // none of them may re-rank one. Layout kind and reorgNonce are in the key so
  // an algorithm switch or explicit Re-layout re-solves even with an unchanged
  // shape.
  const topologyKey = `${JSON.stringify(dag.nodes.map((n) => n.id))}|${JSON.stringify(
    dag.edges.map((e) => [e.id, e.source, e.target]),
  )}`;
  const laid = useMemo(
    () =>
      applyLayout(
        layout,
        // Topology-only inputs — no decoration rides in, so the memoized
        // result can never go stale on decoration churn. Dependency edges
        // only: hierarchy links are NEVER layout input (see the
        // reconciliation below), exactly as before. `data` is present only
        // because React Flow's Node type requires it — the solvers read just
        // ids and endpoints; Stage 4 replaces it wholesale.
        dag.nodes.map((n) => ({ id: n.id, position: { x: 0, y: 0 }, data: {} })),
        dag.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
      ),
    // `topologyKey` fully covers the `dag.*` inputs above; keying on the
    // string rather than the per-poll arrays is the whole point of the split.
    [topologyKey, layout, reorgNonce],
  );

  // Switching layout algorithm or asking for a re-org discards manual drags so
  // the graph snaps fully to the fresh auto-layout. Declared before the
  // reconciliation effect so the ref is cleared before it re-merges positions.
  useEffect(() => {
    dragged.current.clear();
  }, [layout, reorgNonce]);

  // --- Stage 2 · status-pop detection ---------------------------------------
  //
  // Keyed to the DAG object identity alone (guarded by `seenDag`): it must not
  // re-arm when a reconciliation runs for selection/config/worker-row churn,
  // and the flags must survive those re-merges until the next poll —
  // recomputing here for a selection change would drop the flags mid-flight
  // and cut a celebration short.
  useEffect(() => {
    if (seenDag.current === dag) return;
    const prev = prevStatus.current;
    popped.current = new Set(
      dag.nodes.filter((n) => prev.has(n.id) && prev.get(n.id) !== n.status).map((n) => n.id),
    );
    prevStatus.current = new Map(dag.nodes.map((n) => [n.id, n.status]));
    seenDag.current = dag;
  }, [dag]);

  // --- Stage 3 · actual-launch evidence --------------------------------------
  //
  // What a stage ACTUALLY launched with, from two evidence layers (never the
  // viewer config, which is only the plan and drifts the moment a harness is
  // re-picked after dispatch):
  //   1. Orca's fleet row (`launch.agent`, provider id fallback). CAVEAT,
  //      verified against Orca 1.4.205 (2026-09-22): worker-list's
  //      projection.launch is null even for supervised worker-start
  //      launches — the durable facts live only in worker-show under
  //      worker.startOptions.launch.effective, and list rows do not include
  //      startOptions. This layer only earns its keep on builds whose list
  //      projection carries launch facts; enriching it here would cost one
  //      worker-show CLI call per row per 2s poll, deliberately not done.
  //   2. This viewer coordinator's own attempt records — the working source
  //      for viewer-driven runs, supervised AND legacy/tracking (opencode,
  //      custom commands). Launches made outside the viewer session (manual
  //      CLI, a previous process) have no attempt record and fall back to
  //      the plan behind a "no launch record found" tooltip.
  // worker-list is newest-first, so the first fleet row per Task is the
  // latest attempt; for attempts, keep the latest startedAt per Task.
  const actualHarness = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of workerRows) {
      const agent = row.projection?.launch?.agent ?? row.projection?.provider?.id ?? null;
      if (row.taskId && agent && !map.has(row.taskId)) map.set(row.taskId, agent);
    }
    // Second evidence layer: the viewer coordinator's own attempt records
    // (see the caveat above for why the fleet layer alone cannot be trusted
    // on 1.4.205). Keep the latest attempt per Task.
    const latestAttemptByTask = new Map<string, RunAttempt>();
    for (const attempt of attempts) {
      const prev = latestAttemptByTask.get(attempt.taskId);
      if (!prev || attempt.startedAt >= prev.startedAt) latestAttemptByTask.set(attempt.taskId, attempt);
    }
    for (const [taskId, attempt] of latestAttemptByTask) {
      const agent = attempt.effective?.agent ?? attempt.harness;
      if (agent && !map.has(taskId)) map.set(taskId, agent);
    }
    return map;
  }, [workerRows, attempts]);

  // --- Stage 4 · reconciliation: decoration onto positioned geometry ---------
  //
  // Re-derives the SEMANTICS — status colouring, selection, lead ring, harness
  // provenance, pop, edge classes, hierarchy links — and merges them onto the
  // memoized positions from Stage 1. This effect is the only place decoration
  // can change what the user sees, and it never re-runs the solver: `laid`
  // changes identity only when topology, layout kind or reorgNonce change.
  // `layout` and `reorgNonce` are listed directly because a Re-layout with an
  // unchanged shape memo-hits `laid` yet must still re-merge (the drag-clear
  // above has emptied `dragged`, and the stale merged positions must go).
  useEffect(() => {
    const dir: "LR" | "TB" = layout === "layered-tb" ? "TB" : "LR";
    const statusById = new Map(dag.nodes.map((n) => [n.id, n.status]));
    const nodeById = new Map(dag.nodes.map((n) => [n.id, n]));

    // `laid.nodes` is the same id sequence as `dag.nodes` (Stage 1 is keyed to
    // exactly that topology), so index i is the paint order — the same `--i`
    // entrance stagger and deterministic tilt as before.
    const decoratedNodes: Node<TaskNodeData>[] = laid.nodes.map((n, i) => {
      const dagNode = nodeById.get(n.id);
      return {
        ...n,
        type: "task",
        data: {
          label: dagNode?.label ?? n.id,
          status: dagNode?.status ?? "pending",
          selected: n.id === selectedId,
          lead: n.id === leadTaskId,
          // A launched stage shows what Orca/the coordinator recorded; stages
          // with no launch evidence at all fall back to the planned (config)
          // harness, and the tooltip says which is which.
          harness: actualHarness.get(n.id) ?? effectiveHarness(n.id),
          harnessActual: actualHarness.has(n.id),
          dir,
          index: i,
          // deterministic pseudo-random tilt from the paint order: stickers
          // slapped on paper, stable across polls (no RNG, no jumping)
          tilt: (((i * 37) % 5) - 2) * 0.8,
          pop: popped.current.has(n.id),
        },
      };
    });
    // an edge carries the state of the dependency it represents: satisfied
    // (inked green), being worked on (pencil-traced), or not yet reached —
    // decorated here, onto the layout's own edge list, never inside it.
    const decoratedEdges: Edge[] = laid.edges.map((e) => {
      const from = statusById.get(e.source);
      const running = from === "dispatched";
      const done = from === "completed";
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        // pencil-sketch the link out of a node that is currently running
        type: running ? "pencil" : undefined,
        className: running ? "edge--run" : done ? "edge--done" : "edge--idle",
      };
    });

    // Ownership links (Phase 4) are rendered as edges but are NEVER layout
    // input: the Stage 1 solver ranked only the dependency arrows, so a
    // parent whose child is ready does not drag it into an earlier rank, and
    // every layout algorithm (LR/TB/force) behaves exactly as before. Merged
    // BELOW the dependency edges (array order = paint order) so ownership
    // reads as the subordinate structure it is. The toolbar toggle removes
    // them outright — they are presentation-only, so hiding them loses no
    // scheduling meaning. An owner's Task can also be missing from this Run
    // (dangling parent_id): the server already emits no link for it.
    const hierarchyEdges: Edge[] = showHierarchy
      ? (dag.hierarchy ?? []).map((l) => ({
          id: l.id,
          source: l.parent,
          target: l.child,
          type: "hierarchy",
          className: "edge--hierarchy",
          selectable: false,
          deletable: false,
        }))
      : [];

    setNodes((cur) => {
      const currentById = new Map(cur.map((n) => [n.id, n]));
      return decoratedNodes.map((n) => {
        const current = currentById.get(n.id);
        const keep =
          dragged.current.get(n.id) ??
          (draggingId.current === n.id ? current?.position : undefined);

        // `setNodes` receives brand-new user-node objects on every status poll.
        // In React Flow, a new object without `measured` means "re-initialize
        // this node": its cached handle bounds are cleared until ResizeObserver
        // measures it again, and during that gap every connected EdgeWrapper
        // returns null — so edges and their handles unmount/remount on ordinary
        // polls, which reads as flicker and used to restart the (now removed)
        // per-edge WAAPI trace. Carrying the library-owned dimensions tells
        // React Flow this is the same measured node, so handles, edge DOM and
        // dragged positions survive ordinary polls.
        return {
          ...n,
          position: keep ?? n.position,
          measured: current?.measured,
        };
      });
    });
    setEdges([...hierarchyEdges, ...decoratedEdges]);
  }, [laid, dag, leadTaskId, selectedId, layout, reorgNonce, showHierarchy, actualHarness, config, setNodes, setEdges]);

  // Auto-fit when the node count changes, so live status polls don't yank the
  // viewport while the user is inspecting (or dragging).
  useEffect(() => {
    if (nodes.length !== prevCount.current) {
      prevCount.current = nodes.length;
      const t = window.setTimeout(() => rf.fitView({ padding: 0.22, duration: 300 }), 60);
      return () => window.clearTimeout(t);
    }
  }, [nodes.length, rf]);

  // Re-fit after a layout switch or re-org (node count is unchanged, so the
  // effect above won't fire).
  useEffect(() => {
    const t = window.setTimeout(() => rf.fitView({ padding: 0.22, duration: 400 }), 90);
    return () => window.clearTimeout(t);
  }, [layout, reorgNonce, rf]);

  // Opening, closing or resizing the communication rail changes the canvas
  // viewport but not the DAG layout. Reframe the existing positions after the
  // flex layout settles; do not reuse reorgNonce because that intentionally
  // clears the user's manually dragged positions.
  useEffect(() => {
    if (fitNonce === handledFitNonce.current) return;
    handledFitNonce.current = fitNonce;
    const t = window.setTimeout(() => rf.fitView({ padding: 0.22, duration: 320 }), 90);
    return () => window.clearTimeout(t);
  }, [fitNonce, rf]);

  const onNodeDragStart = useCallback((_e: unknown, node: Node) => {
    draggingId.current = node.id;
  }, []);
  const onNodeDragStop = useCallback((_e: unknown, node: Node) => {
    dragged.current.set(node.id, node.position);
    draggingId.current = null;
  }, []);

  if (dag.nodes.length === 0) {
    return (
      <div className="dag-empty">
        <div className="dag-empty__doodle">🖍️</div>
        <div className="dag-empty__title">A blank page, for now</div>
        <div className="dag-empty__hint">
          Load the <code>orca-dag</code> skill in your agent and talk through what you want to
          build — it will break the work down and draw the graph.
          <br />
          Tasks and deps grow here stroke by stroke, like crayon — then pick a harness per node and
          fire.
        </div>
      </div>
    );
  }

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.2}
        /* Cull to the viewport: a dense, zoomed-out graph mounts only what is
           actually on screen (and still mounts whatever becomes visible while
           panning/zooming), which is what keeps a big DAG from building every
           node, filter and stamp at once. Visibility is computed from React
           Flow's own viewport transform, so dragged positions, edge
           connectivity, hierarchy links and the node `role="group"`/aria-label
           accessibility are untouched — only off-screen DOM is skipped. */
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => onSelect(n.id === selectedId ? null : n.id)}
        onPaneClick={() => onSelect(null)}
      >
        <Background variant={BackgroundVariant.Lines} gap={30} color="rgba(96,132,178,0.085)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </>
  );
}

export function DagView(props: {
  dag: DagResponse;
  leadTaskId: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  layout: LayoutKind;
  reorgNonce: number;
  fitNonce: number;
  showHierarchy: boolean;
  /** Durable fleet rows — the authority on what actually launched per Task. */
  workerRows: WorkerRowView[];
  /** Viewer-coordinator attempt records — the only launch evidence for
   *  legacy/tracking starts (opencode, custom commands), whose fleet rows
   *  carry no launch facts at all. Scoped to the selected Run by the caller. */
  attempts: RunAttempt[];
}) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}
