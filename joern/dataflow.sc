//> using file joerny.sc

// dataflow.sc — follow ONE datum end-to-end: a value-centric data-flow graph.
//
// The call graph answers "who calls whom"; the algorithm view answers "what
// happens in this method". This answers "where does this value come from and go
// to" — the actual flow of a datum from its source, through every transform, to
// the sinks that persist / send / emit it.
//
// Mechanically (no LLM): uses Joern's data-flow engine (`reachableByFlows`,
// def-use). Each hop is a real data-dependence edge, so a path from
// `event.getLogDate()` to `executeUpdate(...)` is proven, not guessed. Every
// node carries its `file:line`.
//
// Usage (inside Joern):
//   :load joern/dataflow.sc
//   run(cpgPath = "/abs/cpg.bin",
//       source = "get.*|is.*",                    // regex on call names (value origins)
//       sink   = "executeUpdate|executeQuery|prepareStatement|send|write")
// Narrow `source`/`sink` to focus on one datum; keep maxFlows small — flows fan
// out fast.

import io.joern.dataflowengineoss.language._
import io.joern.dataflowengineoss.queryengine.EngineContext
import io.shiftleft.codepropertygraph.generated.nodes.{Call, Expression}

@main def run(cpgPath: String,
              source: String = "get.*|is.*",
              sink: String = "executeUpdate|executeQuery|prepareStatement|send|sendMessage|write|writeObject|publish",
              sourceContains: String = "",
              maxFlows: Int = 12, maxSources: Int = 120): Unit = {
  importCpg(cpgPath)
  def R(s: String): Unit = println("RESULT " + s)
  implicit val ec: EngineContext = EngineContext()
  def clean(s: String): String = s.replaceAll("\\s+", " ").trim.take(70)

  val sinks = cpg.call.name(sink).l
  var sources = cpg.call.name(source).nameNot("<operator>.*").l
  if (sourceContains.nonEmpty) sources = sources.filter(_.code.toLowerCase.contains(sourceContains.toLowerCase))
  R(s"sinks = ${sinks.size}, sources = ${sources.size}")
  val srcSlice = sources.take(maxSources)
  if (sinks.isEmpty || srcSlice.isEmpty) { R("no source/sink pair"); return }

  val flows = sinks.reachableByFlows(srcSlice.iterator).take(maxFlows).l
  R(s"flows found = ${flows.size}")
  if (flows.isEmpty) { R("no data flows from source to sink"); return }

  // Build a DAG: node per distinct flow element (by code+line); edge per hop.
  def locOf(e: Expression): String =
    e.method.filename + ":" + e.lineNumber.map(_.toString).getOrElse("?")
  case class N(id: String, label: String, kind: String, loc: String)
  val nodes = scala.collection.mutable.LinkedHashMap.empty[String, N]
  val edges = scala.collection.mutable.LinkedHashSet.empty[(String, String)]
  def nid(e: Expression): String = "n:" + Option(e.code).map(_.hashCode).getOrElse(0) + ":" + e.lineNumber.map(_.toString).getOrElse("?")

  flows.foreach { flow =>
    val els = flow.elements.collect { case e: Expression => e }
    els.zipWithIndex.foreach { case (e, i) =>
      val id = nid(e)
      val kind = if (i == 0) "source" else if (i == els.size - 1) "sink" else "transform"
      // A node seen in several flows keeps its most meaningful role: a source/
      // sink label wins over a mid-flow "transform".
      if (!nodes.contains(id) || kind != "transform")
        nodes(id) = N(id, clean(e.code), kind, locOf(e))
    }
    els.sliding(2).foreach {
      case Seq(a, b) => edges += ((nid(a), nid(b)))
      case _         =>
    }
  }
  R(s"nodes = ${nodes.size}, edges = ${edges.size}")

  joerny.step("trace data flow") {
    val gNodes = nodes.values.toList.map { n =>
      val shape = n.kind match { case "source" => "terminal"; case "sink" => "io"; case _ => "process" }
      joerny.Node(n.id, n.label, n.kind, Map("shape" -> shape, "loc" -> n.loc))
    }
    val gEdges = edges.toList.map { case (a, b) => joerny.Edge(a, b, "flows to") }
    val title = if (sourceContains.nonEmpty) s"dataflow: $sourceContains → sink" else s"dataflow: $source → sink"
    joerny.graph(title)
      .id("dataflow-" + (if (sourceContains.nonEmpty) sourceContains.toLowerCase else "all"))
      .flowchart("LR")
      .narrate("Value-centric data-flow: each node is a step a value passes through, each edge is a " +
        "proven data-dependence hop (Joern's dataflow engine), from source (terminal) through transforms " +
        "(process) to sinks (I/O). Not who-calls-who — where the datum actually goes. Every node has file:line.")
      .nodes(gNodes)
      .edges(gEdges)
      .emit()
  }
  R("done")
}
