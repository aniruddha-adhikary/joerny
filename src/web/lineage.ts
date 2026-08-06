import cytoscape, { type Core, type EventObject } from "cytoscape";
import dagre from "cytoscape-dagre";
import type { Layer } from "../shared/layer.js";

cytoscape.use(dagre);

const KIND_COLOR: Record<string, string> = {
  graph: "#6ea8fe",
  table: "#7ed6a5",
  note: "#e0b978",
};

/**
 * Renders the lineage DAG (layers as nodes, `derivedFrom` as edges) into the
 * left pane. Tapping a layer selects it.
 */
export function renderLineage(
  container: HTMLElement,
  layers: Layer[],
  selectedId: string | null,
  onSelect: (id: string) => void,
): Core {
  const ids = new Set(layers.map((l) => l.id));
  const elements: cytoscape.ElementDefinition[] = [
    ...layers.map((l) => ({ data: { id: l.id, label: l.name, color: KIND_COLOR[l.kind] ?? "#b0bac9" } })),
  ];
  for (const l of layers) {
    for (const parent of l.derivedFrom) {
      if (ids.has(parent)) elements.push({ data: { id: `${parent}->${l.id}`, source: parent, target: l.id } });
    }
  }

  const cy = cytoscape({
    container,
    elements,
    style: [
      {
        selector: "node",
        style: {
          "background-color": "data(color)",
          label: "data(label)",
          color: "#0f1115",
          "font-size": 9,
          "font-weight": 700,
          "text-valign": "center",
          "text-halign": "center",
          "text-max-width": "90px",
          "text-wrap": "ellipsis",
          shape: "round-rectangle",
          width: "label",
          height: 20,
        },
      },
      {
        selector: "edge",
        style: {
          width: 1.5,
          "line-color": "#4a5268",
          "target-arrow-color": "#4a5268",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "arrow-scale": 0.7,
        },
      },
      { selector: "node.selected", style: { "border-width": 3, "border-color": "#fff" } },
    ],
    layout: { name: "dagre", rankDir: "TB", nodeSep: 12, rankSep: 26 } as cytoscape.LayoutOptions,
    userZoomingEnabled: true,
    userPanningEnabled: true,
  });

  if (selectedId) cy.$id(selectedId).addClass("selected");
  cy.on("tap", "node", (evt: EventObject) => onSelect(evt.target.id()));
  return cy;
}
