# Plan — CFC read-label provenance for SQLite

> The foundational problem for CFC-on-read (per-column AND per-row, 06-cfc.md):
> to label a query result soundly, the runtime must know each result column's
> source `(table, column)`. Arbitrary SQL projection (aliases, expressions,
> joins, `*`) hides that. Status: **design** (read-provenance approach decided).

## The problem (why naïve by-name labeling is unsound)

`@db/sqlite` keys result rows by the SELECT's **output column names**, not by
source. Matching result keys to schema columns by name is **unsound**:

- `SELECT body AS x …` → result key `x` → no schema match → the confidential
  `body`'s label is **silently dropped** (leak). Affects per-column too, not just
  per-row.
- `SELECT subject AS from_email …` → result key `from_email` → a per-row
  projection computes the label from `subject`'s value → **wrong/under-restrictive
  label** (spoof).
- A column name present in **multiple joined tables** → the flat result can't say
  which table it came from (ambiguous).

So sound read labeling requires **column provenance**, which by-name does not give.

## Decision: SQLite column-origin metadata via FFI (proven viable)

The bundled `@db/sqlite` libsqlite3 is compiled with
`SQLITE_ENABLE_COLUMN_METADATA` (verified: `sqlite3_column_origin_name` /
`_table_name` / `_database_name` are exported), and both `Database` and
`Statement` expose `unsafeHandle`. Calling `sqlite3_column_origin_name(stmt, i)`
on the prepared statement gives the **true origin** of each result column:

| Query output | origin `(table, column)` | meaning |
|---|---|---|
| `from_email AS renamed` | `(emails, from_email)` | alias resolved |
| `subject AS from_email` | `(emails, subject)` | **spoof defeated** (origin ≠ output name) |
| `upper(from_email) AS x` | `(null, null)` | expression → no single origin |

(Proven by an FFI probe against the bundled lib.) This is sound, needs **no SQL
parser and no query restrictions**, and the only non-mapped case (expressions,
`(null, null)`) is handled by **failing closed**.

### Soundness rules

- A result column is labeled by looking up its **origin** `(table, column)` in the
  declared schema's `ifc` — never by its output name. So an alias is transparent
  and a spoofed output name cannot acquire another column's label.
- **`(null, null)` origin → fail closed.** Expressions, literals, some compound
  selects, and views produce no origin. Such a column is treated as carrying the
  **maximum confidentiality of the query's source tables** (conservative), or the
  query is refused — never silently unlabeled. (A finer "join the labels of the
  columns the expression references" would require expression parsing; null →
  max is the sound default and avoids the parser.)
- **Per-row projection** (Phase 3) is fed by **origin-identified** source columns:
  the projection's inputs (`from_email`, `to_emails`) are located by origin, not
  output name. If a required source column is **absent** from the result (e.g.
  `SELECT subject` only), the row cannot be labeled → fail closed.

## Architecture

Provenance is captured **server-side** (where the prepared statement lives — the
`ReadConnectionPool` connection in the memory package), then labels are applied
**runner-side** (where `db.tables`/`ifc` live):

1. **Server** (`memory`): after preparing the SELECT, read each result column's
   origin `(table, column)` via FFI on `stmt.unsafeHandle`
   (`sqlite3_column_table_name` + `sqlite3_column_origin_name`). Return the rows
   **plus a per-output-column provenance array** `[{ out, table, column } | null]`.
2. **Runner** (`runner`): for each result column, map its origin → the declared
   `db.tables[table].properties[column].ifc`; attach per-column labels to the
   result (per-field, via the persist-label-per-path mechanism). For Phase 3,
   feed origin-identified source columns into `rowConfidentiality(row)` per result
   row. Null origin → fail closed.

This split keeps the engine (which has provenance) and the CFC policy (which has
the schema `ifc`) each doing what only it can.

## FFI plumbing (the one real engineering risk)

We need a stable handle to the **same** libsqlite3 `@db/sqlite` loaded, to call
the origin functions on its statement pointers. Options, in preference order:

1. **Point `@db/sqlite` at a lib we control via `DENO_SQLITE_PATH`** and
   `Deno.dlopen` that same path for the three origin symbols. Guarantees the
   build has column metadata and gives us a known path (no reliance on the
   plug-cached hashed filename). Most robust for production.
2. **Resolve the plug-cached path** the way `@db/sqlite` does (same release URL +
   version) and `dlopen` it. Works today but couples to plug's cache layout.
3. **Upstream**: ask `@db/sqlite` to expose `columnOrigin(i)` on `Statement`.
   Cleanest long-term; not blocking.

`Deno.dlopen` of the same file resolves to the already-loaded image, and the
origin functions read only from the statement struct (no global state), so
calling them on `@db/sqlite`-created statement pointers is safe (proven).

**Fallback if FFI is unavailable in some deployment:** constrain labeled-table
reads to a safe projection (bare/qualified column names only — no `AS`,
expressions, or ambiguous columns), policed by a light output-list check and
failing closed. Less ergonomic, no FFI. Keep as a documented degraded mode.

## What this unblocks

With sound provenance, **both** per-column (Phase 2) and per-row (Phase 3) read
labeling become sound and parser-free:
- **Per-column:** origin → column `ifc` → per-field label on the result.
- **Per-row:** origin-identified source columns → `rowConfidentiality(row)` per
  result row → per-element label; absent source columns → fail closed.

## Open items for the design review

- **D-prov-1 — FFI plumbing path** (Option 1 `DENO_SQLITE_PATH` vs Option 2
  plug-path vs Option 3 upstream). Recommend Option 1 for production robustness;
  Option 2 acceptable to prototype.
- **D-prov-2 — null-origin policy:** max-confidentiality-of-source-tables vs
  refuse-the-query. Recommend **max-of-source** (usable; conservative) with an
  opt-in strict mode that refuses.
- **D-prov-3 — capture cost:** three FFI calls per result column per query. Only
  needed when the queried db declares any `ifc`; skip entirely for unlabeled dbs
  (the common case) so there's zero overhead until CFC is actually used.
- **D-prov-4 — [resolved] non-SELECT-shape edge cases.** Pinned by
  `v2-sqlite-column-origin-test.ts` (run on a read-only connection opened
  exactly as `ReadConnectionPool`) confirms soundness everywhere and is *better*
  than expected: alias → true origin; spoof (`subject AS from_email`) → origin
  `(emails, subject)` (defeated); expression/literal → `(null,null)` (fail
  closed); JOIN → origin table disambiguates same-named columns; and **UNION,
  CTE, view, and subquery all resolve to the TRUE origin** `(emails, from_email)`
  — not null. So null-origin is rarer than feared (mostly just expressions),
  and a non-null origin is never a *wrong* column. The FFI helper is
  `v2/sqlite/column-origin.ts` (`columnOrigins(stmtHandle, count)` +
  `columnOriginAvailable()`), with the lib resolved via `DENO_SQLITE_PATH` or the
  plug-cached prebuilt.
