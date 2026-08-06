import type { GraphNode, Layer } from "../shared/layer.js";

export type ViewMode = "primary" | "projection";

/** One stop on the navigation trail — a layer, an optional selected node within
 *  it, the view mode, and the `via` label describing how we got here (e.g.
 *  "projection", "cites", "derived from"). Powers back/forward + the breadcrumb
 *  so drilling across layers never silently loses where you came from. */
export interface NavEntry {
  layerId: string;
  nodeId: string | null;
  viewMode: ViewMode;
  /** How this step was reached from the previous one (breadcrumb connector). */
  via: string;
}

/** Client-side mirror of the session's layers plus current selection and the
 *  navigation history (a browser-style back/forward stack with a breadcrumb). */
export class AppState {
  readonly layers = new Map<string, Layer>();
  viewMode: ViewMode = "primary";
  selectedNodeId: string | null = null;

  /** Linear visit history; `histIndex` is the current position within it. */
  history: NavEntry[] = [];
  histIndex = -1;

  get selectedLayerId(): string | null {
    return this.histIndex >= 0 ? this.history[this.histIndex].layerId : null;
  }

  /** Navigate to a layer (optionally focusing a node / view), pushing a new
   *  history entry and discarding any forward entries — exactly like a browser.
   *  Consecutive navigations to the identical spot are collapsed. */
  navigate(
    layerId: string,
    opts: { nodeId?: string | null; viewMode?: ViewMode; via?: string; replace?: boolean } = {},
  ): void {
    const nodeId = opts.nodeId ?? null;
    const viewMode = opts.viewMode ?? "primary";
    const via = opts.via ?? "select";
    const cur = this.current();
    if (cur && cur.layerId === layerId && cur.nodeId === nodeId && cur.viewMode === viewMode) {
      this.selectedNodeId = nodeId;
      this.viewMode = viewMode;
      return;
    }
    // Replace the current stop instead of pushing (used when auto-following live
    // emissions so a burst of new layers collapses into a single "latest" crumb
    // rather than spamming the trail).
    if (opts.replace && this.histIndex >= 0) {
      this.history = this.history.slice(0, this.histIndex + 1);
      this.history[this.histIndex] = { layerId, nodeId, viewMode, via };
      this.applyCurrent();
      return;
    }
    this.history = this.history.slice(0, this.histIndex + 1);
    this.history.push({ layerId, nodeId, viewMode, via });
    this.histIndex = this.history.length - 1;
    this.applyCurrent();
  }

  /** Move the selected node / view within the current layer without adding a
   *  history stop (node clicks within one layer shouldn't spam the trail — they
   *  update the current entry in place). */
  focusNode(nodeId: string | null): void {
    this.selectedNodeId = nodeId;
    if (this.histIndex >= 0) this.history[this.histIndex].nodeId = nodeId;
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    if (this.histIndex >= 0) this.history[this.histIndex].viewMode = mode;
  }

  current(): NavEntry | null {
    return this.histIndex >= 0 ? this.history[this.histIndex] : null;
  }

  canBack(): boolean {
    return this.histIndex > 0;
  }
  canForward(): boolean {
    return this.histIndex < this.history.length - 1;
  }
  back(): void {
    if (this.canBack()) {
      this.histIndex -= 1;
      this.applyCurrent();
    }
  }
  forward(): void {
    if (this.canForward()) {
      this.histIndex += 1;
      this.applyCurrent();
    }
  }
  /** Jump straight to a breadcrumb entry by its history index. */
  jumpTo(index: number): void {
    if (index >= 0 && index < this.history.length) {
      this.histIndex = index;
      this.applyCurrent();
    }
  }

  private applyCurrent(): void {
    const e = this.current();
    this.selectedNodeId = e ? e.nodeId : null;
    this.viewMode = e ? e.viewMode : "primary";
  }

  upsert(layer: Layer): void {
    this.layers.set(layer.id, layer);
  }

  remove(id: string): void {
    this.layers.delete(id);
    // Drop any history stops that referenced the removed layer.
    const kept = this.history.filter((h) => h.layerId !== id);
    if (kept.length !== this.history.length) {
      this.history = kept;
      this.histIndex = Math.min(this.histIndex, this.history.length - 1);
      this.applyCurrent();
    }
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
