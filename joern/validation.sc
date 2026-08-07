//> using file joerny.sc

// validation.sc — reconstruct the *validation logic* of a system as a
// field ⟷ check bipartite graph.
//
// Use case: "show me every validation applied to each field" — e.g. across a
// form or a domain object. Instead of who-calls-who, it asks: which guards
// (if / while conditions) actually READ a given field, and what do they check?
//
// Mechanically (no LLM): every control-structure condition that references a
// field access (`order.status`) or a getter (`order.getStatus()`) is a check on
// that member. We group checks by the member they read, so each field lists the
// exact predicates that validate it — every one carrying its `file:line`.
//
// Usage (inside Joern):
//   :load joern/validation.sc
//   run(cpgPath = "/abs/cpg.bin", typeName = "TradeOrder")   // typeName optional
// `typeName` (optional) restricts to fields of one domain type; omit for all.

import io.shiftleft.codepropertygraph.generated.nodes.{Call, ControlStructure}

@main def run(cpgPath: String, typeName: String = "", maxChecks: Int = 400): Unit = {
  importCpg(cpgPath)
  def R(s: String): Unit = println("RESULT " + s)
  def simple(t: String): String = if (t.contains(".")) t.substring(t.lastIndexOf('.') + 1) else t
  def clean(s: String): String = s.replaceAll("\\s+", " ").trim.take(90)

  // ---- a "read" of a field inside a guard condition -------------------------
  // Returns (owner, member, refCode) best-effort by parsing the receiver code —
  // robust across Joern node types (no typeFullName step on bare Expression).
  def getterReads(cond: Iterator[Call]): List[(String, String, String)] =
    cond.name("get.*|is.*").nameNot("<operator>.*").flatMap { c =>
      val code = c.code
      val owner = if (code.contains(".")) simple(code.takeWhile(_ != '.').trim) else "?"
      val n = c.name
      val member = if (n.startsWith("get")) n.drop(3) else if (n.startsWith("is")) n.drop(2) else n
      if (member.isEmpty) None
      else Some((owner, member.head.toString.toLowerCase + member.tail, code))
    }.l

  def fieldReads(cond: Iterator[Call]): List[(String, String, String)] =
    cond.name("<operator>.fieldAccess").flatMap { c =>
      val code = c.code
      if (!code.contains(".")) None
      else {
        val owner = simple(code.substring(0, code.indexOf('.')).trim)
        val member = code.substring(code.lastIndexOf('.') + 1).trim
        if (member.isEmpty || member.contains("(")) None else Some((owner, member, code))
      }
    }.l

  val guards = cpg.controlStructure
    .filter(c => Set("IF", "WHILE", "DO", "FOR").contains(c.controlStructureType))
    .filter(_.condition.nonEmpty).l
  R(s"guards with a condition = ${guards.size}")

  // (field, guardNodeId, guardCode, loc, refCode)
  case class Check(owner: String, member: String, gid: String, code: String, loc: String, ref: String)
  val checks = scala.collection.mutable.ListBuffer.empty[Check]
  guards.foreach { g =>
    val condCalls = g.condition.ast.isCall
    val reads = getterReads(condCalls) ++ fieldReads(g.condition.ast.isCall)
    val loc = g.method.filename + ":" + g.lineNumber.map(_.toString).getOrElse("?")
    val gcode = clean(g.condition.code.headOption.getOrElse(g.code))
    reads.distinct.foreach { case (owner, member, ref) =>
      if (typeName.isEmpty || owner == simple(typeName))
        checks += Check(owner, member, "check-" + g.id.toString, gcode, loc, ref)
    }
  }
  val kept = checks.toList.take(maxChecks)
  R(s"field-reading checks = ${checks.size} (kept ${kept.size})")

  val byField = kept.groupBy(c => c.owner + "." + c.member)
  R(s"distinct validated fields = ${byField.size}")
  byField.toList.sortBy(-_._2.size).take(10).foreach { case (f, cs) => R(s"  $f  <- ${cs.size} check(s)") }

  // ---- emit: bipartite field ⟷ check graph + a per-field table -------------
  joerny.step("reconstruct validation") {
    val fieldNodes = byField.keys.toList.map { f =>
      joerny.Node("field:" + f, simple(f.split('.').head) + "." + f.split('.').last, "field",
        Map("checks" -> byField(f).size))
    }
    // one check node per distinct (field, guard) so the same guard checking two
    // fields shows an edge to each — the predicate is the shared evidence.
    val checkNodes = kept.map { c =>
      joerny.Node(c.gid + ":" + c.owner + "." + c.member, c.code, "check",
        Map("loc" -> c.loc, "predicate" -> c.code))
    }.distinctBy(_.id)
    val edges = kept.map { c =>
      joerny.Edge("field:" + c.owner + "." + c.member, c.gid + ":" + c.owner + "." + c.member,
        "validated by", Map("loc" -> c.loc))
    }.distinctBy(e => (e.src, e.dst))

    joerny.graph(if (typeName.isEmpty) "validation: all fields" else s"validation: ${simple(typeName)}")
      .id(if (typeName.isEmpty) "validation-all" else "validation-" + simple(typeName).toLowerCase)
      .narrate("Field ⟷ check map. Every edge is a control-structure condition that " +
        "reads the field — the validation applied to it, mechanically from the CPG (no LLM). " +
        "Left = fields; right = the exact predicates guarding them, each with file:line.")
      .nodes(fieldNodes ++ checkNodes)
      .edges(edges)
      .emit()

    val rows = byField.toList.sortBy(-_._2.size).map { case (f, cs) =>
      List(simple(f.split('.').head), f.split('.').last, cs.size, cs.map(_.code).distinct.take(3).mkString(" ; "))
    }
    joerny.table(if (typeName.isEmpty) "validation rules" else s"validation rules: ${simple(typeName)}")
      .id((if (typeName.isEmpty) "validation-all" else "validation-" + simple(typeName).toLowerCase) + "-table")
      .from(if (typeName.isEmpty) "validation-all" else "validation-" + simple(typeName).toLowerCase)
      .narrate("One row per field: how many checks read it and sample predicates. A field " +
        "with 0 rows here is validated nowhere — a coverage gap.")
      .columns("type", "field", "#checks", "sample predicates")
      .rows(rows)
      .emit()
  }
  R("done")
}
