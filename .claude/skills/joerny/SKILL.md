---
name: joerny
description: Live-visualize Joern CPG analysis in the browser. Use when running Joern (CPG queries, component discovery, taint/call-graph analysis) so the human can watch the graphs, tables, and notes you produce update live.
---

# joerny — live companion for Joern analysis

As you explore a Code Property Graph with Joern, **publish each representation you
produce as a "layer"** so the human sees it render live in a browser: graphs,
tables, and notes, connected by a lineage DAG that shows how one layer projects
into the next.

joerny is **watch-only** — you drive, the browser follows. It never changes the
CPG and never blocks you.

## When to use

Invoke this whenever you run Joern for the human: importing/querying a CPG,
doing component discovery (see any CPG discovery guide), fan-in analysis,
clustering, taint tracking, etc. If the human is watching you work in Joern,
they almost certainly want the visual companion up.

## Setup (once per session)

1. Start the viewer from the project root (it stays running across turns):

   ```bash
   # from the joerny checkout
   npm run build   # first time only
   node dist/cli.js --project-dir "$PWD" --open &
   ```

   It prints a URL with a per-session key and the layer directory, e.g.:

   ```
   [joerny] point your Joern scripts here:  export JOERNY_DIR=".../.joerny/current/layers"
   [joerny] open in browser:  http://127.0.0.1:PORT/?key=...
   ```

2. **Tell the human the URL** (repeat it each turn, like a visual companion).
3. Export `JOERNY_DIR` so your Joern scripts know where to emit:

   ```bash
   export JOERNY_DIR="$PWD/.joerny/current/layers"
   ```

## Emitting layers from a Joern script

Import the helper and call the builder that matches the representation. **You
decide the kind**: if the output is naturally a graph (nodes + relationships)
use `graph`; if it's rows/metrics use `table`; if it's prose/findings use `note`.
Not everything is a graph — don't force it.

```scala
//> using file joern/joerny.sc

// GRAPH: entities + relationships
joerny.graph("high-fan-in-infra")
  .from("entry-points")                        // derivedFrom → lineage DAG
  .narrate("Methods called by 5+ distinct job classes — the SDK layer.")
  .nodes(infra.map(m => joerny.Node(m.fullName, m.name, "infra")))
  .edges(callPairs.map { case (a, b) => joerny.Edge(a, b, "calls") })
  .emit()

// TABLE: rows/metrics that aren't a graph
joerny.table("structural-clusters")
  .from("entry-points")
  .narrate("Jobs grouped by identical depth-3 call-tree fingerprint.")
  .columns("cluster", "jobs", "shared call-tree")
  .row("sftp-ingest", "Job1, Job2, Job5", "getConnection → readLine → parse → upload")
  .emit()

// NOTE: findings / summary as markdown
joerny.note("summary")
  .from("components")
  .markdown("## Findings\n- 12 jobs → 3 components (4:1)\n- Unknown: 2%")
  .emit()
```

### Rules for good layers

- **Stable, meaningful node ids** (prefer `fullName`). The same id in two layers
  is treated as the same entity, so the human can see a method appear across
  fan-in, clusters, and components. Ids also make re-emitting *update* a layer
  instead of duplicating it.
- **Always `.narrate(...)`** — one or two sentences on *what this layer is and
  why it matters*. This is the human's running commentary.
- **Declare lineage with `.from(parentId, ...)`** whenever a layer is derived
  from an earlier one. This is what draws the pipeline.
- **Show projections** between stages with `.map(joerny.Mapping(fromNodeId,
  toNodeId, "note"))` or `.mapNodes(pairs)` — e.g. which shared methods make up
  which component. The human specifically wants to *see how one representation
  projects into the next*. These mappings power the browser's **Projection**
  tab, which draws parent nodes → this layer's nodes with the mapping edges, so
  make `fromNodeId` a node id that exists in a parent layer (its `.from(...)`).
- **Emit as you go**, phase by phase — don't wait until the end. The point is a
  live picture of your exploration.
- Keep graphs focused (derived/aggregated views, not the raw 100k-node CPG).

## Verify

After emitting, tell the human which layer just appeared and remind them of the
URL. New layers auto-select and highlight in the browser.
