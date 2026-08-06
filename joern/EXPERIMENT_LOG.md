# Projection experiments — how far the primitives push

Goal: stress-test the `joerny.derive.*` projection primitives (see `joerny.sc`)
against **real, differently-shaped** Java codebases, computing every mapping
*with provenance* instead of hand-authoring it — and record where each
abstraction holds up and where it honestly breaks.

The **same script** (`experiments.sc`) ran unchanged against all three CPGs.
Nothing is hardcoded to one codebase: own-code is the CPG's `isExternal` flag,
entry points fall back to call-graph roots when there's no useful `main()`, and
behavior is proven by the **callee receiver type**, never by method names
(the anti-pattern the requirements-extraction golden-guide warns about).

## Corpus (a healthy mix)

| CPG | Kind | methods / types / calls | Persistence | Entry style |
|---|---|---|---|---|
| `old-enterprise-java-samples` | J2EE batch/consumer (raw JDBC, JMS, SOAP, SFTP) | 1284 / 259 / 12725 | raw JDBC (`prepareStatement`) | 4× `main()` |
| `spring-petclinic` | Spring Boot MVC + Spring Data JPA | 215 / 141 / 504 | JPA (annotations) | trivial `main()` → falls back to controller roots |
| `mybatis/jpetstore-6` | Stripes ActionBeans + MyBatis | 393 / 77 / 1156 | MyBatis XML mappers | no `main()` → call-graph roots |
| `spring-petclinic-rest` | Spring REST, ships JDBC **and** JPA repo impls | 743 / 286 / 2599 | hand-written JDBC + JPA | no `main()` → 147 controller/repo roots |
| `google/gson` | Pure serialization **library** (no app, no I/O) | 1574 / 399 / 11035 | none | no `main()` → 358 public-API roots |

## Results (one line per stage; `RESULT` lines from the run)

