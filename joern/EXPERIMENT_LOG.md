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

## Results (one line per stage; `RESULT` lines from the run)

**Entry points (#classify seed).**
- oldent: `main` × 4.
- petclinic: `mainReach=0` → **fell back to 54 call-graph roots** (the Spring `main` reaches no own code through DI/reflection).
- jpetstore: no `main` → **196 call-graph roots** (ActionBean handlers).

**Behavioral flags — classify by receiver type @ depth 3 (primitive #1).**
- oldent: `DB-JDBC×4, MQ×4, XML×2, SFTP×1, FILE×1`.
- petclinic: `HTTP/WEB×14, ORM/JPA×2`.
- jpetstore: `MYBATIS×26, HTTP/WEB×6`.
- Each flag edge carries provenance = the exact reachable callee type that proved it (e.g. `reaches org.apache.ibatis.session.SqlSession.selectList`).

**Completeness / unknown count (report, don't hide).**
- unknown share of distinct external targets: oldent **66%**, petclinic **80%**, jpetstore **78%**.
- The tail is dominated by `java.lang.*`, `java.util.*` and `<unresolvedNamespace>` — expected noise; the point is it's *counted and surfaced*, not swept away.

**SQL tables + domain clusters — bipartite projection (primitive #3).**
- oldent: 62 SQL methods → 44 class→table edges over **12 real tables** (`CLIENTS, TRADE_ORDERS, SETTLEMENT_RECORDS, PRICING_CACHE, BILLING_LEDGER, AUDIT_LOG, …`) → **2 domain clusters**.
- petclinic & jpetstore: **0** — no literal SQL reachable via `prepareStatement`.

**Capability blocks — high fan-in, block-vs-expand (primitive #1/#2).**
- oldent: **39** methods with ≥5 distinct caller classes in 7 packages (`getConnection`×27, `closeQuietly`×27, `setAttribute`×17 …).
- petclinic: 1. jpetstore: 0.

**Connected flow tree — AST-order calls + CDG guards + inline SQL (primitive #5, enriched).**
- oldent `DemoRunner.main`: 34 steps (`EXTERNAL 22 / EXPAND 7 / BLOCK 5`), real SQL inlined at the steps that run it.
- petclinic `PetController.processUpdateForm`: 14 steps.
- jpetstore `OrderActionBean.newOrderForm`: 14 steps.

## What holds up, what breaks

**Holds up across all three (codebase-agnostic):**
- **Behavior = graph structure.** Classifying by callee *receiver type* generalized from raw JDBC to JPA to MyBatis just by widening the taxonomy — no per-codebase name lists.
- **Entry-point discovery via call-graph roots.** The `main()`-or-roots fallback correctly handled a batch system, a DI framework, and a servlet app. Confirms the golden-guide's "has `main()` ≠ is a job."
- **The connected flow tree.** The AST-order walk with CDG guards / loop context / `[BLOCK]`/`[EXPAND]` tags produced a readable per-entry-point flow everywhere; SQL inlining simply *enriches* it where literal SQL exists.
- **Fan-in capability blocks** are meaningful *at scale* (39 in the 1284-method system) and correctly ~empty in the two small apps — no false "everything is a block."

**Where it breaks (and the honest signal it emits):**
- **`prepareStatement`-driven SQL is a sharp boundary.** It fully recovers the data model for raw-JDBC (oldent) and finds **nothing** under ORM/JPA (petclinic) or MyBatis XML (jpetstore). The primitive detects this and emits a `note` telling the agent to switch producer (`@Entity`/`@Table`, or mapper XML) — it does not silently return an empty graph.
- **DI/reflection fragments the static call graph.** A framework `main()` reaches ~no own code, so any "reachable-from-main" analysis is worthless for Spring/Stripes apps — you must seed from handler roots. (This is why `mainReach` gates the fallback.)
- **Bipartite coupling gets dense fast.** oldent's shared-table projection is 115 coupling edges → only 2 clusters; with `minShared=1` almost everything that touches a shared table collapses together. Real use needs a higher `minShared` / backboning (a known next step).
- **Unknown tail is large (66–80%).** A name-agnostic taxonomy leaves most external calls unclassified. That's fine — it's *reported* — but it means classification is a starting scaffold, not a complete map.

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
