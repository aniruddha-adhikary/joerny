/*
 * joerny.sc — emit typed analysis layers from a Joern script to the joerny viewer.
 *
 * Import from your analysis script:
 *
 *   //> using file joerny.sc
 *
 * Then publish layers as you discover them:
 *
 *   joerny.graph("high-fan-in-infra")
 *     .from("entry-points")
 *     .narrate("Methods called by 5+ distinct classes — the SDK layer.")
 *     .nodes(infra.map(m => joerny.Node(m.fullName, m.name, "method")))
 *     .edges(callEdges.map { case (a, b) => joerny.Edge(a, b, "calls") })
 *     .emit()
 *
 *   joerny.table("unknown-report").columns("job", "unknown%").row("Foo", "3%").emit()
 *   joerny.note("summary").markdown("## Findings\n- ...").emit()
 *
 * Each layer is written as one JSON file to $JOERNY_DIR (default
 * ".joerny/current/layers"). Writes are atomic (temp file + rename) so the
 * viewer never reads a half-written layer. Re-emitting the same id replaces it.
 *
 * Zero external dependencies — JSON is hand-serialized so this works regardless
 * of what is on Joern's classpath.
 */

import java.io.{File, PrintWriter}
import java.time.Instant

object joerny {

  final case class Node(id: String, label: String = null, `type`: String = null, props: Map[String, Any] = Map.empty)
  // `origin` records how a connection came to exist: "mechanical" (computed from
  // the CPG — the default and the honest one), "llm" (inferred/inserted by a
  // model — an artificial link), or "manual" (hand-authored). The viewer renders
  // non-mechanical connections distinctly so guesses are never mistaken for facts.
  final case class Edge(src: String, dst: String, `type`: String = null, props: Map[String, Any] = Map.empty,
                        origin: String = "mechanical")
  final case class Mapping(from: String, to: String, evidence: String = null, origin: String = "mechanical")

  /** Mark an edge as LLM-inferred (rendered dashed): a link a model proposed, not one the CPG proves. */
  def llmEdge(src: String, dst: String, `type`: String = null, props: Map[String, Any] = Map.empty): Edge =
    Edge(src, dst, `type`, props, "llm")
  /** Mark a mapping as LLM-inferred (rendered dashed). */
  def llmMapping(from: String, to: String, evidence: String = null): Mapping =
    Mapping(from, to, evidence, "llm")

  /** The computed result of a projection primitive: target nodes, optional edges,
   *  the provenance-carrying mappings (source node -> target node, `evidence` = why),
   *  and a few stats. Feed straight into a graph layer with `.project(result)`. */
  final case class Projection(
    nodes: List[Node] = Nil,
    edges: List[Edge] = Nil,
    mappings: List[Mapping] = Nil,
    stats: Map[String, Any] = Map.empty
  )

  // ---- script trace: step spans --------------------------------------------
  //
  // Wrap a phase of your script so the emit timeline reads as a trace: every
  // layer emitted inside the block is tagged with this step's name, and the
  // wall-clock duration is logged. This is the honest unit of a script trace —
  // a phase boundary you declare, not per-line instrumentation (Joern runs a
  // .sc as a compiled block). Steps may be nested; the innermost name wins.
  //
  //   joerny.step("classify jobs") {
  //     joerny.graph("roles").project(...).emit()
  //   }
  //
  private var _currentStep: String = null
  private[this] def currentStep: String = _currentStep

  def step[T](label: String)(body: => T): T = {
    val prev = _currentStep
    _currentStep = label
    val t0 = System.currentTimeMillis()
    try body
    finally {
      val ms = System.currentTimeMillis() - t0
      println(s"[joerny] step '$label' — ${ms}ms")
      _currentStep = prev
    }
  }

  // ---- output location -----------------------------------------------------

  private def outDir(): File = {
    val path = sys.env.get("JOERNY_DIR")
      .orElse(sys.props.get("joerny.dir"))
      .filter(_.nonEmpty)
      .getOrElse(".joerny/current/layers")
    val f = new File(path)
    f.mkdirs()
    f
  }

  private def slug(s: String): String = {
    val cleaned = s.trim.toLowerCase.replaceAll("[^a-z0-9]+", "-").replaceAll("(^-+|-+$)", "")
    if (cleaned.isEmpty) "layer" else cleaned
  }

