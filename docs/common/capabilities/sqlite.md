# Reading a SQLite Database

A pattern can be handed a SQLite database the way it is handed any other input:
by reference. The input is typed `SqliteDb`, and the pattern reads it with
`db.query`. It never opens a file, never names a path, and never picks a source
— whoever wired the input chose those.

The handle's readable value is a small descriptor, not the data. Reading it as
a value tells a pattern nothing it can compute over; the rows come back only
from a query.

## Declaring the input

Type the input `SqliteDb`, imported from `commonfabric`:

```tsx
// Shown at module scope.
import { pattern, type SqliteDb } from "commonfabric";

interface Input {
  orders: SqliteDb;
}

export default pattern<Input>(({ orders }) => ({
  count: orders.query<{ n: number }>("SELECT count(*) AS n FROM orders"),
}));
```

`SqliteDb` is the whole declaration. A pattern that widens it — to `any`, or to
a hand-written object type with a `query` method on it — compiles and then
receives the handle's descriptor value rather than the handle, so `query` is
missing at run time. What makes the input arrive as a handle is the declared
type: `SqliteDb` is what the compiler lowers to the cell-shaped input the
runtime binds a database to.

## db.query

`db.query<Row>(sql, options?)` is a reactive read, not a promise. Never `await`
it. Call it in the pattern body and read `pending` / `error` / `result`
reactively; it re-runs when its inputs change, and results are memoized per
request.

```tsx
// Shown at module scope.
export default pattern<{ orders: SqliteDb }>(({ orders }) => {
  const pending = orders.query<{ id: number; glaze: string; boxes: number }>(
    "SELECT id, glaze, boxes FROM orders WHERE shipped = 0 ORDER BY id",
  );

  return lift((rows?: Array<{ glaze: string; boxes: number }>) =>
    (rows ?? []).map((row) => `${row.boxes} × ${row.glaze}`).join(", ")
  )(pending.result);
});
```

The call returns an envelope, not the rows:
`{ pending, result?, error?, withheld? }`. `result` holds the rows once there
are any, so a field typed as the rows themselves — `PerSession<Row[]>` — cannot
take the call's value, and reading `.result` is what gets from one to the
other. `withheld` counts the rows a read-time clearance kept from this reader,
and is absent unless the query asked for one.

Render the failure, not just the wait. A pattern that branches only on
`pending` shows a loading view for as long as the query stays broken, because a
query that failed is settled — `pending` is `false` and `error` holds the
reason — and nothing further arrives to move it on. `error` reaches the pattern
for a statement the database refuses and for a handle that does not read back
as one, so a view that shows it is the difference between a page that says what
went wrong and a page that spins.

The `<Row>` type argument names the columns the statement projects, and is what
turns a result into something typed. Without it the rows come back as
`Record<string, unknown>`, and a `_cf_link` column comes back as a raw link
string rather than a live cell.

The tables are declared on the database rather than on the pattern, so a
pattern reading an input database does not restate them. What it needs to know
is which tables and columns are there — the shape of the contract it is
querying against — and that is a property of the handle it was given.

Where a pattern also writes to the database, pass `{ reactOn: db }` so the read
re-runs after a committed write. An input a pattern only reads has nothing to
react to.

## One statement, one database

A query is a single read-only `SELECT` (a read-only CTE counts). Multiple
statements, DML, DDL, `PRAGMA`, `ATTACH` and `DETACH` are refused, and so is a
schema-qualified table name. The consequence worth planning around: one
statement reads the tables of the one database it was issued on, and no
statement can join across two handles. Two databases means two queries and a
join expressed in the pattern.

## Session-scoped results

Where the runtime carries a read ceiling — a lens on what this particular run
may observe — the result of every query it issues has to be **session-scoped**,
and a query whose result is broader is refused before anything is written. A
space- or user-shared result is one cell that every runtime on the space
resolves, so one runtime cannot narrow it for itself; a session-scoped result
is the run's own.

Declare the scope on the query:

```tsx
// Shown at module scope.
export const recentOrders = (orders: SqliteDb) =>
  orders.query<{ id: number; glaze: string }>(
    "SELECT id, glaze FROM orders ORDER BY id DESC LIMIT 20",
    { scope: "session" },
  );
```

`PerSession<>` on the result field and `.asScope("session")` on the query do
the same thing, and a session-scoped database makes its queries session-scoped
without a declaration. A run under a ceiling that gets a refusal instead of
rows is usually a query that declared no scope.

## Labeled columns

A column may declare an `ifc` label on the database's table schema, and that
label rides into the result: a row read out of a labeled column carries what
the column requires, and code downstream of the read is held to it. Two
options bound a read against such a column — `maxConfidentiality` for a ceiling
the result may not exceed, and `onExceed` to choose between failing the query
and dropping the rows that exceed it.

Where the label lands decides where to look for it. Each result row splits into
its own entity doc and the column's label sits on that doc, at the column's own
path; the query's own document holds `pending`, `result` and `requestHash` and
carries no label at any path. So a probe of the query document reports a fully
labeled result as unlabeled, and the read that answers is one that follows the
links the path crosses — `cf cell get-label <cell> <path>/result/<i>/<col>`
does, and reports the column's label from the row's own doc. Inside a pattern
nothing has to be asked for: a consumer inherits the label from the
dereferences its read traverses.

## The rest of the API

[`docs/specs/sqlite-builtin/`](../../specs/sqlite-builtin/README.md) is the full
specification: the handle type and the method surface in
[01](../../specs/sqlite-builtin/01-api.md), links in columns in
[02](../../specs/sqlite-builtin/02-cf-link-encoding.md), where a database comes
from in [03](../../specs/sqlite-builtin/03-database-sources.md), the statement
guard and transactions in
[04](../../specs/sqlite-builtin/04-server-execution-and-transactions.md),
reactivity in [05](../../specs/sqlite-builtin/05-reactivity.md), and the label
rules in [06](../../specs/sqlite-builtin/06-cfc.md).
