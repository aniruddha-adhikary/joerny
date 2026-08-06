import type { GraphEdge, GraphNode, Layer, LayerKind } from "./layer.js";

export interface ValidationResult {
  ok: boolean;
  layer?: Layer;
  errors: string[];
}

const KINDS: LayerKind[] = ["graph", "table", "note"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Validate a parsed JSON value against the layer schema. Returns a normalized
 * layer (with defaults filled in) on success, or a list of human-readable
 * errors. Deliberately lenient about extra fields so scripts can attach props.
 */
export function validateLayer(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(raw)) {
    return { ok: false, errors: ["layer must be a JSON object"] };
  }

  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) errors.push("`id` must be a non-empty string");

  const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : (typeof id === "string" ? id : "");
  if (!name) errors.push("`name` (or a usable `id`) is required");

  const kind = raw.kind;
  if (typeof kind !== "string" || !KINDS.includes(kind as LayerKind)) {
    errors.push(`\`kind\` must be one of ${KINDS.join(", ")}`);
  }

  const derivedFrom = raw.derivedFrom === undefined ? [] : raw.derivedFrom;
  if (!isStringArray(derivedFrom)) errors.push("`derivedFrom` must be an array of strings");

  const narration = raw.narration === undefined ? undefined : String(raw.narration);
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();

  let mappings: Layer["mappings"];
  if (raw.mappings !== undefined) {
    if (!Array.isArray(raw.mappings)) {
      errors.push("`mappings` must be an array");
    } else {
      mappings = [];
      for (const m of raw.mappings) {
        if (isObject(m) && typeof m.from === "string" && typeof m.to === "string") {
          mappings.push({ from: m.from, to: m.to, evidence: m.evidence === undefined ? undefined : String(m.evidence) });
        } else {
          errors.push("each mapping needs string `from` and `to`");
        }
      }
    }
  }

  // Kind-specific payload.
  if (kind === "graph") {
    if (!Array.isArray(raw.nodes)) errors.push("graph layer requires `nodes` array");
    if (raw.edges !== undefined && !Array.isArray(raw.edges)) errors.push("`edges` must be an array");
    if (Array.isArray(raw.nodes)) {
      for (const n of raw.nodes) {
        if (!isObject(n) || typeof n.id !== "string") {
          errors.push("each graph node needs a string `id`");
          break;
        }
      }
    }
    if (Array.isArray(raw.edges)) {
      for (const e of raw.edges) {
        if (!isObject(e) || typeof e.src !== "string" || typeof e.dst !== "string") {
          errors.push("each edge needs string `src` and `dst`");
          break;
        }
      }
    }
  } else if (kind === "table") {
    if (!isStringArray(raw.columns)) errors.push("table layer requires `columns` (string array)");
    if (!Array.isArray(raw.rows) || !raw.rows.every((r) => Array.isArray(r))) {
      errors.push("table layer requires `rows` (array of arrays)");
    }
  } else if (kind === "note") {
    if (typeof raw.markdown !== "string") errors.push("note layer requires `markdown` string");
  }

  if (errors.length > 0) return { ok: false, errors };

  const base = {
    id: id as string,
    name,
    derivedFrom: derivedFrom as string[],
    narration,
    createdAt,
    mappings,
  };

  let layer: Layer;
  if (kind === "graph") {
    layer = {
      ...base,
      kind: "graph",
      nodes: normalizeNodes(raw.nodes as unknown[]),
      edges: normalizeEdges((raw.edges as unknown[]) ?? []),
    };
  } else if (kind === "table") {
    layer = { ...base, kind: "table", columns: raw.columns as string[], rows: raw.rows as unknown[][] };
  } else {
    layer = { ...base, kind: "note", markdown: raw.markdown as string };
  }

  return { ok: true, layer, errors: [] };
}

function normalizeNodes(nodes: unknown[]): GraphNode[] {
  return nodes.map((n) => {
    const o = n as Record<string, unknown>;
    return {
      id: o.id as string,
      label: typeof o.label === "string" ? o.label : (o.id as string),
      type: typeof o.type === "string" ? o.type : undefined,
      props: isObject(o.props) ? o.props : undefined,
    };
  });
}

function normalizeEdges(edges: unknown[]): GraphEdge[] {
  return edges.map((e) => {
    const o = e as Record<string, unknown>;
    return {
      src: o.src as string,
      dst: o.dst as string,
      type: typeof o.type === "string" ? o.type : undefined,
      props: isObject(o.props) ? o.props : undefined,
    };
  });
}
