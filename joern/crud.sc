//> using file joerny.sc

// crud.sc — WHO owns WHAT data, and where to cut module boundaries.
//
// Use case: to re-implement a system you must know which code reads/writes which
// entity (a CRUD matrix), which entity has a single writer (a clear ownership
// boundary), and which classes hold otherwise-separate groups together through
// shared data (structural cut points — natural seams to split on).
//
// Mechanically (no LLM):
//   - CRUD access = SQL verb (FROM/JOIN = read, INSERT/UPDATE/DELETE = write) on
//     the tables named in a method's concatenated `prepareStatement` literals,
//     attributed to the method's owning class. (Raw JDBC. Under JPA/ORM there is
//     no literal SQL — switch to @Entity/@Table; this producer says so and stops.)
//   - Coupling = two classes share a table (hub tables above `maxHubShare` are
//     backboned out so a ubiquitous table doesn't couple everything).
//   - Cut points = articulation vertices of that coupling graph (Tarjan): remove
//     one and a cluster splits in two → a candidate ownership boundary.
//   - Ownership = a table with exactly one writing class.
//
// Usage (inside Joern):
//   :load joern/crud.sc
//   run(cpgPath = "/abs/cpg.bin", maxHubShare = 0.5)

import io.shiftleft.codepropertygraph.generated.nodes.Method

