/**
 * The joerny layer schema — the contract between a Joern analysis script
 * (via joerny.sc) and the joerny viewer. One emitted layer = one JSON file
 * in `.joerny/<session>/layers/`.
 *
 * This module is shared verbatim by the server and the browser frontend, so it
 * must stay dependency-free and DOM-free.
 */

export type LayerKind = "graph" | "table" | "note";

export interface GraphNode {
  /** Stable, meaningful id (prefer method fullName etc.) so the same entity
   *  merges across layers. */
  id: string;
  label: string;
  /** Free-form category used for styling/legend, e.g. "method", "table". */
  type?: string;
  props?: Record<string, unknown>;
}

export interface GraphEdge {
  src: string;
  dst: string;
  type?: string;
  props?: Record<string, unknown>;
}

/** Node-level projection: how an item in a parent layer maps into this one. */
export interface NodeMapping {
  /** Node id in a `derivedFrom` parent layer. */
  from: string;
  /** Node id in this layer. */
  to: string;
  note?: string;
}

export interface LayerBase {
  /** Stable id per emit; re-emitting the same id replaces the layer. */
  id: string;
  name: string;
  kind: LayerKind;
  /** Parent layer ids — forms the lineage DAG. Empty for roots. */
  derivedFrom: string[];
  /** Short agent-authored "what/why" for this layer. */
  narration?: string;
  createdAt: string;
  /** Optional node-level mappings to a parent layer. */
  mappings?: NodeMapping[];
}

export interface GraphLayer extends LayerBase {
  kind: "graph";
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface TableLayer extends LayerBase {
  kind: "table";
  columns: string[];
  rows: unknown[][];
}

export interface NoteLayer extends LayerBase {
  kind: "note";
  markdown: string;
}

export type Layer = GraphLayer | TableLayer | NoteLayer;

/** WebSocket protocol: server -> browser. */
export type ServerMessage =
  | { type: "hello"; session: string; layers: Layer[] }
  | { type: "layer-upserted"; layer: Layer }
  | { type: "layer-removed"; id: string };

/** WebSocket protocol: browser -> server (feedback hook, stubbed for MVP). */
export type ClientMessage = {
  type: "select";
  layerId: string;
  nodeId?: string;
};
