# CFC Phase 3 — per-row, data-derived SQLite labels (design)

Status: **design, pre-implementation.** Builds on Phase 2 (per-column static
`ifc`, #3895). Gated on open question Q16 in
[08-open-questions.md](../08-open-questions.md); Q17 (filter vs. fail) is now
adjudicated at the CFC spec level (CFC spec §8.17.2, invariant 14 — fail
default, skip as a declared existence release) and what remains of it here is
implementation phasing (3.b). The integrity-combine operator
is held swappable for CT-1668 (handled in parallel). This doc proposes the spec
format, the helper set, the evaluator placement, the read/write split, and the
fail-closed rules, and identifies the one decision that needs its own sub-step.
Per the Phase 2 convention, once landed this folds into
[06-cfc.md](../06-cfc.md) and is deleted.

## 1. Goal and motivating case

A row's confidentiality often depends on its **own data**, not a static schema
label. The motivating case: an email row should be confidential to the user, the
sender, and every recipient.

```tsx
const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;
const Emails = table(
  { id: "integer", from: "text", to: "text", body: "text" },
  (f) => ({
    // any(...) = ONE OR-clause: any participant may read (CFC spec §3.1.8).
    // Errors at table() time until the runner's clause-aware label profile
    // lands (CFC spec §18.5.3); all(...) is the conjunctive form that works
    // today but means "ALL participants must be satisfied" — see the §4 helper table.
    confidentiality: any(
      principal("mailto", match(f.from, ADDR)),
      principal("mailto", match(f.to,   ADDR)),   // global match splits recipients
      dbOwner(),                                   // the mailbox owner — fixed, from the db ref
    ),
    // integrity too — authored-by-sender, gated on anti-spoof checks; see §4.
  }),
);
```

Row 1 (from alice, to bob) ⟶ confidential to `[[alice ∨ bob ∨ owner]]` (one
OR-clause: any participant or the db owner reads); row 2 (from carol, to
{dave,erin}) ⟶ `[[carol ∨ dave ∨ erin ∨ owner]]`. The label is a function of
the row, so it **cannot** be a static schema label: it is computed from the
row's values **on write** and re-derived **on read**.

## 2. The trust model, restated (why declarative)

CFC today is a runtime-core discipline: patterns are untrusted sandboxed code;
the runner core (cell.ts, `packages/runner/src/cfc/*`) is the policy point;
labels are persisted as CFC metadata and re-checked at sinks/commit-boundaries
(`prepareBoundaryCommit`, [prepare.ts](../../../../packages/runner/src/cfc/prepare.ts)).
The memory **server** currently stores SQLite rows opaquely and does no CFC
(`applyCommitTransaction` → `applySqliteOperation` → `runWrite`,
[engine.ts:3203-3281](../../../../packages/memory/v2/engine.ts)).

The atomic SQLite write lands inside `applyCommitTransaction`, where **no pattern
or sandbox code runs**. So the row-label rule cannot be a callback into pattern
code. It must be a **declarative projection** that:

1. serializes into the table schema (it already rides server↔runner as
   `op.db.tables` / `db.tables`), and
2. is evaluable by a small, fixed evaluator on **both** sides without invoking
   user code.

The decisive consequence (and the audit property we want): **a row's
confidentiality is a pure function of its stored columns** — recomputable at any
time, by either side, identically.

## 3. The hard part Phase 2 never had: labels that **vary per row**

Phase 2 attaches a column's label by writing the result array under a schema
whose `items` carries per-field `ifc`. That label-derivation walk,
`walkIfcSchema`
([prepare.ts:971](../../../../packages/runner/src/cfc/prepare.ts)), descends into
an array's `items` under a **single `"*"` wildcard path segment** — so every
element gets the **same** label. That is correct for per-column (static) labels
and is exactly why Phase 2 could lean entirely on the schema mechanism.

Per-row labels are **different for every element**. A static `items` schema
cannot express them, and a tuple `items: [s0, s1, …]` is not what `walkIfcSchema`
understands (it treats `items` as one sub-schema, reads no `.ifc` off an array).
**This is the central new problem of Phase 3:** how to land a *different*
persisted label on each split-out row entity doc. Everything else (the spec, the
helpers, the ceiling check) is comparatively mechanical; this is where the design
risk is, and §7 treats it as the spike to de-risk first.

## 4. Proposed authoring surface

Extend `table()` with a second `options` argument carrying a **row-label rule**.
`table()` is realized in
[packages/memory/v2/sqlite/schema.ts:116](../../../../packages/memory/v2/sqlite/schema.ts)
and re-exported to patterns via the builder
([factory.ts:48](../../../../packages/runner/src/builder/factory.ts)); it is a
plain runtime function (not transformer-lowered), so the rule is built **eagerly
at definition time** with no transformer change.

The rule is a function of a **shallow, typed field handle** `f` (one accessor per
column, from the column names) returning a **confidentiality** and/or **integrity**
label expression. It is *not* a deep proxy and there is no `.map` — a global regex
match does the splitting at runtime:

```ts
const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;   // pull address tokens out of a messy To/Cc line

const Emails = table(
  { from:"text", to:"text", cc:"text", body:"text", auth:"text" },
  (f) => ({
    confidentiality: any(
      principal("mailto", match(f.to,  ADDR)),   // global match ⟹ split for free
      principal("mailto", match(f.cc,  ADDR)),
      principal("mailto", match(f.from, ADDR)),
      dbOwner(),
    ),
    integrity: when(matches(f.auth, /dmarc=pass/),        // only if not spoofed
      endorsedBy(principal("mailto", match(f.from, ADDR)))),
  }),
);
```

The closed helper set (each *returns* an AST node):

| helper | meaning |
|---|---|
| `match(f.col, /re/, group?)` | run the regex (global) over the column's text ⟹ an ordered list of matches (or capture `group`). The universal field extractor — split + clean in one; subsumes JSON arrays and dirty `Name <addr>` lists |
| `principal(protocol, term)` | `did:<protocol>:<v>` for each `v` in `term` (distributes over a match list). No hardcoded scheme |
| `dbOwner()` | the db's owner — the principal that created the SqliteDb cell, resolved from the db ref (a fixed db property, so the rule stays pure; for a per-user-scoped db this is that user) |
| `any(...t)` | **one OR-clause** over the terms' atoms: any alternative satisfies it (CFC spec §3.1.8 authored disjunction). **Reserved: errors at `table()` time** until the runner's clause-aware profile lands (CFC spec §18.5.3 rule 3) — never silently lowered to the conjunctive form |
| `all(...t)` | separate **conjunctive** clauses, one per atom (today's only confidentiality combinator; what earlier drafts called `union`, renamed because "union" read as any-of while lowering as all-of) |
| `intersect(...t)` | set ∩ over terms — integrity meets only (§10) |
| `when(matches(f.col,/re/), term)` | include `term` only if the regex matches the column (gate trust on extracted metadata). NB: a `when`-gated confidentiality alternative is absent from some rows, so it never has the common-alternative property (CFC spec §8.17.4) — a principal that should be able to read aggregates must be listed unconditionally |
| `endorsedBy(term)` / `authoredBy(term)` | wrap principal atoms as integrity (provenance) atoms |
| `const(atom)` | a literal atom (escape hatch) |

`f.<col>` is the only way to name data and may appear **only** as a `match` /
`matches` argument. The rule returns `{ confidentiality?, integrity? }` — two
**independent** expressions (coupling them through one lattice op would nuke
integrity; see §10). Integrity is a first-class requirement, not an afterthought:
"authored by the sender, *if* anti-spoof checks pass" is the `when(matches(…))`
+ `endorsedBy(…)` shape above.

**No acting-principal term in rules.** `currentUser()` is deliberately *not* a
rule helper: a rule must be a pure function of (stored columns, db ref) so the
write-gate, the server commit, and read re-derivation compute the **same**
label (§2). An acting-principal term breaks that — re-derived at read time it
resolves to the *reader*, so in `any(...)` it would place **every reader** into
the OR-clause (self-granted access), and even in `all(...)` it makes the
persisted row-doc label flap with whoever queried last. AST validation rejects
it. The acting user belongs in the **result ceiling** (§7a, resolved at prepare
time — CFC spec §8.17.3); a writer-derived principal must come from a stored
column; "the mailbox owner" is `dbOwner()`.

**Integrity from row content is forgeable.** The `when(dmarc=pass)` gate reads
text any row writer controls: a writer who fabricates `auth: "…dmarc=pass…"`
mints authored-by-the-sender provenance for a message the sender never wrote.
Deriving a *confidentiality* OR-set from row content is bounded by the writer's
own release authority (choosing the audience of your own row — CFC spec §3.1.8
conjunctive-join rule, invariant 7); deriving *integrity* from row content is
not bounded by anything. Until the write path can require trusted-ingestion
integrity on the `auth` column itself, `endorsedBy`/`authoredBy` minted this
way MUST lower to a weaker self-describing claim (e.g. a
`ClaimedAuthoredBy`-shaped atom) that policies may upgrade via the
provider-trust pattern (CFC spec §5.6.3), never to the trusted `AuthoredBy`
family directly.

Relatedly, a global `match` over `from` can yield **multiple** "senders"
(crafted display names: `"Mallory <bait@evil>" <real@x>` contains two
address-shaped tokens). For confidentiality alternatives this is
writer-authority-bounded and acceptable; for any integrity-bearing position
the evaluator MUST fail closed on more than one match.

## 5. The serialized spec (AST) and how it is built

The rule compiles to a JSON AST on the table schema. `TableSchema` already has
`[key: string]: unknown`, so it rides existing wire paths unchanged:

```jsonc
"rowLabel": {
  "version": 1,
  "table": "emails",                       // the rule's own table (origin scoping, §7)
  "confidentiality": { "anyOf": [          // any(...) ⟹ one OR-clause; all(...) ⟹ { "allOf": [...] }
    { "principal": { "protocol":"mailto", "of": { "match": { "field":"to",   "source":"[^\\s<>,;\"]+@[^\\s<>,;\"]+", "flags":"g" } } } },
    { "principal": { "protocol":"mailto", "of": { "match": { "field":"from", "source":"…", "flags":"g" } } } },
    { "dbOwner": true }
  ]},
  "integrity": { "when": { "match": { "field":"auth", "source":"dmarc=pass" } },
    "then": { "endorsedBy": { "principal": { "protocol":"mailto",
      "of": { "match": { "field":"from", "source":"…", "flags":"g" } } } } } }
}
```

The `anyOf` node evaluates to a single OR-clause in the row's label, using the
CFC wire form `{ anyOf: [...atoms] }` (CFC spec §4.2.1 / §18.5.1); `allOf`
evaluates to one conjunctive clause per atom (the flat form the runner
understands today).

**Built eagerly — no proxy, no transformer.** `table()` calls the rule once; each
helper *is* a constructor returning its node (`f.to` ⟹ `{field:"to"}`), so the
returned object literally **is** the AST. No trace-capture, no symbolic `.map`, no
transformer lowering — the regex moved the variable-length-ness to runtime, which
collapsed the whole capture problem (a `RegExp` literal serializes to
`{source, flags}`).

Fail-closed **at authoring**: TS types already forbid non-helper expressions
(`match` takes a field handle + `RegExp`; `any`/`all` take terms). On top of
that, `table()` **validates the produced AST** and throws on an unknown column
in any `field`, an unknown op, a regex that fails a safety lint (§6), or — until
the runner ships the clause-aware label profile (CFC spec §18.5.3 rule 3) — any
`anyOf` node. A malformed rule is rejected at definition time — never silently
shipped, and `any(...)` is never silently lowered to conjunctive semantics.

> **Rejected: a TypeScript-type-level rule** (a `RowLabel<…>` carrier lowered by
> the schema-generator, à la `Confidential<T,X>`). Studied on the ground: the
> transformer *can* lower our exact fixed-shape AST from a type, **but** (a) it
> **fails open** — an unreadable sub-term lowers to `undefined` and silently
> drops from the JSON (`extractLiteralLikeValue` in
> `packages/schema-generator/src/formatters/common-fabric-formatter.ts`), i.e.
> silent **under-labeling** with no diagnostic — the opposite of the builder's
> fail-closed authoring; and (b) **integrity is not expressible** — the
> `when(dmarc=pass)` conditional and `intersect`/meet need structure that bare TS
> unions (`A|B` ⟹ `undefined`) can't carry. Integrity is a hard requirement, so
> the type route is out. (A narrower idea — per-column `Readers<string,"mailto",Re>`
> annotations that the *existing* per-column `ifc` lowering already handles — can
> express the union-of-principals *confidentiality* case declaratively and could
> be added later as sugar, but it can't do integrity or meet, so it is not the
> primary surface.)

## 6. The evaluator — one pure function, shared by both sides

A single evaluator interprets the AST against a row's values, producing **both**
label components:

```ts
// NEW: packages/memory/v2/sqlite/row-label.ts  (beside table() and schema.ts)
export function evaluateRowLabel(
  rule: RowLabelSpec,
  row: Record<string, unknown>,                 // column name -> value
  ctx: { dbOwner?: string },                    // fixed db properties only — §4
): { confidentiality: unknown[]; integrity: unknown[] } | { error: string };
```

Op semantics: `match` runs `new RegExp(source, flags)` over the field's string
value, collecting every match (or capture `group`) ⟹ a list; `principal` maps each
to `did:<protocol>:<v>`; `anyOf` collects its terms' atoms (structural dedup) into
**one OR-clause** `{anyOf: [...]}`; `allOf` emits one conjunctive clause per atom;
`intersect` is set ∩ (integrity only);
`when` includes its `then` only if the test regex matches; `dbOwner`
resolves from `ctx` (the db ref's owner — never the acting principal, §4);
`endorsedBy`/`authoredBy` wrap principal atoms into integrity
atoms (the existing `{kind, subject}` shape, cf. `RepresentsCurrentUser`) —
subject to the §4 downgrade rule (content-derived provenance lowers to a
self-describing claim atom, and >1 match in an integrity-bearing position is
`{error}`).

**Placement: `packages/memory`.** `table()` already lives there and the runner
already imports from `@commonfabric/memory/v2` (`columnDeclaresIfc`,
[sqlite-builtins.ts:35](../../../../packages/runner/src/builtins/sqlite-builtins.ts)).
One shared evaluator means the **server** (commit, §8) and **runner** (read, §7)
can never drift — the §2 audit property by construction.

Fail-closed contract (returns `{error}`, never a partial label): a referenced
field absent from `row`; a non-string value where a regex needs one; a
`dbOwner()` with no owner in `ctx`; an unknown op ⟶ **`{error}`**. Callers turn
`{error}` into a refused query / rejected write (§9).

**Regex safety.** Author regexes run **server-side at commit**, so a pathological
pattern is a ReDoS vector against the commit fold. Mitigation (pick at impl): cap
input length, reject nested-quantifier patterns via a `safe-regex` lint at
`table()` time, and/or match via RE2 (linear-time) through FFI. The authoring lint
is the first line; a per-eval input cap is the backstop.

> Alternative considered, deferred: register `principal`/`json_each`/regexp-style
> **SQLite scalar functions** and evaluate the rule as an in-engine SQL expression
> at commit (implementation-plan §9b). Elegant server-side (true row, in-engine,
> atomic), but the runner has no SQLite connection on the read path (rows arrive
> over RPC), so the shared JS interpreter is what unifies both sides today; the
> SQL-function route stays open as a server-side optimization once §8 lands.

## 7. Read side (`db.query`) — the load-bearing path

The read side is where the value is delivered: it makes the email row actually
confidential-to-its-recipients. **It is also self-sufficient** — because the
label is *re-derived from stored data*, the row's effective confidentiality is
fixed by the read-side evaluation regardless of what the write side did. So the
read side is the MVP and ships first.

**Placement: runner-side**, in the `sqliteQuery` flush
([sqlite-builtins.ts:387-471](../../../../packages/runner/src/builtins/sqlite-builtins.ts)),
right where Phase 2 already labels columns. The runner has the result rows,
`res.columns` (origins), the serialized rule (in `db.tables`), and the full CFC
attach machinery. No new server protocol for v1.

Flow, per labeled query result:

1. **Locate the rule's input columns by TRUE origin, not output name** (Phase 2
   soundness rule #1). The rule names `emails.from_email`. For each referenced
   field, find the result column whose `res.columns[k]` origin is
   `(rule.table, field)`. `SELECT subject AS from_email` has origin
   `(emails, subject)` ⟶ does **not** match `from_email` ⟶ no spoof.
2. **Fail closed on missing/ambiguous inputs** (soundness rule #2). A field the
   rule needs that is absent from the projection (`SELECT id, body` omits
   `from_email`/`to_emails`), or two result columns sharing that origin, ⟶
   **refuse the query** (`{error}` on `q.error`, like the duplicate-output-name
   refusal at [sqlite-builtins.ts:205](../../../../packages/runner/src/builtins/sqlite-builtins.ts)).
   Never under-label.
3. **Evaluate** `evaluateRowLabel(rule, rowValues_i, {dbOwner})` per row,
   reading values from the origin-resolved result columns ⟹ `{confidentiality,
   integrity}` (`anyOf`/`allOf`/`intersect`/`when` resolved inside the evaluator). `{error}`
   ⟶ refuse the query.
4. **Combine** the per-row label (confidentiality *and* integrity) with Phase 2's
   per-column label via the **swappable** cross-merge operator (§10) ⟶ the row's
   label.
5. **Attach** that label to row entity `i` (see "per-row attachment" below).

`dbOwner` comes from the db ref (captured when the `sqliteDatabase` handle cell
is created — §4). The *ceiling's* acting-user placeholder is different: it
resolves at prepare time from
`tx.getCfcState().trustSnapshot?.actingPrincipal`
([prepare.ts](../../../../packages/runner/src/cfc/prepare.ts)) — the same source
`{__ctCurrentPrincipal:true}` resolves from (§7a).

### Per-row attachment — the spike (§3's problem, concretely)

Each row already splits into its own entity doc; the question is landing a
*distinct* label on each.

**First, what does NOT work (Oracle-verified against the code).** The tempting
move — after the array write, decorate each slot via
`result.key("result").key(i).asSchema({ifc: rowLabel_i})` (a concrete index
instead of `"*"`) — is **refuted on two independent counts**:

1. **It throws and aborts the commit.** Schema policy inputs are keyed by target
   cell **ignoring path** (`targetKey = space\0scope\0id`,
   [prepare.ts:626](../../../../packages/runner/src/cfc/prepare.ts)), so Phase
   2's array write (`["result"]` ⟶ `{type:"array",items}`) and the per-index
   write (`["result","1"]` ⟶ `{type:"object",properties:{"1":…}}`,
   [prepare.ts:835-854](../../../../packages/runner/src/cfc/prepare.ts)) merge on
   the same key and hit the incompatible-`type` guard ⟶ **throws**
   `type changed incompatibly at /result: ["array"]->["object"]`
   ([schema-merge.ts:262-274](../../../../packages/runner/src/cfc/schema-merge.ts)),
   uncaught out of `prepareBoundaryCommit`
   ([extended-storage-transaction.ts:313](../../../../packages/runner/src/storage/extended-storage-transaction.ts)).
2. **It targets the wrong doc.** Each row already split into its **own** entity
   doc (`recursivelyAddIDIfNeeded` stamps an `[ID]` on every array-element object,
   [cell.ts:2601](../../../../packages/runner/src/cell.ts); the doc is created at
   [data-updating.ts:686-751](../../../../packages/runner/src/data-updating.ts)).
   A concrete-index write decorates the **parent's `["result",i]` link slot**,
   not the row doc that a downstream `.get()` dereferences into — and reads
   accumulate labels from the **row doc's** `["cfc"]` via dereference traces
   ([sqlite-cfc-label.test.ts:104-124](../../../../packages/runner/integration/sqlite-cfc-label.test.ts)).
   The label would never be seen.

**The correct seam: land the row label on the row entity doc's own root.** The
row doc is created at
[data-updating.ts:686-751](../../../../packages/runner/src/data-updating.ts),
which already records a schema policy input for it via
`recordRelevantSchemaWritePolicyInput(tx, newEntryLink, newEntryLink.schema)`
([data-updating.ts:727](../../../../packages/runner/src/data-updating.ts)) at the
doc **root** (path `[]`). A root-level object `ifc` there has **no** array/`"*"`
collision (different doc, root path) and — Oracle-confirmed — propagates to every
field via prefix-match (`cfcLabelPathPrefixMatches` treats `"*"` as a wildcard;
`cfcConfidentialityForObservationNode` **unions** all matching entries,
[label-view-core.ts:31](../../../../packages/runner/src/cfc/label-view-core.ts),
[observation.ts:61](../../../../packages/runner/src/cfc/observation.ts)), so
reading `q.result[i]` or `q.result[i].body` inherits the row label joined with
the field's per-column label. Same-path `ifc` unions monotonically (confidentiality
can't weaken, [schema-merge.ts:125-149](../../../../packages/runner/src/cfc/schema-merge.ts)).
The read-side model in §7 is sound; only the **write seam** had to change.

The remaining question — *how to plumb the per-row-varying label onto each
split-out row doc*, since the array write uses a single `items` schema — is now
**resolved by spike 3.0 (run; verdict below).**

#### Spike 3.0 — RESOLVED. Chosen mechanism: a direct row-doc write.

The spike (a throwaway Runtime-emulator test) wrote `{result:[{a:1},{a:2}]}`
under the Phase 2 per-column schema and then attached a **distinct** root `ifc`
to each row doc, three ways. **Verdict: a second runner-side write to each row
doc — keyed by the row doc's own id, root path — works end-to-end, needs no core
change, and composes in a single transaction.** Concretely, in the flush, after
the array write splits the rows into docs:

```ts
cell.asSchema(perColumnSchema).withTx(tx).set({ result: rows });   // Phase 2 split
for (let i = 0; i < rows.length; i++) {
  const link = parseLink(cell.key("result").key(i).withTx(tx).getRaw()); // {id: rowDocId, path: []}
  createCell(runtime, { ...link, space }, tx)
    .asSchema({ type:"object", additionalProperties:true, ifc: rowLabel_i })
    .withTx(tx).set(rows[i]);     // re-set same value; records the root schema policy input
}
```

Measured result (atoms simplified): each row doc's persisted `labelMap` ends up
`[{path:[], confidentiality:["row-i"]}, {path:["a"], confidentiality:["col-a"]}]`
— the per-row root label and the Phase 2 per-column label **coexist on the same
row doc** (keyed by row-doc id + root path ⟶ **no** array/object collision, so
the merge-throw that kills R1 never arises). A trace read of `result[i].a`
(`cfcLabelViewForDereferenceTraces` after a traversing `.get()`) yields
`["row-i","col-a"]` — **distinct per row**, joined with the column label, the
root label dominating the field via prefix-match. Re-setting the *same* row value
suffices (the schema-ifc-write policy input is recorded on `.set()` regardless of
a value diff), and array-write + per-row writes commit in **one** `editWithRetry`.

This is essentially the spec's S1 goal (per-row root `ifc` on the row doc)
achieved **without** touching the array-split core (`data-updating.ts`) — the
flush just writes each freshly-split row doc directly. The two alternatives were
also exercised: the **carried-label / `link-write`** path (S2) works too but lands
the label on the *parent's* `["result",i]` slot (read via the trace source side)
and doesn't co-locate with the per-column label as cleanly; a new policy-input
kind (S3) is unnecessary. The **refuted** R1 (concrete-index `asSchema` on the
parent) is the one that throws.

> Row doc ids are minted from `frame.generatedIdCounter++`
> ([cell.ts:2608](../../../../packages/runner/src/cell.ts)) — keyed by array
> **position**, not content. Distinct positions ⟶ distinct docs; the same
> position across re-queries ⟶ the same doc id (stable, but the label must be
> recomputed and rewritten whenever the row at a position changes — which the
> flush does every query, so it self-heals).

> The whole-row label correctly dominates its fields: a field of a row is at
> least as confidential as the row, so a root label inheriting down is sound (it
> can only *raise* confidentiality, never lower a field's own column label).

### Read decision: label by default; ceilings, skip-vs-fail, and aggregates

The spec says rows the reader can't see are "filtered, or the query fails
closed." The runtime has **no reader-clearance concept** (ceilings gate
*writes/sinks*; reads attach labels; enforcement happens downstream), so v1's
default is: **attach the per-row label, enforce nothing at read** — identical
philosophy to Phase 2. But three read-surface questions need answers *now*,
because their semantics shape the API even where enforcement is deferred.

**(a) Output ceiling — the consumer declares what the result may carry.** A
query may declare the maximum confidentiality its *result* is allowed to hold:

```ts
// Typed: the Row schema carries it — the transformer ALREADY injects rowSchema
// for db.query<Row>, and the schema-generator ALREADY lowers MaxConfidentiality
// to ifc.maxConfidentiality. Zero new lowering machinery.
type MyView = MaxConfidentiality<EmailRow, [CurrentUser, DbOwner]>;
const q = db.query<MyView>({ sql, onExceed: "skip" });

// Untyped: a per-query option.
const q = db.query({ sql, maxConfidentiality: [...], onExceed: "fail" });
```

Ceiling atoms may be placeholder principals — `{__ctCurrentPrincipal:true}`
(exists today, resolved at prepare time) and a new db-owner placeholder resolved
from the db ref (§4 `dbOwner()`). The check is per row: the computed label
(per-row ⊔ per-column) must **fit** the ceiling — and this is
`cfcObservationFitsCeiling`, which exists. So output ceilings are
**v1-implementable without reader clearance**: not "is the reader cleared" but
"does the result honor its declared contract." It also closes a gap: the result
cell is a *write* destination, so a declared ceiling makes the labeled
result-write subject to the same `maxConfidentiality` discipline as any other
CFC write.

**Ceiling syntax has two readings — they must stay syntactically distinct**
(CFC spec §8.10.3). A flat atom *list* is the **conjunctive** reading: the
destination's own label, all entries required of its observer — that is what
`cfcObservationFitsCeiling`'s flat-subset check implements, and flat lists keep
that meaning permanently. The per-user-mailbox intent ("this result is observed
by any of these principals") is the **reader-enumeration** reading, written as
an explicit OR-clause ceiling — `any([currentUser(), dbOwner()])` — and checked
by clause subsumption: **every** enumerated reader must satisfy **every** clause
of the row's label. The quantification matters: checking only that each clause
is satisfied by *some* enumerated reader would let a row labeled `{DbOwner}`
into a result the current user observes. So `MaxConfidentiality<EmailRow,
[CurrentUser, DbOwner]>` (a list) means current-user ∧ db-owner; the per-user
view wants `any([...])` and lands together with OR-clauses.

**(b) `onExceed: "fail" | "skip"` (default `"fail"`).** What happens when a
row's computed label exceeds the ceiling:

- **`"fail"` (default):** refuse the whole query (`q.error`). Fail-closed,
  leak-minimal, and the only sound mode for aggregates (below).
- **`"skip"` (opt-in):** drop the offending rows, return the rest — "show me
  what fits." Available only for plain row-returning queries. Skipping is
  observable (Q17's "filtering leaks row counts" — a consumer who can compare
  against another source can infer withheld rows); that inherent leak is why it
  is opt-in, not the default.

Q17 is now adjudicated at the CFC spec level (CFC spec §8.17.2, invariant 14):
skip is a per-row release of one presence bit to the result's audience, and it
is permitted only when all three hold — **(i) declared** in the query/schema
contract (this `onExceed` option), never runtime-selected; **(ii)
policy-permitted**: the table's governing policy allows the existence release
(for a shared mailbox store, "other people's rows exist here" is usually the
point — but that judgment belongs to the container's policy); **(iii)
auditable**: skip events are recorded. `"fail"` stays the default.

The option is inert when no ceiling is declared (v1 labels everything). When
3.b reader-clearance lands, the *same* option governs clearance misses — the
ceiling stops being only-declared and becomes the reader's clearance; the
skip/fail machinery is unchanged. Honesty note for v1: under today's
**conjunctive** lowering (flat atoms, subset fit), a multi-participant row
fits only a ceiling that lists *every* participant — so narrow ceilings like
`[CurrentUser]` skip almost everything. Ceilings become genuinely useful for
per-user views once OR-clauses land (a `[[sender ∨ recipients]]` clause is
satisfied by any one participant, CFC spec §3.1.8); the surface is designed
for that future.

**(c) Aggregates and unattributable outputs — `COUNT(*)`, `SUM(x)`,
`upper(x) || y`.** These are null-origin columns (no single `(table, column)`
source). Phase 2 gave them the conservative *static* merge of all labeled
columns (`deriveNullOriginIfc`). With a row rule that is no longer sufficient:
the output derives from **every contributing row**, the sound label is the join
of all their per-row labels, and that cannot be re-derived from the projection
(the rule's inputs aren't present per-row; the output isn't per-row at all). So:

- **Default: refuse.** Any null-origin result column on a rule-bearing table ⟶
  refuse the query (fail closed). Stricter than Phase 2, and deliberately scoped:
  tables *without* a row rule keep Phase 2 behavior unchanged.
- **`skip` never applies to aggregates.** The withheld rows already contributed
  server-side — a count can't be un-counted. With a ceiling declared, an
  aggregate is always `fail`-mode; combined with the default this means
  `COUNT(*)` on a rule-bearing table fails rather than under-labels, which is
  the intended reading.
- **Relaxations, in order of arrival.** (0) *The free one, once OR-clauses
  land*: a principal the rule lists **unconditionally** in `any(...)` (outside
  any `when`) is an alternative in every clause of every row — the
  **common-alternative property** (CFC spec §8.17.4) — so it satisfies the
  join of all contributing rows and reads aggregates **by the ordinary
  algebra**: no declaration, no declassification. With `any(…, dbOwner())`,
  `COUNT(*)` for the db owner is sound as-is; this removes the motivating
  pressure for `derived:`.
  (i) *Author-declared derived label* (optional follow-up): the rule may
  declare `derived: all(dbOwner())` — the label carried by outputs that derive
  from rows without per-row attribution (counts, sums, expressions). Same
  source-B trust basis as the rule itself: the author owns the policy for row
  *contents* (the rule) and for row *existence/aggregates* (`derived`).
  `COUNT(*)` then carries static-merge ⊔ `derived`, ceiling-checked as usual
  (fail-only). Two conditions (CFC spec §8.17.1 rule 4): it is **declared,
  never inferred**, and where its readers go beyond the common-alternative set
  it is an **existence declassification** — it releases row existence to
  principals not entitled to every row — and must be flagged as such in
  review.
  (ii) *Exact aggregate label* (3.c, server-side): the server evaluates the
  rule over the actual contributing rows and joins — precise, no declaration
  needed. Until then, fail closed.

(`GROUP BY` needs no special casing: aggregate columns in the projection refuse
via the rule above, and a missing rule-input column refuses via §7.2.)

**What stays deferred to 3.b:** reader-clearance itself — filtering rows by *who
is asking* rather than by a declared ceiling. That needs a read-time clearance
model the runtime doesn't have, plus the OR-clause work for it to be useful
(the §4 `any`/`all` distinction), and **it warrants its own sub-step** (the task's explicit
question). Note the two distinct "fail closed" senses, kept separate: **(a)
can't evaluate the rule** (missing/ambiguous input, aggregate) ⟶ refuse query —
*in v1*; **(b) reader not cleared for a labeled row** ⟶ skip/refuse per
`onExceed` — *3.b, riding the surface defined here*.

## 8. Write side (`db.exec`) — the gate

The write side is a **gate** (reject bad writes); it does not determine the
row's effective label (read re-derivation does, §7). It has two concerns:

1. **No-laundering:** values flowing *into* the row (`db.exec` params) carry
   upstream CFC labels; each must be captured by the row's computed label, else
   confidential data is stored under a weaker label.
2. **Ceiling / required-integrity:** the row's derived label must fit the
   destination's declared `maxConfidentiality` and satisfy `requiredIntegrity`.

**The layering tension (task rule #5), stated plainly.** These two concerns split
across layers:

- The **input-value labels** (concern 1) live **only in the runner** —
  `cfcLabelViewForCell(value)`
  ([cell.ts .exec()](../../../../packages/runner/src/cell.ts), Phase 2's
  write-ceiling). The server sees raw param values with no CFC labels. So the
  no-laundering check is **inherently runner-side**.
- The **true committed row** (needed to evaluate the rule for non-trivial SQL:
  `INSERT … SELECT`, `SET col = expr`, defaults, triggers) is known **only
  server-side**, after `runWrite`. The runner has params, which equal the row
  only for the simple attributable shapes Phase 2 already handles.

Given that split, the recommended phasing:

- **Phase 3.a (with the read side): runner-side gate, extending Phase 2's
  write-ceiling.** When the target table has a rule and the write is
  *attributable* (params↦columns via `parseWriteParamColumns`,
  [write-targets.ts](../../../../packages/runner/src/builtins/sqlite/write-targets.ts)),
  evaluate the rule on the params ⟶ prospective row label; record it as the
  write's **sink-request** policy input
  ([sink-request.ts](../../../../packages/runner/src/cfc/sink-request.ts), the
  declared seam); check input-value labels fit under it (concern 1) and under the
  declared ceiling/integrity (concern 2). **Fail closed** on non-attributable
  writes — the exact set Phase 2 already rejects (`INSERT…SELECT`, computed SET,
  upsert, named params).
- **Phase 3.c (follow-up): server-side commit evaluation** in
  `applyCommitTransaction`, after `applySqliteOperation`/`runWrite`
  ([engine.ts:3207](../../../../packages/memory/v2/engine.ts)). Read back the
  affected row(s) by rowid (`SELECT <rule input cols> FROM <table> WHERE rowid =
  last_insert_rowid()` — a server-constructed query over known columns, **not** a
  parse of user SQL), evaluate the shared evaluator (§6) against the **true** row,
  enforce ceiling/required-integrity; throw to roll back the whole atomic commit
  on violation. This is the sound enforcement point and the only way to cover
  non-attributable writes.

**What moves into `packages/memory`, and why.** The **evaluator** (§6) moves down
now (so both sides share it). The **server-side gate** (3.c) is what genuinely
requires new memory-layer CFC: row read-back by rowid, ceiling/required-integrity
checks against schema, and rollback-on-violation. Its blocker is concern 1: the
server has no input-value labels, so it can enforce *ceiling/integrity* (pure
functions of row + schema) but **not** no-laundering — that stays runner-side.
3.c is therefore additive trusted enforcement layered under the runner gate, not
a replacement. UPDATE-affected-rowid capture (SQLite gives no updated-rowid set
directly; options: restrict labeled writes to single-row, or a preupdate/session
hook) is the open implementation question for 3.c and a reason to phase it
after 3.a.

## 9. Fail-closed rules (consolidated)

1. **Authoring:** the produced AST references an unknown column, uses an unknown
   op, or carries a regex that fails the safety lint ⟶ `table()` throws (§5).
2. **Read, unresolvable input:** a rule input column missing from the result by
   origin, or ambiguous (two columns same origin) ⟶ refuse the query (§7.2).
3. **Read, bad data:** a value isn't a string where a `match` regex needs one;
   evaluator `{error}` ⟶ refuse the query (§6).
4. **Read, unattributable output:** any null-origin column (`COUNT(*)`,
   expression) on a rule-bearing table ⟶ refuse the query, unless the rule
   declares a `derived` label (§7c). `skip` never applies to aggregates.
5. **Read, ceiling exceeded:** a row's computed label doesn't fit the declared
   output ceiling ⟶ `onExceed` decides: fail the query (default) or skip the
   row (explicit opt-in, row-returning queries only) (§7a-b).
6. **Write, unattributable:** params can't be mapped to the rule's columns
   (Phase 2's set) ⟶ reject the write (§8).
7. **Server (3.c):** can't read back the affected row / can't evaluate ⟶ throw,
   roll back the commit (§8).

Never treat "couldn't resolve / couldn't evaluate" as "no label."

## 10. Combining labels + CT-1668

Two different combines, kept distinct:

- **Within the rule — author-controlled.** `any`/`all`/`intersect` are explicit
  in the surface, so the author expresses clause shape and meet vs. join per
  component directly (e.g. confidentiality = `any(recipients…)` one OR-clause
  or `all(…)` conjunctive clauses; integrity = a single gated `endorsedBy`, or
  `intersect` of several sources). The evaluator just executes what's written.
  Crucially, confidentiality and integrity are **separate** expressions — *not*
  combined through one coupled lattice op, which would nuke integrity the
  moment a confidentiality-only term (`dbOwner()`) is combined in.
- **Cross-merge — one swappable seam.** Folding the per-row label together with
  Phase 2's per-column label (and stamping it onto the row entity) still needs a
  single combine operator. Today `mergeLabel`
  ([label-view-core.ts:68](../../../../packages/runner/src/cfc/label-view-core.ts))
  unions both components; CT-1668 may switch *integrity* to a **meet**. The CFC
  spec is unambiguous about the endpoint (spec §3.1.6.2, §8.6.2): integrity
  combines by class-aware **intersection** whenever labels of *different*
  values fold into a derived one — union is correct only when accumulating
  claims about the *same* value at one path (they all hold of that value).
  Cross-row and aggregate combines are always the derived case. Design rule:
  route every cross-merge through a `combineLabels(a, b, { integrity })` seam
  (default delegating to `mergeLabel`), so flipping integrity to meet is one
  line and doesn't pre-empt CT-1668. Confidentiality stays a join — flat-atom
  union today, clause concatenation once OR-clauses land (more
  clauses/requirements = strictly safe); a merge MUST NOT union the
  *alternatives* of two different clauses (CFC spec §3.1.8 rule 5). Do **not**
  bake a union-integrity assumption into the row-label path.

## 11. Phasing (red-green sub-steps)

| step | scope | gate |
|---|---|---|
| **3.0 spike** | ✅ **DONE** — direct row-doc write confirmed end-to-end (§7); R1 refuted | unblocked |
| **3.a-spec** | `table(cols, rule)` eager-builder helpers + AST serialize + AST validation + `evaluateRowLabel` (conf + integrity, unit-tested in isolation) | — |
| **3.a-read** | runner-side read labeling: origin-resolve inputs, evaluate, combine, attach; aggregate refusal; output ceiling + `onExceed` skip/fail; fail-closed (§9.2-5). e2e | the MVP |
| **3.a-write** | runner-side gate extending write-ceiling; sink-request policy input; fail-closed (§9.6) | — |
| **3.b** | read-time clearance (Q17), riding §7's `onExceed` surface; needs OR-clauses to be useful | **deferred**, own design |
| **3.c** | server-side commit evaluation (true-row, rollback) (§8) | follow-up |

Each ships its own failing-test-first increment; commit in small coherent steps.

## 12. Test plan

- **Unit (pure):** builder→AST (the §4 lambda ⟶ the §5 AST; AST validation rejects
  unknown column/op/unsafe regex); `evaluateRowLabel` (regex `match` splits a dirty
  `Name <addr>, addr` line; `principal` protocol; `any`/`all`/`intersect`; `when` gate;
  `dbOwner` ctx resolution (and the acting-principal term rejected by AST
  validation); `endorsedBy` integrity; each fail-closed branch);
  origin-resolution (alias hides input, spoof, duplicate-origin) using the
  column-origin spike harness — a direct `columnOrigins` unit test must `await
  ensureColumnOriginAvailable()` first
  ([column-origin.ts](../../../../packages/memory/v2/sqlite/column-origin.ts)).
- **e2e (real toolshed):** mirror
  [sqlite-cfc-label.test.{ts,tsx}](../../../../packages/runner/integration/sqlite-cfc-label.test.ts):
  seed two email rows with different sender/recipients; read each row's inherited
  label via `cfcLabelViewForDereferenceTraces(tx, tx.getCfcState().dereferenceTraces)`
  after a traversing `.get()` (not `cfcLabelViewForCell` on the leaf); assert row
  1 ⟶ `{alice,bob,owner}`, row 2 ⟶ `{carol,dave,erin,owner}` (distinct labels =
  the per-row property). Assert **integrity** too: a row whose `auth` shows
  `dmarc=pass` carries the authored-by-sender atom; one without it does not (the
  `when` gate). A `SELECT subject` projection that omits the rule's inputs ⟶
  `q.error` (fail closed). `SELECT COUNT(*)` on the rule-bearing table ⟶
  `q.error` (aggregate refusal; with a `derived` label declared, it instead
  carries that label). Output ceiling: a `MaxConfidentiality`-annotated
  `db.query<Row>` over rows where one fits and one exceeds ⟶ `onExceed:"skip"`
  returns exactly the fitting row; `onExceed:"fail"` (and the default) ⟶
  `q.error`; an aggregate + `onExceed:"skip"` is rejected (fail-only). Write a
  value whose label exceeds the row's computed label ⟶ `db.exec` rejects.
- **Harness gotchas already known:** clone provider rows to extensible via
  `cloneIfNecessary(_, {frozen:false})` before a labeled write; the labeled write
  needs `prepareTxForCommit` (the flush's `editWithRetry` runs it); surface
  `editWithRetry`'s `{error}` to `q.error` rather than leaving `pending`.

## 13. Decisions that need review before coding

1. ✅ **Per-row attachment seam — RESOLVED by spike 3.0** (§7). A direct row-doc
   write under a root-`ifc` schema (keyed by the row doc's own id) attaches
   distinct per-row labels that coexist with per-column labels and read back
   distinctly via dereference traces, in one transaction, with no core change.
   R1 (concrete-index `asSchema` on the parent) refuted (merge-throws). *No
   further input needed — noted here for the reviewer's confirmation.*
2. **Write side now vs later (3.a runner gate vs 3.c server enforcement)** — §8.
   Recommendation: runner gate now (mirrors Phase 2), server enforcement as
   follow-up. *Is shipping the read MVP + runner gate, with server enforcement
   deferred, the right cut — or must 3.c land together to be sound enough to
   merge?*
3. **Filtering deferral** — §7. Recommendation: defer 3.b (no reader-clearance
   exists; Q17's principle is adjudicated, CFC spec §8.17.2). *Confirm that
   labeling + declared-ceiling enforcement (no reader-clearance) is an
   acceptable v1.*
4. **Helper-set expressiveness (Q16)** — §4. *Are `match`(regex) / `principal`
   (protocol) / `any`/`all`/`intersect` / `when` / `endorsedBy` / `dbOwner` enough
   for v1 (confidentiality **and** integrity), or do join-table recipients / richer
   trust metadata need more?*
5. **Integrity combine (CT-1668)** — §10. Within-rule meet/join is now author-
   controlled (`any`/`all`/`intersect`); keep the **cross-merge** `combineLabels`
   swappable and confirm confidentiality-as-join (union today, clause
   concatenation under OR) is uncontested.
6. **Output ceiling + `onExceed`** — §7a-b. Confirm: default `"fail"`; `"skip"`
   opt-in and row-returning-only; the option name itself (`onExceed` vs
   alternatives); and the new db-owner ceiling placeholder (a
   `__ctCurrentPrincipal`-style atom resolved from the db ref) — naming + where
   it resolves.
7. **Aggregate policy** — §7c. Confirm: refuse-by-default on rule-bearing
   tables (Phase 2 behavior preserved for rule-less tables), and whether the
   author-declared `derived:` fallback label is wanted in v1 or deferred until
   a real use case demands it (recommendation: defer).
