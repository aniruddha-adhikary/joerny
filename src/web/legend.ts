import type { Layer } from "../shared/layer.js";
import { buildTypePalette, edgeColor, KIND_COLORS } from "./colors.js";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

const dot = (color: string, label: string): string =>
  `<span class="lg-item"><span class="lg-dot" style="background:${color}"></span>${esc(label)}</span>`;
const line = (color: string, label: string): string =>
  `<span class="lg-item"><span class="lg-line" style="background:${color}"></span>${esc(label)}</span>`;

const KIND_MEANING: Record<string, string> = {
  graph: "nodes + edges",
  table: "rows (not graphable)",
  note: "markdown",
};

// Friendly labels for meaning-bearing node types (requirements/facts/coverage).
const TYPE_MEANING: Record<string, string> = {
  requirement: "requirement (supported)",
  "req-unverified": "requirement (unverified)",
  "req-unsupported": "requirement (unsupported)",
  "fact-flow": "fact: flow step",
  "fact-table": "fact: table",
  "fact-capability": "fact: capability",
  covered: "covered by a requirement",
  gap: "gap: no requirement",
};

/**
 * Builds the legend for the currently shown view. It reflects *what is actually
 * on screen* — the layer kind, the node types present (with their colours) and
 * the edge relationship kinds — so colours and shapes aren't a mystery.
 */
export function legendHtml(layer: Layer, mode: "primary" | "projection"): string {
  const parts: string[] = [];
  parts.push(`<span class="lg-item"><span class="lg-badge kind-${layer.kind}">${layer.kind}</span>${esc(KIND_MEANING[layer.kind] ?? "")}</span>`);

  if (mode === "projection") {
    parts.push(dot("#8b93a7", "parent (source)"));
    parts.push(dot(KIND_COLORS.graph, "derived (this layer)"));
    parts.push(`<span class="lg-hint">hover a node to reveal its mapping evidence</span>`);
    return parts.join("");
  }

  if (layer.kind === "graph") {
    const palette = buildTypePalette(layer.nodes.map((n) => n.type));
    const types = Array.from(new Set(layer.nodes.map((n) => n.type).filter((t): t is string => !!t))).sort();
    for (const t of types) parts.push(dot(palette.get(t) ?? "#b0bac9", TYPE_MEANING[t] ?? t));

    const edgeTypes = Array.from(new Set(layer.edges.map((e) => e.type).filter((t): t is string => !!t))).sort();
    for (const t of edgeTypes) parts.push(line(edgeColor(t), t));
    if (types.length + edgeTypes.length === 0) parts.push(`<span class="lg-hint">untyped nodes/edges</span>`);
  } else if (layer.kind === "table") {
    parts.push(`<span class="lg-hint">${layer.rows.length} rows × ${layer.columns.length} cols</span>`);
  }
  return parts.join("");
}

/** Static legend explaining the layer-kind colours used in the lineage/list. */
export function kindLegendHtml(): string {
  return (Object.keys(KIND_COLORS) as Array<keyof typeof KIND_COLORS>)
    .map((k) => dot(KIND_COLORS[k], k))
    .join("");
}
