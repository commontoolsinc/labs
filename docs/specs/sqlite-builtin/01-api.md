# 01 — TypeScript API

## Built-in vs. new Cell type — decision

**Decision: built-ins, with a lightweight database *handle* that is an ordinary
cell.** We do not introduce a new `Cell` subtype.

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

- The **handle** is a normal cell carrying a small descriptor (which source,
  which db identity). Its TypeScript type is `Cell<SqliteDatabase>`.
- The **table/row shape** is expressed as a JSON Schema the author passes to a
  query/execute call (`rows` / table schema), which is where `_cf_link` columns
  and future CFC labels are declared.

## `sqliteDatabase(source?)`

Builder factory that returns an opaque database handle. The handle selects one
of three sources (Section [03](./03-database-sources.md)); with no argument it
binds to a cell derived from the current pattern context (the default source).

```ts
type SqliteDatabase = {
  /** Reactivity token; bumped after every committed write to this database.
   *  Pass to `sqliteQuery({ reactOn })` for "re-run on any write" behavior. */
  readonly version: number;
};

export declare function sqliteDatabase(
  source?: SqliteDatabaseSource,
): OpaqueRef<SqliteDatabase>;

type SqliteDatabaseSource =
  | undefined // default: cell-derived (Section 03.1)
  | { cell: OpaqueRef<unknown> } // explicit cell-derived
  | { vm: OpaqueRef<VmHandle>; path: string } // VM file (stub, Section 03.2)
  | { disk: OpaqueRef<DiskHandle> }; // on-disk via `cf` (stub, Section 03.3)
```

The handle is a cell so it can be passed between sub-patterns and stored, and so
its `version` field participates in normal reactivity. The underlying database
identity (file name / attach alias) is **opaque to the pattern** — it is derived
from the handle cell's entity id (Section [03](./03-database-sources.md)) and
never constructed by pattern code.

## `sqliteQuery(params)` — reactive read

```ts
type SqliteQueryParams = {
  db: OpaqueRef<SqliteDatabase>;
  /** A single read-only statement. Multiple statements / write statements throw. */
  sql: string;
  /** Positional (`?`) or named (`:name`) bindings. Cells are encoded per
   *  Section 02 only when bound to a `_cf_link` parameter; otherwise a cell
   *  binding throws. */
  params?: unknown[] | Record<string, unknown>;
  /** Reactivity input. Read wholesale as an `any` schema; when its committed
   *  value changes, the query re-runs. Typically `db.version`. See Section 05. */
  reactOn?: unknown;
  /** Optional JSON Schema describing a result row. Drives `_cf_link` decoding
   *  and result typing. See "TypeScript and table types" below. */
  rows?: JSONSchema;
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
single `SELECT` (or read-only CTE). Result columns named `*_cf_link` are decoded
back into live cells before the rows reach the pattern (Section
[02](./02-cf-link-encoding.md)).

Reactivity is **explicit and coarse** in v1: the query re-runs when `reactOn`'s
committed value changes. The built-in reads `reactOn` under an `any` schema, so
*any* change to that value (or anything it transitively links to) invalidates
the query — the "maintain parallel cells that change when the query should be
redone" strategy. Passing `db.version` gives "re-run on any write to this
database"; passing a narrower cell scopes invalidation more tightly.

## `sqliteExecute(params)` — write

```ts
type SqliteExecuteParams = {
  db: OpaqueRef<SqliteDatabase>;
  /** One or more write statements (INSERT/UPDATE/DELETE/DDL). */
  sql: string;
  params?: unknown[] | Record<string, unknown>;
  /** Optional JSON Schema for the bound parameters; declares which params are
   *  `_cf_link` and (future) carries CFC labels. */
  bind?: JSONSchema;
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
A cell bound to a parameter is encoded to a sigil link **only** when that
parameter targets a `_cf_link` column; otherwise binding a cell throws (Section
[02](./02-cf-link-encoding.md)).

## TypeScript and table types

The most useful TypeScript surface is **row/column declaration**, not full
inference over arbitrary SQL.

Why we stop short of typing query inputs/outputs from the SQL text:

- Inferring the parameter tuple and result-row type from a `sql` string would
  require an in-type SQL parser. It is brittle (dialect, expressions, joins,
  aliases) and out of proportion to the value.
- The author already knows the row shape they expect. Letting them declare it is
  simpler and is exactly the hook CFC needs.

So v1 offers a table-schema helper whose primary jobs are (a) marking `_cf_link`
columns, (b) typing the rows a query returns, and (c) (future) carrying CFC
labels — the same `ifc` mechanism schemas already support
([`packages/api/index.ts`](../../../packages/api/index.ts) `ifc` field).

```tsx
import { table, cfLink, type Default } from "commonfabric";

// `table(...)` is a thin helper returning a JSONSchema for one row, with
// `_cf_link` columns typed as Cell<T> and (future) per-column `ifc` labels.
const MessageRowSchema = table({
  id: "integer",
  body: "text",
  ts: "integer",
  // A `_cf_link` column: stored as TEXT, surfaces as Cell<User>.
  author_cf_link: cfLink<User>(),
});

type MessageRow = RowOf<typeof MessageRowSchema>;
// => { id: number; body: string; ts: number; author_cf_link: Cell<User> }

const recent = sqliteQuery<MessageRow>({
  db,
  sql: "SELECT id, body, ts, author_cf_link FROM messages",
  reactOn: db.version,
  rows: MessageRowSchema,
});
```

`table(...)` and `cfLink<T>()` compile to plain JSON Schema; `cfLink<T>()`
emits `{ type: "string" }` plus an internal marker (e.g. `cfLink: true`) the
runtime uses to drive encode/decode and to enforce the "single string field
ending in `_cf_link`" rule (Section [02](./02-cf-link-encoding.md)). Query
parameter tuples and free-form result columns remain `unknown`/author-annotated;
we do not attempt to derive them from the SQL string.

## Registration & wiring (implementation note)

Following the conventions reported for existing built-ins:

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
