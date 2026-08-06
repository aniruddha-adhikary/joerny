/*
 * example-analysis.sc — a runnable sketch of a joerny-instrumented Joern script.
 *
 * Run against a prebuilt CPG:
 *
 *   export JOERNY_DIR="$PWD/.joerny/current/layers"   # printed by `joerny`
 *   joern --script joern/example-analysis.sc --param cpgPath=cpg.bin
 *
 * It emits three linked layers — a graph, a table, and a note — mirroring the
 * component-discovery workflow. Swap the placeholder queries for real CPGQL.
 */

//> using file joerny.sc

import io.shiftleft.codepropertygraph.generated.nodes.Method

@main def run(cpgPath: String): Unit = {
  importCpg(cpgPath)

  // --- Layer 1: entry points (graph) --------------------------------------
  val entryPoints: List[Method] =
    cpg.method.name("main").l // replace with your real entry-point predicate

  joerny.graph("entry-points")
    .narrate(s"${entryPoints.size} entry-point methods discovered.")
    .nodes(entryPoints.map(m => joerny.Node(m.fullName, m.name, "entrypoint")))
    .edges(Nil)
    .emit()

  // --- Layer 2: high-fan-in infra (graph, derived from entry points) ------
  // Methods called by many distinct classes — the shared SDK layer.
  val fanIn: List[Method] =
    cpg.method.filter { m => m.caller.typeDecl.fullName.dedup.size >= 5 }.l

  joerny.graph("fan-in-infra")
    .from("entry-points")
    .narrate(s"${fanIn.size} methods called by 5+ distinct classes — the SDK layer.")
    .nodes(fanIn.map(m => joerny.Node(m.fullName, m.name, "infra")))
    .edges(
      fanIn.flatMap { callee =>
        callee.caller.fullName.dedup.l.map(caller => joerny.Edge(caller, callee.fullName, "calls"))
      }
    )
    .emit()

  // --- Layer 3: summary (note, derived from the graphs) -------------------
  joerny.note("summary")
    .from("fan-in-infra")
    .markdown(
      s"""## Discovery summary
         |
         |- Entry points: **${entryPoints.size}**
         |- Shared infra methods: **${fanIn.size}**
         |""".stripMargin
    )
    .emit()

  println("[example] emitted entry-points, fan-in-infra, summary")
}
