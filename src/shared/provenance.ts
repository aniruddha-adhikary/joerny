import type { EdgeOrigin, Layer } from "./layer.js";

/** A tally of connections (graph edges + node mappings) by how they came to
 *  exist. This is the anti-hallucination lens: `mechanical` links trace back to
 *  the CPG / a deterministic rule, while `llm` / `manual` links were asserted by
 *  a model or a human and are not ground truth. Absent origin = mechanical. */
export interface OriginTally {
  mechanical: number;
  llm: number;
  manual: number;
}

export function emptyTally(): OriginTally {
  return { mechanical: 0, llm: 0, manual: 0 };
}

function bump(t: OriginTally, origin: EdgeOrigin | undefined): void {
  t[origin ?? "mechanical"] += 1;
}

/** Count the connections a single layer introduces, by origin. */
export function layerOriginTally(layer: Layer): OriginTally {
  const t = emptyTally();
  if (layer.kind === "graph") for (const e of layer.edges) bump(t, e.origin);
  for (const m of layer.mappings ?? []) bump(t, m.origin);
  return t;
}

/** Sum tallies across layers (e.g. everything revealed up to the cursor). */
export function sumTallies(layers: Layer[]): OriginTally {
  const t = emptyTally();
  for (const l of layers) {
    const lt = layerOriginTally(l);
    t.mechanical += lt.mechanical;
    t.llm += lt.llm;
    t.manual += lt.manual;
  }
  return t;
}

/** True when a layer introduces any artificial (llm/manual) connection — i.e.
 *  this emit added something that is not ground truth from the CPG. */
export function hasArtificial(layer: Layer): boolean {
  const t = layerOriginTally(layer);
  return t.llm > 0 || t.manual > 0;
}

export function artificialCount(t: OriginTally): number {
  return t.llm + t.manual;
}
