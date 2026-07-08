# 06 — CFC

CFC carries **confidentiality and integrity** through SQLite **per column**
(implemented) and **per row** (implemented — Phase 3.a–c). Per-column static
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
  query — it inherits the conservative combined label of the db's labeled
  columns: confidentiality unions (a sound over-approximation), but integrity is
  NOT unioned — CT-1668 settled the integrity cross-merge on the class-aware meet
  (never union), so a computed value inherits no integrity evidence and is
  conservatively dropped (full propagation classes pending).
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
| `all(...t)` | separate **conjunctive** clauses, one per atom — the default confidentiality combinator |
| `any(...t)` | **one OR-clause**: any alternative satisfies it (CFC spec §3.1.8). Serializes into the rule as an authored OR-clause (un-reserved by Epic E1) — never silently lowered to the conjunctive form |
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
column, an unknown op, an integrity-only op in confidentiality position (and
vice versa), or a regex
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
2. **Aggregates lift by the common-alternative property, else refuse.** A
   null-origin column (`COUNT(*)`, expression) on a rule-bearing query derives
   from every contributing row and cannot be re-labeled per row, so per-row
   attribution is impossible. Instead the read intersects, across every
   **confidentiality-bearing** rule-bearing table, the atoms that are a *static
   unconditional reader of every row* — a `dbOwner()` or `constant(...)`
   alternative that appears in every conjunctive clause (the common-alternative
   property, CFC spec §8.17.4). Three outcomes:
   - **A non-empty intersection** labels the aggregate rows by that reader set
     (a single atom, or an `any(...)` OR-clause) and lets the declared output
     ceiling decide — a member reads the join of all contributing rows, so the
     aggregate carries no declassification.
   - **An integrity-only (or otherwise unconstrained) set of tables** imposes no
     confidentiality, so the aggregate is public: it carries no per-row label.
   - **A confidentiality-bearing table with no reader in the intersection**
     (e.g. a per-row `principal(match(...))` rule, or two tables with disjoint
     owners) still **refuses**: no principal is guaranteed to read every
     contributing row. Query the rows directly, add an unconditional reader, or
     move the aggregate to a rule-less table.

   Rule-less tables keep Phase 2's conservative static merge. (An
   author-declared `derived:` fallback label for the refuse case remains a
   possible follow-up.)
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
computed label (per-row joined with the projection's per-column atoms). It is
**not** reader clearance: the ceiling asks "may the result carry this?", not
"may *this reader* see it?". Read-time clearance is a separate, opt-in mode
(below).

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
ceiling list keeps the **conjunctive** reading — every entry required of the
observer (clause subsumption restricted to singletons, CFC spec §8.10.3); the
reader-enumeration reading ("observed by any of these") is an explicit
`any([...])` ceiling, **implemented** with OR-clauses (Epic A2). A row modeled
with an `any(...)` rule fits such a reader-enumeration ceiling, so per-user
views are now genuinely useful; a flat conjunctive label of the same
participants would still require a ceiling listing every one.

`onExceed` governs a ceiling miss: **`"fail"`** (default) refuses the whole
query; **`"skip"`** drops the offending rows and returns the rest. Skipping
releases one row-presence bit per withheld row, so it is a **declared**
existence release (CFC spec §8.17.2, invariant 14): opt-in in the query
contract, required to be policy-permitted and auditable — and it never applies
to aggregates (a withheld row already contributed server-side; a count cannot
be un-counted), where the mode is rejected outright.

**Read-time clearance (Phase 3.b).** Filtering by *who is asking*, rather than
by a declared contract: `db.query(sql, { readClearance: true })` keeps only the
rows the **acting reader** may read and drops the rest. A reader may read a row
iff, for **every** conjunctive clause of the row's re-derived confidentiality,
the reader is one of that clause's alternatives (the label stores concrete
principals — `dbOwner()` is resolved at eval time — so this is exact-match; a
non-principal atom like a caveat is never reader-satisfiable, so the row is
withheld — fail closed). Because dropping a row releases its presence bit, this
is a **declared existence release** (CFC spec §8.17, invariant 14) and requires
all three:

- **(a) declared** in the query contract (the explicit `readClearance` option —
  never a silent fallback);
- **(b) policy-permitted**: the touched rule-bearing table must opt in with
  `table(columns, rule, { allowReadClearance: true })` (serialized as
  `rowLabelReadClearance` on the schema). A clearance query against a table that
  has not opted in **refuses**; so does one that touches no rule-bearing table,
  or that runs with no acting principal;
- **(c) auditable**: the query result reports `withheld` — the count of rows the
  reader could not read — so the release is observable in aggregate without
  leaking which rows were dropped.

It **never applies to aggregates** (a null-origin projection has no per-row
reader to test), where the mode is rejected outright. Read-time clearance
composes with a declared ceiling: a row survives only if **both** the contract
admits it and the reader may read it.