  // ---- JSON serialization (hand-rolled) -------------------------------------

  private def esc(s: String): String = {
    val sb = new StringBuilder
    s.foreach {
      case '"'  => sb.append("\\\"")
      case '\\' => sb.append("\\\\")
      case '\n' => sb.append("\\n")
      case '\r' => sb.append("\\r")
      case '\t' => sb.append("\\t")
      case c if c < 0x20 => sb.append("\\u%04x".format(c.toInt))
      case c    => sb.append(c)
    }
    sb.toString
  }

  private def jsonVal(v: Any): String = v match {
    case null            => "null"
    case None            => "null"
    case Some(x)         => jsonVal(x)
    case b: Boolean      => b.toString
    case i: Int          => i.toString
    case l: Long         => l.toString
    case d: Double       => if (d.isNaN || d.isInfinite) "null" else d.toString
    case f: Float        => jsonVal(f.toDouble)
    case s: String       => "\"" + esc(s) + "\""
    case m: Map[_, _]    => m.map { case (k, x) => "\"" + esc(k.toString) + "\":" + jsonVal(x) }.mkString("{", ",", "}")
    case it: Iterable[_] => it.map(jsonVal).mkString("[", ",", "]")
    case other           => "\"" + esc(other.toString) + "\""
  }

  private def field(name: String, json: String): String = "\"" + esc(name) + "\":" + json

  private def optStr(name: String, v: String): Option[String] =
    Option(v).filter(_.nonEmpty).map(s => field(name, jsonVal(s)))

  private def nodeJson(n: Node): String = {
    val fields = List(
      Some(field("id", jsonVal(n.id))),
      Some(field("label", jsonVal(Option(n.label).getOrElse(n.id)))),
      optStr("type", n.`type`),
      if (n.props.nonEmpty) Some(field("props", jsonVal(n.props))) else None
    ).flatten
    fields.mkString("{", ",", "}")
  }

  // Absence of `origin` means "mechanical", so only serialize the non-default
  // (artificial) provenance to keep layers compact and back-compatible.
  private def optOrigin(v: String): Option[String] =
    Option(v).filter(o => o.nonEmpty && o != "mechanical").map(o => field("origin", jsonVal(o)))

  private def edgeJson(e: Edge): String = {
    val fields = List(
      Some(field("src", jsonVal(e.src))),
      Some(field("dst", jsonVal(e.dst))),
      optStr("type", e.`type`),
      optOrigin(e.origin),
      if (e.props.nonEmpty) Some(field("props", jsonVal(e.props))) else None
    ).flatten
    fields.mkString("{", ",", "}")
  }

  private def mappingJson(m: Mapping): String = {
    val fields = List(
      Some(field("from", jsonVal(m.from))),
      Some(field("to", jsonVal(m.to))),
      optStr("evidence", m.evidence),
      optOrigin(m.origin)
    ).flatten
    fields.mkString("{", ",", "}")
  }

  private def writeLayer(id: String, body: List[String]): String = {
    val dir = outDir()
    val json = body.mkString("{", ",", "}")
    val finalFile = new File(dir, id + ".json")
    val tmpFile = new File(dir, "." + id + ".json.tmp")
    val pw = new PrintWriter(tmpFile, "UTF-8")
    try pw.write(json) finally pw.close()
    // atomic-ish replace so the watcher never sees a partial file
    if (finalFile.exists()) finalFile.delete()
    tmpFile.renameTo(finalFile)
    println(s"[joerny] emitted layer '$id' -> ${finalFile.getPath}")
    finalFile.getPath
  }

  // ---- builders -------------------------------------------------------------

  sealed abstract class Builder[B <: Builder[B]](val kind: String, val name: String) {
    self: B =>
    protected var _id: String = slug(name)
    protected var _from: List[String] = Nil
    protected var _narration: String = null
    protected var _mappings: List[Mapping] = Nil

    def id(v: String): B = { _id = v; self }
    def from(parents: String*): B = { _from = _from ++ parents.toList; self }
    def narrate(text: String): B = { _narration = text; self }
    def map(mappings: Mapping*): B = { _mappings = _mappings ++ mappings.toList; self }
    def mapNodes(pairs: Iterable[(String, String)]): B = {
      _mappings = _mappings ++ pairs.map { case (a, b) => Mapping(a, b) }.toList; self
    }

