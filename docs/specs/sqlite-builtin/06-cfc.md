# 06 — CFC

CFC carries **confidentiality and integrity** through SQLite **per column**
(implemented) and **per row** (implemented — Phase 3.a). Per-column static
`ifc` is honored — read-label propagation and write-time ceiling checks,
derived from the labels declared on the table schema. Per-row, **data-derived**
labels are computed from each row's own values by a declarative rule on the
table schema: re-derived and attached per row on read, gated on write. A db
that declares no `ifc` and no row rule is unaffected and pays nothing.

## Background: the existing label model

CFC labels are open-ended sets of **atoms** (immutable JSON values), not a fixed
classification lattice
([`packages/runner/src/cfc.ts`](../../../packages/runner/src/cfc.ts);
`packages/api/cfc-atoms.ts`). A schema attaches labels through its `ifc` field
([`packages/api/index.ts`](../../../packages/api/index.ts)):

- `confidentiality` — who may read (set of atoms; principals are common atoms,
  e.g. `did:mailto:…`, `did:key:…`).
- `integrity` / `addIntegrity` / `requiredIntegrity` — provenance/authenticity
  guarantees.
- `maxConfidentiality` — a ceiling the output may not exceed.
- `ownerPrincipal`, `writeAuthorizedBy` — access/authorization control;
  `{ __ctCurrentPrincipal: true }` resolves to the acting principal at
  prepare-time.

Labels join by **union with structural dedup** (`deepEqual`), and confidentiality
is checked by "every atom in the label fits under the destination's
`maxConfidentiality` ceiling." This flat representation is the all-singleton
degenerate case of the CFC spec's CNF algebra (every atom an independent
conjunctive clause; the subset ceiling check is CFC spec §8.10.3's clause
subsumption restricted to singletons) — the clause-aware migration path is CFC
spec §18.5. Async effects already declare a **write policy**
before committing side effects via the sink-request mechanism
([`packages/runner/src/cfc/sink-request.ts`](../../../packages/runner/src/cfc/sink-request.ts)),
which is the seam SQLite writes will use.

## Per-column labels (implemented)

A column's label is declared on the database table schema's `ifc`, reusing the
mechanism schemas already support. `table(...)` (registered via
`sqliteDatabase({ tables })`, Section [01](./01-api.md)) passes `ifc` through per
field:

```tsx
// Shown inside a pattern body.
const notes = table({
  id: "integer primary key",
  body: { type: "string", ifc: { confidentiality: ["secret-body"] } },
});
```

This honors **source B**: labels DERIVED from the schema's declared per-column
`ifc`. Tunnelling arbitrary captured labels write→read that are NOT described on
the schema (**source A** — a value that flowed in confidential and was stored in
a plain column) is deferred; the reserved label column for that future work is
`cf_label`. Every path below is gated on the db declaring at least one labeled
column (`columnDeclaresIfc`), so unlabeled dbs pay nothing.

### Read — sound column provenance, per-field labels

`@db/sqlite` keys result rows by the SELECT's **output names**, which is unsound:
`SELECT body AS x` hides a confidential column, `SELECT subject AS from_email`
spoofs another, and a name present in several joined tables is ambiguous. So
labels are keyed off each result column's **TRUE origin** `(table, column)`, read
from SQLite column metadata via FFI (`sqlite3_column_origin_name` /
`sqlite3_column_table_name`) on the prepared statement
([`column-origin.ts`](../../../packages/memory/v2/sqlite/column-origin.ts)):

| query output | origin | meaning |
|---|---|---|
| `body AS x` | `(notes, body)` | alias resolved |
| `subject AS from_email` | `(emails, subject)` | spoof defeated |
| `upper(body)` | `(null, null)` | no single source |
| JOIN / UNION / CTE / view / subquery | true origin | disambiguated |

