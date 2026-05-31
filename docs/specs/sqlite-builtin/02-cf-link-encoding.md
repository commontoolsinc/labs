# 02 — `_cf_link` column encoding

Cell references are first-class values in patterns, but SQLite only stores
scalars. This section defines how a cell crosses that boundary losslessly.

## The rule

A column (or bound parameter) is a **link column** iff **both**:

1. its name ends with the suffix `_cf_link`, and
2. it is declared `TEXT` — by the database's table schema
   (`cfLink<T>()`, Section [01](./01-api.md)), by a `sqliteQuery<Row>` result
   field typed `Cell<T>`, or by SQLite column affinity.

For a link column:

- **On write**, the bound value **must** be a cell reference (a `Cell`, an
  `OpaqueRef` to a cell, or anything that resolves to a link). It is opaquely
  encoded to a **full sigil link string** before the `INSERT`/`UPDATE`.
- **On read**, the stored string is transparently decoded back into a live
  `Cell` before the row reaches the pattern.

The encoding is **opaque to the pattern**: pattern code binds a cell and reads a
cell; the string form is never exposed.

## Throw conditions

The system fails loudly rather than silently mis-storing data:

| Condition | Result |
| --- | --- |
| Binding a cell reference to a **non-`_cf_link`** column/parameter | **throw** — cells may only be persisted via link columns. |
| A column named `*_cf_link` that is **not** declared/affined as `string` | **throw** — link columns must be a single string field. |
| Binding a **non-cell** value to a `_cf_link` column | **throw** — link columns store cells only. |
| Reading a `_cf_link` column whose value is non-null and **not a parseable sigil link** | **throw** (surfaced as the query's `error`). |
| A `_cf_link` value that is itself multi-field / not a single scalar string | **throw** — "they must be a single field of type string and end with `_cf_link`". |

`NULL` in a link column is allowed and decodes to `null` (an absent cell).

## Encoding format

The stored string is a **fully-qualified, absolute** serialization of the
runtime's sigil link — absolute so the row is portable and resolvable
independent of any base document or space.

The runtime already produces this shape. `Cell.getAsLink()` returns a `SigilLink`
(see [`packages/runner/src/cell.ts`](../../../packages/runner/src/cell.ts) and
[`packages/runner/src/link-utils.ts`](../../../packages/runner/src/link-utils.ts)
`createSigilLinkFromParsedLink`). For storage we serialize it with **no `base`**
so `id`, `space`, and `scope` are always present:

```jsonc
// JSON.stringify of the SigilLink, stored as TEXT in the _cf_link column:
{
  "/": {
    "link@1": {
      "id":    "of:bafy2bzace…",                 // entity id, always present
      "space": "did:key:z6Mk…",                   // owning space DID, always present
      "scope": "space",                            // resolved scope, always present
      "path":  ["author", "name"]                  // optional value-relative path
      // NOTE: `schema` and any asCell flags are stripped before storage.
    }
  }
}
```

Rationale for absolute links:

- A database may be ATTACHed by transactions originating in different documents;
  a base-relative link would be ambiguous.
- The VM-file and on-disk sources (Section [03](./03-database-sources.md)) may
  outlive or be shared beyond the originating space; absolute links keep stored
  references meaningful.

## Encode path (write)

Executed during the write built-in's mutation phase, before the statement is
queued into the commit (Section [04](./04-server-execution-and-transactions.md)):

1. Determine which parameters target link columns by mapping each parameter to
   its column (from the statement's named columns) and checking the database's
   table schema (`cfLink` marker); lacking that, fall back to the `*_cf_link`
   column name when the SQL names columns explicitly.
2. For each link parameter:
   - If the value is not a cell reference → **throw**.
   - Resolve it to a `NormalizedFullLink`, build an absolute `SigilLink` via
     `createSigilLinkFromParsedLink(link, { includeSchema: false })` (no base),
     and `JSON.stringify` it.
3. For each non-link parameter: if the value is a cell reference → **throw**;
   otherwise pass through as a SQLite scalar.

Because the cell's `space`/`id` are captured at encode time on the client, the
encoded string is stable regardless of where the row is later read.

## Decode path (read)

Executed in the query built-in after rows return from the server, before
`sendResult`:

1. Identify link columns from, in order: the `sqliteQuery<Row>` schema (a field
   typed `Cell<T>` → `asCell`), the database's table schema (`cfLink` marker),
   or the `*_cf_link` column-name convention from the result set.
2. For each link column value:
   - `null` → `null`.
   - Else `JSON.parse` and validate it is a single `link@1` sigil. If not →
     **throw** into the query `error`.
   - Reconstruct a `Cell` from the normalized link via the runtime (the same
     path `Cell.fromLink`/link resolution uses), carrying the column's declared
     element schema (from `cfLink<T>()` or the `Cell<T>` in `Row`) so downstream
     `.get()`/`.key()` are typed.
3. Non-link columns pass through unchanged.

The decoded `Cell` is a normal reactive cell: reading it later subscribes to
*its* contents independently of the SQL query's own reactivity (Section
[05](./05-reactivity.md)).

## Why a naming convention rather than schema-only

The `*_cf_link` suffix makes the contract legible directly in SQL and in raw
table dumps, and lets the encode/decode rules apply even when neither the table
schema nor a `sqliteQuery<Row>` type covers a column. The schemas
(`cfLink<T>()`, or a `Cell<T>` field in `Row`) refine it with the element type
and, later, CFC labels — but the suffix is the load-bearing, self-documenting
marker.
This mirrors how the runtime already keys behavior off structural conventions
rather than out-of-band registration.
