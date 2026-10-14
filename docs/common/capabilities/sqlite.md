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
  hasOrders: orders.query<{ present: number }>(
    "SELECT EXISTS (SELECT 1 FROM orders) AS present",
  ),
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
    "SELECT id, glaze, boxes FROM orders WHERE shipped = 0 ORDER BY id LIMIT 200",
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

A read refused for labeling arrives the same way and is the case most easily
mistaken for an empty source: where a table declares a per-row label rule, a
query that does not project every column the rule reads is refused rather than
returned unlabeled, and `error` names the column and says to select it.
`result` is then absent, not empty — so a view that renders "none found" over
it states a fact about the data that nobody established. Branch on `error`
before branching on emptiness.

The `<Row>` type argument names the columns the statement projects, and is what
turns a result into something typed. Without it the rows come back as
`Record<string, unknown>`, and a `_cf_link` column comes back as a raw link
string rather than a live cell.

The tables are declared on the database rather than on the pattern, so a
pattern reading an input database does not restate them. What it needs to know
is which tables and columns are there — the shape of the contract it is
querying against — and that is a property of the handle it was given.

A read with no `reactOn` runs again only when its own inputs change — its
statement or its params — and that is right for a database nothing else writes
while the pattern runs. Where a pattern also writes to the database, pass
`{ reactOn: db }` so the read re-runs after a committed write.

A database written from outside the runtime is the other case. A connector
store another process fills changes without any commit the runtime sees, so
neither the handle nor anything else in the space moves when it does, and a
read with no `reactOn` keeps the rows it read first. Such a store is refreshed
through a freshness cell the writer's host updates after it writes: pass that
cell as `reactOn`, and the read re-runs each time the host reports new data.

## A param is a value

A bind param is resolved as the statement is issued, and `undefined` is refused
rather than bound: the whole read fails with "sqlite: param is undefined",
`error` carries that text, and every field computed from the result is empty.
`null` is what binds SQL NULL.

An input's declared default is applied when the input is READ, so an input
handed to `params` as itself rather than as a value read out of it arrives
undefaulted. That costs nothing until someone composes the pattern: a caller
forwards an optional input of its own, which reads `undefined` while nobody has
supplied one, and the read the pattern's own default was written to cover is
the read that fails. Leaving the argument key out is the only shape the default
covers on its own.

```tsx
// Shown at module scope.
import { computed, Default, pattern, type SqliteDb } from "commonfabric";

export default pattern<{ ledger: SqliteDb; month?: string | Default<""> }>(
  ({ ledger, month }) => {
    // Read out of `month` rather than `month` itself, so a caller forwarding a
    // month nobody supplied gets the empty string the statement resolves.
    const monthParam = computed(() => month);

    return ledger.query<{ id: number }>(
      "WITH month(first) AS (SELECT COALESCE(NULLIF(?, ''), " +
        "strftime('%Y-%m', 'now')) || '-01') " +
        "SELECT id FROM rows_plaid_transaction, month " +
        "WHERE date >= first AND date < date(first, '+1 month') LIMIT 200",
      { params: [monthParam] },
    );
  },
);
```

The month is matched as a range over `date` — on or after its first day and
before the next month's — rather than as `substr(date, 1, 7) = ?`. A range over
a column is something an index on that column serves, so the database reads
only the month's rows. An index on the column does not serve a function of it,
which is evaluated on every row; only an index on that same expression would,
and a store written outside the runtime rarely has one.

## One statement, one database

A query is a single read-only `SELECT` (a read-only CTE counts). Multiple
statements, DML, DDL, `PRAGMA`, `ATTACH` and `DETACH` are refused, and so is a
schema-qualified table name. The consequence worth planning around: one
statement reads the tables of the one database it was issued on, and no
statement can join across two handles. Two databases means two queries and a
join expressed in the pattern.

## Bound the rows

