//> using file joerny.sc

// overlay.sc — align 2+ algorithms and show where they MERGE and DIVERGE.
//
// Use case: several flows (jobs / handlers) look similar — where exactly do they
// do the SAME steps (the mergeable common backbone → extract a shared component)
// and where do they diverge (each flow's own logic)? This overlays their step
// spines and colours shared vs flow-unique steps.
//
// Mechanically (no LLM): each method is linearised to its ordered *significant*
// steps (pre-order AST walk) — control-flow guards and non-trivial calls, with
// noise (logging/toString/operators) dropped. Two steps are "the same" when they
// share a signature:
//   - a call  → the callee's fullName (RuleEngine.evaluate is RuleEngine.evaluate
//     in every flow, regardless of surrounding variable names)
//   - a guard → its normalised condition text
// A step present in >= 2 flows is shared; each consecutive pair of steps is an
// edge, coloured by how many flows take that same transition — so a shared
// sub-path (a "merge line") is literally a run of shared nodes + shared edges.
//
// This is a LINEARISED spine, not full branch semantics (that's `algorithm.sc`
// per method) — an honest, comparable projection, labelled as such.
//
// Usage (inside Joern):
//   :load joern/overlay.sc
//   run(cpgPath = "/abs/cpg.bin", entries = "processOrder,handleReject")
// Omit `entries` to auto-pick the 3 own methods with the richest control flow.

import io.shiftleft.codepropertygraph.generated.nodes.{AstNode, Block, Call, ControlStructure, Method, Return}