    protected def commonFields(): List[String] = {
      List(
        Some(field("id", jsonVal(_id))),
        Some(field("name", jsonVal(name))),
        Some(field("kind", jsonVal(kind))),
        Some(field("derivedFrom", "[" + _from.map(jsonVal).mkString(",") + "]")),
        optStr("narration", _narration),
        optStr("step", currentStep),
        Some(field("createdAt", jsonVal(Instant.now().toString))),
        if (_mappings.nonEmpty) Some(field("mappings", "[" + _mappings.map(mappingJson).mkString(",") + "]")) else None
      ).flatten
    }

    protected def payloadFields(): List[String]

    def emit(): String = writeLayer(_id, commonFields() ++ payloadFields())
  }

  final class GraphBuilder(name: String) extends Builder[GraphBuilder]("graph", name) {
    private var _nodes: List[Node] = Nil
    private var _edges: List[Edge] = Nil
    def nodes(ns: Iterable[Node]): GraphBuilder = { _nodes = _nodes ++ ns.toList; this }
    def node(n: Node): GraphBuilder = { _nodes = _nodes :+ n; this }
    def edges(es: Iterable[Edge]): GraphBuilder = { _edges = _edges ++ es.toList; this }
    def edge(e: Edge): GraphBuilder = { _edges = _edges :+ e; this }
    /** Merge a computed projection (its nodes, edges and provenance mappings) into this layer. */
    def project(p: Projection): GraphBuilder = {
      _nodes = _nodes ++ p.nodes
      _edges = _edges ++ p.edges
      _mappings = _mappings ++ p.mappings
      this
    }
    protected def payloadFields(): List[String] = List(
      field("nodes", "[" + _nodes.map(nodeJson).mkString(",") + "]"),
      field("edges", "[" + _edges.map(edgeJson).mkString(",") + "]")
    )
  }

  final class TableBuilder(name: String) extends Builder[TableBuilder]("table", name) {
    private var _columns: List[String] = Nil
    private var _rows: List[List[Any]] = Nil
    def columns(cs: String*): TableBuilder = { _columns = cs.toList; this }
    def rows(rs: Iterable[Iterable[Any]]): TableBuilder = { _rows = _rows ++ rs.map(_.toList).toList; this }
    def row(cells: Any*): TableBuilder = { _rows = _rows :+ cells.toList; this }
    protected def payloadFields(): List[String] = List(
      field("columns", "[" + _columns.map(jsonVal).mkString(",") + "]"),
      field("rows", "[" + _rows.map(r => "[" + r.map(jsonVal).mkString(",") + "]").mkString(",") + "]")
    )
  }

  final class NoteBuilder(name: String) extends Builder[NoteBuilder]("note", name) {
    private var _markdown: String = ""
    def markdown(md: String): NoteBuilder = { _markdown = md; this }
    protected def payloadFields(): List[String] = List(field("markdown", jsonVal(_markdown)))
  }

  def graph(name: String): GraphBuilder = new GraphBuilder(name)
  def table(name: String): TableBuilder = new TableBuilder(name)
  def note(name: String): NoteBuilder = new NoteBuilder(name)

  // ---- projection primitives -----------------------------------------------
  //
  // A projection is a function from source nodes to target nodes plus the
  // mappings that record *why* each source landed where it did (the `evidence`).
  // These helpers compute the mappings-with-provenance for you so a script can
  // declare intent ("group these by call-shape") instead of hand-typing edges.
  // They are generic and dependency-free — you pass plain ids and functions, so
  // they work on any Joern classpath and on non-CPG data alike.
  //
  //   val p = joerny.derive.classify(types, _.name, Seq(
  //     joerny.derive.whenContains[TypeDecl]("dao",  _.name, "DAO"),
  //     joerny.derive.whenContains[TypeDecl]("rule", _.name, "Rule")))
  //   joerny.graph("roles").from("types").project(p).emit()

  object derive {

