import type { Layer } from "../shared/layer.js";

/** Client-side mirror of the session's layers plus current selection. */
export class AppState {
  readonly layers = new Map<string, Layer>();
  selectedLayerId: string | null = null;

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
}
