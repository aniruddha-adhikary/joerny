//> using file joerny.sc

// algorithm.sc — reconstruct the *algorithm* of a method as a flowchart.
//
// The other producers answer "who calls whom" (structure). This one answers
// "what actually happens to the data, step by step": it walks the method's AST
// control structure into an ordered, branching flowchart of
//   - decisions  — the control-flow guards (if / while / for / switch conditions)
//   - processes  — data operations (assignments, own-code calls)
//   - io         — external side effects (DB / queue / file / network)
//   - terminals  — start / return / end
// connected by branch-labelled edges (yes / no / loop / exit / on error).
//
// It is 100% mechanical (reconstructed from the CPG's AST + control structures),
// so it is ground truth, not an LLM's paraphrase of the code. When you ask for a
// specific algorithm from a higher-level module, it also drills one level down:
// every own-code call becomes its own derived flowchart layer (lineage), mapped
// back to the exact call site — so you can trace the transformation across layers.
//
// Usage (inside Joern):
//   :load joern/algorithm.sc
//   run(cpgPath = "/abs/cpg.bin", entry = "processOrder", focusType = "Order")
// `entry` matches a method by name/fullName substring; omit to auto-pick the
// own method with the richest control flow. `focusType` (optional) rings every
// step that touches that data type so you can follow the declaration's data.

import io.shiftleft.codepropertygraph.generated.nodes.{AstNode, Block, Call, ControlStructure, Method, Return}

