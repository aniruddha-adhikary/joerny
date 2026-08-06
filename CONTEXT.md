# joerny

A local browser companion that live-renders the analysis an AI coding agent produces while it drives Joern over a codebase. The agent emits typed **Layers** with **Lineage** and node-level **Mappings**; joerny watches and visualizes them. joerny consumes an existing CPG — it never builds or manages one.

## Language

### Emitted output

**Layer**:
One emitted unit of analysis output, rendered on its own in the viewer. Every layer has a **Kind** and a stable id (re-emitting the same id replaces it).
_Avoid_: view, panel, result, artifact

**Kind**:
How a Layer is represented — exactly one of `Graph`, `Table`, or `Note`. The agent classifies each layer's Kind; "not graphable" falls back to Table or Note.
_Avoid_: type (reserved for a node's category), format

**Note** (a Kind):
A Layer whose content is markdown commentary. This word refers **only** to the markdown layer Kind — never to the proof on a Mapping (that is **Evidence**).
_Avoid_: markdown, comment, annotation

**Narration**:
The short agent-authored "what/why" attached to a Layer, shown in the inspector. Distinct from a Note Layer.
_Avoid_: description, caption

### Structure between layers

**Lineage**:
The DAG of Layers. Its edges are Derivations. Lineage is a *layer-level* structure.
_Avoid_: history, graph, tree, pipeline

**Derivation**:
A single layer→layer edge in the Lineage: "this Layer was derived from that one" (the `derivedFrom` link). A Derivation may be *realized by* Mappings.
_Avoid_: parent link, dependency, derivedFrom (that's the field name, not the concept name)

### Structure within a derivation

**Mapping**:
A single node→node link — a node in a parent Layer to a node in this Layer — that realizes a Derivation and carries **Evidence**. This is the *node-level* counterpart to a Derivation.
_Avoid_: edge (reserved for within-layer Graph edges), link, projection edge, note

**Evidence**:
The proof carried by a Mapping: *why* this source node maps to this target node (the shared fingerprint key, the matched marker literal, the shared table…). Weak or absent Evidence must be reported, never fabricated.
_Avoid_: note, reason, comment, provenance-string

**Origin**:
*How a connection came to exist* — the provenance of a Graph edge or a Mapping. Exactly one of `mechanical` (computed from the CPG or a deterministic rule — authoritative, the honest default), `llm` (inferred or inserted by a language model — an artificial link, not ground truth), or `manual` (hand-authored by a human). Absent = `mechanical`. The viewer renders non-mechanical connections distinctly (solid = mechanical, dashed = llm, dotted = manual) so a guess is never mistaken for a fact. Distinct from **Evidence**: Evidence is *why* a link holds; Origin is *who/what* asserted it.
_Avoid_: source (reserved for a node's `file:line`), type, kind, confidence

**Projection**:
The computed bundle a `derive.*` primitive produces from a parent Layer: derived nodes/edges + the Mappings (with Evidence) that connect them back to the source. Merged into a Layer with `.project(...)`. The viewer's *Projection view* renders a Layer's Mappings.
_Avoid_: transformation, mapping set, derivation output

**derive primitive**:
A generic, on-demand combinator that computes a Projection: `classify` (tag into categories), `groupByKey` (equivalence/fingerprint grouping), `bipartite` (two node types → coupling + clusters), `slice` (reachability/impact). Optional — the agent may also emit raw Layers with hand-authored Mappings.
_Avoid_: analyzer, transformer, rule

### Script execution over time

**Step**:
*A named phase of an analysis script* — declared with `joerny.step("…"){ … }`. Every Layer emitted inside the block is tagged with the Step's name, grouping the emit sequence into phases. The honest, high-fidelity unit of a script trace: a boundary the author declares, not per-line instrumentation (Joern runs a `.sc` as a compiled block). Absent = ungrouped.
_Avoid_: checkpoint, stage, span, milestone

**Trace**:
*The replayable record of what a script did*, over time. Because every emit is a timestamped checkpoint, the ordered Layer sequence already **is** the trace; the viewer's scrubber folds it from the start up to a time cursor so you watch the Lineage grow in emit order, grouped by Step, with a running mechanical-vs-artificial (see **Origin**) tally — the anti-hallucination lens over time.
_Avoid_: log, replay, timeline (that's the UI control), history (reserved for nav back/forward)

### Analysis vocabulary

**Backboning**:
Dropping ubiquitous "hub" nodes from a bipartite coupling computation (via `minShared` / `maxHubShare`) so a dense projection separates into meaningful clusters instead of collapsing into one blob. A tunable knob, not a fixed constant.
_Avoid_: pruning, filtering, thresholding

**Capability**:
An external behavior a piece of code performs, proven by the *receiver type* of what it calls (e.g. JDBC I/O, JMS, HTTP) — not by method names. Matched against a subsystem's I/O surface, so *modeling* a value type (e.g. `java.sql.Date`) is not a Capability.
_Avoid_: feature, behavior flag, tag

**Shape**:
Whether a codebase reads as an `application` (has entry integration behavior) or a `library` (no `main()`, no external Capabilities). Shape flips the meaning of high fan-in: shared infrastructure in an application vs. core public API in a library.
_Avoid_: type, category