This binds the SAME libsqlite3 `@db/sqlite` already loaded (it is compiled with
`SQLITE_ENABLE_COLUMN_METADATA`; it just doesn't expose those symbols), getting
its path the way `@db/sqlite` does — plug's `download({ cache: "use" })` (a cache
hit returns the already-downloaded file; no scan, no network) — with
`DENO_SQLITE_PATH` as an override. If the symbols can't be bound, a labeled query
fails loudly rather than mislabeling.

Provenance is captured **server-side** (where the prepared statement lives); the
**runner** maps each origin → the column's `ifc` and writes the result rows under
a **per-field label schema** (`labelResultSchema`), so a consumer reading
`q.result[i].<col>` inherits that column's label:

- An origin column's `ifc` is copied to its result field.
- A `null`-origin column (expression / literal / aggregate) does NOT refuse the
  query — it inherits the conservative combined label of the db's labeled columns
  via the runtime's `mergeLabel` (the integrity-combine semantics for *derived*
  data are an open question — see CT-1668).
- Two columns projecting to the same output name **refuse** the query (the
  per-row label would be ambiguous).

The label is attached when the **query result is written back into the result
cell** (the read path), in a transaction separate from — and after — the read.
This is distinct from a SQL mutation, which joins the *caller's* transaction and
is only ceiling-checked; the result-cell write is its own CFC-relevant write and
must be prepared like any `ifc`-bearing write before it commits. The per-field
label lands on each split-out row entity, and a downstream consumer inherits it
by accumulating labels across the dereferences its read traverses (not from the
label of a single navigated cell).

> Implementation: the result write is the post-commit effect of `db.query`,
> committed via `runtime.editWithRetry` (which runs `prepareTxForCommit`); the
> SQL mutation is `db.exec` recording a `sqlite` op on `this.tx`; downstream
> inheritance is `cfcLabelViewForDereferenceTraces`, not `cfcLabelViewForCell`.

### Write — ceiling check

`db.exec` checks each bound value's confidentiality (read off the value via
`cfcLabelViewForCell`) against the target column's `maxConfidentiality`, before
recording the write. The target column is resolved by a bounded, **fail-closed**
parser (`parseWriteParamColumns` / `parseWriteTable`):

- A resolution miss — unknown table, column not in the declared schema, a
  schema-qualified target, an interleaved literal in `VALUES`, `UPDATE OR
  <action>`, an identifier case mismatch — rejects a labeled value rather than
  treating "no ceiling found" as "no ceiling". Column match is case-insensitive.
