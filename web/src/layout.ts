import dagre from "@dagrejs/dagre";
import { Position, type Edge, type Node } from "@xyflow/react";
import type { LayoutKind } from "./types";

export const NODE_W = 296;
export const NODE_H = 136;
export const GATE_W = 244;
export const GATE_H = 100;

/**
 * Assign deterministic left-to-right (or top-to-bottom) positions using dagre —
 * the classic Sugiyama layered DAG layout. Deterministic so live status polls
 * recolor nodes in place without the graph jumping around.
 */
function layoutDag<N extends Node>(
  nodes: N[],
  edges: Edge[],
  direction: "LR" | "TB" = "LR",
): { nodes: N[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 28, ranksep: 68, marginx: 18, marginy: 18 });
  g.setDefaultEdgeLabel(() => ({}));

  nodes.forEach((n) => {
    const isGate = n.type === "gate";
    g.setNode(n.id, { width: isGate ? GATE_W : NODE_W, height: isGate ? GATE_H : NODE_H });
  });
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  const positioned = nodes.map((n) => {
    const isGate = n.type === "gate";
    const w = isGate ? GATE_W : NODE_W;
    const h = isGate ? GATE_H : NODE_H;
    const p = g.node(n.id);
    return {
      ...n,
      position: { x: p.x - w / 2, y: p.y - h / 2 },
      sourcePosition: direction === "LR" ? Position.Right : Position.Bottom,
      targetPosition: direction === "LR" ? Position.Left : Position.Top,
    };
  }) as N[];

  return { nodes: positioned, edges };
}

/** Arrange the graph with the chosen classic layout algorithm. */
export function applyLayout<N extends Node>(
  kind: LayoutKind,
  nodes: N[],
  edges: Edge[],
): { nodes: N[]; edges: Edge[] } {
  switch (kind) {
    case "layered-tb":
      return layoutDag(nodes, edges, "TB");
    case "layered-lr":
    default:
      return layoutDag(nodes, edges, "LR");
  }
}
