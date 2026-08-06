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

  // dagre gives clean hierarchy for small/tree-like graphs, but collapses wide
  // bipartite/hub graphs into a thin column — use force-directed above a
  // modest node count so those spread out in 2D.
  const big = layer.nodes.length > 30;

  const cy = cytoscape({
    container,
    elements,
    style: [
      {
        selector: "node",
        style: {
          "background-color": "data(color)",
          // On dense graphs, labels are hidden by default and revealed on
          // hover/selection (see `.lbl`) so the view isn't a wall of text.
          label: big ? "" : "data(label)",
          color: "#e6e9ef",
          "font-size": 10,
          "text-valign": "center",
          "text-halign": "right",
          "text-margin-x": 4,
          "text-max-width": "200px",
          "text-wrap": "ellipsis",
          "text-outline-color": "#0f1115",
          "text-outline-width": big ? 2 : 0,
          // Size hubs by degree on big graphs so structure reads at a glance.
          width: big ? ((ele: cytoscape.NodeSingular) => 10 + Math.min(ele.degree(false), 22)) : 14,
          height: big ? ((ele: cytoscape.NodeSingular) => 10 + Math.min(ele.degree(false), 22)) : 14,
        },
      },
      {
        selector: "edge",
        style: {
          width: 1,
          // Repeated edge labels are pure noise on dense graphs.
          label: big ? "" : "data(label)",
          "font-size": 8,
          color: "#8b93a7",
          "line-color": "#333a49",
          "target-arrow-color": "#333a49",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "arrow-scale": 0.7,
          opacity: big ? 0.4 : 0.9,
        },
      },
      { selector: "node.lbl", style: { label: "data(label)", "z-index": 20, "font-size": 11 } },
      { selector: ".faded", style: { opacity: 0.08 } },
      { selector: "edge.lit", style: { "line-color": "#6ea8fe", "target-arrow-color": "#6ea8fe", opacity: 0.95, width: 1.6 } },
      { selector: "node:selected", style: { "background-color": "#fff", "border-width": 2, "border-color": "#6ea8fe" } },
      { selector: ".highlight", style: { "background-color": "#fff", "border-width": 2, "border-color": "#6ea8fe" } },
    ],
    layout: big
      ? ({
          name: "cose",
          idealEdgeLength: () => 130,
          nodeRepulsion: () => 20000,
          nodeOverlap: 20,
          gravity: 0.25,
          componentSpacing: 120,
          animate: false,
          randomize: true,
        } as unknown as cytoscape.LayoutOptions)
      : ({ name: "dagre", rankDir: "LR", nodeSep: 22, rankSep: 80 } as cytoscape.LayoutOptions),
    wheelSensitivity: 0.2,
  });

  // Hover-to-focus on dense graphs: dim everything, light up the hovered node
  // and its immediate neighborhood, and reveal just those labels.
  const clearFocus = (): void => {
    cy.elements().removeClass("faded lit");
    cy.nodes(":unselected").removeClass("lbl");
  };
  const focus = (node: cytoscape.NodeSingular): void => {
    const hood = node.closedNeighborhood();
    cy.elements().addClass("faded");
    hood.removeClass("faded");
    hood.nodes().addClass("lbl");
    node.connectedEdges().removeClass("faded").addClass("lit");
  };
  if (big) {
    cy.on("mouseover", "node", (evt: EventObject) => focus(evt.target as cytoscape.NodeSingular));
    cy.on("mouseout", "node", () => {
      clearFocus();
      cy.nodes(":selected").forEach((n: cytoscape.NodeSingular) => focus(n));
    });
  }

  cy.on("tap", "node", (evt: EventObject) => {
    const node = evt.target as cytoscape.NodeSingular;
    if (big) {
      clearFocus();
      focus(node);
      node.addClass("lbl");
    }
    onSelect(node.id());
  });
  cy.on("tap", (evt: EventObject) => {
    if (evt.target === cy) {
      if (big) clearFocus();
      onSelect(null);
    }
  });

  return { cy, destroy: () => cy.destroy() };
}
