import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLayer } from "./validate.js";

test("accepts a minimal graph layer and fills defaults", () => {
  const res = validateLayer({
    id: "entry-points",
    name: "Entry Points",
    kind: "graph",
    nodes: [{ id: "a", label: "A" }, { id: "b" }],
    edges: [{ src: "a", dst: "b", type: "calls" }],
  });
  assert.ok(res.ok, res.errors.join("; "));
  assert.equal(res.layer?.kind, "graph");
  assert.deepEqual(res.layer?.derivedFrom, []);
  assert.ok(typeof res.layer?.createdAt === "string");
  if (res.layer?.kind === "graph") {
    assert.equal(res.layer.nodes[1].label, "b"); // label defaults to id
  }
});

test("rejects a graph layer without nodes", () => {
  const res = validateLayer({ id: "x", name: "x", kind: "graph" });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(" "), /nodes/);
});

test("rejects an unknown kind", () => {
  const res = validateLayer({ id: "x", name: "x", kind: "heatmap" });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(" "), /kind/);
});

test("validates table layers", () => {
  const ok = validateLayer({ id: "t", name: "t", kind: "table", columns: ["a", "b"], rows: [[1, 2]] });
  assert.ok(ok.ok);
  const bad = validateLayer({ id: "t", name: "t", kind: "table", columns: ["a"], rows: "nope" });
  assert.equal(bad.ok, false);
});

test("validates note layers and preserves lineage + mappings", () => {
  const res = validateLayer({
    id: "n",
    name: "n",
    kind: "note",
    markdown: "# hi",
    derivedFrom: ["t"],
    mappings: [{ from: "a", to: "b", evidence: "projected" }],
  });
  assert.ok(res.ok, res.errors.join("; "));
  assert.deepEqual(res.layer?.derivedFrom, ["t"]);
  assert.equal(res.layer?.mappings?.[0].evidence, "projected");
});

test("rejects non-object input", () => {
  assert.equal(validateLayer(null).ok, false);
  assert.equal(validateLayer([]).ok, false);
  assert.equal(validateLayer("nope").ok, false);
});
