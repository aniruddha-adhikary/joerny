import { EventEmitter } from "node:events";
import type { Layer } from "../shared/layer.js";

export interface StoreEvents {
  upserted: (layer: Layer) => void;
  removed: (id: string) => void;
}

/**
 * In-memory record of the current session's layers, keyed by id. The watcher
 * feeds it validated layers; the WebSocket server subscribes to its events and
 * broadcasts diffs to connected browsers.
 */
export class LayerStore extends EventEmitter {
  private layers = new Map<string, Layer>();
  /** Tracks which file produced which layer id, so a deleted file removes the
   *  right layer even though ids are derived from file contents. */
  private fileToId = new Map<string, string>();

  upsertFromFile(file: string, layer: Layer): void {
    const previousId = this.fileToId.get(file);
    if (previousId && previousId !== layer.id) {
      // The file's layer id changed; drop the stale entry.
      this.layers.delete(previousId);
      this.emit("removed", previousId);
    }
    this.fileToId.set(file, layer.id);
    this.layers.set(layer.id, layer);
    this.emit("upserted", layer);
  }

  removeByFile(file: string): void {
    const id = this.fileToId.get(file);
    if (!id) return;
    this.fileToId.delete(file);
    this.layers.delete(id);
    this.emit("removed", id);
  }

  all(): Layer[] {
    return [...this.layers.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
