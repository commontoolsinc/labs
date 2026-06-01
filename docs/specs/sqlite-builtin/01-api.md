# 01 — TypeScript API

## Built-in vs. new Cell type — decision

**Decision: built-ins, with a lightweight, opaque database *handle*.** We do not
introduce a new `Cell` subtype.

The runtime's reactive I/O — `fetchData`, `generateText`, `streamData` — is all
expressed as built-ins registered in
[`packages/runner/src/builtins/index.ts`](../../../packages/runner/src/builtins/index.ts)
and surfaced as builder factories in
[`packages/runner/src/builder/built-in.ts`](../../../packages/runner/src/builder/built-in.ts).
A built-in returns an `OpaqueRef<{ pending, result, error }>` and re-runs when
its inputs change. A SQLite query is the same shape, so it slots into the
existing machinery: read-tracking, scheduler subscription, post-commit effects,
request hashing, and the CFC write-policy sink (Section
[06](./06-cfc.md)) are all reused rather than re-implemented.

A new `Cell` *subclass* (e.g. `SqliteCell` with `.query()`/`.execute()` methods)
was considered and rejected for v1:

- `Cell` is deeply woven into schema inference
  ([`packages/api/schema.ts`](../../../packages/api/schema.ts)), link
  serialization ([`packages/runner/src/cell.ts`](../../../packages/runner/src/cell.ts)),
  and `asCell` wrapping. A new subtype touches all of it.
- Methods that *create graph nodes* (so they participate in reactivity) don't
  belong on a value handle — node creation is the builder's job. Sugar methods
  would just forward to the built-ins anyway.
- Read and write must be **separately gated** by CFC. Two built-ins make the
  capability boundary explicit; methods on one object blur it.

The "database type" the author cares about is therefore expressed two ways,
neither of which is a new Cell subclass:

- The **handle** is a branded, opaque value (`SqliteDatabase`) — see "The handle
  type" below.
- The **table/row shape** lives on the database (`sqliteDatabase({ tables })`),
  with `sqliteQuery<T>` declaring divergent result shapes — see "Schema
  ownership" and "TypeScript and table types".

## The handle type

`SqliteDatabase` is a **branded, otherwise-empty type**: opaque to pattern code,
a cell reference to the runtime.

```ts
declare const __sqliteDb: unique symbol;
/** Opaque database handle. Empty to pattern code; carries a `toCell`
 *  back-pointer to its handle cell at runtime. Patterns only ever *forward* it
 *  (to sqliteQuery / sqliteExecute / reactOn), never read it. */
type SqliteDatabase = { readonly [__sqliteDb]: true };
```

Why a branded value rather than `Cell<SqliteDatabase>` or `OpaqueCell<…>`:

- A handle should be **forwarded, never read**. The database identity/source is
  opaque to the pattern by design, so there are no fields to expose. A branded
  empty type expresses exactly that.
- It still travels as a **reference**, because every value materialized from a
  cell carries a `toCell` back-pointer
  ([`packages/runner/src/back-to-cell.ts`](../../../packages/runner/src/back-to-cell.ts);
  query-result proxies expose `[toCell]: () => Cell<unknown>` —
  [`packages/runner/src/query-result-proxy.ts`](../../../packages/runner/src/query-result-proxy.ts)).
  So the runtime can always recover the handle cell — to name the database
  (from its entity id), to resolve its source server-side, and to subscribe for
  reactivity — without the pattern ever holding a readable `Cell`.
- The handle cell's **readable value is empty**; the source descriptor lives as
  **server-side state keyed by the handle cell's id** (Section
  [03](./03-database-sources.md)), so even at runtime a pattern materializing the
  handle gets `{}` + `[toCell]`, never the file path. The brand is truthful, not
  cosmetic.

## `sqliteDatabase(options?, source?)`

Builder factory returning a handle. The **table schema and DDL are owned here**
(see "Schema ownership") — passed first because they are the common case. The
optional **source** comes second because it is rarely non-default; with no
source the handle binds to a cell allocated for it in the current pattern
context (the default, cell-derived source).

