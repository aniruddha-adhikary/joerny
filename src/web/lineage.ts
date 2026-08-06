import cytoscape, { type Core, type EventObject } from "cytoscape";
import dagre from "cytoscape-dagre";
import type { Layer } from "../shared/layer.js";
import { KIND_COLORS } from "./colors.js";

cytoscape.use(dagre);

/**
 * Renders the lineage DAG (layers as nodes, `derivedFrom` as edges) into the
 * left pane. Tapping a layer node selects it. A derivation edge whose child
 * carries node-level mappings is drawn as an inspectable link labelled with its
 * mapping count — single-tapping it selects the child layer (the inspector then
 * shows its Mappings, i.e. *how* the transformation was made), and
 * double-tapping opens the Projection view (`onOpenProjection`).
 */
export function renderLineage(
  container: HTMLElement,
  layers: Layer[],
  selectedId: string | null,
  onSelect: (id: string) => void,
  onOpenProjection: (childId: string) => void,
): Core {
  const ids = new Set(layers.map((l) => l.id));
  const elements: cytoscape.ElementDefinition[] = [
    ...layers.map((l) => ({ data: { id: l.id, label: l.name, color: KIND_COLORS[l.kind] ?? "#b0bac9" } })),
  ];
  for (const l of layers) {
    const maps = l.mappings?.length ?? 0;
    for (const parent of l.derivedFrom) {
      if (ids.has(parent)) {
        elements.push({
          data: {
            id: `${parent}->${l.id}`,
            source: parent,
            target: l.id,
            child: l.id,
            maps,
            label: maps > 0 ? `${maps}` : "",
            cls: maps > 0 ? "mapped" : "plain",
          },
        });
      }
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
      {
        // A derivation with computed node-level mappings is clickable → projection.
        selector: "edge[cls = 'mapped']",
        style: {
          "line-color": "#63cbd0",
          "target-arrow-color": "#63cbd0",
          label: "data(label)",
          "font-size": 8,
          color: "#63cbd0",
          "text-background-color": "#0f1115",
          "text-background-opacity": 1,
          "text-background-padding": "1px",
        },
      },
      { selector: "edge.hl", style: { "line-color": "#6ea8fe", "target-arrow-color": "#6ea8fe", width: 2.5 } },
      { selector: "node.selected", style: { "border-width": 3, "border-color": "#fff" } },
    ],
    layout: { name: "dagre", rankDir: "TB", nodeSep: 12, rankSep: 30 } as cytoscape.LayoutOptions,
    userZoomingEnabled: true,
    userPanningEnabled: true,
  });

  if (selectedId) {
    cy.$id(selectedId).addClass("selected");
    // Light up the derivations feeding the selected layer so its provenance
    // reads at a glance.
    cy.edges(`[child = "${selectedId}"]`).addClass("hl");
  }
  cy.on("tap", "node", (evt: EventObject) => onSelect(evt.target.id()));

  // Single tap selects the derivation's child (inspector shows its Mappings);
  // a second tap on the same edge within the double-tap window opens the
  // Projection. The single action is deferred so a double-tap can cancel it.
  let pending: ReturnType<typeof setTimeout> | null = null;
  let lastEdgeId = "";
  cy.on("tap", "edge", (evt: EventObject) => {
    const e = evt.target as cytoscape.EdgeSingular;
    const child = e.data("child") as string;
    const mapped = (e.data("maps") as number) > 0;
    if (pending && lastEdgeId === e.id()) {
      clearTimeout(pending);
      pending = null;
      lastEdgeId = "";
      if (mapped) onOpenProjection(child);
      else onSelect(child);
      return;
    }
    lastEdgeId = e.id();
    pending = setTimeout(() => {
      pending = null;
      lastEdgeId = "";
      onSelect(child);
    }, 260);
  });
  cy.on("mouseover", "edge[cls = 'mapped']", () => {
    container.style.cursor = "pointer";
  });
  cy.on("mouseout", "edge", () => {
    container.style.cursor = "default";
  });
  return cy;
}