**Entry points (#classify seed).**
- oldent: `main` × 4.
- petclinic: `mainReach=0` → **fell back to 54 call-graph roots** (the Spring `main` reaches no own code through DI/reflection).
- jpetstore: no `main` → **196 call-graph roots** (ActionBean handlers).
- petclinic-rest: no `main` → **147 roots** (REST controllers + repo impls).
- gson: no `main` → **358 roots** — the entire public API surface (a library has no single entry).

**Behavioral flags — classify by receiver type @ depth 3 (primitive #1).**
- oldent: `DB-JDBC×4, MQ×4, XML×2, SFTP×1, FILE×1`.
- petclinic: `HTTP/WEB×14, ORM/JPA×2`.
- jpetstore: `MYBATIS×26, HTTP/WEB×6`.
- petclinic-rest: `ORM/JPA×52, HTTP/WEB×11, DB-JDBC×7, VALIDATION×1` — the richest, because it ships **both** a JPA and a hand-written JDBC repository implementation.
- gson: **none** — earlier this was a `DB-JDBC×3` **false positive** (gson has a `java.sql.Date` TypeAdapter); now fixed by matching the JDBC *I/O carriers* (`Connection`/`Statement`/`ResultSet`/`DataSource`) instead of the whole `java.sql.` package, so merely *modeling* a value type no longer counts as doing JDBC. See "where it breaks" for the general lesson.
- Each flag edge carries provenance = the exact reachable callee type that proved it (e.g. `reaches org.apache.ibatis.session.SqlSession.selectList`).

**Completeness / unknown count (report, don't hide).**
- unknown share of distinct external targets: oldent **66%**, petclinic **80%**, jpetstore **78%**, petclinic-rest **86%**, gson **100%**.
- The tail is dominated by `java.lang.*`, `java.util.*`, reflection, and `<unresolvedNamespace>` — expected noise; the point is it's *counted and surfaced*, not swept away. gson's 100% is the correct signal that a pure library has no external-integration behavior to classify.

**SQL tables + domain clusters — bipartite projection (primitive #3).**
- oldent: 62 SQL methods → 44 class→table edges over **12 real tables** (`CLIENTS, TRADE_ORDERS, SETTLEMENT_RECORDS, PRICING_CACHE, BILLING_LEDGER, AUDIT_LOG, …`). Without backboning `minShared=1` collapsed 25/26 classes into one blob; **backboning** (`maxHubShare=0.4`) drops the ubiquitous `TRADE_ORDERS` hub and separates it into **9 clusters**.
- petclinic-rest: 8 SQL methods → 16 edges over **6 real tables** (`PET, PETTYPE, SPECIALTY, USERS, VET_SPECIALTIES, VISIT`); backboning drops the `PET`/`VISIT` hubs → **6 clusters** — its JDBC repo variant exposes literal SQL that the JPA-only apps don't.
- petclinic, jpetstore & gson: **0** — no literal SQL reachable via `prepareStatement`.

**Capability blocks — high fan-in, block-vs-expand (primitive #1/#2).**
- oldent: **39** methods with ≥5 distinct caller classes in 7 packages (`getConnection`×27, `closeQuietly`×27, `setAttribute`×17 …).
- gson: **81** in 23 packages (`peek`×46, `nextNull`×34, `nullValue`×24) — but these are the library's **core abstraction** (`JsonReader`/`JsonWriter`), not rebuildable infrastructure (see below).
- petclinic-rest: 3 (`getId`/`setId`/`isNew` — JPA entity base). petclinic: 1. jpetstore: 0.

**Connected flow tree — AST-order calls + CDG guards + inline SQL (primitive #5, enriched).**
- oldent `DemoRunner.main`: 34 steps (`EXTERNAL 22 / EXPAND 7 / BLOCK 5`), real SQL inlined at the steps that run it.
- petclinic `PetController.processUpdateForm`: 14 steps.
- jpetstore `OrderActionBean.newOrderForm`: 14 steps.
- petclinic-rest `VetRestControllerV1.updateVet`: 13 steps.
- gson `MapTypeAdapterFactory$Adapter.write`: 17 steps (`BLOCK 12`) — dominated by reused library primitives.

## What holds up, what breaks

**Holds up across all five (codebase-agnostic):**
- **Behavior = graph structure.** Classifying by callee *receiver type* generalized from raw JDBC to JPA to MyBatis just by widening the taxonomy — no per-codebase name lists.
- **Entry-point discovery via call-graph roots.** The `main()`-or-roots fallback correctly handled a batch system, a DI framework, and a servlet app. Confirms the golden-guide's "has `main()` ≠ is a job."
- **The connected flow tree.** The AST-order walk with CDG guards / loop context / `[BLOCK]`/`[EXPAND]` tags produced a readable per-entry-point flow everywhere; SQL inlining simply *enriches* it where literal SQL exists.
- **Fan-in capability blocks** scale with the codebase (39 in the 1284-method oldent, ~0 in the small apps) — no false "everything is a block" — though what a block *means* differs for a library (see below).

**Where it breaks (and the honest signal it emits):**
- **`prepareStatement`-driven SQL is a sharp boundary.** It fully recovers the data model for raw-JDBC (oldent) and finds **nothing** under ORM/JPA (petclinic) or MyBatis XML (jpetstore). The primitive detects this and emits a hint telling the agent to switch producer (`@Entity`/`@Table`, or mapper XML) — it does not silently return an empty graph.
- **DI/reflection fragments the static call graph.** A framework `main()` reaches ~no own code, so any "reachable-from-main" analysis is worthless for Spring/Stripes apps — you must seed from handler roots. (This is why `mainReach` gates the fallback.)
- **Bipartite coupling gets dense fast — now backboned.** oldent's `minShared=1` projection collapsed almost everything sharing a table into one blob. `derive.bipartite` now takes `maxHubShare`: right-nodes touched by more than that fraction of lefts (a ubiquitous table like `TRADE_ORDERS`) are dropped from the coupling computation (still kept in `incidence`), which separates oldent into 9 clusters and petclinic-rest into 6. Still a tunable knob, not a universal constant.
- **Unknown tail is large (66–100%).** A name-agnostic taxonomy leaves most external calls unclassified. That's fine — it's *reported* — but it means classification is a starting scaffold, not a complete map.
- **Receiver-type classification false-positived on *modeled* types — now fixed.** gson used to get `DB-JDBC×3` purely because it has a `java.sql.Date` TypeAdapter: it *models* the type without ever touching a database. "Reaches a `java.sql.*` type" ≠ "performs JDBC." The taxonomy now matches only the JDBC *I/O carriers* (`Connection`, `Statement`, `PreparedStatement`, `CallableStatement`, `ResultSet`, `DriverManager`, `DataSource`), so use-of-subsystem is separated from mention-of-a-value-type; gson now reports **no** DB capability. The general lesson holds: for a subsystem, match its I/O surface, not its whole package.
- **Library vs application inverts `[BLOCK]`/`[EXPAND]` — now surfaced.** In an app, high fan-in = shared infrastructure to extract as a service. In a library (gson: 81 high-fan-in methods), high fan-in just means the *core public abstraction* — there's nothing to "rebuild." The experiment now detects shape (no `main()` and no external-integration capabilities ⇒ `library`) and re-labels the blocks as **core API** with a hint telling the agent not to read them as service boundaries. The fan-in signal is real but its *meaning* is mission-dependent — the shape flag makes that explicit instead of leaving a fixed rule to misfire.
- **Persistence *implementation*, not framework, decides SQL applicability.** Plain petclinic (JPA-only) yields 0 tables; petclinic-rest — same framework, but shipping a hand-written JDBC repo — yields 6. The producer to reach for depends on how persistence is actually coded, which the agent must detect per codebase.

## Takeaway for the tool

The primitives are the right substrate, but **every mission and codebase is
different** — the agent must choose the seed (main vs roots), widen the taxonomy,
pick the persistence producer (JDBC literals vs `@Entity` vs mapper XML), and
tune `minShared`. So `experiments.sc` is a **reference, not a pipeline**, and the
skill is written as an on-demand toolbox: reach for a primitive when its shape
fits, invent a raw query when it doesn't, and always emit provenance so the
projection is inspectable.

## Reproduce

```bash
export JOERNY_DIR="$PWD/.joerny/current/layers"
joern --script joern/experiments.sc --param cpgPath=/path/to/cpg.bin
```
