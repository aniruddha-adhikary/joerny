import cytoscape, { type Core, type EventObject } from "cytoscape";
import dagre from "cytoscape-dagre";
import type { FlowDirection, GraphLayer } from "../shared/layer.js";
import { FLOW_BRANCH_COLORS, FLOW_SHAPE_COLORS } from "./colors.js";

cytoscape.use(dagre);

export interface FlowchartViewHandle {
  cy: Core;
  destroy: () => void;
}

// Cytoscape shape per flowchart node role — the classic flowchart vocabulary:
// diamond = decision (guard), rhomboid = io side-effect, round-rectangle =
// process/terminal. Colour (from FLOW_SHAPE_COLORS) reinforces the role.
const SHAPE_GEOM: Record<string, cytoscape.Css.NodeShape> = {
  decision: "diamond",
  process: "round-rectangle",
  io: "rhomboid",
  terminal: "round-rectangle",
};

function shapeOf(props: Record<string, unknown> | undefined): string {
  const s = props?.shape;
  return typeof s === "string" && s in SHAPE_GEOM ? s : "process";
}

function branchColor(type: string | undefined): string {
  return FLOW_BRANCH_COLORS[type ?? ""] ?? "#5a6270";
}

/**
 * Renders a flowchart layer (a graph whose `render === "flowchart"`): the
 * step-by-step control flow of an algorithm, with decision/process/io/terminal
 * node shapes, branch-labelled edges, and a hierarchical layout. Reads top-down
 * by default (the flowchart norm) with a TB/LR toggle. Nodes on the tracked
 * data path (`props.focus`) are ringed so you can follow the data through.
 */
export function renderFlowchart(
  container: HTMLElement,
  layer: GraphLayer,
  onSelect: (nodeId: string | null) => void,
): FlowchartViewHandle {
  const nodeIds = new Set(layer.nodes.map((n) => n.id));
  const edges = layer.edges.filter((e) => nodeIds.has(e.src) && nodeIds.has(e.dst));

  const elements: cytoscape.ElementDefinition[] = [
    ...layer.nodes.map((n) => {
      const shape = shapeOf(n.props);
      return {
        data: {
          id: n.id,
          label: n.label,
          shape,
          geom: SHAPE_GEOM[shape],
          color: FLOW_SHAPE_COLORS[shape] ?? "#6ea8fe",
          focus: n.props?.focus === true ? "1" : "0",
        },
      };
    }),
    ...edges.map((e, i) => ({
      data: {
        id: `e${i}`,
        source: e.src,
        target: e.dst,
        label: e.type ?? "",
        color: branchColor(e.type),
        origin: e.origin ?? "mechanical",
      },
    })),
  ];

  let direction: FlowDirection = layer.direction === "LR" ? "LR" : "TB";
  const layoutOpts = (): cytoscape.LayoutOptions =>
    ({
      name: "dagre",
      rankDir: direction,
      nodeSep: 26,
      rankSep: 46,
      edgeSep: 12,
      padding: 16,
      animate: false,
    }) as unknown as cytoscape.LayoutOptions;

  // Inferred (not annotated) so data-mapper strings like "data(geom)" and props
  // this @types version omits (padding) aren't rejected; cast when passed in.
  const style = [
      {
        selector: "node",
        style: {
          shape: "data(geom)",
          "background-color": "data(color)",
          "background-opacity": 0.22,
          "border-width": 1.5,
          "border-color": "data(color)",
          label: "data(label)",
          color: "#e8ebf2",
          "font-size": 10,
          "font-family": "'JetBrains Mono', ui-monospace, monospace",
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "wrap",
          "text-max-width": "150px",
          width: "label",
          height: "label",
          padding: "8px",
        },
      },
      // Diamonds need extra padding so the condition text clears the corners.
      { selector: "node[shape = 'decision']", style: { padding: "20px" } },
      { selector: "node[shape = 'io']", style: { padding: "12px" } },
      {
        selector: "edge",
        style: {
          width: 1.6,
          label: "data(label)",
          "font-size": 9,
          color: "#c7cdda",
          "text-background-color": "#14171f",
          "text-background-opacity": 0.85,
          "text-background-padding": "2px",
          "line-color": "data(color)",
          "target-arrow-color": "data(color)",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "arrow-scale": 0.9,
        },
      },
      // Provenance carries over from the node-link view: a mechanical edge is
      // solid, an llm-inferred one dashed, a manual one dotted.
      { selector: "edge[origin = 'llm']", style: { "line-style": "dashed", "line-dash-pattern": [6, 3] } },
      { selector: "edge[origin = 'manual']", style: { "line-style": "dotted" } },
      // A node on the tracked data path gets a bright ring so you can follow the
      // declaration's data through the algorithm.
      {
        selector: "node[focus = '1']",
        style: { "border-width": 3, "border-color": "#fff", "background-opacity": 0.4 },
      },
      { selector: ".faded", style: { opacity: 0.14 } },
      { selector: "edge.lit", style: { width: 2.6, opacity: 1, "z-index": 21 } },
      { selector: "node:selected", style: { "background-opacity": 0.55, "border-color": "#fff", "border-width": 3 } },
      { selector: ".highlight", style: { "background-opacity": 0.55, "border-color": "#fff", "border-width": 3 } },
    ];

  const cy = cytoscape({
    container,
    elements,
    style: style as unknown as cytoscape.Stylesheet[],
    layout: layoutOpts(),
    wheelSensitivity: 0.2,
  });

  // Hover: trace the path through a node (its in/out edges + neighbours lit).
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
    onSelect((evt.target as cytoscape.NodeSingular).id());
  });
  cy.on("tap", (evt: EventObject) => {
    if (evt.target === cy) onSelect(null);
  });

  // Orientation toggle — flowcharts read best top-down, but a wide, shallow
  // algorithm is clearer left-right, so let the reader flip it.
  const controls = document.createElement("div");
  controls.className = "fc-controls";
  const mkBtn = (dir: FlowDirection, text: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = "fc-dir" + (direction === dir ? " active" : "");
    b.textContent = text;
    b.title = dir === "TB" ? "Top-down" : "Left-right";
    b.addEventListener("click", () => {
      if (direction === dir) return;
      direction = dir;
      controls.querySelectorAll(".fc-dir").forEach((e) => e.classList.remove("active"));
      b.classList.add("active");
      cy.layout(layoutOpts()).run();
    });
    return b;
  };
  controls.appendChild(mkBtn("TB", "↓ TB"));
  controls.appendChild(mkBtn("LR", "→ LR"));
  const prevPosition = container.style.position;
  container.style.position = "relative";
  container.appendChild(controls);

  return {
    cy,
    destroy: () => {
      controls.remove();
      container.style.position = prevPosition;
      cy.destroy();
    },
  };
}
