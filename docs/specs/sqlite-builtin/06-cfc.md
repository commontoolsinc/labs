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
`maxConfidentiality` ceiling." Async effects already declare a **write policy**
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

The labeled write is CFC-relevant, so its transaction is prepared
(`prepareTxForCommit`, via the builtin's `editWithRetry`) before commit or it
rolls back. The per-field label lands on each split-out row entity; downstream
reads inherit it through dereference-trace accumulation (not a single-cell
`cfcLabelViewForCell`).

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

Proposed surface: a **row-label rule** on the table schema that maps row fields
to label atoms. It is a declarative projection (so it can run on the server
during the commit and during reads) rather than arbitrary pattern code:

```tsx
const EmailRowSchema = table(
  {
    id: "integer",
    from_email: "text",
    to_emails: "text", // JSON array of addresses
    body: "text",
  },
  {
    // Per-row confidentiality derived from row fields.
    rowConfidentiality: (row) => [
      principal(row.from_email),          // "did:mailto:" + from_email
      ...jsonArray(row.to_emails).map(principal),
      currentUserPrincipal(),             // resolves to the viewing/owning user
    ],
  },
);
```

Semantics:

- **On write**, the rule is evaluated against the inserted/updated row to
  produce the row's confidentiality atom set, recorded as the write's CFC
  policy input via the sink-request path before commit. The write is rejected if
  it would exceed the destination ceiling or fail required integrity.
- **On read**, the same rule re-derives each row's label from its column values,
  and the row's cell label is the **join** of the per-column labels and the
  per-row label. Rows the reader is not cleared for are filtered (or the query
  fails closed), per the standard confidentiality check.
- The rule must be a **pure projection over the row's own fields** (plus
  runtime-resolved principals like `currentUserPrincipal()`), so it is
  evaluable both server-side at commit and client-side at read without running
  pattern code. Helpers like `principal(field)` compile to
  `"did:mailto:" + field` (or `did:key:` etc. by helper variant).

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
