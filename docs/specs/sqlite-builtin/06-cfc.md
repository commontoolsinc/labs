# 06 — CFC

CFC carries **confidentiality and integrity** through SQLite **per column**
(implemented) and **per row** (deferred). Per-column static `ifc` is honored
today — read-label propagation and write-time ceiling checks, derived from the
labels declared on the table schema. Per-row, data-derived labels (Phase 3) are
still future. A db that declares no `ifc` is unaffected and pays nothing.

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

## Per-row labels derived from a field

The motivating case: an email row's confidentiality should be to the user, the
sender, and all recipients — constructed from row data, e.g.
`"did:mailto:" + from_email`. This is **data-dependent**, so it cannot be a
static schema label; it must be computed from the row's values at write time and
re-derived at read time.

**"To the user, the sender, and all recipients" means *any-of*** — one
OR-clause `[[sender ∨ recipients ∨ owner]]` in CFC terms (an authored
disjunction, CFC spec §3.1.8), written `any(...)` in the rule surface. Under
the runner's current flat **conjunctive** lowering the same atom set means
*all-of*: a row fits only a ceiling listing every participant, so per-user
views return nothing. The surface keeps the two combinators explicit — `all(...)`
(conjunctive clauses, implementable today) and `any(...)` (one OR-clause,
**errors at `table()` time** until the clause-aware label profile lands, CFC
spec §18.5.3) — so the wrong semantics is never shipped silently.

Proposed surface: a **row-label rule** on the table schema that maps row fields
to label atoms. It is a declarative projection (so it can run on the server
during the commit and during reads) rather than arbitrary pattern code (full
helper set and AST: [plans/cfc-phase3-per-row.md](./plans/cfc-phase3-per-row.md) §4–§5):

```tsx
const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;
const EmailRowSchema = table(
  {
    id: "integer",
    from_email: "text",
    to_emails: "text", // dirty "Name <addr>, addr" list; regex splits it
    body: "text",
  },
  (f) => ({
    // Per-row confidentiality derived from row fields: one OR-clause.
    confidentiality: any(
      principal("mailto", match(f.from_email, ADDR)),
      principal("mailto", match(f.to_emails, ADDR)),
      dbOwner(),                          // the mailbox owner, from the db ref
    ),
  }),
);
```

Semantics:

- **On write**, the rule is evaluated against the inserted/updated row to
  produce the row's confidentiality atom set, recorded as the write's CFC
  policy input via the sink-request path before commit. The write is rejected if
  it would exceed the destination ceiling or fail required integrity.
- **On read**, the same rule re-derives each row's label from its column values,
  and the row's cell label is the **join** of the per-column labels and the
  per-row label. When a row's label exceeds what the result may carry, the query
  **fails closed by default**; dropping the offending rows (`onExceed: "skip"`)
  is a declared opt-in, because skipping releases one row-presence bit per
  withheld row — it requires the table's policy to permit that existence
  release and the skips to be auditable (Q17, adjudicated as CFC spec §8.17.2
  and invariant 14). Skip never applies to aggregates.
- The rule must be a **pure projection over the row's own fields** (plus fixed
  db properties like `dbOwner()`), so it is evaluable both server-side at
  commit and client-side at read with the **same** result. The acting-principal
  placeholder is deliberately not a rule term — re-derived at read time it
  would resolve to the *reader*, placing every reader into an `any(...)`
  clause; it belongs in the result's declared ceiling instead (CFC spec
  §8.17.3). Helpers like `principal("mailto", term)` compile to
  `"did:mailto:" + v` per extracted value (or `did:key:` etc. by protocol
  argument).

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
3. **Phase 3 — per-row:** add the row-label projection, evaluated at commit and
   read; integrate with row-level filtering/fail-closed reads.
