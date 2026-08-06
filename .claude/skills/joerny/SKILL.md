---
name: joerny
description: Live-visualize Joern CPG analysis in the browser. Use when running Joern (CPG queries, component/requirements discovery, taint/call-graph analysis) so the human can watch the graphs, tables, and notes you produce update live.
---

# joerny — live companion for Joern analysis

As you explore a Code Property Graph with Joern, **publish each representation
you produce as a "layer"** so the human watches it render live: graphs, tables,
and notes, connected by a lineage DAG that shows how one layer projects into the
next.

joerny is **watch-only** and **malleable**: you drive, the browser follows. It
never changes the CPG, never blocks you, and — crucially — it does **not impose
a fixed analysis pipeline**. Every mission and every codebase is different. You
query however that codebase demands and emit whatever you compute; joerny just
renders and lineages it.

## When to use

Whenever you run Joern for the human: importing/querying a CPG, component or
requirements discovery, fan-in analysis, clustering, slicing, taint tracking.
If the human is watching you work in Joern, they want the visual companion up.

## Setup (once per session)

1. Start the viewer from the joerny checkout (stays running across turns):

   ```bash
   npm run build   # first time only
   node dist/cli.js --project-dir "$PWD" --open &
   ```

   It prints a URL with a per-session key and the layer directory.

2. **Tell the human the URL** (repeat it each turn).
3. Export `JOERNY_DIR` so your Joern scripts know where to emit:

   ```bash
   export JOERNY_DIR="$PWD/.joerny/current/layers"
   ```

## The contract: classify the output, then emit

Import the helper and call the builder that matches the representation. **You
decide the kind** — not everything is a graph, don't force it:

- `graph` — entities + relationships (nodes + edges)
- `table` — rows/metrics that aren't a graph
- `note`  — prose/findings as markdown

```scala
//> using file joern/joerny.sc

joerny.graph("high-fan-in-infra").from("entry-points")
  .narrate("Methods called by 5+ distinct classes — the shared SDK layer.")
  .nodes(infra.map(m => joerny.Node(m.fullName, m.name, "infra")))
  .edges(callPairs.map { case (a, b) => joerny.Edge(a, b, "calls") })
  .emit()

joerny.table("capability-matrix").from("entry-points")
  .narrate("What external behavior each entry point exhibits.")
  .columns("entry point", "DB", "MQ", "FILE")
  .row("BatchScheduler", "yes", "yes", "").emit()

joerny.note("summary").from("components")
  .markdown("## Findings\n- 12 jobs → 3 components\n- Unknown: 2%").emit()
```

### Always
- **Stable, meaningful node ids** (prefer `fullName`). The same id in two layers
  is the same entity, so the human sees a method recur across fan-in, clusters,
  components. Re-emitting an id *updates* the layer instead of duplicating it.
- **`.narrate(...)`** one or two sentences: what this layer is and why it matters.
- **`.from(parentId, ...)`** whenever a layer is derived from an earlier one —
  this draws the pipeline (lineage DAG).
- **Emit as you go**, phase by phase. The point is a live picture of exploration.
- Keep graphs focused (derived/aggregated views, not the raw 100k-node CPG).

## Projections with provenance — computed, not hand-typed

The human wants to *see how one representation projects into the next* ("these
methods → this component", "old job → new config"). Don't hand-author mapping
edges. Compute them with the **`joerny.derive.*` primitives**, which return a
`Projection` (target nodes + edges + **provenance-carrying mappings** where each
`note` is the evidence) that you merge with `.project(...)`:

```scala
val comp = joerny.derive.groupByKey(methods, _.fullName, fingerprintOf)
joerny.graph("components").from("methods").project(comp).emit()
// each method → its component, note = "shared key: <fingerprint>"
```

Available primitives (all take plain ids + functions — wire them to *your*
queries; skip them and emit raw when they don't fit):

| Primitive | Use when | Provenance note |
|---|---|---|
| `derive.classify(items, id, rules)` | tagging entities into categories | the marker that matched |
| `derive.groupByKey(items, id, key)` | equivalence/fingerprint grouping | the shared key |
| `derive.bipartite(pairs, minShared[, maxHubShare])` | two node types → coupling + clusters; raise `minShared` or lower `maxHubShare` to drop ubiquitous hubs (backboning) so dense projections separate | the shared right-nodes / cluster / hubs dropped |
| `derive.slice(seeds, edges, maxDepth)` | reachability / impact / dependency scope | discovery depth |

`.map(joerny.Mapping(from, to, note))` is still there for the rare bespoke edge,
but prefer computed projections so the relationship is inspectable.

## Techniques worth drawing on (NOT a fixed sequence)

These come from real CPG requirements-extraction. Reach for one when its shape
fits the mission; ignore the rest. See `joern/experiments.sc` for a reference
run across three different codebases and `joern/EXPERIMENT_LOG.md` for where each
holds up vs. breaks.

- **Behavior = graph structure, never method names.** Classify a method/job by
  the **receiver type** of what it calls (e.g. `javax.jms.*`,
  `org.apache.ibatis.*`, `org.springframework.web.*`), traced to depth ~3.
  Names lie; `send()` could be MQ, email, or HTTP.
- **Match a subsystem's I/O surface, not its whole package.** "Reaches
  `java.sql.*`" ≠ "does JDBC" — a library can *model* `java.sql.Date` with zero
  DB I/O. Require the I/O carriers (`java.sql.Connection`/`Statement`/
  `ResultSet`, `javax.sql.DataSource`) so use-of-subsystem isn't confused with
  mention-of-a-value-type. Same idea for any capability flag.
- **Entry points aren't always `main()`.** Batch systems seed from `main`; a DI
  framework (Spring) or servlet app has a trivial/absent `main` — seed from
  **call-graph roots** (own methods with no own-code caller = request handlers).
- **SQL via `prepareStatement`, not regex.** For raw JDBC, find SQL-executing
  methods and concatenate their literals in source-line order (regex-on-all-
  literals picks up log strings). Under ORM/JPA or MyBatis XML there is **no
  literal SQL** — say so and switch producer (`@Entity`/`@Table`, mapper XML).
- **Capability blocks = high fan-in — but its meaning depends on shape.** In an
  **application**, methods called by ≥5 distinct classes are shared
  infrastructure (`[BLOCK]` — rebuild as a service); low fan-in job-specific
  helpers are `[EXPAND]` — inline their logic. In a **library** (no `main()`,
  no external-integration capabilities) high fan-in is just the *core public
  API*, not rebuildable infrastructure — don't read it as a service boundary.
  Detect shape first, then interpret; decide by fan-in count, never by
  `path.contains("util")`.
- **Connected flow tree** (the readable, implementable format): walk an entry
  point's AST calls in source order, and for each attach its **CDG guard**
  (`controlledBy`), enclosing loop, inline SQL, and `[BLOCK]`/`[EXPAND]` tag.
  Emit as a `graph` whose step nodes carry `guard`/`sql`/`tag` props.
- **Report the unknowns.** After classifying, count the call targets you didn't
  map and emit them as a `table`. Never claim completeness without the count.

## Verify

After emitting, tell the human which layer appeared and remind them of the URL.
New layers auto-select and highlight in the browser.