@main def run(cpgPath: String, entry: String = "", focusType: String = "", maxCallees: Int = 6): Unit = {
  importCpg(cpgPath)
  def R(s: String): Unit = println("RESULT " + s)

  val own = cpg.method.isExternal(false).filterNot(_.name.startsWith("<")).l
  val ownFn = own.map(_.fullName).toSet

  // ---- pick the entry method ------------------------------------------------
  val entryMethod: Option[Method] =
    if (entry.nonEmpty)
      own.filter(m => m.fullName.contains(entry) || m.name == entry).sortBy(-_.controlStructure.size).headOption
    else
      own.filterNot(_.name.matches("(?i).*(demo|test).*"))
        .map(m => (m, m.controlStructure.size)).filter(_._2 >= 2).sortBy(-_._2).headOption.map(_._1)

  if (entryMethod.isEmpty) { R("no suitable method found for entry='" + entry + "'"); return }
  val root = entryMethod.get
  R("algorithm entry = " + root.fullName + "  (controlStructures=" + root.controlStructure.size + ")")

  // ---- helpers --------------------------------------------------------------
  // The data type to follow through the flow: an explicit focusType, else the
  // first domain-typed parameter (not primitive / java.* / String).
  def isDomainType(t: String): Boolean =
    t.nonEmpty && !t.startsWith("java.") && !t.startsWith("scala.") &&
      !t.startsWith("javax.") && !Set("int","long","double","float","boolean","char","byte","short","void").contains(t) &&
      t != "java.lang.String" && !t.contains("<")
  val focus: String =
    if (focusType.nonEmpty) focusType
    else root.parameter.filterNot(_.name == "this").typeFullName.filter(isDomainType).headOption.getOrElse("")
  val focusSimple = if (focus.contains(".")) focus.substring(focus.lastIndexOf('.') + 1) else focus
  if (focus.nonEmpty) R("following data type: " + focus)

  // Calls that are pure noise for an algorithm read — logging, string plumbing,
  // reflection — treated as transparent so the flowchart shows real operations.
  val noise = List("println","print","log","Logger","toString","valueOf","format","append",
    "StringBuilder","getClass","hashCode","<operator>","currentTimeMillis","nanoTime")
  def isNoise(name: String, full: String): Boolean =
    noise.exists(n => name.contains(n)) || List("java.io.PrintStream","Logger","java.lang.String","java.lang.StringBuilder")
      .exists(full.contains)

  // I/O side effects, by the callee's owning type (receiver) — the same
  // behaviour-from-structure taxonomy the other producers use.
  val ioCarriers = List("java.sql.Connection","java.sql.Statement","java.sql.PreparedStatement","java.sql.ResultSet",
    "javax.jms","com.jcraft.jsch","java.io.File","java.nio.file","java.net.","HttpClient","URLConnection",
    "org.springframework.jdbc","javax.persistence","org.hibernate")
  def isIo(full: String): Boolean = ioCarriers.exists(full.contains)

  def clean(s: String): String = s.replaceAll("\\s+", " ").trim
  def short(s: String, n: Int = 64): String = { val c = clean(s); if (c.length > n) c.take(n - 1) + "…" else c }
  def touchesFocus(n: AstNode): Boolean = {
    if (focus.isEmpty) false
    else try n.ast.isIdentifier.typeFullName.exists(t => t == focus || t.endsWith("." + focusSimple)) ||
      (focusSimple.nonEmpty && n.code.contains(focusSimple)) catch { case _: Throwable => false }
  }

  def kids(n: AstNode): List[AstNode] = try n.astChildren.l.sortBy(_.order) catch { case _: Throwable => Nil }

  // ---- the flowchart builder (per method) -----------------------------------
  // Reconstructs a structured flowchart by folding the method's AST blocks.
  // A fragment is (entry node, dangling exits) where each exit carries the label
  // for the edge that will connect it to whatever comes next.
  class FlowBuild(m: Method, slug: String) {
    val srcFile: String = { val f = m.filename; if (f.nonEmpty && f != "<empty>") f else m.fullName }
    def loc(n: AstNode): String = srcFile + ":" + n.lineNumber.map(_.toString).getOrElse("?")
    val nodes = scala.collection.mutable.LinkedHashMap.empty[String, joerny.Node]
    val edges = scala.collection.mutable.ListBuffer.empty[joerny.Edge]
    // callee fullName -> (parent node id at the call site, evidence)
    val callSites = scala.collection.mutable.LinkedHashMap.empty[String, (String, String)]

    case class Frag(entry: Option[String], exits: List[(String, String)])
    val transparent = Frag(None, Nil)

    def nid(n: AstNode): String = s"$slug#${n.id}"
    def addNode(id: String, label: String, shape: String, focusFlag: Boolean, at: AstNode = null): String = {
      if (!nodes.contains(id)) {
        val locProps: Map[String, Any] =
          if (at != null) Map("loc" -> loc(at)) else Map.empty
        nodes(id) = joerny.Node(id, label, shape,
          Map("shape" -> shape) ++ locProps ++ (if (focusFlag) Map("focus" -> true) else Map.empty))
      }
      id
    }
    def addEdge(src: String, dst: String, label: String): Unit =
      edges += joerny.Edge(src, dst, if (label.isEmpty) null else label)

    def connect(exits: List[(String, String)], to: String): Unit =
      exits.foreach { case (src, lbl) => addEdge(src, to, lbl) }

    // Fold a sequence of statements into one fragment, chaining significant ones.
    def walkBlock(stmts: List[AstNode]): Frag = {
      var entry: Option[String] = None
      var pending: List[(String, String)] = Nil
      var carried: List[(String, String)] = Nil // exits inherited when block starts transparent
      for (s <- stmts) {
        val f = walkStmt(s)
        f.entry match {
          case Some(e) =>
            connect(pending, e)
            if (entry.isEmpty) entry = Some(e)
            pending = f.exits
          case None =>
            // transparent statement: keep whatever exits we already had
            carried = carried ++ f.exits
        }
      }
      Frag(entry, if (pending.nonEmpty) pending else carried)
    }

    def blockStmts(n: AstNode): List[AstNode] = kids(n).flatMap {
      case b: Block => kids(b)
      case other    => List(other)
    }

    def walkStmt(s: AstNode): Frag = s match {
      case cs: ControlStructure => walkControl(cs)
      case r: Return =>
        val id = addNode(nid(r), short(r.code, 40), "terminal", touchesFocus(r), r)
        Frag(Some(id), Nil) // a return terminates this path
      case c: Call if c.name == "<operator>.assignment" => walkAssignment(c)
      case c: Call if c.name.startsWith("<operator>")    => transparent
      case c: Call                                       => walkCall(c)
      case _                                             => transparent
    }

    def walkControl(cs: ControlStructure): Frag = {
      val cst = cs.controlStructureType
      cst match {
        case "IF" =>
          val cond = try cs.condition.code.headOption.map(short(_, 70)).getOrElse("?") catch { case _: Throwable => "?" }
          val d = addNode(nid(cs), cond, "decision", touchesFocus(cs), cs)
          val tStmts = try cs.whenTrue.flatMap(kids).l catch { case _: Throwable => Nil }
          val fStmts = try cs.whenFalse.flatMap(kids).l catch { case _: Throwable => Nil }
          val tFrag = walkBlock(tStmts)
          val tExits = tFrag.entry match {
            case Some(e) => addEdge(d, e, "yes"); tFrag.exits
            case None    => List((d, "yes"))
          }
          if (fStmts.nonEmpty) {
            val fFrag = walkBlock(fStmts)
            val fExits = fFrag.entry match {
              case Some(e) => addEdge(d, e, "no"); fFrag.exits
              case None    => List((d, "no"))
            }
            Frag(Some(d), tExits ++ fExits)
          } else Frag(Some(d), tExits :+ ((d, "no")))

        case "WHILE" | "FOR" | "DO" =>
          val cond = try cs.condition.code.headOption.map(short(_, 60)).getOrElse(cst.toLowerCase) catch { case _: Throwable => cst.toLowerCase }
          val d = addNode(nid(cs), s"$cst  $cond", "decision", touchesFocus(cs), cs)
          val body = try cs.astChildren.isBlock.l.lastOption.map(kids).getOrElse(Nil) catch { case _: Throwable => Nil }
          val bFrag = walkBlock(body)
          bFrag.entry match {
            case Some(e) => addEdge(d, e, "loop"); connect(bFrag.exits, d) // loop back
            case None    => addEdge(d, d, "loop")
          }
          Frag(Some(d), List((d, "exit")))

        case "SWITCH" =>
          val sel = try cs.condition.code.headOption.map(short(_, 40)).getOrElse("") catch { case _: Throwable => "" }
          val d = addNode(nid(cs), s"switch  $sel", "decision", touchesFocus(cs), cs)
          val body = try cs.astChildren.isBlock.l.lastOption.map(kids).getOrElse(Nil) catch { case _: Throwable => Nil }
          val bFrag = walkBlock(body)
          bFrag.entry.foreach(e => addEdge(d, e, "case"))
          Frag(Some(d), if (bFrag.exits.nonEmpty) bFrag.exits else List((d, "")))

        case "TRY" =>
          val blocks = try cs.astChildren.isBlock.l catch { case _: Throwable => Nil }
          val tFrag = walkBlock(blocks.headOption.map(kids).getOrElse(Nil))
          var allExits = tFrag.exits
          blocks.drop(1).foreach { cb =>
            val cFrag = walkBlock(kids(cb))
            cFrag.entry.foreach(e => tFrag.entry.foreach(te => addEdge(te, e, "on error")))
            allExits = allExits ++ cFrag.exits
          }
          Frag(tFrag.entry, allExits)

        case "BREAK" | "CONTINUE" =>
          val id = addNode(nid(cs), cst.toLowerCase, "terminal", false)
          Frag(Some(id), Nil)

        case _ =>
          // Unknown structure: walk its blocks transparently so nothing is lost.
          walkBlock(try cs.astChildren.isBlock.l.flatMap(kids) catch { case _: Throwable => Nil })
      }
    }

    // An assignment is a "data operation" worth showing only if it transforms
    // data via a (non-noise) call, writes a field, or touches the focus type —
    // trivial `x = null` / `x = literal` plumbing is dropped so the flow stays legible.
    def walkAssignment(c: Call): Frag = {
      val rhsCalls = try c.argument(2).ast.isCall.filterNot(_.name.startsWith("<operator>")).filterNot(x => isNoise(x.name, x.methodFullName)).l catch { case _: Throwable => Nil }
      val isFieldWrite = try c.argument(1).start.isCall.name("<operator>.fieldAccess").nonEmpty catch { case _: Throwable => false }
      val focusFlag = touchesFocus(c)
      if (rhsCalls.isEmpty && !isFieldWrite && !focusFlag) transparent
      else {
        val id = addNode(nid(c), short(c.code, 64), "process", focusFlag, c)
        // A domain call on the RHS is a drill-down point → record the call site.
        rhsCalls.headOption.foreach { rc => recordCallee(rc, id) }
        Frag(Some(id), List((id, "")))
      }
    }

    def walkCall(c: Call): Frag = {
      if (isNoise(c.name, c.methodFullName)) transparent
      else {
        val shape = if (isIo(c.methodFullName)) "io" else "process"
        val focusFlag = touchesFocus(c)
        val id = addNode(nid(c), short(c.code, 64), shape, focusFlag, c)
        recordCallee(c, id)
        Frag(Some(id), List((id, "")))
      }
    }

    def recordCallee(c: Call, parentNodeId: String): Unit = {
      val full = c.methodFullName
      if (ownFn.contains(full) && !callSites.contains(full))
        callSites(full) = (parentNodeId, s"call site: ${short(c.code, 60)} @ ${loc(c)}")
    }

    def build(): Unit = {
      val start = addNode(s"$slug#start", "▶ " + m.name, "terminal", false)
      val bodyStmts = try m.block.astChildren.l.sortBy(_.order) catch { case _: Throwable => Nil }
      val frag = walkBlock(bodyStmts)
      frag.entry match {
        case Some(e) => addEdge(start, e, "")
        case None    => // empty body
      }
      if (frag.exits.nonEmpty) {
        val end = addNode(s"$slug#end", "■ end", "terminal", false)
        connect(frag.exits, end)
      }
    }
  }

  def slugOf(m: Method): String =
    (m.typeDecl.name.headOption.getOrElse("") + "." + m.name).replaceAll("[^A-Za-z0-9]+", "-").replaceAll("(^-+|-+$)", "").toLowerCase

  def buildFor(m: Method): FlowBuild = { val b = new FlowBuild(m, slugOf(m)); b.build(); b }

  // ---- emit the entry algorithm ---------------------------------------------
  val rootSlug = slugOf(root)
  val rootBuild = buildFor(root)
  val rootLayerId = "algo-" + rootSlug
  joerny.step("reconstruct algorithm") {
    joerny.graph(s"algorithm: ${root.name}")
      .id(rootLayerId)
      .flowchart("TB")
      .narrate(s"Step-by-step control flow of ${root.name}: guards (diamonds), data ops (rectangles), I/O (parallelograms). Reconstructed mechanically from the CPG AST — ground truth, not paraphrase." +
        (if (focus.nonEmpty) s" Ringed nodes touch the $focusSimple data." else ""))
      .nodes(rootBuild.nodes.values.toList)
      .edges(rootBuild.edges.toList)
      .emit()
  }
  R(s"entry flowchart: nodes=${rootBuild.nodes.size} edges=${rootBuild.edges.size} callees=${rootBuild.callSites.size}")

  // ---- drill down: one derived flowchart per own-code callee (lineage) ------
  joerny.step("drill into callees") {
    rootBuild.callSites.toList.take(maxCallees).foreach { case (calleeFn, (parentNodeId, evidence)) =>
      cpg.method.fullNameExact(calleeFn).headOption.foreach { cm =>
        val cb = buildFor(cm)
        // Only worth a layer if there's real structure to show.
        if (cb.nodes.size >= 3) {
          val cSlug = slugOf(cm)
          val cLayerId = "algo-" + cSlug
          val startId = s"$cSlug#start"
          joerny.graph(s"algorithm: ${cm.name}")
            .id(cLayerId)
            .flowchart("TB")
            .from(rootLayerId)
            .narrate(s"Called by ${root.name}. Its own step-by-step algorithm.")
            .nodes(cb.nodes.values.toList)
            .edges(cb.edges.toList)
            // Map the parent's call-site node → this callee's start, evidence = the call site.
            .map(joerny.Mapping(parentNodeId, startId, evidence))
            .emit()
          R(s"  callee flowchart: ${cm.name} nodes=${cb.nodes.size} (from $parentNodeId)")
        }
      }
    }
  }

  R("done")
}
