import type { EdgeOrigin, Layer } from "../shared/layer.js";
import type { AppState } from "./state.js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

/** How to navigate away from the inspector — to a layer, optionally focusing a
 *  node, with a breadcrumb `via` label. */
export type NavigateFn = (layerId: string, opts?: { nodeId?: string | null; via?: string }) => void;

const ORIGIN_LABEL: Record<EdgeOrigin, string> = {
  mechanical: "computed",
  llm: "LLM-inferred",
  manual: "manual",
};

function originBadge(origin: EdgeOrigin | undefined): string {
  const o = origin ?? "mechanical";
  if (o === "mechanical") return "";
  return ` <span class="origin-badge origin-${o}">${ORIGIN_LABEL[o]}</span>`;
}

/**
 * Renders the right pane: the selected layer's narration + metadata, and — when
 * a node is selected — that node's props, its citation traceback (for
 * requirements), the source/evidence behind it, which *other* layers contain
 * the same node id (navigable), and the mappings touching it. Every cross-layer
 * jump goes through `navigate` so it lands on the breadcrumb trail.
 */
export function renderInspector(
  el: HTMLElement,
  state: AppState,
  layer: Layer,
  selectedNodeId: string | null,
  navigate: NavigateFn,
): void {
  const parts: string[] = [];

  parts.push(`<h3>${escapeHtml(layer.name)} <span class="kind-badge kind-${layer.kind}">${layer.kind}</span></h3>`);
  if (layer.narration) parts.push(`<div class="narration">${escapeHtml(layer.narration)}</div>`);

  const meta: string[] = [];
  meta.push(`<span class="k">id</span><span class="v">${escapeHtml(layer.id)}</span>`);
  if (layer.derivedFrom.length) {
    // Layer-level traceback: which layers this one was derived from. Clickable
    // so "this requirement layer came from flow-tree + data-access" is walkable.
    const chips = layer.derivedFrom
      .map((p) => `<span class="chip" data-layer="${escapeHtml(p)}" data-via="derived from">${escapeHtml(p)}</span>`)
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

  const selectedNode =
    selectedNodeId && layer.kind === "graph" ? layer.nodes.find((n) => n.id === selectedNodeId) : undefined;

  // Node detail comes *before* the layer-wide mappings list so a selected node's
  // evidence/source is never buried under a long projection table.
  {
    const node = selectedNode;
    if (node) {
      parts.push(`<h3>Node</h3>`);
      const nodeMeta: string[] = [
        `<span class="k">id</span><span class="v">${escapeHtml(node.id)}</span>`,
        `<span class="k">label</span><span class="v">${escapeHtml(node.label)}</span>`,
      ];
      if (node.type) nodeMeta.push(`<span class="k">type</span><span class="v">${escapeHtml(node.type)}</span>`);
      // Keys rendered as their own blocks (code / badges / links), not inline rows.
      const blockKeys = new Set(["source", "detail", "requirement", "status", "gate", "note", "cites"]);
      for (const [k, v] of Object.entries(node.props ?? {})) {
        if (blockKeys.has(k)) continue;
        nodeMeta.push(`<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span>`);
      }
      parts.push(`<div class="kv">${nodeMeta.join("")}</div>`);

      const props = (node.props ?? {}) as Record<string, unknown>;
      const status = props.status ? String(props.status) : "";
      if (status) {
        const cls = `st-${status.toLowerCase()}`;
        parts.push(`<div class="status-line"><span class="status-badge ${cls}">${escapeHtml(status)}</span>${
          props.gate ? `<span class="gate">${escapeHtml(String(props.gate))}</span>` : ""
        }</div>`);
      }
      if (props.note) parts.push(`<div class="callout">${escapeHtml(String(props.note))}</div>`);
      if (props.requirement) parts.push(`<blockquote class="req-text">${escapeHtml(String(props.requirement))}</blockquote>`);

      // Citation traceback: a requirement cites fact ids that live in *this*
      // layer as their own nodes. Render them as clickable chips so
      // requirement → fact → its source/originating-layer is an explicit,
      // navigable thread (with breadcrumb + back), not just prose.
      if (props.cites && layer.kind === "graph") {
        const factIds = String(props.cites)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (factIds.length) {
          const nodeIds = new Set(layer.nodes.map((n) => n.id));
          const chips = factIds
            .map((fid) => {
              const known = nodeIds.has(fid);
              const cls = known ? "chip fact" : "chip fact missing";
              const attrs = known ? ` data-node="${escapeHtml(fid)}" data-via="cites"` : "";
              const title = known ? "open this fact" : "cited fact not found (unsupported)";
              return `<span class="${cls}"${attrs} title="${title}">${escapeHtml(fid)}</span>`;
            })
            .join("");
          parts.push(`<h3>Cites (traceback)</h3><div class="chips">${chips}</div>`);
        }
      }

      if (props.detail) parts.push(`<h3>Evidence</h3><pre class="code">${escapeHtml(String(props.detail))}</pre>`);
      if (props.source) {
        const loc = props.loc ? `<span class="loc">${escapeHtml(String(props.loc))}</span>` : "";
        parts.push(`<h3>Source ${loc}</h3><pre class="code src">${escapeHtml(String(props.source))}</pre>`);
      }

      // Cross-layer traceback: the same node id appearing in other layers is how
      // a fact links back to the layer it originated in.
      const others = state.layersContainingNode(node.id).filter((l) => l.id !== layer.id);
      if (others.length) {
        const chips = others
          .map(
            (l) =>
              `<span class="chip" data-layer="${escapeHtml(l.id)}" data-node="${escapeHtml(node.id)}" data-via="same node">${escapeHtml(l.name)}</span>`,
          )
          .join("");
        parts.push(`<h3>Also appears in</h3><div class="chips">${chips}</div>`);
      }
    }
  }

  const allMappings = layer.mappings ?? [];
  // With a node selected, show only the mappings that touch it (its lineage in
  // and out); otherwise the whole layer's mapping table.
  const shown = selectedNode
    ? allMappings.filter((m) => m.from === selectedNode.id || m.to === selectedNode.id)
    : allMappings;
  if (shown.length) {
    const title = selectedNode ? `Mappings for ${escapeHtml(selectedNode.label)} (${shown.length})` : `Mappings (${allMappings.length})`;
    parts.push(`<h3>${title}</h3>`);
    const rows = shown
      .slice(0, 50)
      .map(
        (m) =>
          `<div class="hint"><code>${escapeHtml(m.from)}</code> → <code>${escapeHtml(m.to)}</code>${originBadge(m.origin)}${
            m.evidence ? ` — ${escapeHtml(m.evidence)}` : ""
          }</div>`,
      )
      .join("");
    parts.push(rows);
  }

  el.innerHTML = parts.join("");
  // A chip either selects a node in the current layer (data-node only) or jumps
  // to another layer (optionally focusing a node) — always via the breadcrumb.
  el.querySelectorAll<HTMLElement>(".chip[data-layer], .chip[data-node]").forEach((chip) => {
    if (chip.classList.contains("missing")) return;
    chip.addEventListener("click", () => {
      const targetLayer = chip.dataset.layer ?? layer.id;
      const nodeId = chip.dataset.node ?? null;
      navigate(targetLayer, { nodeId, via: chip.dataset.via ?? "select" });
    });
  });
}
