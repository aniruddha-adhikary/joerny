import type cytoscape from "cytoscape";

/**
 * Presentation is chosen from the graph's *shape*, not fixed thresholds.
 * The same layer type can be a 4-node sketch or a 400-node hairball, so we
 * measure node/edge counts, density and hubbiness and derive how to lay it out,
 * whether to show labels, and how hard to declutter — rather than hardcoding
 * "big = n > 30".
 */
export interface Shape {
  n: number;
  m: number;
  avgDeg: number;
  maxDeg: number;
  /** m ≈ n-1 and low density → hierarchy/tree; dagre reads best. */
  treeLike: boolean;
  /** a few nodes carry most edges → force layout + emphasize hubs. */
  hubby: boolean;
  /** many nodes or high density → aggressive declutter. */
  crowded: boolean;
}

export interface Presentation {
  shape: Shape;
  nodeLabels: "always" | "hover";
  edgeLabels: "always" | "hover";
  sizeByDegree: boolean;
  edgeOpacity: number;
  fontSize: number;
  layout: cytoscape.LayoutOptions;
}

export function measure(nodeCount: number, edges: Array<{ source: string; target: string }>): Shape {
  const n = Math.max(nodeCount, 1);
  const m = edges.length;
  const deg = new Map<string, number>();
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  }
  const maxDeg = deg.size ? Math.max(...deg.values()) : 0;
  const avgDeg = (2 * m) / n;
  return {
    n,
    m,
    avgDeg,
    maxDeg,
    treeLike: n >= 3 && m <= n * 1.3 && maxDeg <= Math.max(6, n * 0.5),
    hubby: maxDeg >= Math.max(8, n * 0.4),
    crowded: n > 24 || avgDeg > 3 || maxDeg > 14,
  };
}

/**
 * Derive layout + label/declutter strategy from a shape. `rankDir` lets the
 * bipartite projection force a left→right hierarchy even when it isn't tree-like.
 */
export function present(shape: Shape, opts: { preferDagreLR?: boolean } = {}): Presentation {
  const { n, m, avgDeg, maxDeg, treeLike, hubby, crowded } = shape;

  const nodeLabels: "always" | "hover" = crowded || n > 22 ? "hover" : "always";
  // Edge labels are the first thing to overwhelm a view; keep them only when
  // there are few edges and the graph isn't crowded.
  const edgeLabels: "always" | "hover" = !crowded && m <= 16 ? "always" : "hover";
  const sizeByDegree = maxDeg >= 6;
  const edgeOpacity = crowded ? 0.28 : avgDeg > 1.6 ? 0.5 : 0.7;
  const fontSize = n > 60 ? 10 : 12;

  // Spacing grows with the graph so labels/nodes don't collide.
  const spacingFactor = crowded ? 1.3 : 1.05;

  // A left→right hierarchy only reads while one rank isn't overcrowded. A
  // bipartite projection where many sources funnel into one hub (e.g. 17
  // classes → one cluster) becomes a tall single column that fit-zoom crushes
  // horizontally — so dagre yields to a force layout once it's hubby/crowded,
  // which spreads the sources radially around the hub instead.
  const useDagre = (opts.preferDagreLR && !hubby && !crowded) || (treeLike && !hubby);

  let layout: cytoscape.LayoutOptions;
  if (m === 0) {
    // No edges = a pure classification set (e.g. coverage covered/gap). A single
    // column is unreadable; a near-square grid packs it and stays scannable.
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    layout = { name: "grid", cols, condense: true, spacingFactor } as cytoscape.LayoutOptions;
  } else if (useDagre) {
    // Hierarchical: node/rank separation scales with node count.
    const nodeSep = Math.min(18 + n, 60);
    const rankSep = opts.preferDagreLR ? 220 : Math.min(90 + n * 2, 200);
    layout = { name: "dagre", rankDir: "LR", nodeSep, rankSep, spacingFactor } as cytoscape.LayoutOptions;
  } else {
    // Force-directed: repulsion and edge length scale with size/hubbiness so
    // hub graphs spread and dense graphs get breathing room.
    const repulsion = 12000 + n * 400 + (hubby ? 12000 : 0);
    const idealEdge = 90 + Math.min(n * 2, 120);
    layout = {
      name: "cose",
      idealEdgeLength: () => idealEdge,
      nodeRepulsion: () => repulsion,
      nodeOverlap: 24 + Math.min(n, 30),
      gravity: crowded ? 0.15 : 0.3,
      componentSpacing: 120 + Math.min(n * 2, 120),
      animate: false,
      randomize: true,
    } as unknown as cytoscape.LayoutOptions;
  }

  return { shape, nodeLabels, edgeLabels, sizeByDegree, edgeOpacity, fontSize, layout };
}
