// Read-label provenance via SQLite column-origin metadata, on a read-only
// connection opened exactly as the ReadConnectionPool does. The soundness
// contract under aliasing / spoofing / expressions / joins / UNION / CTE / view:
// a non-null origin is the TRUE source column; anything the engine can't
// attribute reports null (the caller fails closed).

import { assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import {
  columnOriginAvailable,
  columnOrigins,
} from "../v2/sqlite/column-origin.ts";
import { ReadConnectionPool } from "../v2/sqlite/read-pool.ts";
import { ensureSqliteLibPath } from "./sqlite-lib-path.ts";

// Production binds the column-origin FFI via DENO_SQLITE_PATH only; provision it
// here (test-only) so these provenance assertions run against the real lib.
await ensureSqliteLibPath();

function seed(path: string): void {
  const db = new Database(path); // writable for setup
  db.exec("CREATE TABLE emails (from_email TEXT, subject TEXT, body TEXT)");
  db.exec("CREATE TABLE people (from_email TEXT, name TEXT)");
  db.exec("CREATE VIEW v_emails AS SELECT from_email, subject FROM emails");
  db.exec("INSERT INTO emails VALUES ('a@x.com','hi','secret')");
  db.exec("INSERT INTO people VALUES ('a@x.com','Ada')");
  db.close();
}

/** Open read-only (as the pool does) and return per-output-column origin. */
function origins(
  roDb: Database,
  sql: string,
): Array<[string | null, string | null]> {
  const stmt = roDb.prepare(sql);
  try {
    const o = columnOrigins(stmt.unsafeHandle, stmt.columnNames().length);
    return o.map((c) => [c.table, c.column]);
  } finally {
    stmt.finalize();
  }
}

Deno.test({
  name: "column-origin metadata is reachable in this deployment",
  sanitizeResources: false,
}, () => {
  // Provisioned above via ensureSqliteLibPath() (sets DENO_SQLITE_PATH); in
  // production a deployment sets DENO_SQLITE_PATH and labeled queries that need
  // provenance fail loudly if it's absent.
  assertEquals(columnOriginAvailable(), true);
});

Deno.test({
  name: "column origin is sound through alias / spoof / expression / join",
  sanitizeResources: false,
}, () => {
  const path = Deno.makeTempFileSync({ suffix: ".sqlite" });
  seed(path);
  const ro = new Database(path, { readonly: true });
  try {
    // Alias resolved to the true source column.
    assertEquals(
      origins(ro, "SELECT from_email AS renamed, subject FROM emails"),
      [["emails", "from_email"], ["emails", "subject"]],
    );
    // Spoof defeated: output named `from_email` but origin is `subject`.
    assertEquals(
      origins(ro, "SELECT subject AS from_email FROM emails"),
      [["emails", "subject"]],
    );
    // Expression + literal: no single origin -> null -> caller fails closed.
    assertEquals(
      origins(ro, "SELECT upper(from_email) AS x, 1 AS n FROM emails"),
      [[null, null], [null, null]],
    );
    // Join: same column name in two tables is disambiguated by origin table.
    assertEquals(
      origins(
        ro,
        "SELECT e.from_email, p.from_email FROM emails e " +
          "JOIN people p ON e.from_email = p.from_email",
      ),
      [["emails", "from_email"], ["people", "from_email"]],
    );
    // SELECT * carries every column's true origin.
    assertEquals(
      origins(ro, "SELECT * FROM emails"),
      [["emails", "from_email"], ["emails", "subject"], ["emails", "body"]],
    );
  } finally {
    ro.close();
    Deno.removeSync(path);
  }
});

Deno.test({
  name:
    "pool.queryWithOrigins returns rows + per-column origin (real pool path)",
  sanitizeResources: false,
}, () => {
  const path = Deno.makeTempFileSync({ suffix: ".sqlite" });
  seed(path);
  const pool = new ReadConnectionPool();
  try {
    const { rows, columns } = pool.queryWithOrigins(
      path,
      "SELECT from_email AS sender, subject FROM emails ORDER BY subject",
    );
    assertEquals(rows, [{ sender: "a@x.com", subject: "hi" }]);
    // Output name is the alias; origin is the TRUE source column.
    assertEquals(columns, [
      { output: "sender", table: "emails", column: "from_email" },
      { output: "subject", table: "emails", column: "subject" },
    ]);
  } finally {
    pool.close();
    Deno.removeSync(path);
  }
});

Deno.test({
  name:
    "compound/CTE/view origins are sound (true source or null, never wrong)",
  sanitizeResources: false,
}, () => {
  const path = Deno.makeTempFileSync({ suffix: ".sqlite" });
  seed(path);
  const ro = new Database(path, { readonly: true });
  try {
    // For each of these the only conceivable source column is `from_email`; the
    // soundness requirement is that origin.column is EITHER `from_email` (true
    // source) OR null (fail closed) — never some other column.
    const sound = (sql: string) => {
      for (const [, col] of origins(ro, sql)) {
        if (col !== null && col !== "from_email") {
          throw new Error(`unsound origin ${col} for: ${sql}`);
        }
      }
    };
    sound("SELECT from_email FROM emails UNION SELECT from_email FROM people");
    sound("WITH c AS (SELECT from_email FROM emails) SELECT from_email FROM c");
    sound("SELECT from_email FROM v_emails");
    sound("SELECT from_email FROM (SELECT from_email FROM emails)");
  } finally {
    ro.close();
    Deno.removeSync(path);
  }
});
