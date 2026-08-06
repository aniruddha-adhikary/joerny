import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { validateLayer } from "../shared/validate.js";
import type { LayerStore } from "./store.js";

function isLayerFile(p: string): boolean {
  const name = basename(p);
  // Skip dotfiles (incl. the `.<name>.json.tmp` writes joerny.sc makes before
  // its atomic rename). Match on basename only — the layers dir itself lives
  // under `.joerny/`, so a path-based dot check would ignore everything.
  return !name.startsWith(".") && name.endsWith(".json");
}

/**
 * Watches the session's `layers/` directory and feeds validated `*.json` layers
 * into the store.
 */
export function watchLayers(layersDir: string, store: LayerStore): FSWatcher {
  const watcher = chokidar.watch(layersDir, {
    depth: 0,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
  });

  const ingest = async (abs: string): Promise<void> => {
    if (!isLayerFile(abs)) return;
    try {
      const text = await readFile(abs, "utf8");
      const parsed = JSON.parse(text);
      const result = validateLayer(parsed);
      if (result.ok && result.layer) {
        store.upsertFromFile(abs, result.layer);
      } else {
        console.warn(`[joerny] ignoring invalid layer ${basename(abs)}: ${result.errors.join("; ")}`);
      }
    } catch (err) {
      console.warn(`[joerny] failed to read layer ${basename(abs)}: ${(err as Error).message}`);
    }
  };

  watcher
    .on("add", ingest)
    .on("change", ingest)
    .on("unlink", (abs) => {
      if (isLayerFile(abs)) store.removeByFile(abs);
    });

  return watcher;
}