```ts
export declare function sqliteDatabase(
  options?: { tables?: TableSchemas },
  source?: SqliteDatabaseSource,
): SqliteDatabase; // OpaqueRef<SqliteDatabase> in builder position

type SqliteDatabaseSource =
  | undefined // default: cell-derived from the pattern's own context (Section 03.1)
  | { vm: OpaqueRef<VmHandle>; path: string }; // VM file (stub, Section 03.2)
// NOTE: there is no way to point a database at an arbitrary cell. The
// cell-derived handle is always the one the runtime allocates for this call —
// targeting some other cell would re-introduce ambient authority. There is also
// no `{ disk }` variant: on-disk databases are *injected* as a pattern input via
// `cf piece link <piece> <field> sqlite:<path>` (Section 03.3), not selected by
// the pattern.
```

The underlying database identity (file name / attach alias) is **opaque to the
pattern** — derived from the handle cell's entity id (Section
[03](./03-database-sources.md)) and never constructed by pattern code.

## Schema ownership — the database owns its tables

The table/column schema is a property of the **database**, not of an individual
query, so it is declared once on `sqliteDatabase({ tables })` rather than
re-stated per call. The runtime **owns table creation and migration** from this
declaration, validating that `_cf_link` columns are `TEXT` and (later) attaching
per-column CFC labels in one place.

```tsx
import { table, cfLink, sqliteDatabase } from "commonfabric";

const db = sqliteDatabase({
  tables: {
    messages: table({
      id: "integer primary key",
      body: "text",
      ts: "integer",
      author_cf_link: cfLink<User>(), // TEXT in SQLite, Cell<User> in TS
    }),
  },
});
```

This is the single source of truth: the per-query `rows` argument is **gone**.
Because result columns map back to declared columns by name, the runtime already
knows which columns are `_cf_link` for a straightforward
`SELECT … FROM messages`, and decodes them (Section [02](./02-cf-link-encoding.md))
with no per-query annotation.

Leaving DDL to the database (rather than the old manual `CREATE TABLE IF NOT
EXISTS` in pattern code) avoids silent drift: `CREATE TABLE IF NOT EXISTS`
no-ops when a table already exists with a *different* shape, hiding mismatches.
Runtime-owned migration reconciles the declared schema instead. (Migration
scope and SQLite `ALTER` limits are tracked in
[08-open-questions.md](./08-open-questions.md).)

## `sqliteQuery<Row>(params)` — reactive read

```ts
type SqliteQueryParams = {
  db: SqliteDatabase;
  /** A single read-only statement. Multiple statements / write statements throw. */
  sql: string;
  /** Positional (`?`) or named (`:name`) bindings. A cell bound to a `_cf_link`
   *  column is encoded per Section 02; a cell bound anywhere else throws. */
  params?: unknown[] | Record<string, unknown>;
  /** Reactivity input. Read wholesale (any schema); when its committed value
   *  changes, the query re-runs. Pass the whole `db` for "any committed write
   *  to this database re-runs". See Section 05. */
  reactOn?: unknown;
};

type SqliteQueryState<Row = Record<string, unknown>> = {
  pending: boolean;
  result?: Row[];
  error?: unknown;
};

export declare function sqliteQuery<Row = Record<string, unknown>>(
  params: SqliteQueryParams,
): OpaqueRef<SqliteQueryState<Row>>;
```

`sqliteQuery` is **read-only**. The server rejects any statement that is not a
single `SELECT` (or read-only CTE). `_cf_link` columns are decoded back into
live cells before the rows reach the pattern (Section
[02](./02-cf-link-encoding.md)).

The **`Row` type argument replaces the old `rows` schema**. In this codebase a
type argument can be lowered to a runtime JSON Schema by the transformer — that
is exactly what `toSchema<T>()` does (a compile-time call the transformer
rewrites; the runtime stub throws if the transformer didn't run —
[`packages/runner/src/builder/factory.ts`](../../../packages/runner/src/builder/factory.ts)).
`sqliteQuery<Row>` is wired the same way: the transformer lowers `Row` into the
runtime schema the built-in receives, so **one type argument gives both the
author-facing return type and the runtime decode/CFC schema** — they cannot
drift, because they are the same `Row`.

This also handles projections the table schema can't: because `Cell<T>` lowers
to `asCell`, declaring a result field as `Cell<User>` tells the runtime that
column is cell-bearing **even when an alias hides the `_cf_link` suffix**:

```tsx
sqliteQuery<{ who: Cell<User>; n: number }>({
  db,
  sql: "SELECT author_cf_link AS who, count(*) AS n FROM messages GROUP BY author_cf_link",
  reactOn: db,
});
// `who` carries asCell -> the stored sigil link is decoded into Cell<User>,
// even though the projection aliased away the _cf_link suffix.
```

For a straightforward `SELECT … FROM <declared table>`, omit `Row` and let the
database's table schema drive decoding. Reach for `<Row>` when the projection
diverges (joins, aliases, computed columns).

> **Transformer dependency.** `sqliteQuery<Row>` requires the ts-transformer to
> lower its type argument into a schema (alongside `toSchema<T>`). Without that
> support the generic is erased and carries no runtime decode/CFC info. This is
> a transformer feature, not just a signature — confirm with the
> ts-transformers owner. See [08-open-questions.md](./08-open-questions.md).

## `sqliteExecute(params)` — write

```ts
type SqliteExecuteParams = {
  db: SqliteDatabase;
  /** One or more write statements (INSERT/UPDATE/DELETE). DDL is owned by the
   *  database, not issued here. */
  sql: string;
  params?: unknown[] | Record<string, unknown>;
};

type SqliteExecuteState = {
  pending: boolean;
  /** rowid of the last inserted row, and number of changed rows, after commit. */
  result?: { lastInsertRowid?: number; changes: number };
  error?: unknown;
};

export declare function sqliteExecute(
  params: SqliteExecuteParams,
): OpaqueRef<SqliteExecuteState>;
```

`sqliteExecute` is **effectful**. It is registered with `isEffect: true` (as
`llm`/`generateText` are in
[`packages/runner/src/builtins/index.ts`](../../../packages/runner/src/builtins/index.ts))
and its writes are folded into the surrounding commit transaction so they are
atomic with cell writes (Section [04](./04-server-execution-and-transactions.md)).

There is **no per-call `bind` schema**: the database's table schema already
declares which columns are `_cf_link`, so for `INSERT INTO messages
(author_cf_link, …)` the runtime maps each parameter position to its column and
encodes link parameters accordingly. A cell bound to a parameter is encoded to a
sigil link **only** when that parameter targets a `_cf_link` column; otherwise
binding a cell throws (Section [02](./02-cf-link-encoding.md)).

## TypeScript and table types — why these boundaries

- **Table/column declaration** lives on the database (`table(...)`,
  `cfLink<T>()`), because it is a property of the database and is the natural
  home for `_cf_link` markers and future per-column CFC labels (the same `ifc`
  mechanism schemas already support —
  [`packages/api/index.ts`](../../../packages/api/index.ts) `ifc` field).
- **Result-row typing** is the `sqliteQuery<Row>` type argument, lowered to a
  runtime schema by the transformer — needed only when a projection diverges
  from a declared table.
- **We do not infer types from the SQL string.** An in-type SQL parser
  (dialect, expressions, joins, aliases) is brittle and out of proportion to the
  value. Parameter tuples remain author-annotated.

`table(...)` and `cfLink<T>()` compile to plain JSON Schema; `cfLink<T>()` emits
`{ type: "string" }` plus an internal marker (e.g. `cfLink: true`) the runtime
uses to drive encode/decode and to enforce the "single string field ending in
`_cf_link`" rule (Section [02](./02-cf-link-encoding.md)).

## Registration & wiring (implementation note)

Following the conventions of existing built-ins:

1. Implementations in `packages/runner/src/builtins/sqlite-query.ts` and
   `packages/runner/src/builtins/sqlite-execute.ts`, each exporting an `Action`
   factory `(inputsCell, sendResult, addCancel, cause, parentCell, runtime)`.
2. Register in
   [`packages/runner/src/builtins/index.ts`](../../../packages/runner/src/builtins/index.ts):
   `addModuleByRef("sqliteQuery", raw(sqliteQuery))` and
   `addModuleByRef("sqliteExecute", raw(sqliteExecute, { isEffect: true }))`.
3. Builder factories via `createNodeFactory({ type: "ref", implementation: ... })`
   in `packages/runner/src/builder/built-in.ts`, exported from
   `packages/runner/src/builder/factory.ts`.
4. Public types in [`packages/api/index.ts`](../../../packages/api/index.ts).
5. Teach the ts-transformer to lower the `sqliteQuery<Row>` type argument to a
   runtime schema (alongside `toSchema<T>`).