@main def run(cpgPath: String, entries: String = "", maxFlows: Int = 4): Unit = {
  importCpg(cpgPath)
  def R(s: String): Unit = println("RESULT " + s)

  val own = cpg.method.isExternal(false).filterNot(_.name.startsWith("<")).l
  val ownFn = own.map(_.fullName).toSet
  val names = entries.split(",").map(_.trim).filter(_.nonEmpty).toList

  val flows: List[Method] =
    if (names.nonEmpty)
      names.flatMap(n => own.filter(m => m.fullName.contains(n) || m.name == n)
        .sortBy(-_.controlStructure.size).headOption).distinctBy(_.fullName)
    else
      own.filterNot(_.name.matches("(?i).*(demo|test|main)$"))
        .map(m => (m, m.controlStructure.size)).filter(_._2 >= 2).sortBy(-_._2).take(3).map(_._1)

  if (flows.size < 2) { R("need >= 2 flows; found " + flows.size); return }
  R(s"flows (${flows.size}): ${flows.map(m => m.typeDecl.name.headOption.getOrElse("?") + "." + m.name).mkString(", ")}")

  // ---- helpers (shared with algorithm.sc's taxonomy) ------------------------
  val noise = List("println","print","log","Logger","toString","valueOf","format","append",
    "StringBuilder","getClass","hashCode","currentTimeMillis","nanoTime")
  def isNoise(name: String, full: String): Boolean =
    noise.exists(n => name.contains(n)) ||
      List("java.io.PrintStream","Logger","java.lang.String","java.lang.StringBuilder").exists(full.contains)
  val ioCarriers = List("java.sql.Connection","java.sql.Statement","java.sql.PreparedStatement","java.sql.ResultSet",
    "javax.jms","com.jcraft.jsch","java.io.File","java.nio.file","java.net.","HttpClient","URLConnection",
    "org.springframework.jdbc","javax.persistence","org.hibernate")
  def isIo(full: String): Boolean = ioCarriers.exists(full.contains)
  def clean(s: String): String = s.replaceAll("\\s+", " ").trim
  def short(s: String, n: Int = 56): String = { val c = clean(s); if (c.length > n) c.take(n - 1) + "…" else c }
  def simpleFn(full: String): String = { val base = full.split(":").head; base.split('.').takeRight(2).mkString(".") }
  def kids(n: AstNode): List[AstNode] = try n.astChildren.l.sortBy(_.order) catch { case _: Throwable => Nil }
  def loc(m: Method, n: AstNode): String = m.filename + ":" + n.lineNumber.map(_.toString).getOrElse("?")

  // A significant step: its signature (identity across flows), a display label,
  // a shape, and its source location.
  case class Step(sig: String, label: String, shape: String, loc: String)

  // Linearise a method to its ordered significant steps (pre-order AST walk).
  def spine(m: Method): List[Step] = {
    val out = scala.collection.mutable.ListBuffer.empty[Step]
    def visit(n: AstNode): Unit = {
      n match {
        case cs: ControlStructure if Set("IF","WHILE","FOR","DO","SWITCH").contains(cs.controlStructureType) =>
          val cond = try cs.condition.code.headOption.getOrElse("") catch { case _: Throwable => "" }
          if (cond.nonEmpty) {
            val kind = cs.controlStructureType.toLowerCase
            out += Step("?:" + kind + ":" + clean(cond).toLowerCase, short(kind + " " + cond, 60), "decision", loc(m, cs))
          }
          kids(cs).foreach(visit)
        case c: Call if c.name.startsWith("<operator>") =>
          kids(c).foreach(visit) // descend into assignments for nested real calls
        case c: Call if !isNoise(c.name, c.methodFullName) =>
          val full = c.methodFullName
          val shape = if (isIo(full)) "io" else "process"
          out += Step("call:" + full.split(":").head, short(simpleFn(full) + "()", 56), shape, loc(m, c))
          kids(c).foreach(visit)
        case r: Return =>
          kids(r).foreach(visit)
        case other => kids(other).foreach(visit)
      }
    }
    try m.block.astChildren.l.sortBy(_.order).foreach(visit) catch { case _: Throwable => () }
    // de-dupe consecutive identical signatures (a step repeated back-to-back)
    out.toList.foldLeft(List.empty[Step]) { (acc, s) => if (acc.headOption.exists(_.sig == s.sig)) acc else s :: acc }.reverse
  }

  def flowLabel(m: Method): String = m.typeDecl.name.headOption.getOrElse("?") + "." + m.name
  val spines: List[(String, List[Step])] = flows.take(maxFlows).map(m => flowLabel(m) -> spine(m))
  spines.foreach { case (f, ss) => R(s"  $f: ${ss.size} steps") }

  // ---- overlay: union of step signatures, tagged with flow membership -------
  val flowsBySig = scala.collection.mutable.LinkedHashMap.empty[String, scala.collection.mutable.LinkedHashSet[String]]
  val repr = scala.collection.mutable.LinkedHashMap.empty[String, Step]
  spines.foreach { case (f, ss) =>
    ss.foreach { s =>
      if (!repr.contains(s.sig)) repr(s.sig) = s
      flowsBySig.getOrElseUpdate(s.sig, scala.collection.mutable.LinkedHashSet.empty[String]) += f
    }
  }
  // transitions: (sigA -> sigB) -> set of flows taking it
  val transFlows = scala.collection.mutable.LinkedHashMap.empty[(String, String), scala.collection.mutable.LinkedHashSet[String]]
  spines.foreach { case (f, ss) =>
    ss.sliding(2).foreach {
      case Seq(a, b) => transFlows.getOrElseUpdate((a.sig, b.sig), scala.collection.mutable.LinkedHashSet.empty[String]) += f
      case _         =>
    }
  }
  val sharedSteps = flowsBySig.count(_._2.size >= 2)
  R(s"distinct steps = ${repr.size}; shared by >=2 flows = $sharedSteps")

  // ---- emit ------------------------------------------------------------------
  val flowNames = spines.map(_._1)
  def nid(sig: String): String = "ov:" + sig.hashCode.toString

  joerny.step("overlay flows") {
    val nodes = repr.toList.map { case (sig, s) =>
      val fs = flowsBySig(sig).toList
      val kind = if (fs.size >= 2) "shared" else "unique"
      joerny.Node(nid(sig), s.label, kind,
        Map("shape" -> s.shape, "loc" -> s.loc, "flows" -> fs.mkString(", "), "count" -> fs.size))
    }
    val edges = transFlows.toList.map { case ((a, b), fs) =>
      val fl = fs.toList
      joerny.Edge(nid(a), nid(b), if (fl.size >= 2) "shared" else fl.headOption.getOrElse(""),
        Map("flows" -> fl.mkString(", ")))
    }
    joerny.graph(s"flow overlay: ${flowNames.mkString(" vs ")}")
      .id("overlay")
      .flowchart("TB")
      .narrate(s"${flowNames.size} algorithms overlaid on their linearised significant steps. A 'shared' " +
        "node/edge occurs in >=2 flows (the mergeable common backbone — candidate shared component); a " +
        "'unique' one is that flow's own logic. Steps aligned mechanically by signature (callee fullName / " +
        "normalised guard). Linearised spine, not full branch semantics — see algorithm.sc per method.")
      .nodes(nodes)
      .edges(edges)
      .emit()

    // shared-step table: the merge lines, with the flows that share each.
    val rows = flowsBySig.toList.filter(_._2.size >= 2).sortBy(-_._2.size).map { case (sig, fs) =>
      val s = repr(sig)
      List(s.label, s.shape, fs.size, fs.toList.sorted.mkString(", "), s.loc)
    }
    joerny.table("shared steps (merge lines)")
      .id("overlay-shared")
      .from("overlay")
      .narrate("Steps that appear in multiple flows, ranked by how many share them — the common backbone " +
        "to factor out. Each with the flows sharing it and a file:line.")
      .columns("step", "shape", "#flows", "shared by", "site")
      .rows(rows)
      .emit()
  }
  R("done")
}
