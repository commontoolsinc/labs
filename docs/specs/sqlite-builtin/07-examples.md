# 07 — Usage examples

These illustrate the intended authoring surface. They are aspirational pattern
code, not yet runnable.

## Example 1 — A reactive message log with cell references

A pattern that stores messages in SQLite, references the author as a live cell
via a `_cf_link` column, and renders the 20 most recent messages reactively.

```tsx
import {
  sqliteDatabase,
  sqliteQuery,
  sqliteExecute,
  table,
  cfLink,
  handler,
  derive,
  pattern,
  type Cell,
} from "commonfabric";

interface User { name: string; avatarUrl: string }

export default pattern<{ me: Cell<User> }>(({ me }) => {
  // Cell-derived, per-space, atomic. Tables are declared once here; the runtime
  // owns creation/migration — no CREATE TABLE in pattern code.
  const db = sqliteDatabase(undefined, {
    tables: {
      messages: table({
        id: "integer primary key",
        author_cf_link: cfLink<User>(), // TEXT in SQLite, Cell<User> in TS
        body: "text",
        ts: "integer",
      }),
    },
  });

  // No <Row> needed: the projection maps 1:1 to the declared `messages` table,
  // so the runtime already knows `author_cf_link` is a link column.
  const recent = sqliteQuery({
    db,
    sql: "SELECT id, body, ts, author_cf_link FROM messages ORDER BY ts DESC LIMIT 20",
    reactOn: db, // re-run after any committed write to this db
  });

  const send = handler<{ body: string }, { author: Cell<User> }>(
    ({ body }, { author }) => {
      sqliteExecute({
        db,
        sql: "INSERT INTO messages (author_cf_link, body, ts) VALUES (?, ?, ?)",
        params: [author, body, Date.now()], // `author` Cell -> sigil link (param 1 targets a _cf_link column)
      });
    },
  );

  return {
    [UI]: derive(recent.result, (rows) =>
      (rows ?? []).map((m) => (
        // m.author_cf_link is a live Cell<User>; reading it is independently reactive
        <div>
          <b>{derive(m.author_cf_link, (u) => u?.name)}</b>: {m.body}
        </div>
      ))),
    send: send.with({ author: me }),
  };
});
```

Key points:

- The database owns the `messages` schema, so `author_cf_link` is known to be a
  link column without any per-query/per-write annotation. Binding the `author`
  cell to a non-link column (e.g. `body`) would throw (Section
  [02](./02-cf-link-encoding.md)).
- `reactOn: db` subscribes to the handle cell; the `INSERT` marks it dirty only
  after it **commits durably** (Section [05](./05-reactivity.md)), so `recent`
  never shows phantom rows.
- Each `m.author_cf_link` decodes to a `Cell<User>`; the inner `derive` updates
  if that user's name changes, without re-running the SQL query.

## Example 2 — A projection that needs `<Row>`

When the result shape diverges from a declared table (joins, aliases, computed
columns), declare it with the `sqliteQuery<Row>` type argument. A `Cell<T>`
field marks a decoded link column even when the alias drops the `_cf_link`
suffix.

```tsx
const leaderboard = sqliteQuery<{ author: Cell<User>; n: number }>({
  db,
  sql: `SELECT author_cf_link AS author, count(*) AS n
        FROM messages GROUP BY author_cf_link ORDER BY n DESC LIMIT 10`,
  reactOn: db,
});

return derive(
  { rows: leaderboard.result, pending: leaderboard.pending, error: leaderboard.error },
  ({ rows, pending, error }) => {
    if (pending) return "Loading…";
    if (error) return `Query failed: ${String(error)}`;
    // `author` decoded back into Cell<User> despite the `AS author` alias.
    return rows!.map((r) => ({ name: derive(r.author, (u) => u?.name), count: r.n }));
  },
);
```

## Example 3 — Atomic cell + SQLite write in one handler

The handler mutates a cell and inserts a row. Both land in the same commit, so
an observer never sees the counter incremented without the row (or vice versa).

```tsx
const bump = handler<{ body: string }, { count: Cell<number>; db: SqliteDatabase }>(
  ({ body }, { count, db }) => {
    count.set(count.get() + 1);                 // cell write
    sqliteExecute({                              // SQLite write, same transaction
      db,
      sql: "INSERT INTO events (body, ts) VALUES (?, ?)",
      params: [body, Date.now()],
    });
  },
);
```

If the commit is rejected (seq conflict) or the process crashes mid-commit, the
post-crash reconciliation (Section [04](./04-server-execution-and-transactions.md))
ensures the row and the counter agree.

## Example 4 — VM-file source (stubbed)

```tsx
// vmHandle is an opaque capability handle to a VM; path is inside that VM.
const db = sqliteDatabase({ vm: vmHandle, path: "/var/lib/app/data.db" });

// In v1 this resolves but the server returns `not-implemented` for VM sources.
const rows = sqliteQuery({ db, sql: "SELECT * FROM kv", reactOn: db });
```

## Example 5 — On-disk source injected via `cf` (stubbed)

The pattern is **source-agnostic**: it declares a `db` *input* and consumes it.
It never names a file or picks a source — an operator connects one.

```tsx
export default pattern<{ db: SqliteDatabase }>(({ db }) => {
  const lookup = sqliteQuery<{ value: string }>({
    db,
    sql: "SELECT value FROM lookup WHERE key = ?",
    params: [key],
    // No reactOn: a static reference dataset the operator manages out of band.
  });

  return derive(
    { rows: lookup.result, pending: lookup.pending, error: lookup.error },
    ({ rows, pending, error }) => {
      if (pending) return "Waiting for a database to be connected…"; // until cf wires it
      if (error) return `Database error: ${String(error)}`;
      return rows?.[0]?.value;
    },
  );
});
```

```bash
# Operator wires an on-disk SQLite file into the piece's `db` input. The sqlite:
# scheme create-if-absents a handle cell (id derived from space DID + abs path)
# and writes a normal sigil link to it. (Stubbed in v1; see Section 03.3.)
cf piece link <piece-id> db sqlite:/abs/path/reference-data.db
# Before this runs, the pattern renders "Waiting for a database to be connected…".
```