```tsx
// Shown for illustration only.
// Per-user mailbox view: each reader sees only their own messages.
const mine = db.query<Row>("SELECT * FROM messages ORDER BY id", {
  readClearance: true,
});
// mine.withheld === (rows the acting reader may not read)
```

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
  UPDATE may write a rule-input column only when the server evaluates at
  commit (the 3.c relaxation below); one that writes only non-input columns
  with unlabeled values passes, while a labeled value outside an evaluable
  INSERT fails closed. DELETE stores nothing and passes.
- Everything the runner cannot attribute on a rule-bearing table —
  `INSERT…SELECT`, upsert, columnless INSERT, named params, an unparseable
  target — **fails closed**, except the 3.c-covered shapes below.
- **The 3.c relaxation (capability-gated).** When the connected server
  advertises commit-time re-derivation (`sqliteCommitRowLabelEval` in its
  `hello.ok` protocol flags — inherent to the server build, stored by the
  memory client, read synchronously by the gate; absent/unknown reads
  `false`), the shapes whose ONLY problem is that the runner cannot see the
  committed row are admitted with **unlabeled** inputs: `INSERT…SELECT`,
  upsert, columnless INSERT (including zero-param `DEFAULT VALUES`), and an
  attributable UPDATE that writes a rule-input column. The server derives the
  label from the true post-image (below). **No-laundering stays runner-side
  regardless**: the server sees only stored values, never the CFC labels the
  writer's bound inputs carry, so a labeled value bound to a shape the runner
  cannot evaluate keeps failing closed — there is no computed row label to
  verify capture against. Named params, a literal/expression SET, and an
  unparseable/undeclared target also keep failing closed. Against an old
  server (no advertisement) every reject stays exactly as before. Admitted
  relaxed shapes record no runner-side policies; the read side re-derives.

### Server commit — re-derive the committed row (implemented — Phase 3.c)

The write's ground truth is the row the statement actually commits, whatever
the statement's shape — so the server re-derives it there. Inside
`applyCommitTransaction`
([`commit-eval.ts`](../../../packages/memory/v2/sqlite/commit-eval.ts),
called from `applySqliteOperation`), a folded `sqlite` write whose target
table declares a rule:

1. executes with an appended `RETURNING <rowid> AS __cf_rowid` (stepping to
   completion applies the whole DML and yields the affected rowids; the
   returned-row count must equal `sqlite3_changes` — a mismatch means the
   suffix didn't take effect, e.g. an unterminated trailing comment swallowed
   it — else fail closed);
2. reads the affected rows **back by rowid** — the TRUE post-image, immune to
   RETURNING's same-statement timing caveats — selecting exactly the rule's
   input columns;
3. runs the **shared evaluator** (`evaluateRowLabel`, the same one the write
   gate and read re-derivation use) per row with `dbOwner` resolved from the
   op's db ref, and **throws on any failure — rolling back the whole commit**,
   cell ops included.

Evaluation runs **unconditionally** (not gated on the client's protocol
flags): it is the server's own soundness enforcement, so a stale or hostile
client cannot skip it. Fail closed server-side, each rolling back the commit:
an unattributable or undeclared target on a rule-bearing db (attributed with
the SAME shared parser the runner gate uses,
[`write-targets.ts`](../../../packages/memory/v2/sqlite/write-targets.ts)), an
unrecognized leading keyword (CTE-fronted writes), an invalid wire-supplied
spec, a statement that already carries RETURNING (a second clause cannot be
appended soundly — and `db.exec` returns void, so it had no consumer), every
rowid alias shadowed by declared columns, an affected-row count over the
policy cap (`MAX_ROW_LABEL_EVAL_ROWS`; each row runs the rule's regexes on the
shared engine connection, and INSERT…SELECT escapes the params-ride-the-
statement bound), a read-back/count mismatch, and any evaluator `{error}`.
DELETE and rule-less target tables keep the plain write path; rule-less dbs
pay nothing.

A rolled-back commit is a **terminal** rejection: the server preserves the
`RowLabelCommitError` name over the wire (it is not collapsed into a generic
`TransactionError`), and the runner classifies it non-retryable
([`storage/rejection.ts`](../../../packages/runner/src/storage/rejection.ts)
`isTerminalRejection`). Re-running the identical handler would recompute the
identical refused write, so the doomed handler stops immediately rather than
consuming its retry budget — its per-attempt speculative rev bumps would only
starve concurrent sibling commits that share reactive state.

Trust note: `op.db.owner` is client-supplied like the rest of the db ref. A
forged owner can only turn an ABSENT `dbOwner()` resolution into a present
one — every structural failure the evaluator enforces (strict-if-present,
`min` anchors, unique integrity subjects, malformed nodes) is
owner-independent — and the read side re-resolves the owner from the handle
cell, never from a writer's claim. Residual (accepted): a mid-session server
swap new→old behind one host could admit one relaxed write that neither side
evaluates; no-laundering still ran runner-side, and the read side still
re-derives.

