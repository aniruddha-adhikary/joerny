import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphLayer } from "./layer.js";
import { layerOriginTally, sumTallies, hasArtificial, artificialCount } from "./provenance.js";

function graph(edges: GraphLayer["edges"], mappings?: GraphLayer["mappings"]): GraphLayer {
  return {
    id: "g",
    name: "g",
    kind: "graph",
    derivedFrom: [],
    createdAt: "2020-01-01T00:00:00Z",
    nodes: [],
    edges,
    mappings,
  };
}

test("counts edges + mappings by origin, treating absent as mechanical", () => {
  const layer = graph(
    [
      { src: "a", dst: "b" }, // mechanical (absent)
      { src: "b", dst: "c", origin: "llm" },
      { src: "c", dst: "d", origin: "manual" },
    ],
    [
      { from: "x", to: "y" }, // mechanical
      { from: "y", to: "z", origin: "llm" },
    ],
  );
  const t = layerOriginTally(layer);
  assert.deepEqual(t, { mechanical: 2, llm: 2, manual: 1 });
  assert.equal(artificialCount(t), 3);
  assert.equal(hasArtificial(layer), true);
});

test("a purely mechanical layer is not artificial", () => {
  const layer = graph([{ src: "a", dst: "b" }]);
  assert.equal(hasArtificial(layer), false);
  assert.equal(artificialCount(layerOriginTally(layer)), 0);
});

test("sumTallies accumulates across the revealed layers", () => {
  const a = graph([{ src: "a", dst: "b" }]);
  const b = graph([{ src: "b", dst: "c", origin: "llm" }], [{ from: "x", to: "y", origin: "manual" }]);
  assert.deepEqual(sumTallies([a, b]), { mechanical: 1, llm: 1, manual: 1 });
});
