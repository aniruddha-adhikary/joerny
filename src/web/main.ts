import { marked } from "marked";
import type { ServerMessage } from "../shared/layer.js";
import { AppState } from "./state.js";
import { renderGraph, type GraphViewHandle } from "./graphView.js";
import { renderProjection, type ProjectionHandle } from "./projectionView.js";
import { renderLineage } from "./lineage.js";
import { renderInspector } from "./inspector.js";
import { legendHtml, kindLegendHtml } from "./legend.js";

const state = new AppState();
let graphHandle: GraphViewHandle | null = null;
let projectionHandle: ProjectionHandle | null = null;

const el = {
  status: document.getElementById("status") as HTMLElement,
  statusText: document.getElementById("statusText") as HTMLElement,
  sessionLabel: document.getElementById("sessionLabel") as HTMLElement,
  lineage: document.getElementById("lineage") as HTMLElement,
  layerList: document.getElementById("layerList") as HTMLElement,
  centerEmpty: document.getElementById("centerEmpty") as HTMLElement,
  cy: document.getElementById("cy") as HTMLElement,
  tableWrap: document.getElementById("tableWrap") as HTMLElement,
  noteWrap: document.getElementById("noteWrap") as HTMLElement,
  rightEmpty: document.getElementById("rightEmpty") as HTMLElement,
  inspector: document.getElementById("inspector") as HTMLElement,
  toolbar: document.getElementById("centerToolbar") as HTMLElement,
  tabPrimary: document.getElementById("tabPrimary") as HTMLElement,
  tabProjection: document.getElementById("tabProjection") as HTMLElement,
  projection: document.getElementById("projection") as HTMLElement,
  legend: document.getElementById("legend") as HTMLElement,
  kindLegend: document.getElementById("kindLegend") as HTMLElement,
  nav: document.getElementById("navbar") as HTMLElement,
  navBack: document.getElementById("navBack") as HTMLButtonElement,
  navForward: document.getElementById("navForward") as HTMLButtonElement,
  breadcrumb: document.getElementById("breadcrumb") as HTMLElement,
};

el.kindLegend.innerHTML = kindLegendHtml();

el.tabPrimary.addEventListener("click", () => setViewMode("primary"));
el.tabProjection.addEventListener("click", () => {
  if (el.tabProjection.hasAttribute("disabled")) return;
  setViewMode("projection");
});

el.navBack.addEventListener("click", () => {
  state.back();
  renderAll();
});
el.navForward.addEventListener("click", () => {
  state.forward();
  renderAll();
});
// Browser-style keyboard nav (Alt+←/→) so back/forward feels native.
window.addEventListener("keydown", (ev) => {
  if (ev.altKey && ev.key === "ArrowLeft") {
    ev.preventDefault();
    state.back();
    renderAll();
  } else if (ev.altKey && ev.key === "ArrowRight") {
    ev.preventDefault();
    state.forward();
    renderAll();
  }
});