Every result row is written into the space as a document of its own — which
is what gives a per-row label somewhere to sit — so the row count of a
statement is a durable cost of the space rather than the cost of one render. A
query that returns a million distinct rows writes a million documents, and they
stay written after the view that asked for them is gone. The query writes a
row document once and never rewrites it. It is keyed on the row's content and,
for a row of a labeled database, on its label, beside a per-space secret that
keeps the id from saying anything about the row. Equal rows share one
document, a row the result held before takes its old document back, and a
re-run whose rows are unchanged writes no row documents. A row whose data or
label changed is another document, and the one it had stays in the space. A
reference a pattern keeps to a row therefore does not change when the query
runs again: read the query's `result` for the current rows. The query is not
the only writer that can reach a row document, though: other code holding a
reference to one can write to it. Three things re-key every row of a labeled
database at once and write it again: changing which database the query
reads, changing the query's projection, and re-declaring the handle's
`tables`. A row projecting a column name a Fabric
record reserves (`constructor`, `__proto__`) crosses the wire as a list of
entries and is stored the same way.

A statement therefore bounds its rows, and a filter is not a bound. A `WHERE`
clause narrows the candidates and says nothing about how many survive it: a
month of a large store is still most of a large store. `LIMIT` is what states
the ceiling, and a tight filter under it is what makes the rows the ceiling
admits the interesting ones.

A few hundred rows is a sensible ceiling for a view. It is more than a reader
takes in at once, and it keeps what one query leaves behind in the space
proportionate to what the view displays. A view that needs more of the store
than that pages through it — a bound the reader moves. Paging bounds what one
query writes rather than what the space accumulates: every page fetched
materializes its rows, and nothing reclaims the rows of a page the reader has
left. Returning to an earlier page issues a fresh query, and its rows land on
the documents they had before. The durable cost is
the number of distinct row documents the pages materialize, which grows with
every page whose rows the space has not held.

Project the columns the view reads and no others: a row document carries every
column the statement selected, so a wider projection is paid on every row.

`LIMIT` bounds the rows a query returns, and therefore the documents it writes.
What the database spends finding those rows is a separate question, and the
query plan answers it: where an index covers the ordering, `ORDER BY … LIMIT n`
reads in order and stops at n; where none does, the database scans the
candidates and sorts them through a temporary B-tree before the first row comes
back. So `LIMIT` alone bounds the writing and not the reading, and a `WHERE`
clause narrow enough to keep the candidate set small is what bounds the work of
an ordering the database cannot walk.

