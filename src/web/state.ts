import type { GraphNode, Layer } from "../shared/layer.js";

export type ViewMode = "primary" | "projection";

/** Client-side mirror of the session's layers plus current selection. */
export class AppState {
  readonly layers = new Map<string, Layer>();
  selectedLayerId: string | null = null;
  viewMode: ViewMode = "primary";

  upsert(layer: Layer): void {
    this.layers.set(layer.id, layer);
  }

  remove(id: string): void {
    this.layers.delete(id);
    if (this.selectedLayerId === id) this.selectedLayerId = null;
  }

  ordered(): Layer[] {
    return [...this.layers.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  selected(): Layer | null {
    return this.selectedLayerId ? this.layers.get(this.selectedLayerId) ?? null : null;
  }

  /** Every layer id (of any kind) whose graph contains a node with this id. */
  layersContainingNode(nodeId: string): Layer[] {
    const out: Layer[] = [];
    for (const layer of this.layers.values()) {
      if (layer.kind === "graph" && layer.nodes.some((n) => n.id === nodeId)) out.push(layer);
    }
    return out;
  }

  /** Look up a node by id across the given layer ids (used to resolve the
   *  parent-side of a projection mapping). Returns the first graph node found. */
  findNode(nodeId: string, inLayerIds: string[]): GraphNode | undefined {
    for (const id of inLayerIds) {
      const layer = this.layers.get(id);
      if (layer?.kind === "graph") {
        const hit = layer.nodes.find((n) => n.id === nodeId);
        if (hit) return hit;
      }
    }
    return undefined;
  }

  /** True when a layer has something meaningful to show in the projection view:
   *  explicit node-level mappings, or shared node ids with a parent graph. */
  hasProjection(layer: Layer): boolean {
    if (layer.mappings && layer.mappings.length > 0) return true;
    if (layer.kind !== "graph" || layer.derivedFrom.length === 0) return false;
    const ids = new Set(layer.nodes.map((n) => n.id));
    return layer.derivedFrom.some((pid) => {
      const parent = this.layers.get(pid);
      return parent?.kind === "graph" && parent.nodes.some((n) => ids.has(n.id));
    });
  }
}
