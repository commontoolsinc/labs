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

const MessageRow = table({
  id: "integer",
  body: "text",
  ts: "integer",
  author_cf_link: cfLink<User>(), // TEXT in SQLite, Cell<User> in TS
});
type MessageRow = RowOf<typeof MessageRow>;

export default pattern<{ me: Cell<User> }>(({ me }) => {
  const db = sqliteDatabase(); // cell-derived, per-space, atomic

  // One-time-ish schema setup (idempotent).
  sqliteExecute({
    db,
    sql: `CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY,
            author_cf_link TEXT,
            body TEXT,
            ts INTEGER
          )`,
  });

  const recent = sqliteQuery<MessageRow>({
    db,
    sql: "SELECT id, body, ts, author_cf_link FROM messages ORDER BY ts DESC LIMIT 20",
    reactOn: db.version, // re-run after any committed write to this db
    rows: MessageRow,
  });

  const send = handler<{ body: string }, { author: Cell<User> }>(
    ({ body }, { author }) => {
      sqliteExecute({
        db,
        sql: "INSERT INTO messages (author_cf_link, body, ts) VALUES (?, ?, ?)",
        params: [author, body, Date.now()], // `author` Cell -> sigil link
        bind: MessageRow, // tells the runtime param 1 is a _cf_link
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

- `params: [author, …]` binds a `Cell<User>` to the `author_cf_link` column; the
  runtime encodes it to an absolute sigil link string (Section
  [02](./02-cf-link-encoding.md)). Binding the same cell to `body` would throw.
- `recent` re-runs only after the `INSERT` **commits durably** (Section
  [05](./05-reactivity.md)), so it never shows phantom rows.
- Each `m.author_cf_link` decodes to a `Cell<User>`; the inner `derive` updates
  if that user's name changes, without re-running the SQL query.

## Example 2 — Pending/error handling and parameters

```tsx
const results = sqliteQuery<{ id: number; title: string }>({
  db,
  sql: "SELECT id, title FROM docs WHERE owner = :owner AND archived = 0",
  params: { owner: ownerId },
  reactOn: db.version,
});

return derive(
  { rows: results.result, pending: results.pending, error: results.error },
  ({ rows, pending, error }) => {
    if (pending) return "Loading…";
    if (error) return `Query failed: ${String(error)}`;
    return rows!.map((r) => r.title);
  },
);
```

## Example 3 — Atomic cell + SQLite write in one handler

The handler mutates a cell and inserts a row. Both land in the same commit, so
an observer never sees the counter incremented without the row (or vice versa).

```tsx
const bump = handler<{ body: string }, { count: Cell<number>; db: Cell<SqliteDatabase> }>(
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
// vmHandle is an opaque capability cell to a VM; path is inside that VM.
const db = sqliteDatabase({ vm: vmHandle, path: "/var/lib/app/data.db" });

// In v1 this resolves but server returns `not-implemented` for VM sources.
const rows = sqliteQuery({ db, sql: "SELECT * FROM kv", reactOn: db.version });
```

## Example 5 — On-disk source linked via `cf` (stubbed)

```bash
# Operator links a real file on disk to an opaque cell the pattern can reference.
cf sqlite link ./reference-data.db --into did:key:z6Mk…/diskHandle
```

```tsx
const db = sqliteDatabase({ disk: diskHandle });
const lookup = sqliteQuery({
  db,
  sql: "SELECT value FROM lookup WHERE key = ?",
  params: [key],
  // No reactOn: a static reference dataset the operator manages out of band.
});
```
