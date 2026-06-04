// SPIKE — prove read-label provenance via SQLite column-origin metadata works
// on a read-only connection opened exactly as the ReadConnectionPool does, and
// nail the soundness edge cases (alias / spoof / expression / join-ambiguity /
// UNION / CTE / view). The soundness contract: a non-null origin is the TRUE
// source column; anything the engine can't attribute reports null (fail closed).

import { assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import {
  columnOriginAvailable,
  columnOrigins,
} from "../v2/sqlite/column-origin.ts";

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
  // If this fails, the FFI lib resolution needs the DENO_SQLITE_PATH production
  // path; the feature would fall back to constrained-projection mode.
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
    // Log what they actually resolve to (informs the design's null-origin rate).
    for (
      const sql of [
        "SELECT from_email FROM emails UNION SELECT from_email FROM people",
        "WITH c AS (SELECT from_email FROM emails) SELECT from_email FROM c",
        "SELECT from_email FROM v_emails",
        "SELECT from_email FROM (SELECT from_email FROM emails)",
      ]
    ) {
      console.log("origin:", JSON.stringify(origins(ro, sql)), "<=", sql);
    }
  } finally {
    ro.close();
    Deno.removeSync(path);
  }
});
