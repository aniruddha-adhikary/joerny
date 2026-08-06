//> using file joerny.sc

// Malleable experiments — the SAME projection primitives run against ANY Java
// CPG. Nothing is hardcoded to one codebase: own-code is the CPG's isExternal
// flag (not a package string), entry points fall back to call-graph roots when
// there's no main(), and behavior is proven by callee RECEIVER TYPE — extended
// to frameworks (JPA / MyBatis / Spring-Web) so real apps classify too.
//
// Stages (each a joerny projection primitive, driven by graph structure):
//   1 entry points   2 behavioral flags(#1)   3 unknown count
//   4 SQL tables + domain clusters(#3)   5 capability blocks(#1/#2)
//   6 connected flow tree(#5 enriched)

import io.shiftleft.codepropertygraph.generated.nodes.Method

@main def run(cpgPath: String): Unit = {
  importCpg(cpgPath)
  def R(s: String): Unit = println("RESULT " + s)
  R(s"cpg=$cpgPath methods=${cpg.method.size} types=${cpg.typeDecl.size} calls=${cpg.call.size} literals=${cpg.literal.size}")

  // behavior taxonomy keyed on the callee's OWNING TYPE (receiver), not name.
  val behaviors: List[(String, List[String])] = List(
    "DB-JDBC"   -> List("java.sql.", "javax.sql."),
    "ORM/JPA"   -> List("javax.persistence", "jakarta.persistence", "org.hibernate", "org.springframework.data", "org.springframework.orm"),
    "MYBATIS"   -> List("org.apache.ibatis", "org.mybatis"),
    "MQ"        -> List("javax.jms.", "org.apache.activemq"),
    "EMAIL"     -> List("javax.mail.", "org.springframework.mail"),
    "SFTP"      -> List("com.jcraft.jsch"),
    "FILE"      -> List("java.io.File", "java.io.FileWriter", "java.io.FileOutputStream", "java.io.BufferedWriter", "java.io.FileReader"),
    "HTTP/WEB"  -> List("javax.servlet.", "jakarta.servlet.", "org.springframework.web", "org.springframework.ui", "org.springframework.stereotype"),
    "XML"       -> List("org.w3c.dom.", "javax.xml.parsers", "org.xml.sax"),
    "SOAP"      -> List("org.apache.axis", "javax.xml.soap"),
    "VALIDATION"-> List("javax.validation", "jakarta.validation")
  )
  def behaviorOf(fn: String): Option[String] =
    behaviors.collectFirst { case (b, ps) if ps.exists(fn.startsWith) => b }

  def reach3(m: Method): List[Method] = {
    val d1 = m.callee.l
    val d2 = d1.flatMap(_.callee.l)
    val d3 = d2.flatMap(_.callee.l)
    (d1 ++ d2 ++ d3).distinctBy(_.fullName)
  }

  // own-code from the CPG itself; entry points = main(), else call-graph roots.
  // A framework app can have a trivial main() that (via DI/reflection) reaches
  // almost no own code — so only trust main() if it actually reaches into the app.
  val ownMethods = cpg.method.isExternal(false).filterNot(_.name.startsWith("<")).l
  val ownFn = ownMethods.map(_.fullName).toSet
  val mains = ownMethods.filter(_.name == "main")
  val roots = ownMethods.filter(m => m.caller.fullName.l.forall(fn => !ownFn.contains(fn)))
  val mainReach = mains.map(m => reach3(m).count(r => ownFn.contains(r.fullName))).maxOption.getOrElse(0)
  val usedMains = mains.nonEmpty && mainReach >= 5
  val entries = (if (usedMains) mains else roots).sortBy(_.fullName)
  R(s"S1 entryMode=${if (usedMains) "main" else "call-graph-roots"} entries=${entries.size} mainReach=$mainReach")

  joerny.graph("entry-points")
    .narrate(s"${entries.size} entry points (${if (usedMains) "main() methods" else "call-graph roots — no main(), so the roots of the own-code call graph, e.g. request handlers"}).")
    .nodes(entries.take(60).map(m => joerny.Node(m.fullName, m.typeDecl.name.headOption.getOrElse("") + "." + m.name, "entrypoint")))
    .edges(Nil).emit()

  // ---- STAGE 2: behavioral classification by receiver type @ depth 3 -------
  val flagMappings = scala.collection.mutable.ListBuffer.empty[joerny.Mapping]
  val capCounts = scala.collection.mutable.LinkedHashMap.empty[String, Int]
  val epCaps = entries.map { m =>
    val reached = reach3(m)
    val caps = behaviors.map(_._1).filter(b => reached.exists(r => behaviorOf(r.fullName).contains(b)))
    caps.foreach { c =>
      capCounts(c) = capCounts.getOrElse(c, 0) + 1
      val ev = reached.map(_.fullName).find(fn => behaviorOf(fn).contains(c)).getOrElse(c)
      flagMappings += joerny.Mapping(m.fullName, s"cap:$c", s"reaches $ev")
    }
    (m, caps)
  }
  joerny.graph("behavioral-flags").from("entry-points")
    .narrate("Each entry point's capabilities, proven by the RECEIVER TYPE of a depth-3 callee (never method names). Projection edges carry the proving call.")
    .nodes(capCounts.keys.toList.map(c => joerny.Node(s"cap:$c", c, "capability")))
    .map(flagMappings.toList: _*).emit()
  joerny.table("entry-point-capabilities").from("entry-points")
    .narrate("Capability matrix (top 25 entry points).")
    .columns("entry point" :: capCounts.keys.toList: _*)
    .rows(epCaps.filter(_._2.nonEmpty).take(25).map { case (m, caps) =>
      (m.typeDecl.name.headOption.getOrElse("") + "." + m.name) :: capCounts.keys.toList.map(c => if (caps.contains(c)) "yes" else "")
    }).emit()
  R(s"S2 capabilityCounts=" + capCounts.toList.sortBy(-_._2).map { case (c, n) => s"$c×$n" }.mkString(","))

  // ---- STAGE 3: completeness / unknown count -------------------------------
  val calledExternal = cpg.call.methodFullName.l
    .filterNot(fn => ownFn.contains(fn)).filterNot(_.startsWith("<operator>")).distinct
  val (known, unknown) = calledExternal.partition(fn => behaviorOf(fn).isDefined)
  val unknownByPkg = unknown.map(_.split("[(:]").head.split('.').dropRight(1).mkString("."))
    .filter(_.nonEmpty).groupBy(identity).view.mapValues(_.size).toList.sortBy(-_._2)
  val pct = if (calledExternal.nonEmpty) unknown.size * 100.0 / calledExternal.size else 0.0
  joerny.table("unknown-behaviors").from("behavioral-flags")
    .narrate(f"Completeness check: $pct%.0f%%%% of distinct external call targets fall outside the taxonomy — the tail to widen, reported not hidden.")
    .columns("external namespace", "distinct methods")
    .rows(unknownByPkg.take(20).map { case (p, n) => List[Any](p, n) }).emit()
  R(f"S3 external=${calledExternal.size} known=${known.size} unknown=${unknown.size} ($pct%.0f%%) topUnknown=" +
    unknownByPkg.take(5).map { case (p, n) => s"$p($n)" }.mkString(","))

  // ---- STAGE 4: SQL tables + domain clusters (prepareStatement-driven) -----
  val sqlMethods = cpg.method.isExternal(false)
    .where(_.ast.isCall.name("prepareStatement|executeQuery|executeUpdate|execute|createStatement")).l
  val readRe  = "(?i)(?:FROM|JOIN)\\s+([A-Za-z_][A-Za-z0-9_]*)".r
  val writeRe = "(?i)(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+([A-Za-z_][A-Za-z0-9_]*)".r
  val stop = Set("ERROR", "DUAL", "WHERE", "SELECT", "SET", "VALUES", "AND", "OR")
  case class SqlHit(cls: String, table: String, mode: String)
  val hits = sqlMethods.flatMap { m =>
    val q = m.ast.isLiteral.sortBy(_.lineNumber.getOrElse(0)).code.mkString(" ")
    val cls = m.typeDecl.fullName.headOption.getOrElse("?")
    (readRe.findAllMatchIn(q).map(x => SqlHit(cls, x.group(1).toUpperCase, "read")).toList ++
     writeRe.findAllMatchIn(q).map(x => SqlHit(cls, x.group(1).toUpperCase, "write")).toList)
      .filter(h => h.table.length > 2 && !stop.contains(h.table))
  }.distinct
  val incidence = hits.map(h => (h.cls, h.table)).distinct
  R(s"S4 sqlMethods=${sqlMethods.size} incidence=${incidence.size} tables=[${incidence.map(_._2).distinct.sorted.mkString(",")}]")
  if (incidence.nonEmpty) {
    val tblNodes = incidence.map(_._2).distinct.map(t => joerny.Node(t, t, "table"))
    val clsNodes = incidence.map(_._1).distinct.map(c => joerny.Node(c, c.split('.').last, "class"))
    joerny.graph("data-access").from("entry-points")
      .narrate(s"class → SQL table access from SQL-executing methods only (${incidence.size} edges, ${incidence.map(_._2).distinct.size} tables). read/write edges.")
      .nodes(clsNodes ++ tblNodes).edges(hits.map(h => joerny.Edge(h.cls, h.table, h.mode)).distinct).emit()
    val bip = joerny.derive.bipartite(incidence, minShared = 1)
    joerny.graph("domain-clusters").from("data-access")
      .narrate(s"Classes coupled through shared tables → ${bip.clusters.stats.getOrElse("clusters", 0)} domain clusters (candidate service boundaries).")
      .nodes(clsNodes).project(bip.clusters).emit()
    R(s"S4 clusters=${bip.clusters.stats.getOrElse("clusters", 0)} couplingEdges=${bip.coupling.stats.getOrElse("edges", 0)}")
  } else {
    joerny.note("data-access").from("entry-points")
      .narrate("No literal SQL reachable via prepareStatement/executeQuery.")
      .markdown("**Boundary:** this codebase externalizes persistence (ORM/JPA annotations or MyBatis XML mappers), so the prepareStatement-driven SQL primitive finds nothing. The data model must come from `@Entity`/`@Table` or mapper XML — a different producer. This is where the primitive honestly *breaks* and the agent must switch technique.")
      .emit()
    R("S4 clusters=0 (no literal SQL — ORM/XML-mapper codebase)")
  }

  // ---- STAGE 5: capability blocks by fan-in (block-vs-expand) --------------
  val fan = ownMethods.map { m =>
    (m, m.caller.typeDecl.fullName.dedup.l.size, m.fullName.split(":").head.split('.').dropRight(1).mkString("."))
  }.filter(_._2 >= 5).sortBy(-_._2)
  val blockMethods = fan.map(_._1.fullName).toSet
  val blockPkgs = fan.map(_._3).distinct
  if (fan.nonEmpty) {
    joerny.graph("capability-blocks").from("entry-points")
      .narrate(s"${fan.size} methods with fan-in ≥5 distinct caller classes = shared capability blocks ([BLOCK] boundaries), in ${blockPkgs.size} packages.")
      .nodes(blockPkgs.map(p => joerny.Node(s"block:$p", p.split('.').takeRight(2).mkString("."), "block")))
      .map(fan.map { case (m, n, p) => joerny.Mapping(m.fullName, s"block:$p", s"$n distinct caller classes → BLOCK") }: _*)
      .emit()
  }
  R(s"S5 blocks(fan-in>=5)=${fan.size} in ${blockPkgs.size} packages; top=" +
    fan.take(5).map { case (m, n, _) => s"${m.name}($n)" }.mkString(","))

  // ---- STAGE 6: connected flow tree ----------------------------------------
  def concatSql(m: Method): String =
    m.ast.isLiteral.sortBy(_.lineNumber.getOrElse(0)).code.l
      .filter(c => c != "null" && c.trim.nonEmpty).map(_.stripPrefix("\"").stripSuffix("\"")).mkString(" ").trim
  val sqlByMethod = sqlMethods.map(m => m.fullName -> concatSql(m)).toMap
  val noise = List("java.io.PrintStream", "Logger", "java.lang.String", "java.lang.StringBuilder", "java.util.")
  // seed = entry point that reaches the most own methods (the richest flow)
  val flowMain = entries.map(m => (m, reach3(m).count(r => ownFn.contains(r.fullName)))).sortBy(-_._2).headOption.map(_._1)
  flowMain.foreach { fm =>
    val calls = fm.ast.isCall.filterNot(_.name.startsWith("<operator>"))
      .filterNot(c => noise.exists(c.methodFullName.contains)).l.sortBy(_.lineNumber.getOrElse(0)).take(40)
    val stepNodes = scala.collection.mutable.ListBuffer.empty[joerny.Node]
    val stepEdges = scala.collection.mutable.ListBuffer.empty[joerny.Edge]
    var prev: Option[String] = None
    calls.zipWithIndex.foreach { case (c, i) =>
      val sid = f"step-$i%02d"
      val guard = try c.controlledBy.isCall.code.l.distinct.take(3).mkString(" ∧ ") catch { case _: Throwable => "" }
      val loop  = try c.inAst.isControlStructure.controlStructureType("FOR|WHILE").code.headOption.getOrElse("") catch { case _: Throwable => "" }
      val tgt = c.methodFullName
      val tag = if (!ownFn.contains(tgt)) "EXTERNAL" else if (blockMethods.contains(tgt)) "BLOCK" else "EXPAND"
      stepNodes += joerny.Node(sid, c.name, "step", Map(
        "line" -> c.lineNumber.getOrElse(0), "tag" -> tag,
        "guard" -> (if (guard.isEmpty) "(unconditional)" else guard),
        "loop" -> (if (loop.isEmpty) "" else s"in loop: $loop"),
        "sql" -> sqlByMethod.getOrElse(tgt, ""), "target" -> tgt))
      prev.foreach(p => stepEdges += joerny.Edge(p, sid, "then"))
      prev = Some(sid)
    }
    joerny.graph("flow-tree").from("capability-blocks").from("entry-points")
      .narrate(s"Connected flow tree for ${fm.typeDecl.name.headOption.getOrElse("")}.${fm.name} — calls in source order, each with its CDG guard, loop context, inline SQL, and [BLOCK]/[EXPAND]/[EXTERNAL] tag. The 95%-implementable format; inspect a step to read its condition + query.")
      .nodes(stepNodes.toList).edges(stepEdges.toList).emit()
    R(s"S6 flow-tree for ${fm.typeDecl.name.headOption.getOrElse("?")}.${fm.name}: ${stepNodes.size} steps; tags=" +
      stepNodes.toList.groupBy(_.props.getOrElse("tag", "?")).view.mapValues(_.size).toMap.mkString(","))
  }

  R("DONE")
}
