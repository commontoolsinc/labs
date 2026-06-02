import {
  type Cell,
  cell,
  handler,
  pattern,
  sqliteDatabase,
  type SqliteDb,
  table,
} from "commonfabric";

interface User {
  name: string;
}

// A handler writes a row via the imperative db.exec (folded into its commit) and
// bumps `version`; the query's reactOn:version re-runs it so the read reflects
// the write (read-after-write is explicit now, not automatic).
const seed = handler<
  Record<string, never>,
  { db: SqliteDb; version: Cell<number>; author: Cell<User> }
>((_, { db, version, author }) => {
  db.exec("INSERT INTO people (author_cf_link) VALUES (?)", [author]);
  version.set(version.get() + 1);
});

// FIXTURE (integration): a typed db.query<Row> surfaces a `_cf_link` result
// column as a live Cell end to end (transformer rowSchema injection + runtime
// decode + consumer asCell read), through the real toolshed server.
export default pattern(() => {
  const db = sqliteDatabase({
    tables: {
      people: table({ id: "integer primary key", author_cf_link: "text" }),
    },
  });
  const version = cell(0);
  const author = cell<User>({ name: "Ada" });

  const q = db.query<{ author_cf_link: Cell<User> }>(
    "SELECT author_cf_link FROM people ORDER BY id",
    { reactOn: version },
  );

  return {
    q,
    author,
    version,
    seed: seed({ db, version, author }),
  };
});
