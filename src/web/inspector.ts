import type { Layer } from "../shared/layer.js";
import type { AppState } from "./state.js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

/**
 * Renders the right pane: the selected layer's narration + metadata, and — when
 * a node is selected — that node's props plus which *other* layers contain the
 * same node id (the cross-layer merge view) and any projection mappings.
 */
export function renderInspector(
  el: HTMLElement,
  state: AppState,
  layer: Layer,
  selectedNodeId: string | null,
  onSelectLayer: (id: string) => void,
): void {
  const parts: string[] = [];

  parts.push(`<h3>${escapeHtml(layer.name)} <span class="kind-badge kind-${layer.kind}">${layer.kind}</span></h3>`);
  if (layer.narration) parts.push(`<div class="narration">${escapeHtml(layer.narration)}</div>`);

  const meta: string[] = [];
  meta.push(`<span class="k">id</span><span class="v">${escapeHtml(layer.id)}</span>`);
  if (layer.derivedFrom.length) {
    const chips = layer.derivedFrom
      .map((p) => `<span class="chip" data-layer="${escapeHtml(p)}">${escapeHtml(p)}</span>`)
      .join("");
    meta.push(`<span class="k">derived from</span><span class="v"><div class="chips">${chips}</div></span>`);
  }
  if (layer.kind === "graph") {
    meta.push(`<span class="k">nodes</span><span class="v">${layer.nodes.length}</span>`);
    meta.push(`<span class="k">edges</span><span class="v">${layer.edges.length}</span>`);
  } else if (layer.kind === "table") {
    meta.push(`<span class="k">rows</span><span class="v">${layer.rows.length}</span>`);
  }
  meta.push(`<span class="k">created</span><span class="v">${escapeHtml(layer.createdAt)}</span>`);
  parts.push(`<div class="kv">${meta.join("")}</div>`);

  if (layer.mappings && layer.mappings.length) {
    parts.push(`<h3>Projections (${layer.mappings.length})</h3>`);
    const rows = layer.mappings
      .slice(0, 50)
      .map(
        (m) =>
          `<div class="hint"><code>${escapeHtml(m.from)}</code> → <code>${escapeHtml(m.to)}</code>${
            m.note ? ` — ${escapeHtml(m.note)}` : ""
          }</div>`,
      )
      .join("");
    parts.push(rows);
  }

  if (selectedNodeId && layer.kind === "graph") {
    const node = layer.nodes.find((n) => n.id === selectedNodeId);
    if (node) {
      parts.push(`<h3>Node</h3>`);
      const nodeMeta: string[] = [
        `<span class="k">id</span><span class="v">${escapeHtml(node.id)}</span>`,
        `<span class="k">label</span><span class="v">${escapeHtml(node.label)}</span>`,
      ];
      if (node.type) nodeMeta.push(`<span class="k">type</span><span class="v">${escapeHtml(node.type)}</span>`);
      for (const [k, v] of Object.entries(node.props ?? {})) {
        nodeMeta.push(`<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span>`);
      }
      parts.push(`<div class="kv">${nodeMeta.join("")}</div>`);

      const others = state.layersContainingNode(node.id).filter((l) => l.id !== layer.id);
      if (others.length) {
        const chips = others
          .map((l) => `<span class="chip" data-layer="${escapeHtml(l.id)}">${escapeHtml(l.name)}</span>`)
          .join("");
        parts.push(`<h3>Also appears in</h3><div class="chips">${chips}</div>`);
      }
    }
  }

  el.innerHTML = parts.join("");
  el.querySelectorAll<HTMLElement>(".chip[data-layer]").forEach((chip) => {
    chip.addEventListener("click", () => onSelectLayer(chip.dataset.layer as string));
  });
}
