# joerny

A live, browser-based visual companion for [Joern](https://joern.io/).

As a coding agent explores a Code Property Graph, joerny renders the
representations it produces — **graphs, tables, notes** — and the **lineage**
between them, updating live in the browser. It's the same watch-a-directory /
push-over-WebSocket idea as the [superpowers visual-companion](https://github.com/obra/superpowers),
generalized from "HTML fragments" to typed, composable analysis layers.

```
Joern script ──(joern/joerny.sc)──▶ .joerny/<session>/layers/*.json
                                             │  (file watch)
                                    joerny server (Node/TS)
                                             │  (WebSocket)
                                    browser: three-pane live view
```

joerny is **watch-only**: the agent drives, the browser follows. It never
touches the CPG.

## Install & run

```bash
npm install
npm run build
node dist/cli.js --project-dir "$PWD" --open
```

This prints a URL containing a per-session access key and the directory to point
your Joern scripts at:

```
[joerny] point your Joern scripts here:  export JOERNY_DIR=".../.joerny/current/layers"
[joerny] open in browser:  http://127.0.0.1:PORT/?key=...
```

### CLI options

| Flag | Default | Meaning |
|------|---------|---------|
| `--project-dir <path>` | cwd | Project root; layers live in `<path>/.joerny/<session>/` |
| `--session <name>` | `current` | Session name (isolates layer sets) |
| `--port <n>` | reuse prior / OS-assigned | Port to bind |
| `--host <addr>` | `127.0.0.1` | Host to bind |
| `--open` | off | Open the browser on start |

## Emitting layers

From any Joern script, import the helper and publish layers as you discover them:

```scala
//> using file joern/joerny.sc

joerny.graph("high-fan-in-infra")
  .from("entry-points")
  .narrate("Methods called by 5+ distinct job classes — the SDK layer.")
  .nodes(infra.map(m => joerny.Node(m.fullName, m.name, "infra")))
  .edges(callPairs.map { case (a, b) => joerny.Edge(a, b, "calls") })
  .emit()

joerny.table("clusters").columns("cluster", "jobs").row("sftp-ingest", "3").emit()
joerny.note("summary").markdown("## Findings\n- 12 jobs → 3 components").emit()
```

The helper (`joern/joerny.sc`) is dependency-free and writes one JSON file per
layer to `$JOERNY_DIR` (atomic writes; re-emitting the same id updates it).

## Layer schema

Each layer is one JSON object — see [`src/shared/layer.ts`](src/shared/layer.ts).

- `kind`: `graph` | `table` | `note`
- `derivedFrom`: parent layer ids → the lineage DAG
- `mappings`: optional node-level projections (how items in a parent layer map
  into this one)
- `narration`: the agent's running commentary

## UI

Three panes: **left** = layer list + lineage DAG; **center** = the active layer
rendered by kind (Cytoscape graph / table / markdown); **right** = inspector
(narration, metadata, node props, projections, and which other layers contain
the selected node).

## Try it without Joern

```bash
npm run build
node dist/cli.js --project-dir "$PWD" --open &
node scripts/demo-layers.mjs --dir .joerny/current/layers --stagger 1500
```

## Agent integration

A Claude Code skill lives at
[`.claude/skills/joerny/SKILL.md`](.claude/skills/joerny/SKILL.md): it tells the
agent to start joerny, classify each output (graph/table/note), and emit layers
with lineage, mappings, and narration.

## Development

```bash
npm run build       # server (tsc) + web bundle (esbuild)
npm run typecheck   # server + web
npm run lint
npm test            # validator unit tests
```

## Not in the MVP

Bidirectional interaction (click → agent runs a follow-up query) is stubbed but
not wired; multi-user/hosting; agents other than Claude Code (the contract is
agent-agnostic though); building/managing the CPG itself.