@main def run(cpgPath: String, maxHubShare: Double = 0.5): Unit = {
  importCpg(cpgPath)
  def R(s: String): Unit = println("RESULT " + s)
  def loc(m: Method): String = m.filename + ":" + m.lineNumber.map(_.toString).getOrElse("?")

  // ---- SQL access facts (same extraction the requirements producer uses) ----
  val sqlMethods = cpg.method.isExternal(false)
    .where(_.ast.isCall.name("prepareStatement|executeQuery|executeUpdate|execute|createStatement")).l
  val readRe  = "(?i)(?:FROM|JOIN)\\s+([A-Za-z_][A-Za-z0-9_]*)".r
  val writeRe = "(?i)(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+([A-Za-z_][A-Za-z0-9_]*)".r
  val stop = Set("ERROR", "DUAL", "WHERE", "SELECT", "SET", "VALUES", "AND", "OR")
  def concatSql(m: Method): String =
    m.ast.isLiteral.sortBy(_.lineNumber.getOrElse(0)).code.l
      .filter(c => c != "null" && c.trim.nonEmpty).map(_.stripPrefix("\"").stripSuffix("\"")).mkString(" ").trim
  def classOf(m: Method): String = m.typeDecl.name.headOption.getOrElse(m.fullName.split('.').dropRight(1).lastOption.getOrElse("?"))

  case class Access(cls: String, table: String, mode: String, method: String, loc: String)
  val accesses = sqlMethods.flatMap { m =>
    val q = concatSql(m)
    val cls = classOf(m)
    (readRe.findAllMatchIn(q).map(x => Access(cls, x.group(1).toUpperCase, "read", m.name, loc(m))).toList ++
     writeRe.findAllMatchIn(q).map(x => Access(cls, x.group(1).toUpperCase, "write", m.name, loc(m))).toList)
      .filter(a => a.table.length > 2 && !stop.contains(a.table))
  }.distinctBy(a => (a.cls, a.table, a.mode, a.method))

  if (accesses.isEmpty) {
    R("no literal SQL found — this codebase likely uses JPA/ORM (no CRUD via prepareStatement).")
    R("switch producer: read @Entity/@Table + repository method names instead.")
    return
  }
  val tables = accesses.map(_.table).distinct.sorted
  val classes = accesses.map(_.cls).distinct.sorted
  R(s"classes=${classes.size} tables=${tables.size} access-facts=${accesses.size}")

  // ---- ownership: a table written by exactly one class -----------------------
  val writersByTable: Map[String, Set[String]] =
    accesses.filter(_.mode == "write").groupBy(_.table).view.mapValues(_.map(_.cls).toSet).toMap
  val owned = writersByTable.filter(_._2.size == 1).view.mapValues(_.head).toMap
  R(s"tables with a single writer (clear owner) = ${owned.size}")
  owned.toList.sortBy(_._1).foreach { case (t, c) => R(s"  $t  owned by $c") }

  // ---- class↔class coupling via shared tables (hub tables backboned out) -----
  val classesPerTable: Map[String, Set[String]] =
    accesses.groupBy(_.table).view.mapValues(_.map(_.cls).toSet).toMap
  val hubCutoff = math.max(2, math.ceil(classes.size * maxHubShare).toInt)
  val hubTables = classesPerTable.filter(_._2.size > hubCutoff).keySet
  if (hubTables.nonEmpty) R(s"backboned hub tables (>$hubCutoff classes): ${hubTables.mkString(", ")}")

  // undirected adjacency: classes sharing a non-hub table
  val adj = scala.collection.mutable.Map.empty[String, scala.collection.mutable.Set[String]]
  classes.foreach(c => adj(c) = scala.collection.mutable.Set.empty[String])
  val sharedBy = scala.collection.mutable.Map.empty[(String, String), Set[String]]
  classesPerTable.filterNot { case (t, _) => hubTables.contains(t) }.foreach { case (t, cs) =>
    val list = cs.toList
    for { i <- list.indices; j <- (i + 1) until list.size } {
      val (a, b) = (list(i), list(j)); adj(a) += b; adj(b) += a
      val key = if (a < b) (a, b) else (b, a)
      sharedBy(key) = sharedBy.getOrElse(key, Set.empty) + t
    }
  }
  val couplingEdges = sharedBy.keys.toList
  R(s"coupling edges (classes sharing a non-hub table) = ${couplingEdges.size}")

  // ---- Tarjan articulation points -------------------------------------------
  val disc = scala.collection.mutable.Map.empty[String, Int]
  val low = scala.collection.mutable.Map.empty[String, Int]
  val artic = scala.collection.mutable.Set.empty[String]
  var timer = 0
  def dfs(u: String, parent: String): Unit = {
    timer += 1; disc(u) = timer; low(u) = timer; var children = 0
    for (v <- adj(u)) {
      if (!disc.contains(v)) {
        children += 1; dfs(v, u); low(u) = math.min(low(u), low(v))
        if (parent != null && low(v) >= disc(u)) artic += u
      } else if (v != parent) low(u) = math.min(low(u), disc(v))
    }
    if (parent == null && children > 1) artic += u
  }
  classes.foreach(c => if (!disc.contains(c)) dfs(c, null))
  R(s"articulation points (candidate boundary cut-points) = ${artic.size}: ${artic.toList.sorted.mkString(", ")}")

  // ---- emit ------------------------------------------------------------------
  joerny.step("map entity CRUD + boundaries") {
    // (1) CRUD matrix: class -> table, edge per mode (read/write).
    val clsNodes = classes.map(c => joerny.Node("cls:" + c, c, "accessor",
      Map("cut-point" -> artic.contains(c))))
    val tblNodes = tables.map { t =>
      val ownerNote = owned.get(t).map(o => "owned by " + o).getOrElse("shared write")
      joerny.Node("tbl:" + t, t, "table", Map("owner" -> ownerNote))
    }
    val crudEdges = accesses.map(a => (a.cls, a.table, a.mode)).distinct.map { case (c, t, mode) =>
      val ev = accesses.find(x => x.cls == c && x.table == t && x.mode == mode).map(_.loc).getOrElse("")
      joerny.Edge("cls:" + c, "tbl:" + t, mode, Map("loc" -> ev))
    }
    joerny.graph("CRUD: classes ⟷ tables")
      .id("crud-matrix")
      .narrate("Which class reads (edge 'read') or writes (edge 'write') which table, from raw-JDBC SQL " +
        "literals — mechanical, each edge with file:line. A table node marked 'owned by X' has a single " +
        "writer (a clear ownership boundary). Classes flagged cut-point are structural seams (see clusters).")
      .nodes(clsNodes ++ tblNodes)
      .edges(crudEdges)
      .emit()

    // (2) CRUD table (the readable matrix).
    val rows = accesses.groupBy(a => (a.cls, a.table)).toList.sortBy { case ((c, t), _) => (c, t) }.map {
      case ((c, t), as) =>
        val modes = as.map(_.mode).distinct.sorted.mkString("+")
        List(c, t, modes, as.map(_.method).distinct.size, as.map(_.loc).head)
    }
    joerny.table("CRUD access matrix")
      .id("crud-matrix-table")
      .from("crud-matrix")
      .narrate("One row per (class, table): the access mode(s) and how many of the class's methods touch it.")
      .columns("class", "table", "mode", "#methods", "first site")
      .rows(rows)
      .emit()

    // (3) coupling graph + cut points (the boundary picture).
    val coupNodes = classes.filter(c => adj(c).nonEmpty).map(c =>
      joerny.Node("cls:" + c, c, if (artic.contains(c)) "cut-point" else "class",
        Map("shares-with" -> adj(c).size)))
    val coupEdges = couplingEdges.map { case (a, b) =>
      val key = if (a < b) (a, b) else (b, a)
      val ts = sharedBy(key).toList.sorted.mkString(", ")
      joerny.Edge("cls:" + a, "cls:" + b, "shares data", Map("tables" -> ts))
    }
    joerny.graph("data coupling + cut points")
      .id("crud-coupling")
      .from("crud-matrix")
      .narrate("Classes linked when they share a (non-hub) table; connected components are candidate " +
        "bounded contexts. A 'cut-point' class is an articulation vertex — removing it splits a cluster, " +
        "so it's a natural boundary/seam. Ubiquitous tables above " + maxHubShare + " share are backboned out.")
      .nodes(coupNodes)
      .edges(coupEdges)
      .emit()

    // (4) cut-point / ownership table.
    val cutRows = artic.toList.sorted.map { c =>
      val tbls = accesses.filter(_.cls == c).map(_.table).distinct.sorted
      List(c, adj(c).size, tbls.mkString(", "))
    }
    joerny.table("boundary cut-points")
      .id("crud-cutpoints")
      .from("crud-coupling")
      .narrate("Articulation-point classes: each holds two otherwise-separate groups together via shared " +
        "data. Splitting here is where a module boundary wants to be drawn. Mechanical (graph structure), " +
        "not an architectural verdict.")
      .columns("class", "#coupled classes", "tables it touches")
      .rows(cutRows)
      .emit()
  }
  R("done")
}
