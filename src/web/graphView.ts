import cytoscape, { type Core, type EventObject } from "cytoscape";
import dagre from "cytoscape-dagre";
import type { GraphLayer } from "../shared/layer.js";

cytoscape.use(dagre);

const TYPE_COLORS = ["#6ea8fe", "#7ed6a5", "#e0b978", "#c88ffb", "#f28ca4", "#63cbd0", "#b0bac9"];

function colorForType(type: string | undefined, palette: Map<string, string>): string {
  const key = type ?? "_";
  if (!palette.has(key)) palette.set(key, TYPE_COLORS[palette.size % TYPE_COLORS.length]);
  return palette.get(key) as string;
}

export interface GraphViewHandle {
  cy: Core;
  destroy: () => void;
}

/**
 * Renders a graph layer into `container` with a dagre (hierarchical) layout,
 * falling back to a force-ish layout when the graph is large. Calls `onSelect`
 * with the node id when a node is tapped.
 */
export function renderGraph(
  container: HTMLElement,
  layer: GraphLayer,
  onSelect: (nodeId: string | null) => void,
): GraphViewHandle {
  const palette = new Map<string, string>();
  const nodeIds = new Set(layer.nodes.map((n) => n.id));

  const elements: cytoscape.ElementDefinition[] = [
    ...layer.nodes.map((n) => ({
      data: { id: n.id, label: n.label, type: n.type ?? "", color: colorForType(n.type, palette) },
    })),
    // Only keep edges whose endpoints exist to avoid cytoscape errors.
    ...layer.edges
      .filter((e) => nodeIds.has(e.src) && nodeIds.has(e.dst))
      .map((e, i) => ({ data: { id: `e${i}`, source: e.src, target: e.dst, label: e.type ?? "" } })),
  ];

  const big = layer.nodes.length > 250;

  const cy = cytoscape({
    container,
    elements,
    style: [
      {
        selector: "node",
        style: {
          "background-color": "data(color)",
          label: "data(label)",
          color: "#e6e9ef",
          "font-size": 10,
          "text-valign": "center",
          "text-halign": "right",
          "text-margin-x": 4,
          "text-max-width": "160px",
          "text-wrap": "ellipsis",
          width: 14,
          height: 14,
        },
      },
      {
        selector: "edge",
        style: {
          width: 1,
          "line-color": "#3a4152",
          "target-arrow-color": "#3a4152",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "arrow-scale": 0.8,
        },
      },
      { selector: "node:selected", style: { "background-color": "#fff", "border-width": 2, "border-color": "#6ea8fe" } },
      { selector: ".highlight", style: { "background-color": "#fff", "border-width": 2, "border-color": "#6ea8fe" } },
    ],
    layout: big
      ? { name: "concentric", concentric: (n: cytoscape.NodeSingular) => n.degree(false), levelWidth: () => 4 }
      : { name: "dagre", rankDir: "LR", nodeSep: 18, rankSep: 60 } as cytoscape.LayoutOptions,
    wheelSensitivity: 0.2,
  });

  cy.on("tap", "node", (evt: EventObject) => onSelect(evt.target.id()));
  cy.on("tap", (evt: EventObject) => {
    if (evt.target === cy) onSelect(null);
  });

  return { cy, destroy: () => cy.destroy() };
}
