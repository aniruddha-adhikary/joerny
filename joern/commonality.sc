//> using file joerny.sc

// commonality.sc — find the COMMON business logic across multiple flows, to
// isolate shared components and draw module boundaries ("merge lines").
//
// Use case: you have N entry points (jobs / handlers / main methods). Which
// logic do several of them share (a candidate shared component / library), and
// which is unique to one flow (that flow's own behaviour)? The shared core is
// where a boundary wants to be drawn.
//
// Mechanically (no LLM): for each entry we compute its reachable set of OWN
// methods over the call graph (depth-bounded), forming an entry ⟷ method
// incidence relation. `joerny.derive.bipartite` turns that into method-sharing
// clusters (with hub backboning so a ubiquitous helper doesn't couple
// everything). Every "shared by k flows" fact carries the flows that share it.
//
// Usage (inside Joern):
//   :load joern/commonality.sc
//   run(cpgPath = "/abs/cpg.bin", entries = "EngineMain,SettlementJob", depth = 4)
// `entries` = comma-separated name substrings; omit to use `main` methods (else
// call-graph roots). `minShared` = how many flows must share a method to couple.

import io.shiftleft.codepropertygraph.generated.nodes.Method

@main def run(cpgPath: String, entries: String = "", depth: Int = 4,
              minShared: Int = 1, maxHubShare: Double = 0.8): Unit = {
  importCpg(cpgPath)
  def R(s: String): Unit = println("RESULT " + s)
  def simpleM(fn: String): String = fn.split(":").head.split('.').takeRight(2).mkString(".")

  val own = cpg.method.isExternal(false).filterNot(_.name.startsWith("<")).l
  val names = entries.split(",").map(_.trim).filter(_.nonEmpty).toList

  val entryMethods: List[Method] =
    if (names.nonEmpty) own.filter(m => names.exists(n => m.fullName.contains(n) || m.name == n))
    else {
      val mains = own.filter(_.name == "main")
      if (mains.nonEmpty) mains
      else own.filter(m => m.caller.isExternal(false).isEmpty).sortBy(-_.callee.isExternal(false).size).take(6)
    }
  if (entryMethods.size < 2) { R("need >= 2 entries; found " + entryMethods.size); return }
  R(s"entries (${entryMethods.size}): ${entryMethods.map(_.name).mkString(", ")}")

  // reachable own methods per entry, depth-bounded BFS over the call graph.
  def reach(m: Method): Set[String] = {
    var seen = Set[String](); var frontier = Set(m); var d = 0
    while (frontier.nonEmpty && d < depth) {
      val next = frontier.flatMap(_.callee.isExternal(false).filterNot(_.name.startsWith("<")).l).toSet
      seen ++= next.map(_.fullName)
      frontier = next.filterNot(x => seen.contains(x.fullName)); d += 1
    }
    seen
  }
  // disambiguate entries that share a simple name (many `main`s) by class.
  def entryLabel(m: Method): String = {
    val cls = m.typeDecl.name.headOption.getOrElse(m.fullName.split('.').dropRight(1).lastOption.getOrElse("?"))
    cls + "." + m.name
  }
  val reachByEntry: List[(String, Set[String])] = entryMethods.map(e => entryLabel(e) -> reach(e))
  val pairs: List[(String, String)] = reachByEntry.flatMap { case (e, ms) => ms.map(m => (e, m)) }
  R(s"incidence pairs = ${pairs.size}")

  // how many flows share each method
  val shareCount: Map[String, Int] = pairs.groupBy(_._2).view.mapValues(_.map(_._1).toSet.size).toMap
  val shared = shareCount.filter(_._2 >= 2)
  R(s"methods reachable from >=2 flows = ${shared.size} (candidate shared components)")
  shared.toList.sortBy(-_._2).take(12).foreach { case (fn, n) => R(s"  x$n  ${simpleM(fn)}") }

  val bp = joerny.derive.bipartite(pairs, minShared, maxHubShare)

  joerny.step("find common logic across flows") {
    // (1) incidence: flows ⟷ their reachable methods, shared ones highlighted.
    val flowNodes = reachByEntry.map { case (e, ms) => joerny.Node("flow:" + e, e, "flow", Map("reaches" -> ms.size)) }
    val methodNodes = pairs.map(_._2).distinct.map { fn =>
      val k = shareCount.getOrElse(fn, 1)
      joerny.Node("m:" + fn, simpleM(fn), if (k >= 2) "shared" else "unique", Map("flows" -> k))
    }
    val incEdges = pairs.distinct.map { case (e, m) => joerny.Edge("flow:" + e, "m:" + m, "reaches") }
    joerny.graph("commonality: flows ⟷ logic")
      .id("commonality-incidence")
      .narrate(s"${entryMethods.size} flows and the own-code methods each reaches (depth $depth). " +
        "Methods reachable from >=2 flows (type 'shared') are candidate shared components; " +
        "methods with one flow are that flow's own logic. Mechanical — call-graph reachability only.")
      .nodes(flowNodes ++ methodNodes)
      .edges(incEdges)
      .emit()

    // (2) shared-component table: the merge lines, ranked.
    val rows = shared.toList.sortBy(-_._2).map { case (fn, n) =>
      val flows = pairs.filter(_._2 == fn).map(_._1).distinct.sorted
      List(simpleM(fn), n, flows.mkString(", "))
    }
    joerny.table("shared components (merge candidates)")
      .id("commonality-shared")
      .from("commonality-incidence")
      .narrate("Methods reachable from multiple flows, ranked by how many flows share them. " +
        "These are where a boundary/shared library wants to be drawn.")
      .columns("method", "#flows", "shared by")
      .rows(rows)
      .emit()

    // (3) coupling clusters over the flows (which flows overlap most).
    joerny.graph("flow coupling clusters")
      .id("commonality-clusters")
      .from("commonality-incidence")
      .narrate("Flows linked when they share >= " + minShared + " method(s); connected components " +
        "are clusters of flows that overlap — natural groupings for a bounded context. " +
        "Ubiquitous helpers above " + maxHubShare + " share are backboned out so they don't couple everything.")
      .project(bp.coupling)
      .project(bp.clusters)
      .emit()
  }
  R("done")
}
