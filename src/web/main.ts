import { marked } from "marked";
import type { ServerMessage } from "../shared/layer.js";
import { AppState } from "./state.js";
import { renderGraph, type GraphViewHandle } from "./graphView.js";
import { renderLineage } from "./lineage.js";
import { renderInspector } from "./inspector.js";

const state = new AppState();
let selectedNodeId: string | null = null;
let graphHandle: GraphViewHandle | null = null;

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
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

function selectLayer(id: string | null, resetNode = true): void {
  state.selectedLayerId = id;
  if (resetNode) selectedNodeId = null;
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
    item.addEventListener("click", () => selectLayer(layer.id));
    el.layerList.appendChild(item);
  }
}

function showCenter(which: "empty" | "cy" | "table" | "note"): void {
  el.centerEmpty.style.display = which === "empty" ? "flex" : "none";
  el.cy.style.display = which === "cy" ? "block" : "none";
  el.tableWrap.style.display = which === "table" ? "block" : "none";
  el.noteWrap.style.display = which === "note" ? "block" : "none";
}

function renderCenter(): void {
  if (graphHandle) {
    graphHandle.destroy();
    graphHandle = null;
  }
  const layer = state.selected();
  if (!layer) {
    showCenter("empty");
    return;
  }
  if (layer.kind === "graph") {
    showCenter("cy");
    graphHandle = renderGraph(el.cy, layer, (nodeId) => {
      selectedNodeId = nodeId;
      renderRight();
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
  renderInspector(el.inspector, state, layer, selectedNodeId, (id) => selectLayer(id));
}

function renderAll(): void {
  renderLayerList();
  renderLineage(el.lineage, state.ordered(), state.selectedLayerId, (id) => selectLayer(id));
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
        state.selectedLayerId = state.ordered()[state.ordered().length - 1].id;
      }
      renderAll();
    } else if (msg.type === "layer-upserted") {
      const isNew = !state.layers.has(msg.layer.id);
      state.upsert(msg.layer);
      // Highlight the latest emission by auto-selecting new layers.
      if (isNew) {
        state.selectedLayerId = msg.layer.id;
        selectedNodeId = null;
      }
      renderAll();
    } else if (msg.type === "layer-removed") {
      state.remove(msg.id);
      renderAll();
    }
  };
}

connect();
