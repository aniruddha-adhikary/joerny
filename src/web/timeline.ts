import type { AppState } from "./state.js";
import { hasArtificial, sumTallies, artificialCount } from "../shared/provenance.js";

/** The trace scrubber: replays the script's emit order. Every emitted layer is
 *  a checkpoint; dragging the playhead reveals layers up to that point (the
 *  lineage DAG grows, the layer list fills in) and shows a running
 *  grounded-vs-artificial tally — the anti-hallucination lens over time.
 *  Layers are grouped into the phases declared by `joerny.step("…")`. */
export interface TimelineHandle {
  playing: boolean;
  stop(): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

let timer: number | null = null;

/** Render the timeline strip. `onScrub` is called whenever the cursor moves so
 *  the caller can re-render the (lightweight) revealed views. */
export function renderTimeline(
  container: HTMLElement,
  state: AppState,
  onScrub: () => void,
): void {
  const layers = state.ordered();
  const n = layers.length;
  // Nothing to trace with 0/1 layers.
  if (n < 2) {
    container.style.display = "none";
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    return;
  }
  container.style.display = "block";
  const cursor = state.cursorIndex();
  const revealed = layers.slice(0, cursor + 1);
  const tally = sumTallies(revealed);
  const artificial = artificialCount(tally);
  const curLayer = layers[cursor];
  const stepLabel = curLayer?.step ?? "—";

  // ---- step lanes: runs of consecutive layers sharing a `step` -------------
  const runs: { step: string | undefined; count: number }[] = [];
  for (const l of layers) {
    const last = runs[runs.length - 1];
    if (last && last.step === l.step) last.count += 1;
    else runs.push({ step: l.step, count: 1 });
  }
  const stepBar = runs
    .map((r) => {
      const label = r.step ? esc(r.step) : "";
      const cls = r.step ? "tl-step" : "tl-step tl-step-none";
      return `<div class="${cls}" style="flex-grow:${r.count}" title="${label}">${label}</div>`;
    })
    .join("");

  // ---- ticks: one per layer, marked by kind + artificial provenance --------
  const ticks = layers
    .map((l, i) => {
      const revealedCls = i <= cursor ? "on" : "off";
      const art = hasArtificial(l) ? " art" : "";
      const cur = i === cursor ? " cur" : "";
      const title = `${esc(l.name)} · ${l.kind}${l.step ? ` · ${esc(l.step)}` : ""}${
        hasArtificial(l) ? " · introduces artificial links" : ""
      }`;
      return `<div class="tl-cell" data-idx="${i}" title="${title}"><span class="tl-tick kind-${l.kind} ${revealedCls}${art}${cur}"></span></div>`;
    })
    .join("");

  const playheadPct = ((cursor + 0.5) / n) * 100;
  const following = state.cursorFollowing();

  container.innerHTML = `
    <div class="tl-head">
      <button class="tl-btn" id="tlPlay" title="Replay emit order">${
        timer !== null ? "❚❚" : "▶"
      }</button>
      <button class="tl-btn" id="tlPrev" title="Step back">◀</button>
      <button class="tl-btn" id="tlNext" title="Step forward">▶</button>
      <span class="tl-count">${cursor + 1} / ${n}</span>
      <span class="tl-step-cur" title="current phase">${esc(stepLabel)}</span>
      <span class="tl-tally" title="connections revealed so far, by origin">
        <span class="tl-grounded">${tally.mechanical} grounded</span>
        <span class="tl-art${artificial > 0 ? " hot" : ""}">${artificial} artificial</span>
      </span>
      <span class="tl-live ${following ? "on" : ""}" title="${
        following ? "following live emits" : "parked in the past — new emits won't jump"
      }">${following ? "● live" : "◦ history"}</span>
    </div>
    <div class="tl-track" id="tlTrack">
      <div class="tl-steps">${stepBar}</div>
      <div class="tl-ticks">${ticks}</div>
      <div class="tl-playhead" style="left:${playheadPct}%"></div>
    </div>`;

  const track = container.querySelector<HTMLElement>("#tlTrack")!;
  const idxFromX = (clientX: number): number => {
    const rect = track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(frac * n - 0.5);
  };
  const scrubTo = (i: number): void => {
    state.setCursor(i);
    onScrub();
  };

  let dragging = false;
  track.addEventListener("pointerdown", (ev) => {
    dragging = true;
    track.setPointerCapture(ev.pointerId);
    scrubTo(idxFromX(ev.clientX));
  });
  track.addEventListener("pointermove", (ev) => {
    if (dragging) scrubTo(idxFromX(ev.clientX));
  });
  track.addEventListener("pointerup", (ev) => {
    dragging = false;
    track.releasePointerCapture(ev.pointerId);
  });

  const play = container.querySelector<HTMLElement>("#tlPlay")!;
  play.addEventListener("click", () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
      onScrub();
      return;
    }
    // Restart from the beginning if parked at the end.
    if (state.cursorFollowing()) state.setCursor(0);
    timer = window.setInterval(() => {
      const next = state.cursorIndex() + 1;
      state.setCursor(next);
      if (state.cursorFollowing()) {
        // reached the end
        clearInterval(timer!);
        timer = null;
      }
      onScrub();
    }, 700);
    onScrub();
  });
  container.querySelector<HTMLElement>("#tlPrev")!.addEventListener("click", () =>
    scrubTo(state.cursorIndex() - 1),
  );
  container.querySelector<HTMLElement>("#tlNext")!.addEventListener("click", () =>
    scrubTo(state.cursorIndex() + 1),
  );
}

/** Stop any running playback (called when layers change out from under us). */
export function stopPlayback(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
