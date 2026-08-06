import cytoscape, { type Core, type EventObject } from "cytoscape";
import dagre from "cytoscape-dagre";
import type { GraphLayer } from "../shared/layer.js";
import { measure, present } from "./viewHeuristics.js";
import { buildTypePalette, edgeColor } from "./colors.js";

cytoscape.use(dagre);

export interface GraphViewHandle {
  cy: Core;
  destroy: () => void;
}

/**
 * Renders a graph layer. Presentation (layout, whether labels/edge-labels show,
 * node sizing, edge dimming) is derived from the graph's measured *shape* via
 * `viewHeuristics`, not fixed thresholds — a small sketch stays fully labelled,
 * a hairball declutters and reveals detail on hover. Calls `onSelect` with the
 * node id when a node is tapped.
 */
export function renderGraph(
  container: HTMLElement,
  layer: GraphLayer,
  onSelect: (nodeId: string | null) => void,
): GraphViewHandle {
  const palette = buildTypePalette(layer.nodes.map((n) => n.type));
  const nodeIds = new Set(layer.nodes.map((n) => n.id));
  const edges = layer.edges.filter((e) => nodeIds.has(e.src) && nodeIds.has(e.dst));

  const p = present(measure(layer.nodes.length, edges.map((e) => ({ source: e.src, target: e.dst }))));
  const hideNodeLabels = p.nodeLabels === "hover";
  const hideEdgeLabels = p.edgeLabels === "hover";

  const elements: cytoscape.ElementDefinition[] = [
    ...layer.nodes.map((n) => ({
      data: { id: n.id, label: n.label, type: n.type ?? "", color: palette.get(n.type ?? "") ?? "#b0bac9" },
    })),
    ...edges.map((e, i) => ({
      data: {
        id: `e${i}`,
        source: e.src,
        target: e.dst,
        label: e.type ?? "",
        color: edgeColor(e.type),
        origin: e.origin ?? "mechanical",
      },
    })),
  ];

  const degSize = (ele: cytoscape.NodeSingular): number => 12 + Math.min(ele.degree(false) * 1.5, 28);

  const cy = cytoscape({
    container,
    elements,
    style: [
      {
        selector: "node",
        style: {
          "background-color": "data(color)",
          label: hideNodeLabels ? "" : "data(label)",
          color: "#e6e9ef",
          "font-size": p.fontSize,
          "text-valign": "center",
          "text-halign": "right",
          "text-margin-x": 5,
          "text-max-width": "160px",
          "text-wrap": "ellipsis",
          "text-outline-color": "#0f1115",
          "text-outline-width": 2,
          width: p.sizeByDegree ? degSize : 16,
          height: p.sizeByDegree ? degSize : 16,
          "border-width": 0,
        },
      },
      {
        selector: "edge",
        style: {
          width: 1.2,
          // Kind is shown via colour; text is revealed for a focused node's
          // incident edges (.lit) unless the graph is small enough to show all.
          label: hideEdgeLabels ? "" : "data(label)",
          "font-size": Math.max(p.fontSize - 2, 8),
          color: "#c7cdda",
          "text-outline-color": "#0f1115",
          "text-outline-width": 2,
          "line-color": "data(color)",
          "target-arrow-color": "data(color)",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "arrow-scale": 0.8,
          opacity: p.edgeOpacity,
        },
      },
      // Provenance: mechanical edges are solid (authoritative); an LLM-inferred
      // link is dashed and a manual one dotted, so a guess never looks like a
      // computed fact (cf. InferaGraph dashing AI-discovered edges).
      { selector: "edge[origin = 'llm']", style: { "line-style": "dashed", "line-dash-pattern": [6, 3] } },
      { selector: "edge[origin = 'manual']", style: { "line-style": "dotted" } },
      { selector: "node.lbl", style: { label: "data(label)", "z-index": 20, "font-size": p.fontSize + 1 } },
      { selector: ".faded", style: { opacity: 0.06 } },
      {
        selector: "edge.lit",
        style: { "line-color": "#6ea8fe", "target-arrow-color": "#6ea8fe", opacity: 1, width: 2, label: "data(label)", "z-index": 21 },
      },
      { selector: "node:selected", style: { "background-color": "#fff", "border-width": 2, "border-color": "#6ea8fe" } },
      { selector: ".highlight", style: { "background-color": "#fff", "border-width": 2, "border-color": "#6ea8fe" } },
    ],
    layout: p.layout,
    wheelSensitivity: 0.2,
  });

  // Hover-to-focus: dim everything, light up the hovered node + neighbourhood
  // and reveal just those labels + incident edge labels. Always available so
  // even a labelled small graph can surface an edge's note on demand.
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
  cy.on("mouseover", "node", (evt: EventObject) => {
    if (cy.nodes(":selected").empty()) focus(evt.target as cytoscape.NodeSingular);
  });
  cy.on("mouseout", "node", () => {
    if (cy.nodes(":selected").empty()) clearFocus();
  });

  cy.on("tap", "node", (evt: EventObject) => {
    const node = evt.target as cytoscape.NodeSingular;
    clearFocus();
    focus(node);
    node.addClass("lbl");
    onSelect(node.id());
  });
  cy.on("tap", (evt: EventObject) => {
    if (evt.target === cy) {
      clearFocus();
      onSelect(null);
    }
  });

  return { cy, destroy: () => cy.destroy() };
}
