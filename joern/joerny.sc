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
  final case class Edge(src: String, dst: String, `type`: String = null, props: Map[String, Any] = Map.empty)
  final case class Mapping(from: String, to: String, note: String = null)

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

  private def edgeJson(e: Edge): String = {
    val fields = List(
      Some(field("src", jsonVal(e.src))),
      Some(field("dst", jsonVal(e.dst))),
      optStr("type", e.`type`),
      if (e.props.nonEmpty) Some(field("props", jsonVal(e.props))) else None
    ).flatten
    fields.mkString("{", ",", "}")
  }

  private def mappingJson(m: Mapping): String = {
    val fields = List(
      Some(field("from", jsonVal(m.from))),
      Some(field("to", jsonVal(m.to))),
      optStr("note", m.note)
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
}
