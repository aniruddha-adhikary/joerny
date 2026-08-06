import cytoscape, { type Core, type EventObject } from "cytoscape";
import dagre from "cytoscape-dagre";
import type { Layer } from "../shared/layer.js";
import type { AppState } from "./state.js";
import { measure, present } from "./viewHeuristics.js";

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

  // Target-side nodes = this layer's *derived* nodes. A node that is itself a
  // mapping source (e.g. the class nodes in a class→cluster projection) is a
  // source, not a target — including it too would litter the view with orphan
  // target nodes that carry no edges and distort the layout.
  const sourceIds = new Set((layer.mappings ?? []).map((m) => m.from));
  if (layer.kind === "graph") {
    for (const n of layer.nodes) if (!sourceIds.has(n.id)) addTarget(n.id, n.label, n.type);
  }

  let edgeCount = 0;
  if (layer.mappings && layer.mappings.length) {
    for (const m of layer.mappings) {
      const src = state.findNode(m.from, layer.derivedFrom);
      addSource(m.from, src?.label ?? m.from.split(/[.#]/).pop() ?? m.from, src?.type);
      addTarget(m.to, m.to.split(/[.#]/).pop() ?? m.to);
      elements.push({
        data: {
          id: `m${edgeCount++}`,
          source: `src::${m.from}`,
          target: `dst::${m.to}`,
          label: m.evidence ?? "",
          origin: m.origin ?? "mechanical",
        },
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

  // Mapping-note labels are the whole point here, but drawing them on every
  // edge at once (e.g. 25 "coupled cluster of 25" edges into one node) is
  // unreadable — so presentation follows the projection's measured shape, and
  // when it's crowded the notes are hidden at rest and revealed for a node's
  // incident edges on hover/selection. It's always a left→right bipartite
  // hierarchy (preferDagreLR), so only labelling/spacing adapts.
  const projEdges = elements
    .filter((e) => (e.data as { source?: string }).source)
    .map((e) => e.data as { source: string; target: string });
  const nodeCount = elements.length - projEdges.length;
  const p = present(measure(nodeCount, projEdges), { preferDagreLR: true });
  const hideEdgeLabels = p.edgeLabels === "hover";

  const cy = cytoscape({
    container,
    elements,
    style: [
      {
        selector: "node",
        style: {
          label: "data(label)",
          color: "#e6e9ef",
          "font-size": p.fontSize,
          "text-valign": "center",
          "text-halign": "right",
          "text-margin-x": 6,
          "text-max-width": "180px",
          "text-wrap": "ellipsis",
          "text-outline-color": "#0f1115",
          "text-outline-width": 2,
          width: 16,
          height: 16,
        },
      },
      { selector: "node[role = 'source']", style: { "background-color": "#8b93a7", shape: "round-rectangle" } },
      { selector: "node[role = 'target']", style: { "background-color": "#6ea8fe" } },
      {
        selector: "edge",
        style: {
          width: 1.2,
          label: hideEdgeLabels ? "" : "data(label)",
          "font-size": Math.max(p.fontSize - 2, 8),
          color: "#c7cdda",
          "text-outline-color": "#0f1115",
          "text-outline-width": 2,
          "line-color": "#3a4252",
          "target-arrow-color": "#3a4252",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "arrow-scale": 0.8,
          "text-rotation": "autorotate",
          opacity: p.edgeOpacity,
        },
      },
      // Provenance: dashed = LLM-inferred mapping, dotted = manual, solid = computed.
      { selector: "edge[origin = 'llm']", style: { "line-style": "dashed", "line-dash-pattern": [6, 3] } },
      { selector: "edge[origin = 'manual']", style: { "line-style": "dotted" } },
      { selector: ".faded", style: { opacity: 0.06 } },
      {
        selector: "edge.lit",
        style: { "line-color": "#6ea8fe", "target-arrow-color": "#6ea8fe", opacity: 1, width: 2, label: "data(label)", "z-index": 21 },
      },
      { selector: ".highlight", style: { "border-width": 2, "border-color": "#fff" } },
    ],
    layout: p.layout,
    wheelSensitivity: 0.2,
  });

  const clearFocus = (): void => {
    cy.elements().removeClass("faded lit");
  };
  const focus = (node: cytoscape.NodeSingular): void => {
    const hood = node.closedNeighborhood();
    cy.elements().addClass("faded");
    hood.removeClass("faded");
    node.connectedEdges().removeClass("faded").addClass("lit");
  };
  cy.on("mouseover", "node", (evt: EventObject) => {
    if (cy.nodes(":selected").empty()) focus(evt.target as cytoscape.NodeSingular);
  });
  cy.on("mouseout", "node", () => {
    if (cy.nodes(":selected").empty()) clearFocus();
  });

  cy.on("tap", "node", (evt: EventObject) => {
    clearFocus();
    focus(evt.target as cytoscape.NodeSingular);
    onSelect(evt.target.data("realId") as string);
  });
  cy.on("tap", (evt: EventObject) => {
    if (evt.target === cy) {
      clearFocus();
      onSelect(null);
    }
  });

  return { cy, destroy: () => cy.destroy(), empty };
}