### Fail-closed rules (consolidated)

1. **Authoring:** unknown column, unknown op, unsafe regex, an integrity/
   confidentiality op in the wrong position, or a malformed `any()` alternative
   (a nested `all()`/`any()`) ⟶ `table()` throws. A well-formed `any(...)` is
   accepted as an authored OR-clause (Epic E1). The same validation re-runs on
   wire-supplied specs before evaluation.
2. **Read, unresolvable input:** a rule input missing from the projection by
   origin, or ambiguous (two columns, same origin) ⟶ refuse the query.
3. **Read, bad data:** evaluator `{error}` (non-string regex input,
   strict-if-present zero match, `min` miss, multi-match integrity subject) ⟶
   refuse the query.
4. **Read, unattributable output:** a null-origin column on a rule-bearing query
   lifts by the common-alternative property (rule 2 / CFC spec §8.17.4) when a
   reader is a static unconditional reader of every row; otherwise ⟶ refuse.
   `skip` never applies to aggregates.
5. **Read, ceiling exceeded:** `onExceed` decides — fail the query (default)
   or skip the row (declared opt-in, row-returning queries only).
6. **Write, unattributable:** fail closed (Phase 2's set) — except the
   3.c-covered shapes with unlabeled inputs against a server that advertises
   commit evaluation (rule-input UPDATE, INSERT…SELECT, upsert, columnless
   INSERT).
7. **Write, laundering:** a labeled input not captured by the computed row
   label ⟶ reject the write — including on every 3.c-relaxed shape (the
   runner cannot compute the label those would store it under).
8. **Commit, server-side (3.c):** unattributable/undeclared target,
   CTE-fronted write, pre-existing RETURNING, invalid wire spec, shadowed
   rowid, row cap, read-back mismatch, evaluator `{error}` ⟶ throw, rolling
   back the whole commit.

Never treat "couldn't resolve / couldn't evaluate" as "no label".

### Combining the label sources

Within a rule, clause shape is author-controlled and explicit (`any` / `all` /
`intersect`), and confidentiality and integrity stay **separate** expressions —
coupling them through one lattice op would nuke integrity the moment a
confidentiality-only term (`dbOwner()`) joins. Folding the per-row label with
Phase 2's per-column label is a join — clause concatenation for confidentiality
(a merge must never union the *alternatives* of two different clauses, CFC spec
§3.1.8). CT-1668 settled the integrity cross-merge on the class-aware
**intersection** the CFC spec endpoint prescribes (§3.1.6.2, §8.6.2) — integrity
is never unioned when labels of different values fold into a derived one.

Demos:
[`cfc-row-label-mailbox`](../../../packages/patterns/cfc-row-label-mailbox/main.tsx)
(rule + ceiling + skip + aggregate refusal end to end) and
[`cfc-row-label-records`](../../../packages/patterns/cfc-row-label-records/main.tsx)
(per-row ∧ per-column composition on one row). e2e:
[`sqlite-cfc-row-label.test.ts`](../../../packages/runner/integration/sqlite-cfc-row-label.test.ts)
(3.a/3.b) and
[`sqlite-cfc-commit-eval.test.ts`](../../../packages/runner/integration/sqlite-cfc-commit-eval.test.ts)
(3.c: atomic rollback + post-image upsert relabel).

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
   - **OR-clauses: _implemented_.** The CNF clause kernel + digest-stable
     `anyOf` canonicalization, clause-subsumption ceiling fit, clause-
     concatenation join, and author-written disjunctive confidentiality (Epic
     A1–A5, #4466–#4481); sqlite `any(...)` un-reserved (Epic E1, #4475);
     common-alternative aggregate reads (CFC spec §8.17.4) via Epic E2 (#4477).
     An authored `any(sender ∨ recipients ∨ owner)` now serializes into the rule
     as one OR-clause instead of erroring at `table()` time.
   - **3.b — read-time clearance: _implemented_** (Epic E3, #4478). Filtering by
     *who is asking* via a separate `db.query({ readClearance: true })` option —
     distinct from the declared-ceiling `onExceed`; it drops rows the reader
     can't read regardless of `onExceed`.
   - **3.c — server-side commit evaluation: _implemented_** (Epic E4, #4552).
     The shared evaluator runs against the **true** committed rows inside
     `applyCommitTransaction` (read-back by rowid), rolling back on violation
     — covering the non-attributable writes the runner gate previously failed
     closed on (INSERT…SELECT, upsert, columnless INSERT, rule-input UPDATE),
     relaxed at the gate only when the server advertises the
     `sqliteCommitRowLabelEval` capability. The no-laundering half stays
     runner-side (the server has no input-value labels). See "Server commit"
     above.
   - **Deferred:** cross-rule joins — a query touching more than one
     rule-bearing table fails closed (`row-label-read.ts`).