Where a view needs a number rather than the rows, ask SQL for the number.
`count(*)`, `sum()` and a `GROUP BY` return one row per group, and one row is
one document; the same answer reached by returning the rows and counting them in
the pattern writes a document per row on the way. An aggregate over a table that
derives its labels from row data is the case to check before relying on one: it
is admitted where the contributing rows have a reader in common, and refused
where they do not, because no principal is then guaranteed to read everything
the aggregate summed. The rule is in
[06](../../specs/sqlite-builtin/06-cfc.md#read--re-derive-per-row-attach-ceiling-dbquery).

```tsx
// Shown at module scope.
export const newestOrders = (orders: SqliteDb, since: number) =>
  orders.query<{ id: number; glaze: string }>(
    "SELECT id, glaze FROM orders WHERE placed_at >= ? " +
      "ORDER BY placed_at DESC LIMIT 200",
    { params: [since] },
  );
```

One row back is not one row read. An aggregate reads every row it summarizes, so
an exact `count(*)` walks the whole table — the narrowest index the table has,
or the table itself where it has none, and a full-text table always — and a
`WHERE` clause no index serves reads every row as well. Over a database the
pattern owns, the walk is usually short. Over a connector store another process
writes, which can run to gigabytes, it is seconds of reading every time the
query runs. An exact count is worth that where the number is what the view
shows; where the question is a smaller one, ask the smaller question:

- Whether a table holds any row: `SELECT EXISTS (SELECT 1 FROM t) AS present`,
  which stops at the first row it finds.
- Whether a column is filled: count over a bounded sample of rows rather than
  over the table.

  ```sql
  SELECT count(*) AS sampled, count(c) AS filled
  FROM (SELECT c FROM t LIMIT 1000)
  ```

  The figures are the sample's — the first rows a scan yields, usually the
  oldest — and not the table's, so a column empty in the sample may still be
  filled further on. For a column of long text or blobs, select
  `nullif(typeof(c), 'null')` in the inner query in place of `c`, which SQLite
  answers for an ordinary table from the row header without loading the value
  (a virtual table, such as a full-text index, still loads it):

  ```sql
  SELECT count(*) AS sampled, count(f) AS filled
  FROM (SELECT nullif(typeof(c), 'null') AS f FROM t LIMIT 1000)
  ```

## A connector store's tombstones, and a query that returns no rows

A connector-backed database carries the conventions of the connector that fills
it, and a pattern reading one is held to them. Two conventions for a deleted row
are in use. One marks a live row with a NULL timestamp, so `deleted_at IS NULL`
selects the rows still standing. The other keeps every text column never-NULL
and puts the state in an integer flag beside it: `deleted = 0` is a live row,
and `deleted_at` holds `''` until a tombstone stamps it. Where a table declares
a `deleted` flag, filter on the flag — a NULL test against the text column of
such a table selects nothing at all, because no row in it ever holds NULL
there.

The table declaration is what to read before writing the predicate. It names the
columns and the label each one carries; which value in a column means a deleted
row is the connector's convention, and the declaration does not state it. So a
predicate carried over from another database is a guess about the one being
queried: every column it names may be there while the value it tests for means
something else. Two databases in one task can disagree about this, and each is
right about itself.

An empty result is a value rather than a failure. A statement matching nothing
settles the way one matching everything does — `pending` false, `error` absent,
`result` an empty list — and every field computed from it is empty in turn, so
the view renders its empty state and nothing reports a problem. The run
succeeded; the emptiness is data.

That is what makes an empty source worth one check before it is believed. Ask
whether the table holds rows at all without the predicate you are least sure of
— the one testing a sentinel — and compare the two: rows in the table and none
under the predicate put the disagreement in the predicate rather than in the
store. `EXISTS` answers that from the first row it finds, where a count would
walk the table to answer a question it needs one row for. Where the emptiness
is then reported onward, name the predicate that produced it, so a reader of
the result learns which condition emptied the source rather than that the
source was empty.

```tsx
// Shown at module scope.
export const liveOrders = (orders: SqliteDb) => ({
  rows: orders.query<{ id: number; glaze: string }>(
    "SELECT id, glaze FROM orders WHERE deleted = 0 " +
      "ORDER BY id DESC LIMIT 200",
  ),
  present: orders.query<{ present: number }>(
    "SELECT EXISTS (SELECT 1 FROM orders) AS present",
  ),
});
```

## Session-scoped results

Where the runtime carries a read ceiling — a lens on what this particular run
may observe — a **session-scoped** result filters its rows under that ceiling.
A space- or user-shared result materializes independently of runtime ceilings.
Its array shape and rows retain their confidentiality labels, and a read
outside the observing runtime's ceiling is withheld. A shared result containing
private rows can therefore withhold the whole array, including its length.
That membership label retains its confidentiality across refreshes, even after
rows are removed or relabeled. An addressed row's payload keeps its own label
without inheriting the array's membership label.

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
without a declaration. Use a session-scoped result when each session needs its
own filtered row set.

## Labeled columns

A column may declare an `ifc` label on the database's table schema, and that
label rides into the result: a row read out of a labeled column carries what
the column requires, and code downstream of the read is held to it. Two
options bound a read against such a column — `maxConfidentiality` for a ceiling
the result may not exceed, and `onExceed` to choose between failing the query
and dropping the rows that exceed it.

Where the label lands decides where to look for it. Each result row splits into
its own entity doc and the column's label sits on that doc, at the column's own
path. The query document labels `result` membership with the join of the
source rows' labels and the label of the query's own statement and parameters,
and labels the `withheld` count with that same join. A shared result joins
every source row's label, including rows skipped by the query contract; a
session-scoped result joins the labels of the rows it holds. Which row sits at
a position of `result` carries the label of the query's statement and
parameters and that row's label. A
reader outside the join therefore cannot observe the array's membership,
length, or withheld count, and code that reads any of them carries the join
into what it writes: a row count of a query over labeled columns carries the
columns' labels, and so does anything computed by mapping over `result`,
which reads its membership. A row read through `result` by its position
carries the label of the query's statement and parameters and that row's own
labels, and not the other rows'. `cf cell get-label <cell> <path>/result/<i>/<col>` follows the links
the path crosses and reports the
column's label from the row's own doc. Inside a pattern nothing has to be asked
for: a consumer inherits the label from the dereferences its read traverses.

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