- Named/object params fail closed for a labeled value (a bind name isn't reliably
  the column, and SET vs WHERE can't be told apart without parsing) — use
  positional `?` with an explicit column list.
- Unlabeled values, and columns without a ceiling, are unaffected.

This is a clean fit because the row schema is *already* a JSON Schema and `ifc`
is *already* understood by `ContextualFlowControl`.

## Per-row labels, derived from row data (implemented — Phase 3.a)

The motivating case: an email row's confidentiality should be the sender, every
recipient, and the mailbox owner — constructed from row data, e.g.
`"did:mailto:" + from_addr`. This is **data-dependent**, so it cannot be a
static schema label; it is computed from the row's own values on write and
**re-derived from stored data** on read.

The rule is a **declarative projection** over (stored columns, fixed db
properties), never pattern code: the atomic SQLite write lands inside
`applyCommitTransaction` server-side (Section
[04](./04-server-execution-and-transactions.md)), where no sandbox code runs,
so the rule must serialize into the table schema and be evaluable by a small
fixed evaluator on either side. That buys the audit property the design is
built around: **a row's label is a pure function of its stored columns** —
recomputable at any time, by either side, identically.

### Authoring surface — `table(columns, rule)`

`table()` takes the rule as an optional second argument
([`schema.ts`](../../../packages/memory/v2/sqlite/schema.ts)); the helpers live
on the builder's `cfSqlite` namespace (one import for the whole vocabulary).
The rule receives a shallow field handle `f` (one accessor per declared column)
and returns `{ confidentiality?, integrity? }` — two **independent**
expressions:

```tsx
// Shown inside a pattern body.
const { table, all, principal, match, whenMatches, authoredBy, dbOwner } =
  cfSqlite;
// Pull address tokens out of a messy "Name <addr>, addr" recipient line.
const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;

const emails = table(
  {
    id: "integer primary key",
    from_addr: "text",
    to_addrs: "text",
    auth: "text",
    body: "text",
  },
  (f) => ({
    // Row confidentiality = sender ∧ every recipient ∧ the mailbox owner.
    confidentiality: all(
      principal("mailto", match(f.from_addr, ADDR, { min: 1 })),
      principal("mailto", match(f.to_addrs, ADDR)),
      dbOwner(),
    ),
    // Provenance gated on the row's own anti-spoof evidence (forgeable by the
    // row's writer — see the integrity rule below).
    integrity: whenMatches(
      f.auth,
      /dmarc=pass/,
      authoredBy(principal("mailto", match(f.from_addr, ADDR, { min: 1 }))),
    ),
  }),
);
```

**"The sender and all recipients" really means *any-of*** — one OR-clause
`[[sender ∨ recipients ∨ owner]]` (an authored disjunction, CFC spec §3.1.8),
written `any(...)`. Under the runner's current flat **conjunctive** lowering
the same atom set means *all-of*: a row fits only a ceiling listing every
participant, so per-user views return nothing. The surface keeps the two
combinators explicit — `all(...)` (conjunctive clauses, works today) and
`any(...)` (one OR-clause, **errors at `table()` time** until the clause-aware
label profile lands, CFC spec §18.5.3) — so the wrong semantics is never
shipped silently.

The closed helper set
([`row-label.ts`](../../../packages/memory/v2/sqlite/row-label.ts); each helper
returns a plain-JSON AST node):

| helper | meaning |
|---|---|
| `match(f.col, /re/, {group?, min?})` | run the regex (forced global) over the column's text ⟹ the ordered list of matches (or capture `group`). The universal field extractor — split + clean in one; subsumes JSON arrays and dirty `Name <addr>` lists. **Strict-if-present:** a non-empty value yielding zero matches fails closed at evaluation (never under-label); `min` makes the field a required anchor |
| `principal(protocol, match(…))` | `did:<protocol>:<v>` for each extracted `v` (distributes over the match list). Normalization is protocol-implied: `mailto`/`web` lowercase + trim; `did:key` untouched (base58 is case-sensitive) |
| `dbOwner()` | the db's owner — the principal that created the SqliteDb cell, resolved from the db ref (a fixed db property, so the rule stays pure; for a per-user-scoped db this is that user) |
| `all(...t)` | separate **conjunctive** clauses, one per atom — today's only confidentiality combinator |
| `any(...t)` | **one OR-clause**: any alternative satisfies it (CFC spec §3.1.8). Serializes, but **rejected at `table()` time** until the clause-aware profile lands — never silently lowered to the conjunctive form |
| `intersect(...t)` | set ∩ over integrity atom sets (the trust-floor meet) — integrity only |
| `whenMatches(f.col, /re/, term)` | include `term` only when the regex TESTS true against the column (gate trust, or a data-dependent conjunct, on extracted metadata). One **fused** helper — a bare `when(matches(…))` pair would collide with the builder's control-flow `when`, whose transformer lowering matches by NAME and mangles any local so named. NB: a gated confidentiality alternative is absent from some rows, so it never has the common-alternative property (CFC spec §8.17.4) |
| `authoredBy(p)` / `endorsedBy(p)` | integrity (provenance) claims over a `principal(…)` term — minted as self-describing claim atoms, see below |
| `constant(atom)` | a literal atom (escape hatch; named `constant` — `const` is reserved) |

`f.<col>` is the only way to name data and may appear **only** as the field
argument of `match` / `whenMatches`.

**No acting-principal term in rules.** `currentUser()` is deliberately not a
helper: a rule must compute the **same** label at the write gate, the server
commit, and read re-derivation — re-derived at read time an acting-principal
term resolves to the *reader*, so in an `any(...)` clause it would place every
reader into the OR-set (self-granted access), and even under `all(...)` the
persisted label would flap with whoever queried last. AST validation rejects
it. The acting user belongs in the **declared output ceiling** (below),
resolved at prepare time (CFC spec §8.17.3); a writer-derived principal must
come from a stored column; "the mailbox owner" is `dbOwner()`.

**Integrity from row content is forgeable.** The
`whenMatches(f.auth, /dmarc=pass/, …)` gate reads text any row writer
controls: a writer who fabricates `auth: "…dmarc=pass…"` would mint
authored-by-the-sender provenance for a message the sender never wrote. So
`authoredBy`/`endorsedBy` mint self-describing `claimed-authored-by` /
`claimed-endorsed-by` atoms — never the trusted `AuthoredBy` family directly;
policies may upgrade the claim via the provider-trust pattern (CFC spec
§5.6.3). Deriving *confidentiality* from row content is, by contrast, bounded
by the writer's own release authority (choosing the audience of your own row).
Relatedly, a global `match` can extract multiple address-shaped tokens from a
crafted display name (`"Mallory <bait@evil>" <real@x>`): acceptable for
confidentiality alternatives, but **more than one match in an
integrity-bearing position fails closed** — a provenance subject must be
unique.

### The serialized spec and the shared evaluator

`table()` runs the rule once at definition time — each helper returns its AST
node, so the returned object literally **is** the AST — validates it, and
attaches it to the table schema as `rowLabel`
(`{version: 1, confidentiality?, integrity?}`), riding the existing
`db.tables` wire paths unchanged. Validation throws at authoring on an unknown
column, an unknown op, an `any()` node (until OR-clauses land), an
integrity-only op in confidentiality position (and vice versa), or a regex
that fails the safety lint (length cap + nested-quantifier/ReDoS reject —
author regexes run at the trusted evaluation points, so a pathological pattern
would be a DoS vector). The same validation **re-runs on wire-supplied specs**
before any evaluation: "couldn't validate" is never "no label".

One pure evaluator —
[`evaluateRowLabel`](../../../packages/memory/v2/sqlite/row-label.ts), in
`packages/memory` beside `table()` — is shared by the write gate, read
re-derivation, and (future) server-side commit evaluation, so the sides can
never drift: the audit property holds by construction. It is fail-closed end
to end: an absent rule-input field, a non-string value where a regex needs
text, a `dbOwner()` with no owner in context, a strict-if-present zero match,
a `min` violation, a multi-match integrity subject, an unknown op — each
returns `{error}`, never a partial label; callers turn `{error}` into a
refused query / rejected write.

### Read — re-derive per row, attach, ceiling (`db.query`)

Because the label is re-derived from stored data, the read side is
self-sufficient: a row is correctly labeled even if it predates the rule.
Implemented in the `sqliteQuery` flush
([`sqlite-builtins.ts`](../../../packages/runner/src/builtins/sqlite-builtins.ts))
with the pure half in
[`row-label-read.ts`](../../../packages/runner/src/builtins/sqlite/row-label-read.ts):

1. **Locate the rule's inputs by TRUE origin, never output name** (Phase 2's
   provenance machinery): for each column the rule reads, find the result
   column whose origin is `(ruleTable, column)`. `SELECT subject AS from_addr`
   does not satisfy `from_addr` — no spoof. A rule input missing from the
   projection, or two result columns sharing its origin, **refuses the
   query**; so does a rule-bearing read without column provenance, or a query
   touching more than one rule-bearing table (cross-rule joins are deferred).
