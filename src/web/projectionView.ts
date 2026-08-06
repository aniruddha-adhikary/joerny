import cytoscape, { type Core, type EventObject } from "cytoscape";
import dagre from "cytoscape-dagre";
import type { Layer } from "../shared/layer.js";
import type { AppState } from "./state.js";

cytoscape.use(dagre);

export interface ProjectionHandle {
  cy: Core;
  destroy: () => void;
  empty: boolean;
}

interface Built {
  elements: cytoscape.ElementDefinition[];
  empty: boolean;
}

/**
 * Builds a bipartite "how this layer projects from its parents" graph:
 * parent (source) nodes on the left, this layer's nodes on the right, connected
 * by mapping edges — so "component ← the common methods it was built from" is
 * actually drawn, not just listed. Falls back to identity edges (shared node
 * ids) when a derived graph declares no explicit mappings.
 *
 * Source/target cytoscape ids are namespaced (`src::`/`dst::`) so a node that
 * appears on both sides (identity projection) doesn't collapse into one.
 */
function build(state: AppState, layer: Layer): Built {
  const elements: cytoscape.ElementDefinition[] = [];
  const added = new Set<string>();

  const addTarget = (id: string, label: string, type?: string): void => {
    const cyId = `dst::${id}`;
    if (added.has(cyId)) return;
    added.add(cyId);
    elements.push({ data: { id: cyId, realId: id, label, role: "target", type: type ?? "" } });
  };
  const addSource = (id: string, label: string, type?: string): void => {
    const cyId = `src::${id}`;
    if (added.has(cyId)) return;
    added.add(cyId);
    elements.push({ data: { id: cyId, realId: id, label, role: "source", type: type ?? "" } });
  };

  // Target-side nodes = this layer's own nodes (or, for non-graph layers, the
  // distinct mapping targets).
  if (layer.kind === "graph") {
    for (const n of layer.nodes) addTarget(n.id, n.label, n.type);
  }

  let edgeCount = 0;
  if (layer.mappings && layer.mappings.length) {
    for (const m of layer.mappings) {
      const src = state.findNode(m.from, layer.derivedFrom);
      addSource(m.from, src?.label ?? m.from.split(/[.#]/).pop() ?? m.from, src?.type);
      addTarget(m.to, m.to.split(/[.#]/).pop() ?? m.to);
      elements.push({
        data: { id: `m${edgeCount++}`, source: `src::${m.from}`, target: `dst::${m.to}`, label: m.note ?? "" },
      });
    }
  } else if (layer.kind === "graph") {
    // Identity projection: nodes shared with a parent graph.
    const ids = new Set(layer.nodes.map((n) => n.id));
    for (const pid of layer.derivedFrom) {
      const parent = state.layers.get(pid);
      if (parent?.kind !== "graph") continue;
      for (const pn of parent.nodes) {
        if (!ids.has(pn.id)) continue;
        addSource(pn.id, pn.label, pn.type);
        elements.push({
          data: { id: `i${edgeCount++}`, source: `src::${pn.id}`, target: `dst::${pn.id}`, label: "same" },
        });
      }
    }
  }

  return { elements, empty: edgeCount === 0 };
}

export function renderProjection(
  container: HTMLElement,
  state: AppState,
  layer: Layer,
  onSelect: (nodeId: string | null) => void,
): ProjectionHandle {
  const { elements, empty } = build(state, layer);

  const cy = cytoscape({
    container,
    elements,
    style: [
      {
        selector: "node",
        style: {
          label: "data(label)",
          color: "#e6e9ef",
          "font-size": 10,
          "text-valign": "center",
          "text-halign": "right",
          "text-margin-x": 5,
          "text-max-width": "200px",
          "text-wrap": "ellipsis",
          width: 16,
          height: 16,
        },
      },
      { selector: "node[role = 'source']", style: { "background-color": "#8b93a7", shape: "round-rectangle" } },
      { selector: "node[role = 'target']", style: { "background-color": "#6ea8fe" } },
      {
        selector: "edge",
        style: {
          width: 1.4,
          label: "data(label)",
          "font-size": 8,
          color: "#8b93a7",
          "line-color": "#4a5268",
          "target-arrow-color": "#4a5268",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "arrow-scale": 0.8,
          "text-rotation": "autorotate",
        },
      },
      { selector: ".highlight", style: { "border-width": 2, "border-color": "#fff" } },
    ],
    layout: { name: "dagre", rankDir: "LR", nodeSep: 14, rankSep: 220 } as cytoscape.LayoutOptions,
    wheelSensitivity: 0.2,
  });

  cy.on("tap", "node", (evt: EventObject) => onSelect(evt.target.data("realId") as string));
  cy.on("tap", (evt: EventObject) => {
    if (evt.target === cy) onSelect(null);
  });

  return { cy, destroy: () => cy.destroy(), empty };
}
