//> using file joerny.sc

// requirements.sc — an EXPERIMENT, not a fixed pipeline.
//
// Goal: compile *ground facts* from the CPG mechanically, phrase them as PRD/BRD
// requirement statements from deterministic templates (no LLM prose here), and
// keep every requirement back-traceable to the exact code fact it came from —
// with a mechanical faithfulness GATE that flags any requirement whose citation
// doesn't resolve or whose named tables aren't actually in the cited evidence.
//
// The LLM's job downstream is only to rename/prioritise/translate — never to
// invent tables, queues, or conditions. Those arrive pre-compiled, with ids.
//
// Facts → requirement → code, all cited:
//   capabilities (receiver TYPE @ depth 3) → integration requirements
//   SQL tables (prepareStatement literals)  → data requirements
//   connected flow steps (+ CDG guards)     → functional requirements + business rules
//
// Params: cpgPath (the CPG) and repoRoot (source tree, to resolve code snippets
// the CPG doesn't store — javasrc2cpg keeps line numbers, not file content).

import io.shiftleft.codepropertygraph.generated.nodes.Method

@main def run(cpgPath: String, repoRoot: String): Unit = {
  importCpg(cpgPath)
  def R(s: String): Unit = println("RESULT " + s)

  // ---- source resolution (CPG stores line numbers, not content) ------------
  def snippet(fileRel: String, a: Int, b: Int): String = {
    try {
      val f = new java.io.File(repoRoot, fileRel)
      if (!f.exists) "" else {
        val src = scala.io.Source.fromFile(f, "UTF-8")
        val lines = try src.getLines().toVector finally src.close()
        val lo = math.max(a - 1, 0)
        val hi = math.min(math.min(b, lines.size), lo + 40)
        lines.slice(lo, hi).mkString("\n")
      }
    } catch { case _: Throwable => "" }
  }
  def methodSnippet(m: Method): String =
    snippet(m.filename, m.lineNumber.getOrElse(1), m.lineNumberEnd.getOrElse(m.lineNumber.getOrElse(1) + 1))
  def methodLoc(m: Method): String =
    m.filename + ":" + m.lineNumber.getOrElse(0)

  // ---- own code + entry points ---------------------------------------------
  val ownMethods = cpg.method.isExternal(false).filterNot(_.name.startsWith("<")).l
  val ownFn = ownMethods.map(_.fullName).toSet
  val entries = ownMethods.filter(_.name == "main").sortBy(_.fullName)
  def jobName(m: Method): String = m.typeDecl.name.headOption.getOrElse("?")

  def reach3(m: Method): List[Method] = {
    val d1 = m.callee.l; val d2 = d1.flatMap(_.callee.l); val d3 = d2.flatMap(_.callee.l)
    (d1 ++ d2 ++ d3).distinctBy(_.fullName)
  }

  // ---- behavior taxonomy (receiver TYPE, never method name) ----------------
  val behaviors: List[(String, List[String])] = List(
    "DB-JDBC"   -> List("java.sql.Connection", "java.sql.Statement", "java.sql.PreparedStatement",
                        "java.sql.CallableStatement", "java.sql.ResultSet", "java.sql.DriverManager",
                        "javax.sql.DataSource", "javax.sql.ConnectionPoolDataSource"),
    "MQ"        -> List("javax.jms.", "org.apache.activemq"),
    "EMAIL"     -> List("javax.mail.", "org.springframework.mail"),
    "SFTP"      -> List("com.jcraft.jsch"),
    "FILE"      -> List("java.io.File", "java.io.FileWriter", "java.io.FileOutputStream", "java.io.BufferedWriter", "java.io.FileReader"),
    "XML"       -> List("org.w3c.dom.", "javax.xml.parsers", "org.xml.sax")
  )
  def behaviorOf(fn: String): Option[String] =
    behaviors.collectFirst { case (b, ps) if ps.exists(fn.startsWith) => b }
  val capHuman: Map[String, String] = Map(
    "DB-JDBC" -> "a relational database over JDBC",
    "MQ"      -> "a JMS message broker",
    "EMAIL"   -> "an email/SMTP gateway",
    "SFTP"    -> "a remote host over SFTP",
    "FILE"    -> "the local file system",
    "XML"     -> "XML document processing"
  )

  // ---- SQL cache: method -> tables (read/write) + concatenated query --------
  val sqlMethods = cpg.method.isExternal(false)
    .where(_.ast.isCall.name("prepareStatement|executeQuery|executeUpdate|execute|createStatement")).l
  val readRe  = "(?i)(?:FROM|JOIN)\\s+([A-Za-z_][A-Za-z0-9_]*)".r
  val writeRe = "(?i)(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+([A-Za-z_][A-Za-z0-9_]*)".r
  val stop = Set("ERROR", "DUAL", "WHERE", "SELECT", "SET", "VALUES", "AND", "OR")
  def concatSql(m: Method): String =
    m.ast.isLiteral.sortBy(_.lineNumber.getOrElse(0)).code.l
      .filter(c => c != "null" && c.trim.nonEmpty).map(_.stripPrefix("\"").stripSuffix("\"")).mkString(" ").trim
  case class SqlHit(method: Method, table: String, mode: String, query: String)
  val sqlHits = sqlMethods.flatMap { m =>
    val q = concatSql(m)
    (readRe.findAllMatchIn(q).map(x => SqlHit(m, x.group(1).toUpperCase, "read", q)).toList ++
     writeRe.findAllMatchIn(q).map(x => SqlHit(m, x.group(1).toUpperCase, "write", q)).toList)
      .filter(h => h.table.length > 2 && !stop.contains(h.table))
  }.distinctBy(h => (h.method.fullName, h.table, h.mode))
  val tables = sqlHits.map(_.table).distinct.sorted
  R(s"tables=[${tables.mkString(",")}] sqlMethods=${sqlMethods.size} hits=${sqlHits.size}")

  // ---- FACT REGISTRY (everything a requirement may cite) --------------------
  case class Fact(fid: String, label: String, kind: String, detail: String, source: String, loc: String)
  val facts = scala.collection.mutable.LinkedHashMap.empty[String, Fact]
  def addFact(f: Fact): String = { if (!facts.contains(f.fid)) facts(f.fid) = f; f.fid }

  // capability facts (per entry, proven by a concrete callee receiver type)
  val entryCaps = entries.map { m =>
    val reached = reach3(m)
    val caps = behaviors.map(_._1).flatMap { b =>
      reached.map(_.fullName).find(fn => behaviorOf(fn).contains(b)).map(fn => (b, fn))
    }
    caps.foreach { case (c, fn) =>
      addFact(Fact(s"cap:$c", capHuman.getOrElse(c, c), "fact-capability",
        s"reached a callee on type carrier for $c: $fn", "", ""))
    }
    (m, caps.map(_._1))
  }

  // table facts
  tables.foreach { t =>
    val forT = sqlHits.filter(_.table == t)
    val modes = forT.map(_.mode).distinct.sorted.mkString("/")
    val dao = forT.head.method
    addFact(Fact(s"tbl:$t", t, "fact-table",
      s"$modes via ${jobName(dao)}.${dao.name}: ${forT.map(_.query).distinct.head.take(180)}",
      methodSnippet(dao), methodLoc(dao)))
  }

  // ---- connected flow steps for the richest entry (most tables reached) -----
  val sqlMethodFn = sqlMethods.map(_.fullName).toSet
  val sqlByMethod = sqlMethods.map(m => m.fullName -> concatSql(m)).toMap
  def reachedTables(m: Method): Set[String] = {
    val reachedFn = reach3(m).map(_.fullName).toSet
    sqlHits.filter(h => reachedFn.contains(h.method.fullName)).map(_.table).toSet
  }
  // Exclude demo/test harnesses — the golden guide validates entry points against
  // ground truth; a *Demo/*Test main is not a production job even if it touches the most tables.
  val realEntries = entries.filterNot(m => jobName(m).matches("(?i).*(demo|test).*"))
  val flowEntry = (if (realEntries.nonEmpty) realEntries else entries)
    .map(m => (m, reachedTables(m).size, reach3(m).count(r => ownFn.contains(r.fullName))))
    .sortBy(t => (-t._2, -t._3)).headOption.map(_._1)
  R("flowEntry=" + flowEntry.map(m => jobName(m) + "." + m.name))

  val noise = List("java.io.PrintStream", "Logger", "java.lang.String", "java.lang.StringBuilder", "java.util.")
  def flowCalls(m: Method) =
    m.ast.isCall.filterNot(_.name.startsWith("<operator>"))
      .filterNot(c => noise.exists(c.methodFullName.contains)).l.sortBy(_.lineNumber.getOrElse(0))
  case class Step(sid: String, name: String, guard: String, tgt: String, sql: String, tag: String, line: Int)
  val steps = scala.collection.mutable.ListBuffer.empty[Step]
  flowEntry.foreach { fm =>
    // A connected flow, source order: the entry's own calls, and — because a real
    // job's main() often just delegates — one level EXPANDED into each own-code
    // callee it invokes (the golden guide's [EXPAND]). Capped so it stays readable.
    val seeds = fm :: flowCalls(fm).map(_.methodFullName).distinct
      .flatMap(fn => cpg.method.fullNameExact(fn).headOption).filter(m => ownFn.contains(m.fullName))
    val raw = seeds.flatMap(flowCalls).distinctBy(c => (c.methodFullName, c.lineNumber.getOrElse(0))).take(40)
    raw.zipWithIndex.foreach { case (c, i) =>
      val sid = f"step-$i%02d"
      // Keep only real predicates (comparison/logical/boolean-ish calls); the raw
      // CDG guard set can include side-effecting calls that aren't conditions.
      val guard = try c.controlledBy.isCall
        .name("<operator>\\.(equals|notEquals|lessThan|greaterThan|lessEqualsThan|greaterEqualsThan|logicalAnd|logicalOr|logicalNot|not)|equals|contains|isEmpty|isPresent|matches|startsWith|endsWith|isNull|nonEmpty")
        .code.l.distinct.take(3).mkString(" ∧ ") catch { case _: Throwable => "" }
      val tgt = c.methodFullName
      val tag = if (!ownFn.contains(tgt)) "EXTERNAL" else "OWN"
      val sql = sqlByMethod.getOrElse(tgt, "")
      steps += Step(sid, c.name, guard, tgt, sql, tag, c.lineNumber.getOrElse(0))
      val tgtM = cpg.method.fullNameExact(tgt).headOption
      val src = tgtM.filter(_ => ownFn.contains(tgt)).map(methodSnippet).getOrElse("")
      val loc = tgtM.map(methodLoc).getOrElse(methodLoc(fm))
      val detail = List(
        s"call: ${c.name}()  →  $tgt",
        if (guard.nonEmpty) s"guard (CDG): $guard" else "guard: (unconditional)",
        if (sql.nonEmpty) s"SQL: $sql" else ""
      ).filter(_.nonEmpty).mkString("\n")
      addFact(Fact(sid, s"${c.name}()", "fact-flow", detail, src, loc))
    }
  }

  // ---- REQUIREMENT GENERATION (deterministic templates, cited by id) --------
  case class Req(rid: String, kind: String, text: String, cites: List[String], injected: Boolean = false)
  val reqs = scala.collection.mutable.ListBuffer.empty[Req]
  var frn, irn, drn, brn = 0
  def nextId(p: String): String = p match {
    case "FR" => frn += 1; f"FR-$frn%02d"; case "IR" => irn += 1; f"IR-$irn%02d"
    case "DR" => drn += 1; f"DR-$drn%02d"; case _    => brn += 1; f"BR-$brn%02d"
  }

  // FR — one per entry job, listing its proven capabilities
  entryCaps.foreach { case (m, caps) =>
    val capPhrase = if (caps.isEmpty) "in-process orchestration only"
                    else caps.map(c => capHuman.getOrElse(c, c)).mkString(", ")
    reqs += Req(nextId("FR"), "Functional",
      s"The ${jobName(m)} job SHALL run as a standalone entry point, using $capPhrase.",
      caps.map(c => s"cap:$c"))
  }
  // FR — per significant flow step of the richest job (guard and/or SQL)
  val jn = flowEntry.map(jobName).getOrElse("the job")
  steps.filter(s => s.guard.nonEmpty || s.sql.nonEmpty).foreach { s =>
    val tbls = sqlHits.filter(h => h.method.fullName == s.tgt).map(_.table).distinct
    val when = if (s.guard.nonEmpty) s"when `${s.guard}`, " else ""
    val doing = if (tbls.nonEmpty) s"${s.name}, accessing the ${tbls.mkString(", ")} table(s)" else s.name
    reqs += Req(nextId("FR"), "Functional",
      s"In $jn, ${when}the system SHALL $doing.",
      s.sid :: tbls.map(t => s"tbl:$t"))
  }
  // IR — per distinct capability across the system
  facts.values.filter(_.kind == "fact-capability").map(_.fid).toList.distinct.sorted.foreach { fid =>
    val c = fid.stripPrefix("cap:")
    reqs += Req(nextId("IR"), "Integration",
      s"The system SHALL integrate with ${capHuman.getOrElse(c, c)}.", List(fid))
  }
  // DR — per table
  tables.foreach { t =>
    val modes = sqlHits.filter(_.table == t).map(_.mode).distinct.sorted
    val verb = if (modes == List("read")) "read from" else if (modes == List("write")) "persist to" else "read from and persist to"
    reqs += Req(nextId("DR"), "Data",
      s"The system SHALL $verb the $t table.", List(s"tbl:$t"))
  }
  // BR — per distinct non-trivial guard in the flow
  steps.filter(_.guard.nonEmpty).map(s => (s.guard, s)).distinctBy(_._1).foreach { case (g, s) =>
    reqs += Req(nextId("BR"), "Business rule",
      s"$jn SHALL ${s.name} only when `$g` holds.", List(s.sid))
  }

  // Injected "LLM-style" claims — ONLY to demonstrate the gate catches them.
  reqs += Req(nextId("DR"), "Data",
    "The system SHALL persist to the PAYMENTS table for settlement.", List("tbl:PAYMENTS"), injected = true)
  reqs += Req(nextId("FR"), "Functional",
    s"The $jn job SHALL write settlement rows to the SETTLEMENTS table.",
    (facts.values.find(_.kind == "fact-flow").map(_.fid).toList), injected = true)

  // ---- MECHANICAL FAITHFULNESS GATE ----------------------------------------
  val tokenRe = "[A-Z][A-Z0-9_]{3,}".r
  def statusOf(r: Req): (String, String) = {
    val missing = r.cites.filterNot(facts.contains)
    if (missing.nonEmpty) return ("UNSUPPORTED", s"cites unknown fact(s): ${missing.mkString(", ")}")
    val evidence = r.cites.flatMap(facts.get).map(f => (f.detail + " " + f.label + " " + f.source).toUpperCase).mkString(" ")
    val claimed = tokenRe.findAllIn(r.text).toList.distinct
      .filterNot(t => Set("SHALL", "SFTP", "JDBC", "SMTP", "JMS", "XML").contains(t))
    val unbacked = claimed.filterNot(evidence.contains)
    if (unbacked.nonEmpty) ("UNVERIFIED", s"tokens not found in cited evidence: ${unbacked.mkString(", ")}")
    else ("SUPPORTED", "all citations resolve; named tokens appear in evidence")
  }
  val graded = reqs.toList.map(r => (r, statusOf(r)))
  val bySt = graded.groupBy(_._2._1).view.mapValues(_.size).toMap
  R(s"requirements=${reqs.size} status=" + bySt.toList.sortBy(_._1).map { case (s, n) => s"$s×$n" }.mkString(","))

  // ---- EMIT: requirements graph (reqs + cited facts + cites edges) ----------
  def statusType(s: String): String = s match {
    case "SUPPORTED" => "requirement"; case "UNVERIFIED" => "req-unverified"; case _ => "req-unsupported"
  }
  val reqNodes = graded.map { case (r, (st, why)) =>
    joerny.Node(r.rid, r.rid, statusType(st), Map(
      "requirement" -> r.text, "reqType" -> r.kind, "status" -> st, "gate" -> why,
      "cites" -> r.cites.mkString(", "), "note" -> (if (r.injected) "INJECTED to demonstrate the gate" else "")))
  }
  val citedFactIds = reqs.flatMap(_.cites).toSet
  val factNodes = facts.values.filter(f => citedFactIds.contains(f.fid)).map { f =>
    joerny.Node(f.fid, f.label, f.kind, Map(
      "detail" -> f.detail, "source" -> f.source, "loc" -> f.loc).filter(_._2.toString.nonEmpty))
  }.toList
  val citeEdges = graded.flatMap { case (r, _) =>
    r.cites.filter(facts.contains).map(c => joerny.Edge(r.rid, c, "cites"))
  }
  val citeMaps = graded.flatMap { case (r, _) =>
    r.cites.flatMap(facts.get).map(f => joerny.Mapping(r.rid, f.fid, f.detail.replace("\n", " · ").take(160)))
  }
  joerny.graph("requirements").from("flow-tree").from("data-access")
    .narrate(s"${reqs.size} requirements compiled from CPG facts (not the LLM). Each cites the code fact it came from; a mechanical gate flags any whose citation doesn't resolve (UNSUPPORTED) or whose named tables aren't in the cited evidence (UNVERIFIED). Select a fact node to read its source. Status: " +
      bySt.toList.sortBy(_._1).map { case (s, n) => s"$s=$n" }.mkString(", ") + ".")
    .nodes(reqNodes ++ factNodes).edges(citeEdges).map(citeMaps: _*).emit()

  // ---- EMIT: coverage graph (entries + capabilities + SQL methods: covered vs gap)
  // The valuable RTM direction is *code with no requirement*: a DB-touching method
  // is "covered" only if a cited fact's evidence actually names it (Class.method),
  // otherwise it's a gap the mechanical facts found but no requirement explains yet.
  val citedEvidence = citedFactIds.toList.flatMap(facts.get)
    .map(f => f.detail + " " + f.source + " " + f.label).mkString(" \n ")
  def declName(m: Method): String = m.typeDecl.name.headOption.getOrElse("?")
  val covNodes = entries.map { m =>
    val cited = reqs.exists(_.text.contains(jobName(m)))
    joerny.Node(s"job:${jobName(m)}", jobName(m), if (cited) "covered" else "gap", Map("what" -> "entry point"))
  } ++ facts.values.filter(_.kind == "fact-capability").map { f =>
    val cited = citedFactIds.contains(f.fid)
    joerny.Node(f.fid, f.label, if (cited) "covered" else "gap", Map("what" -> "capability"))
  }.toList ++ sqlMethods.distinctBy(_.fullName).map { m =>
    val sig = declName(m) + "." + m.name
    val cited = citedEvidence.contains(sig) || citedEvidence.contains(m.fullName)
    joerny.Node(s"sqlm:${m.fullName}", sig, if (cited) "covered" else "gap",
      Map("what" -> "SQL/JDBC method", "loc" -> methodLoc(m), "source" -> methodSnippet(m)).filter(_._2.nonEmpty))
  }
  val coveredN = covNodes.count(_.`type` == "covered")
  val gapN = covNodes.size - coveredN
  joerny.graph("coverage").from("requirements")
    .narrate(s"Traceability coverage over entry points, capabilities and every DB-touching method: $coveredN covered / $gapN gaps. Gaps (orange) are behaviours the mechanical facts found in code but no requirement explains yet — the 'code with no requirement' direction of an RTM. Select a gap to read the un-specified source.")
    .nodes(covNodes).edges(Nil).emit()

  // ---- EMIT: the PRD/BRD document (rendered from facts) ---------------------
  def glyph(s: String): String = s match { case "SUPPORTED" => "✓"; case "UNVERIFIED" => "⚠ UNVERIFIED"; case _ => "✗ UNSUPPORTED" }
  val sb = new StringBuilder
  sb.append(s"# Requirements — reverse-engineered from `${cpgPath.split('/').last}`\n\n")
  sb.append("Every statement below is **compiled from the CPG** and cites the code fact it came from (ids in `backticks`). ")
  sb.append("A ✓ means the citation resolves and every table/constant it names appears in that evidence; ")
  sb.append("**⚠ UNVERIFIED** / **✗ UNSUPPORTED** mark statements the mechanical gate rejected.\n\n")
  List("Functional", "Integration", "Data", "Business rule").foreach { k =>
    val group = graded.filter(_._1.kind == k)
    if (group.nonEmpty) {
      sb.append(s"## ${k} requirements\n\n")
      group.foreach { case (r, (st, _)) =>
        sb.append(s"- **${r.rid}** ${r.text} ${glyph(st)} `[${r.cites.mkString(", ")}]`")
        if (r.injected) sb.append(" _(injected to demonstrate the gate)_")
        sb.append("\n")
      }
      sb.append("\n")
    }
  }
  sb.append(s"## Coverage\n\n$coveredN of ${covNodes.size} entry points, capabilities and DB-touching methods are cited by ≥1 requirement; **$gapN gaps** remain. ")
  sb.append("See the `coverage` layer for the 'code with no requirement' gaps.\n\n")
  sb.append("## Boundaries — need a human/LLM, not the CPG\n\n")
  sb.append("The structural skeleton above is mechanical. These require meaning the code doesn't carry:\n\n")
  sb.append("- **Why** each job exists, its SLA/priority and schedule (external cron/scheduler config).\n")
  sb.append("- The **business meaning** of coded values/enums and domain terms (mark `TRANSLATE:`).\n")
  sb.append("- **External SDK/message-schema contracts** — the CPG sees the call, not the payload shape.\n")
  sb.append("- **Property-file values** and runtime DB-driven routing.\n")
  joerny.note("requirements-doc").from("requirements")
    .narrate("The rendered PRD/BRD. Prose is template-filled from facts; the LLM would only enrich phrasing/priority and resolve the Boundaries section — never invent the tables/rules above.")
    .markdown(sb.toString).emit()

  R("DONE")
}