    /** Union-find connected components over an undirected edge set. */
    private def connectedComponents(
        seed: scala.collection.Set[String],
        edges: Iterable[(String, String)]): List[Set[String]] = {
      val parent = scala.collection.mutable.Map.empty[String, String]
      def root(x: String): String = {
        var r = x
        while (parent.getOrElse(r, r) != r) r = parent(r)
        var cur = x
        while (parent.getOrElse(cur, cur) != r) { val nxt = parent(cur); parent(cur) = r; cur = nxt }
        r
      }
      def union(a: String, b: String): Unit = { val ra = root(a); val rb = root(b); if (ra != rb) parent(ra) = rb }
      seed.foreach(n => if (!parent.contains(n)) parent(n) = n)
      edges.foreach { case (a, b) =>
        if (!parent.contains(a)) parent(a) = a
        if (!parent.contains(b)) parent(b) = b
        union(a, b)
      }
      parent.keys.toList.groupBy(root).values.map(_.toSet).toList
    }

    /** Convenience: a classification rule that fires when `text(item)` contains any token. */
    def whenContains[A](category: String, text: A => String, tokens: String*): (String, A => Option[String]) =
      category -> ((a: A) => tokens.find(t => text(a).contains(t)).map(t => s"contains '$t'"))

    /** #1 Classification: tag each item with the first matching rule's category.
     *  Rules are `(categoryId, predicate)` where the predicate returns `Some(evidence)`
     *  on a match; that string becomes the mapping's evidence. Unmatched items
     *  are counted in stats but not mapped. */
    def classify[A](items: Iterable[A], id: A => String, rules: Seq[(String, A => Option[String])]): Projection = {
      val ms = scala.collection.mutable.ListBuffer.empty[Mapping]
      val counts = scala.collection.mutable.LinkedHashMap.empty[String, Int]
      var unclassified = 0
      items.foreach { a =>
        val hit = rules.iterator.map { case (cat, f) => f(a).map(ev => (cat, ev)) }.collectFirst { case Some(x) => x }
        hit match {
          case Some((cat, ev)) => counts(cat) = counts.getOrElse(cat, 0) + 1; ms += Mapping(id(a), cat, ev)
          case None            => unclassified += 1
        }
      }
      Projection(
        nodes = counts.toList.map { case (c, n) => Node(c, c, "category", Map("members" -> n)) },
        mappings = ms.toList,
        stats = Map("classified" -> ms.size, "categories" -> counts.size, "unclassified" -> unclassified)
      )
    }

    /** #2 Equivalence grouping ("fingerprint"): items sharing an identical `key` string
     *  form one group. Each group is a target node; every member maps to it with the
     *  shared key as provenance. This is the "these are the same component" primitive. */
    def groupByKey[A](items: Iterable[A], id: A => String, key: A => String,
                      groupId: String => String, groupLabel: String => String): Projection = {
      val groups = items.groupBy(key).toList
      val ms = scala.collection.mutable.ListBuffer.empty[Mapping]
      val nodes = groups.map { case (k, members) =>
        val gid = groupId(k)
        members.foreach(m => ms += Mapping(id(m), gid, s"shared key: ${if (k.length > 80) k.take(80) + "…" else k}"))
        Node(gid, groupLabel(k), "group", Map("size" -> members.size))
      }
      Projection(nodes = nodes, mappings = ms.toList,
        stats = Map("groups" -> groups.size, "items" -> items.size,
                    "nonTrivialGroups" -> groups.count(_._2.size > 1)))
    }

    /** #2 with auto-generated group ids/labels (`group-0`, `group-1`, …). */
    def groupByKey[A](items: Iterable[A], id: A => String, key: A => String): Projection = {
      val index = items.map(key).toList.distinct.zipWithIndex.toMap
      groupByKey(items, id, key, k => s"group-${index(k)}", k => s"group-${index(k)}")
    }

    final case class BipartiteResult(incidence: Projection, coupling: Projection, clusters: Projection)

    /** #3 with no backboning (every shared right counts). */
    def bipartite(pairs: Iterable[(String, String)], minShared: Int): BipartiteResult =
      bipartite(pairs, minShared, maxHubShare = 1.0)

