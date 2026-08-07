//> using file joerny.sc

// lifecycle.sc — recover the STATE MACHINE of a domain object from the code:
// the states a status field takes and the transitions between them.
//
// Use case: "what is the lifecycle of an Order?" A huge chunk of a BRD is the
// allowed state transitions (NEW → FILLED → SETTLED, and what guards each). This
// reconstructs that from the code rather than a human writing it from memory.
//
// Mechanically (no LLM): find every write to a *status* field (setXxxStatus(v)
// or `.status = v`) and its assigned value = the TARGET state. Then look at what
// control-flow guards that write (`controlledBy`); if a guard compares the same
// status against a constant, that constant is the SOURCE state → a directed
// transition source → target, labelled with the method + guard, carrying
// file:line. Writes with no readable source guard start from "(any)".
//
// Usage (inside Joern):
//   :load joern/lifecycle.sc
//   run(cpgPath = "/abs/cpg.bin", field = "status")   // field name substring

import io.shiftleft.codepropertygraph.generated.nodes.Call

@main def run(cpgPath: String, field: String = "status", maxWrites: Int = 300): Unit = {
  importCpg(cpgPath)
  def R(s: String): Unit = println("RESULT " + s)
  val f = field.toLowerCase
  def clean(s: String): String = s.replaceAll("\\s+", " ").trim.take(80)
  // A state literal we recognise, kept deliberately strict so we don't invent
  // transitions: an ALL-CAPS constant (STATUS_FILLED, REJECTED, KYC_APPROVED) or
  // a quoted string literal. Lowercase expressions (variables, getter calls) are
  // NOT states — a write whose value we can't resolve to a literal is skipped.
  val constRe = "([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{3,})".r
  // A quoted string only counts as a state when it IS the whole value (`= "OPEN"`);
  // a quoted substring inside a call (`extractTag(xml, "status")`) is a tag NAME,
  // not a state, so we must not treat it as one.
  val wholeStr = "^\"([^\"]+)\"$".r
  def stateOf(code: String): Option[String] = {
    val t = code.trim
    wholeStr.findFirstMatchIn(t).map(_.group(1))
      .orElse(constRe.findFirstIn(t).map(_.split('.').last))
  }

  // ---- write sites: setter calls and assignments to a *status* FIELD --------
  // Precision matters: we want writes that SET the state, not constant
  // declarations (`STATUS_NEW = "NEW"` in a <clinit>) nor reads into a local
  // (`statusStr = rs.getString("STATUS")`). So: setters, plus assignments whose
  // left side is a field access to the status field (has a `.`), excluding
  // static initialisers.
  val setterCalls = cpg.call.name("(?i)set.*" + java.util.regex.Pattern.quote(field)).l
  val assignCalls = cpg.call.name("<operator>.assignment").filter { c =>
    try { val lhs = c.argument(1).code.toLowerCase; lhs.contains(f) && lhs.contains(".") }
    catch { case _: Throwable => false }
  }.l
  val writes: List[Call] = (setterCalls ++ assignCalls).distinctBy(_.id)
    .filter(_.method.name != "<clinit>").take(maxWrites)
  R(s"status write sites = ${writes.size} (setters ${setterCalls.size}, assigns ${assignCalls.size})")

  def loc(c: Call): String =
    c.method.filename + ":" + c.lineNumber.map(_.toString).getOrElse("?")

  case class Transition(from: String, to: String, method: String, guard: String, loc: String)
  val transitions = writes.flatMap { w =>
    val valCode = if (w.name.startsWith("<operator>")) {
      try w.argument(2).code catch { case _: Throwable => w.code }
    } else {
      w.argument.filterNot(_.argumentIndex == 0).lastOption.map(_.code).getOrElse(w.code)
    }
    // Only a resolvable state literal counts as a target — otherwise we'd be
    // inventing a state from an opaque expression, so skip the write. Also skip
    // when the "state" is just the field name itself (a `getString("STATUS")`
    // column read that slipped through).
    stateOf(valCode).filter(s => s.toLowerCase != f) match {
      case None => Nil
      case Some(target) =>
        // Source state = a constant compared against the SAME field in a guard
        // that AST-encloses this write (an if/while the write sits inside whose
        // condition reads the field). No such guard → this is an entry write.
        val enclosing = w.method.controlStructure.l.filter { cs =>
          cs.condition.code.exists(_.toLowerCase.contains(f)) && cs.ast.id(w.id).nonEmpty
        }
        val guardConds = enclosing.flatMap(_.condition.code.l)
          .filter(_.toLowerCase.contains(f))
        // The field read itself (getStatus / .status) is mixed/lower case, so the
        // ALL-CAPS constants in the guard are the states being compared against.
        val sources = guardConds.flatMap(g => constRe.findAllIn(g).toList.map(_.split('.').last))
          .filter(s => s != target && s.toLowerCase != f).distinct
        val mname = w.method.name
        val guardTxt = clean(guardConds.headOption.getOrElse(""))
        if (sources.isEmpty) List(Transition("(start)", target, mname, guardTxt, loc(w)))
        else sources.map(s => Transition(s, target, mname, guardTxt, loc(w)))
    }
  }
  val trans = transitions.toList.distinctBy(t => (t.from, t.to, t.method))
  val states = (trans.map(_.from) ++ trans.map(_.to)).distinct.filter(_.nonEmpty)
  R(s"states = ${states.size}: ${states.take(12).mkString(", ")}")
  R(s"transitions = ${trans.size}")
  trans.take(12).foreach(t => R(s"  ${t.from} -> ${t.to}  (${t.method})"))

  if (states.isEmpty) { R("no status states recovered for field='" + field + "'"); return }

  joerny.step("recover lifecycle") {
    val stateNodes = states.map { s =>
      val shape = if (s == "(start)") "terminal" else "process"
      joerny.Node("state:" + s, s, "state", Map("shape" -> shape))
    }
    val edges = trans.zipWithIndex.map { case (t, i) =>
      joerny.Edge("state:" + t.from, "state:" + t.to, "transition",
        Map("label" -> t.method, "guard" -> t.guard, "loc" -> t.loc))
    }
    joerny.graph(s"lifecycle: $field")
      .id("lifecycle-" + f)
      .flowchart("LR")
      .narrate("State machine recovered from writes to the '" + field + "' field. Nodes = states " +
        "(status values assigned in code); edges = transitions, labelled with the method that performs " +
        "them and the guard that gates them, each with file:line. Mechanical — no LLM inferred a transition.")
      .nodes(stateNodes)
      .edges(edges)
      .emit()

    val rows = trans.sortBy(t => (t.from, t.to)).map(t => List(t.from, t.to, t.method, t.guard, t.loc))
    joerny.table(s"lifecycle transitions: $field")
      .id("lifecycle-" + f + "-table")
      .from("lifecycle-" + f)
      .narrate("Every recovered transition with the method + guard that performs it and its source location.")
      .columns("from", "to", "method", "guard", "loc")
      .rows(rows)
      .emit()
  }
  R("done")
}
