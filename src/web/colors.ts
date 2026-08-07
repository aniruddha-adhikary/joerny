// Shared colour vocabulary so the on-screen legend matches what the graph draws.

// Semantic edge colours by relationship kind. Anything unlisted uses the default.
export const EDGE_COLORS: Record<string, string> = {
  read: "#7ed6a5",
  write: "#e0879a",
  calls: "#3a4252",
  then: "#6ea8fe",
  uses: "#63cbd0",
  cites: "#c88ffb",
};
export const EDGE_DEFAULT = "#3a4252";

// Palette assigned to node *types* in a stable order.
export const TYPE_COLORS = ["#6ea8fe", "#7ed6a5", "#e0b978", "#c88ffb", "#f28ca4", "#63cbd0", "#b0bac9"];

// Semantic node-type colours that carry meaning (status, roles) — these override
// the rotating palette so e.g. an UNSUPPORTED requirement is always red, a gap
// always orange, regardless of how many other types share the graph.
export const SEMANTIC_TYPE_COLORS: Record<string, string> = {
  requirement: "#7ed6a5", // supported (green)
  "req-unverified": "#e0b978", // amber
  "req-unsupported": "#f0616d", // red
  "fact-flow": "#6ea8fe",
  "fact-table": "#63cbd0",
  "fact-capability": "#c88ffb",
  covered: "#7ed6a5",
  gap: "#e0955a",
};

// Flowchart node-shape colours (algorithm view). A decision (guard) is amber, a
// process (data op) blue, an io side-effect green, a terminal grey — so the
// control-flow reads at a glance without reading every label.
export const FLOW_SHAPE_COLORS: Record<string, string> = {
  decision: "#e0b978",
  process: "#6ea8fe",
  io: "#7ed6a5",
  terminal: "#8b93a7",
};

// Flowchart branch-edge colours: a `yes` path is green, a `no` red, a loop
// purple, so which way control flows is legible at a glance.
export const FLOW_BRANCH_COLORS: Record<string, string> = {
  yes: "#7ed6a5",
  no: "#f0616d",
  loop: "#c88ffb",
  exit: "#8b93a7",
  "on error": "#e0955a",
};

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
  // Types without a semantic colour rotate through TYPE_COLORS; semantic ones
  // keep their fixed meaning-bearing colour.
  let i = 0;
  for (const t of distinct) {
    const semantic = SEMANTIC_TYPE_COLORS[t];
    if (semantic) {
      palette.set(t, semantic);
    } else {
      palette.set(t, TYPE_COLORS[i % TYPE_COLORS.length]);
      i += 1;
    }
  }
  return palette;
}

export function edgeColor(type: string | undefined): string {
  return EDGE_COLORS[type ?? ""] ?? EDGE_DEFAULT;
}