2. **Aggregates refuse.** Any null-origin column (`COUNT(*)`, expression) on a
   rule-bearing query refuses: the output derives from every contributing row,
   and that cannot be re-labeled per row. Rule-less tables keep Phase 2's
   conservative static merge. (Two future lifts: once OR-clauses land, a
   principal listed unconditionally in `any(...)` is an alternative in every
   row's clause — the common-alternative property, CFC spec §8.17.4 — and
   reads aggregates by the ordinary algebra; an author-declared `derived:`
   fallback label remains a possible follow-up.)
3. **Evaluate per row, attach per row.** Each result row already splits into
   its own entity doc; the flush writes each labeled row doc **directly** (its
   own id, root path) under a root-`ifc` schema. Keyed by the row doc's id,
   the per-row root label coexists with Phase 2's per-column field labels on
   the same doc and dominates its fields by prefix-match (a field of a row is
   at least as confidential as the row — inheriting down can only raise).
   Downstream consumers inherit it through dereference traces
   (`cfcLabelViewForDereferenceTraces`), exactly like per-column labels.

**Declared output ceiling.** A query may declare the maximum confidentiality
its result may carry — a consumer contract checked per row against the
computed label (per-row joined with the projection's per-column atoms), **not**
reader clearance (no read-time clearance model exists):

```tsx
// Shown for illustration only.
const skim = db.query<Row>(sql, {
  maxConfidentiality: [{ __ctCurrentPrincipal: true }, { __ctDbOwner: true }],
  onExceed: "skip",
});
```

The ceiling is declared once: either the query's `maxConfidentiality` option
or `ifc.maxConfidentiality` on the typed Row schema (declaring both errors).
Placeholder atoms `{__ctCurrentPrincipal: true}` (the acting user) and
`{__ctDbOwner: true}` (the db's owner) resolve before the check. A flat
ceiling list keeps the **conjunctive** reading permanently — every entry
required of the observer (clause subsumption restricted to singletons, CFC
spec §8.10.3); the reader-enumeration reading ("observed by any of these") is
an explicit `any([...])` ceiling and lands with OR-clauses. Honesty note:
under today's conjunctive lowering a multi-participant row fits only a ceiling
listing every participant, so narrow ceilings skip almost everything —
per-user views become genuinely useful once OR-clauses land.

`onExceed` governs a ceiling miss: **`"fail"`** (default) refuses the whole
query; **`"skip"`** drops the offending rows and returns the rest. Skipping
releases one row-presence bit per withheld row, so it is a **declared**
existence release (CFC spec §8.17.2, invariant 14): opt-in in the query
contract, required to be policy-permitted and auditable — and it never applies
to aggregates (a withheld row already contributed server-side; a count cannot
be un-counted), where the mode is rejected outright.

### Write — the runner gate (`db.exec`)

The write side is a gate; it does not determine the row's effective label
(read re-derivation does). Implemented in `Cell.exec`
([`cell.ts`](../../../packages/runner/src/cell.ts)) with the pure half in
[`row-label-write.ts`](../../../packages/runner/src/builtins/sqlite/row-label-write.ts);
zero cost until a table declares a rule:

- An **attributable INSERT/REPLACE** (positional `?` params with an explicit
  column list — Phase 2's parser) evaluates the rule over the bound values ⟹
  the prospective row label, recorded as the write's CFC policy input via the
  sink-request seam before commit. **No-laundering:** every labeled bound
  value's confidentiality must be captured by that computed label — and an
  empty computed label captures *nothing* (it is not an unrestricted ceiling)
  — else storing the value would launder its label away; fail closed.
- An **UPDATE**'s SET clause must consist entirely of simple `col = ?`
  assignments — attributed from the SQL text, not the bind params; a literal,
  expression, or subquery assignment is unattributable and **fails closed**
  (so `SET col = 'x'` cannot bypass the rule-input check). An attributable
  UPDATE still may not write a rule-input column (the post-image row label
  cannot be computed runner-side — the other inputs are unknown; server-side
  3.c lifts this); one that writes only non-input columns with unlabeled
  values passes, while a labeled value outside an evaluable INSERT fails
  closed. DELETE stores nothing and passes.
- Everything the runner cannot attribute on a rule-bearing table —
  `INSERT…SELECT`, upsert, columnless INSERT, named params, an unparseable
  target — **fails closed**.

### Fail-closed rules (consolidated)

1. **Authoring:** unknown column, unknown op, unsafe regex, `any()` ⟶
   `table()` throws. The same validation re-runs on wire-supplied specs before
   evaluation.
2. **Read, unresolvable input:** a rule input missing from the projection by
   origin, or ambiguous (two columns, same origin) ⟶ refuse the query.
3. **Read, bad data:** evaluator `{error}` (non-string regex input,
   strict-if-present zero match, `min` miss, multi-match integrity subject) ⟶
   refuse the query.
4. **Read, unattributable output:** any null-origin column on a rule-bearing
   query ⟶ refuse; `skip` never applies to aggregates.
5. **Read, ceiling exceeded:** `onExceed` decides — fail the query (default)
   or skip the row (declared opt-in, row-returning queries only).
6. **Write, unattributable:** fail closed (Phase 2's set, plus rule-input
   UPDATEs).
7. **Write, laundering:** a labeled input not captured by the computed row
   label ⟶ reject the write.

Never treat "couldn't resolve / couldn't evaluate" as "no label".

### Combining the label sources

Within a rule, clause shape is author-controlled and explicit (`any` / `all` /
`intersect`), and confidentiality and integrity stay **separate** expressions —
coupling them through one lattice op would nuke integrity the moment a
confidentiality-only term (`dbOwner()`) joins. Folding the per-row label with
Phase 2's per-column label is a join (flat-atom union today; clause
concatenation once OR-clauses land — a merge must never union the
*alternatives* of two different clauses, CFC spec §3.1.8). The integrity
cross-merge remains a swappable seam pending CT-1668; the CFC spec endpoint is
class-aware **intersection** whenever labels of different values fold into a
derived one (CFC spec §3.1.6.2, §8.6.2).

Demos:
[`cfc-row-label-mailbox`](../../../packages/patterns/cfc-row-label-mailbox/main.tsx)
(rule + ceiling + skip + aggregate refusal end to end) and
[`cfc-row-label-records`](../../../packages/patterns/cfc-row-label-records/main.tsx)
(per-row ∧ per-column composition on one row). e2e:
[`sqlite-cfc-row-label.test.ts`](../../../packages/runner/integration/sqlite-cfc-row-label.test.ts).

## Why this stays declarative

Keeping row labels as a declarative projection (rather than a callback into
pattern code) lets the **server** evaluate them at commit time — necessary
because the atomic write happens inside `applyCommitTransaction` server-side
(Section [04](./04-server-execution-and-transactions.md)), where pattern code
does not run. It also makes labels auditable: a row's confidentiality is a pure
function of its stored columns, recomputable at any time.

## Phasing

1. **v1:** no enforcement; `_cf_link` round-tripping only. Schemas *may* carry
   `ifc` but it is ignored.
2. **Phase 2 — per-column: _implemented_** (source B). Honors static `ifc` on
   columns for read-label propagation (sound column-origin provenance, per-field
   labels) and write-time ceiling checks, reusing `ContextualFlowControl`.
   Deferred within Phase 2: **source A** (tunnelling write→read labels not on the
   schema, reserved column `cf_label`).
3. **Phase 3.a — per-row: _implemented_** (#3974). The rule surface, AST +
   validation, the shared evaluator, read-side per-row labeling with declared
   ceilings and `onExceed`, and the runner-side write gate — everything above.
   Deferred:
   - **OR-clauses:** `any(...)` rules and `any([...])` reader-enumeration
     ceilings, gated on the clause-aware label profile (CFC spec §18.5); also
     unlocks common-alternative aggregate reads (CFC spec §8.17.4).
   - **3.b — read-time clearance:** filtering by *who is asking* rather than a
     declared ceiling; rides the same `onExceed` surface, needs OR-clauses to
     be useful. Own design when it lands.
   - **3.c — server-side commit evaluation:** evaluate the shared evaluator
     against the **true** committed row inside `applyCommitTransaction`
     (read-back by rowid), roll back on violation — covers the
     non-attributable writes the runner gate fails closed on today. The
     no-laundering half stays runner-side (the server has no input-value
     labels).