function setViewMode(mode: "primary" | "projection"): void {
  state.setViewMode(mode);
  renderNav();
  renderCenter();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

/** Every layer/node navigation goes through here so it lands on the history
 *  trail and the breadcrumb + back/forward stay in sync. */
function go(layerId: string, opts: { nodeId?: string | null; viewMode?: "primary" | "projection"; via?: string } = {}): void {
  state.navigate(layerId, opts);
  renderAll();
}

function renderLayerList(): void {
  const layers = state.ordered();
  el.layerList.innerHTML = "";
  for (const layer of layers) {
    const item = document.createElement("div");
    item.className = "layer-item" + (layer.id === state.selectedLayerId ? " selected" : "");
    item.innerHTML = `<span class="kind-badge kind-${layer.kind}">${layer.kind[0]}</span><span class="name">${escapeHtml(
      layer.name,
    )}</span>`;
    item.addEventListener("click", () => go(layer.id, { via: "layer list" }));
    el.layerList.appendChild(item);
  }
}

/** The back/forward controls + the breadcrumb trail of where you've been, so a
 *  drill into a projection/other layer keeps its context and is one click to undo. */
function renderNav(): void {
  el.navBack.disabled = !state.canBack();
  el.navForward.disabled = !state.canForward();

  if (state.histIndex < 0) {
    el.breadcrumb.innerHTML = `<span class="crumb-hint">nothing selected</span>`;
    return;
  }
  const crumbs: string[] = [];
  for (let i = 0; i <= state.histIndex; i += 1) {
    const e = state.history[i];
    const layer = state.layers.get(e.layerId);
    if (!layer) continue;
    let label = layer.name;
    if (e.nodeId && layer.kind === "graph") {
      const node = layer.nodes.find((n) => n.id === e.nodeId);
      if (node) label += ` › ${node.label}`;
    }
    if (e.viewMode === "projection") label += ` (projection)`;
    if (i > 0) crumbs.push(`<span class="crumb-via">${escapeHtml(state.history[i].via)}</span>`);
    const cls = i === state.histIndex ? "crumb current" : "crumb";
    crumbs.push(`<button class="${cls}" data-idx="${i}" title="${escapeHtml(label)}">${escapeHtml(label)}</button>`);
  }
  el.breadcrumb.innerHTML = crumbs.join("");
  el.breadcrumb.querySelectorAll<HTMLElement>(".crumb[data-idx]").forEach((c) => {
    c.addEventListener("click", () => {
      state.jumpTo(Number(c.dataset.idx));
      renderAll();
    });
  });
}

function showCenter(which: "empty" | "cy" | "table" | "note" | "projection"): void {
  el.centerEmpty.style.display = which === "empty" ? "flex" : "none";
  el.cy.style.display = which === "cy" ? "block" : "none";
  el.projection.style.display = which === "projection" ? "block" : "none";
  el.tableWrap.style.display = which === "table" ? "block" : "none";
  el.noteWrap.style.display = which === "note" ? "block" : "none";
}

function renderCenter(): void {
  if (graphHandle) {
    graphHandle.destroy();
    graphHandle = null;
  }
  if (projectionHandle) {
    projectionHandle.destroy();
    projectionHandle = null;
  }
  const layer = state.selected();
  if (!layer) {
    el.toolbar.style.display = "none";
    showCenter("empty");
    return;
  }

  const hasProj = state.hasProjection(layer);
  if (!hasProj && state.viewMode === "projection") state.viewMode = "primary";
  el.toolbar.style.display = "flex";
  el.tabPrimary.textContent = layer.kind === "graph" ? "Graph" : layer.kind === "table" ? "Table" : "Note";
  el.tabPrimary.classList.toggle("active", state.viewMode === "primary");
  el.tabProjection.classList.toggle("active", state.viewMode === "projection");
  el.legend.innerHTML = legendHtml(layer, state.viewMode);
  if (hasProj) el.tabProjection.removeAttribute("disabled");
  else el.tabProjection.setAttribute("disabled", "");

  if (state.viewMode === "projection" && hasProj) {
    showCenter("projection");
    projectionHandle = renderProjection(el.projection, state, layer, (nodeId) => {
      state.focusNode(nodeId);
      renderRight();
      renderNav();
      if (projectionHandle) {
        projectionHandle.cy.$(".highlight").removeClass("highlight");
        if (nodeId) projectionHandle.cy.nodes(`[realId = "${nodeId}"]`).addClass("highlight");
      }
    });
    return;
  }

  if (layer.kind === "graph") {
    showCenter("cy");
    graphHandle = renderGraph(el.cy, layer, (nodeId) => {
      state.focusNode(nodeId);
      renderRight();
      renderNav();
      if (graphHandle) {
        graphHandle.cy.$(".highlight").removeClass("highlight");
        if (nodeId) graphHandle.cy.$id(nodeId).addClass("highlight");
      }
    });
  } else if (layer.kind === "table") {
    showCenter("table");
    const head = `<tr>${layer.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr>`;
    const body = layer.rows
      .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(String(c ?? ""))}</td>`).join("")}</tr>`)
      .join("");
    el.tableWrap.innerHTML = `<table class="data"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  } else {
    showCenter("note");
    el.noteWrap.innerHTML = `<div class="note-body">${marked.parse(layer.markdown) as string}</div>`;
  }
}

function renderRight(): void {
  const layer = state.selected();
  if (!layer) {
    el.rightEmpty.style.display = "flex";
    el.inspector.style.display = "none";
    return;
  }
  el.rightEmpty.style.display = "none";
  el.inspector.style.display = "block";
  renderInspector(el.inspector, state, layer, state.selectedNodeId, (layerId, opts) =>
    go(layerId, opts),
  );
}

function renderAll(): void {
  renderNav();
  renderLayerList();
  renderLineage(
    el.lineage,
    state.ordered(),
    state.selectedLayerId,
    (id) => go(id, { via: "lineage" }),
    (childId) => go(childId, { viewMode: "projection", via: "projection" }),
  );
  renderCenter();
  renderRight();
}

// ---- WebSocket ------------------------------------------------------------

function connect(): void {
  const key = new URLSearchParams(location.search).get("key") ?? "";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/?key=${encodeURIComponent(key)}`);

  ws.onopen = () => {
    el.status.classList.add("connected");
    el.statusText.textContent = "connected";
  };
  ws.onclose = () => {
    el.status.classList.remove("connected");
    el.statusText.textContent = "disconnected — retrying…";
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMessage;
    if (msg.type === "hello") {
      el.sessionLabel.textContent = `session: ${msg.session}`;
      for (const layer of msg.layers) state.upsert(layer);
      if (!state.selectedLayerId && msg.layers.length) {
        state.navigate(state.ordered()[state.ordered().length - 1].id, { via: "latest" });
      }
      renderAll();
    } else if (msg.type === "layer-upserted") {
      const isNew = !state.layers.has(msg.layer.id);
      // Follow live emissions only when parked at the newest stop; if the user
      // has navigated back to inspect something, don't yank them away (and don't
      // wipe their forward history).
      const following = !state.canForward();
      state.upsert(msg.layer);
      if (isNew && (following || state.histIndex < 0)) {
        state.navigate(msg.layer.id, { via: "latest" });
      }
      renderAll();
    } else if (msg.type === "layer-removed") {
      state.remove(msg.id);
      renderAll();
    }
  };
}

connect();
