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
`Projection` (target nodes + edges + **Mappings**, each carrying the **evidence**
that proves why the source maps to the target) that you merge with `.project(...)`:

```scala
val comp = joerny.derive.groupByKey(methods, _.fullName, fingerprintOf)
joerny.graph("components").from("methods").project(comp).emit()
// each method → its component, evidence = "shared key: <fingerprint>"
```

Available primitives (all take plain ids + functions — wire them to *your*
queries; skip them and emit raw when they don't fit):

| Primitive | Use when | Mapping evidence |
|---|---|---|
| `derive.classify(items, id, rules)` | tagging entities into categories | the marker that matched |
| `derive.groupByKey(items, id, key)` | equivalence/fingerprint grouping | the shared key |
| `derive.bipartite(pairs, minShared[, maxHubShare])` | two node types → coupling + clusters; raise `minShared` or lower `maxHubShare` to drop ubiquitous hubs (backboning) so dense projections separate | the shared right-nodes / cluster / hubs dropped |
| `derive.slice(seeds, edges, maxDepth)` | reachability / impact / dependency scope | discovery depth |

`.map(joerny.Mapping(from, to, evidence))` is still there for the rare bespoke
mapping, but prefer computed projections so the relationship is inspectable.

### Mark artificial connections (provenance)

Every edge and mapping carries an **origin**: `mechanical` (computed from the
CPG — the default, don't set it) vs. an *artificial* link you couldn't prove
mechanically. When **you (the model) infer or insert** a relationship — a guess
from naming, a plausible grouping the CPG doesn't back — mark it so the viewer
renders it dashed and never lets it pass as a fact:

```scala
joerny.llmEdge(a, b, "resembles")            // vs joerny.Edge(a, b, "calls")
joerny.llmMapping(from, to, "name suggests")  // vs joerny.Mapping(from, to, ev)
// hand-authored by a human: joerny.Edge(a, b, t, origin = "manual")
```

Keep `evidence` (why the link holds) honest and separate from origin (who
asserted it). Prefer mechanical; when you must guess, say so via origin.

### Trace your script with steps

Wrap phases of a long script in `joerny.step("…"){ … }`. Every layer emitted
inside the block is tagged with that phase name, so the viewer's timeline reads
as a **trace of the script** — a scrubber replays your emits in order, groups
them into the named phases, and shows a running *grounded vs. artificial* tally
(the anti-hallucination lens: you watch exactly which phase introduces an
`llm`/`manual` link vs. a `mechanical` one). Steps are the honest unit of a
trace — a phase boundary you declare, not per-line instrumentation.

```scala
joerny.step("discover entry points") {
  joerny.graph("entry-points").nodes(...).emit()
}
joerny.step("propose components") {          // if this phase emits llm mappings,
  joerny.graph("components").project(p).emit() // the timeline flags it as artificial
}
```

Emit intermediate layers at the interesting points — the trace is only as
detailed as the checkpoints you emit.

## Techniques worth drawing on (NOT a fixed sequence)

These come from real CPG requirements-extraction. Reach for one when its shape
fits the mission; ignore the rest. See `joern/experiments.sc` for a reference
run across three different codebases and `joern/EXPERIMENT_LOG.md` for where each
holds up vs. breaks. `joern/requirements.sc` is a second reference: it compiles
evidence-backed PRD/BRD requirements from a CPG (fact → templated requirement →
citation gate → coverage), keeping every statement traceable to `file:line`
source — reach for it when the mission is requirements reconstruction, not as a
mandatory pipeline.

`joern/algorithm.sc` is a third reference — the **algorithm view**: when the
mission is "what actually happens to this data, step by step" (not who-calls-who),
it walks a method's AST control structure into a **flowchart** of guards
(if/while/for/switch conditions → decisions), data operations (assignments,
own-code calls → processes), external side effects (DB/queue/file/net → io) and
returns (terminals), wired by branch-labelled edges (`yes`/`no`/`loop`/`exit`/
`on error`). It is 100% mechanical (reconstructed from the CPG AST, not an LLM
paraphrase), rings every node that touches a chosen `focusType`, and drills one
level down — each own-code callee becomes its own derived flowchart layer,
mapped back to the exact call site (`.from(...)` + a `Mapping`), so the
transformation is traceable across layers. Run it as
`run(cpgPath=..., entry="methodName", focusType="Order")` (omit `entry` to
auto-pick the richest-control-flow own method). Emit a flowchart from your own
walk with `joerny.graph(name).flowchart("TB")` (or `"LR"`) and per-node
`props("shape")` of `decision|process|io|terminal`; the viewer renders shapes,
labels branches, and offers a top-down/left-right toggle. Optional — reach for
it when a specific algorithm matters, skip it when structure is the question.

Four more references cover other graph *shapes* a mission may want. Each is
mechanical (CPG facts + `file:line` evidence, no LLM), optional, and malleable —
tune the params or copy the pattern; none is a mandatory step:

- `joern/dataflow.sc` — **value-centric data flow.** Traces where a datum goes
  (source → transforms → sink) using Joern's dataflow engine
  (`reachableByFlows`, `io.joern.dataflowengineoss`), not who-calls-who. Every
  edge is a proven data-dependence hop. Emits a flowchart with source/sink
  I/O shapes. `run(cpgPath=..., source="get.*|is.*", sink="executeUpdate|send|...")`.
  Reach for it to answer "what happens to `order.price` from read to DB write".
- `joern/validation.sc` — **field ⟷ check map.** Finds control-structure guards
  (`if/while/for`) whose condition reads a field (getter or field access) and
  builds a bipartite field→predicate graph + a per-field rules table (each with
  the exact predicate + `file:line`). `run(cpgPath=..., typeName="Order")` to
  scope to one type (unscoped can be 100+ fields — the table reads best then).
  Reach for it to reconstruct validation across a form/domain object.
- `joern/commonality.sc` — **shared business logic across flows.** For N entry
  points, computes each flow's bounded own-code reachability set, emits a
  flow⟷method incidence graph, a "shared components" table (methods reached by
  ≥k flows = merge/extraction candidates), and flow-coupling clusters via
  `joerny.derive.bipartite`. `run(cpgPath=..., entries="a,b,c", depth=4)`
  (omit `entries` to auto-seed from `main`/call-graph roots). Reach for it to
  isolate components and draw boundaries. Shared ≠ "must extract" — it's a
  mechanical incidence fact; the boundary call stays human.
- `joern/lifecycle.sc` — **state-machine recovery.** Finds writes to a status
  field (setters + field-assignments, excluding constant declarations/reads),
  resolves the target state only from an ALL-CAPS constant or whole-string
  literal (never an opaque expression), and recovers a source state only from an
  AST-enclosing guard that compares the *same* field to a constant. Emits a
  transition flowchart + table. `run(cpgPath=..., field="status")`. Honest by
  design: a write with no guard-proven prior state is a `(start) → STATE` entry,
  not an invented edge — if the code only sets terminal states unconditionally,
  you'll correctly see zero state→state transitions.
- `joern/overlay.sc` — **align 2+ algorithms; show where they merge/diverge.**
  Linearises each method to its ordered significant steps (guards + non-noise
  calls) and overlays them: a step in ≥2 flows is `shared` (the mergeable common
  backbone → extract), one in a single flow is that flow's own logic; edges are
  coloured by how many flows take the transition, so a shared sub-path is a run
  of shared nodes+edges. Steps align by signature (callee fullName / normalised
  guard). `run(cpgPath=..., entries="RuleA.evaluate,RuleB.evaluate")` — pass
  *related* flows (variants of each other); auto-pick grabs the 3 richest-control
  methods, which may be unrelated. It's a linearised spine, not full branch
  semantics (that's `algorithm.sc`) — narrated as such, don't overclaim.
- `joern/crud.sc` — **who owns what data + where to cut boundaries.** From
  raw-JDBC SQL literals builds a class⟷table CRUD matrix (edge per read/write
  with `file:line`), flags **ownership** (a table with exactly one writing class),
  and a class-coupling graph (classes sharing a non-hub table; ubiquitous tables
  backboned out by `maxHubShare`). Runs Tarjan to mark **cut-point** classes
  (articulation vertices — removing one splits a cluster → a natural boundary
  seam). `run(cpgPath=..., maxHubShare=0.5)`. Under JPA/ORM there's no literal
  SQL — it says so and stops (switch to `@Entity`/`@Table`). Cut-points/ownership
  are mechanical graph facts, not an architectural verdict.

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