    /** #3 Bipartite projection: from a two-mode `(left, right)` incidence relation, derive
     *  left↔left coupling (two lefts linked when they share >= `minShared` rights, shared
     *  rights recorded as provenance) and the connected-component clusters over it. Returns
     *  the raw incidence, the coupling graph, and the clusters — pick whichever to emit.
     *
     *  Backboning: a right-node touched by more than `maxHubShare` of the lefts (a ubiquitous
     *  table like AUDIT_LOG) couples almost everything and collapses the graph into one blob,
     *  so such hubs are dropped from the coupling computation (still present in `incidence`).
     *  Pass `maxHubShare = 1.0` to keep every right. Combined with `minShared >= 2` this is
     *  what separates dense projections into meaningful clusters. */
    def bipartite(pairs: Iterable[(String, String)], minShared: Int, maxHubShare: Double): BipartiteResult = {
      val byLeft: Map[String, Set[String]] = pairs.groupBy(_._1).map { case (l, ps) => l -> ps.map(_._2).toSet }
      val lefts = byLeft.keys.toVector.sorted
      // right-node frequency → hubs are those above the share threshold.
      val rightFreq: Map[String, Int] = pairs.groupBy(_._2).map { case (r, ps) => r -> ps.map(_._1).toSet.size }
      val hubs: Set[String] = rightFreq.collect { case (r, f) if f.toDouble / lefts.size > maxHubShare => r }.toSet
      val effLeft: Map[String, Set[String]] = byLeft.map { case (l, rs) => l -> (rs -- hubs) }
      val couplingEdges = scala.collection.mutable.ListBuffer.empty[Edge]
      var i = 0
      while (i < lefts.size) {
        var j = i + 1
        while (j < lefts.size) {
          val a = lefts(i); val b = lefts(j)
          val shared = effLeft(a).intersect(effLeft(b))
          if (shared.size >= minShared)
            couplingEdges += Edge(a, b, "shares", Map("count" -> shared.size, "via" -> shared.toList.sorted.mkString(", ")))
          j += 1
        }
        i += 1
      }
      // connectedComponents seeds from all lefts, so lefts with no surviving
      // coupling edge each form their own singleton cluster.
      val comps = connectedComponents(lefts.toSet, couplingEdges.map(e => (e.src, e.dst)))
      val cms = scala.collection.mutable.ListBuffer.empty[Mapping]
      val clusterNodes = comps.zipWithIndex.map { case (members, k) =>
        val cid = s"cluster-$k"
        members.foreach(m => cms += Mapping(m, cid, s"coupled cluster of ${members.size}"))
        Node(cid, s"cluster-$k (${members.size})", "cluster", Map("size" -> members.size))
      }
      BipartiteResult(
        incidence = Projection(mappings = pairs.map { case (l, r) => Mapping(l, r, "accesses") }.toList,
          stats = Map("pairs" -> pairs.size, "lefts" -> byLeft.size)),
        coupling = Projection(
          nodes = lefts.toList.map(l => Node(l, l.split('.').last, "node")),
          edges = couplingEdges.toList,
          stats = Map("edges" -> couplingEdges.size, "minShared" -> minShared, "hubsDropped" -> hubs.size)),
        clusters = Projection(nodes = clusterNodes, mappings = cms.toList,
          stats = Map("clusters" -> comps.size, "hubsDropped" -> hubs.toList.sorted.mkString(",")))
      )
    }

    /** #5 Forward slice: BFS from each seed id over a directed edge relation up to `maxDepth`.
     *  Every reached node maps back to its seed with the discovery depth as provenance —
     *  the "what implements / is affected by X" primitive. */
    def slice(seeds: Iterable[String], edges: Iterable[(String, String)], maxDepth: Int): Projection = {
      val adj: Map[String, List[String]] = edges.groupBy(_._1).map { case (s, ps) => s -> ps.map(_._2).toList }
      val ms = scala.collection.mutable.ListBuffer.empty[Mapping]
      val reached = scala.collection.mutable.LinkedHashSet.empty[String]
      seeds.foreach { seed =>
        val seen = scala.collection.mutable.Map[String, Int](seed -> 0)
        val q = scala.collection.mutable.Queue.empty[(String, Int)]
        q.enqueue((seed, 0))
        while (q.nonEmpty) {
          val (n, d) = q.dequeue()
          reached += n
          if (n != seed) ms += Mapping(seed, n, s"reachable at depth $d")
          if (d < maxDepth) adj.getOrElse(n, Nil).foreach { m =>
            if (!seen.contains(m)) { seen(m) = d + 1; q.enqueue((m, d + 1)) }
          }
        }
      }
      Projection(
        nodes = reached.toList.map(n => Node(n, n.split('.').last.takeWhile(_ != ':'), "sliced")),
        mappings = ms.toList,
        stats = Map("seeds" -> seeds.size, "reached" -> reached.size)
      )
    }
  }
}
