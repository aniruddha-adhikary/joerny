// Shared colour vocabulary so the on-screen legend matches what the graph draws.

// Semantic edge colours by relationship kind. Anything unlisted uses the default.
export const EDGE_COLORS: Record<string, string> = {
  read: "#7ed6a5",
  write: "#e0879a",
  calls: "#3a4252",
  then: "#6ea8fe",
  uses: "#63cbd0",
};
export const EDGE_DEFAULT = "#3a4252";

// Palette assigned to node *types* in a stable order.
export const TYPE_COLORS = ["#6ea8fe", "#7ed6a5", "#e0b978", "#c88ffb", "#f28ca4", "#63cbd0", "#b0bac9"];

// Layer-kind colours (mirror the CSS custom properties).
export const KIND_COLORS: Record<string, string> = {
  graph: "#6ea8fe",
  table: "#7ed6a5",
  note: "#e0b978",
};

/**
 * Deterministically map node types → colours. Sorting the distinct types first
 * means the same type gets the same colour in the graph and in the legend,
 * regardless of node insertion order.
 */
export function buildTypePalette(types: Array<string | undefined>): Map<string, string> {
  const distinct = Array.from(new Set(types.map((t) => t ?? ""))).sort();
  const palette = new Map<string, string>();
  distinct.forEach((t, i) => palette.set(t, TYPE_COLORS[i % TYPE_COLORS.length]));
  return palette;
}

export function edgeColor(type: string | undefined): string {
  return EDGE_COLORS[type ?? ""] ?? EDGE_DEFAULT;
}
