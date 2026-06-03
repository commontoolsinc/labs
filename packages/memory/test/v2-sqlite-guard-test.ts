// Tests for the SQLite statement guard (spec docs/specs/sqlite-builtin/04).
// The guard is tokenizer-level (no SQL parser, no SQLite authorizer available):
// it must reject non-SELECT reads, writes in the read path, schema-qualified
// references, ATTACH/DETACH/PRAGMA, multiple statements, and references to core
// engine table names.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import {
  assertReadOnly,
  assertWriteSafe,
  classifyStatement,
  CORE_TABLE_NAMES,
  GuardError,
} from "../v2/sqlite/guard.ts";
import { open } from "../v2/engine.ts";

// S4: the guard's core-table denylist is hand-maintained, but unqualified
// pattern-SQL names resolve to the attached cell-db ONLY because `main` (the
// core store) has no table of that name. If the engine ever adds a `main` table
// whose name a pattern also uses and that name is NOT in CORE_TABLE_NAMES, a
// pattern write could silently hit core storage. This asserts the denylist
// covers every real `main` table, so adding an engine table without updating the
// guard fails CI.
describe("CORE_TABLE_NAMES vs the engine schema", () => {
  it("covers every table the engine creates in `main`", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const engine = await open({ url: toFileUrl(path) });
    try {
      const rows = engine.database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' " +
          "AND name NOT LIKE 'sqlite_%'",
      ).all() as Array<{ name: string }>;
      const missing = rows
        .map((r) => r.name)
        .filter((name) => !CORE_TABLE_NAMES.includes(name));
      expect(missing).toEqual([]);
    } finally {
      engine.database.close();
      await Deno.remove(path);
    }
  });
});

describe("classifyStatement", () => {
  it("classifies a plain SELECT as a read", () => {
    const c = classifyStatement("SELECT a, b FROM messages WHERE id = ?");
    expect(c.kind).toBe("select");
    expect(c.multiple).toBe(false);
  });

  it("classifies a read-only CTE as a read", () => {
    const c = classifyStatement(
      "WITH x AS (SELECT 1) SELECT * FROM x",
    );
    expect(c.kind).toBe("select");
  });

  it("classifies INSERT/UPDATE/DELETE as writes", () => {
    expect(classifyStatement("INSERT INTO t (a) VALUES (1)").kind).toBe(
      "write",
    );
    expect(classifyStatement("UPDATE t SET a = 1").kind).toBe("write");
    expect(classifyStatement("DELETE FROM t").kind).toBe("write");
  });

  it("detects multiple statements (ignoring trailing semicolon/whitespace)", () => {
    expect(classifyStatement("SELECT 1;").multiple).toBe(false);
    expect(classifyStatement("SELECT 1; SELECT 2").multiple).toBe(true);
    // semicolon inside a string literal is not a separator
    expect(classifyStatement("SELECT ';' AS x").multiple).toBe(false);
  });

  it("detects schema-qualified table references", () => {
    expect(classifyStatement("SELECT * FROM messages").qualified).toBe(false);
    expect(classifyStatement("SELECT * FROM main.messages").qualified).toBe(
      true,
    );
    // a dotted column reference (table.col) is allowed; only db.table at FROM/JOIN/INTO matters
    expect(classifyStatement("SELECT t.a FROM messages t").qualified).toBe(
      false,
    );
  });
});

describe("assertReadOnly", () => {
  it("passes a single SELECT", () => {
    assertReadOnly("SELECT * FROM messages");
  });

  it("rejects writes, PRAGMA, ATTACH, and multiple statements", () => {
    expect(() => assertReadOnly("INSERT INTO t VALUES (1)")).toThrow(
      GuardError,
    );
    expect(() => assertReadOnly("PRAGMA table_info(t)")).toThrow(GuardError);
    expect(() => assertReadOnly("ATTACH DATABASE 'x' AS y")).toThrow(
      GuardError,
    );
    expect(() => assertReadOnly("SELECT 1; DROP TABLE t")).toThrow(GuardError);
  });

  it("rejects schema-qualified references and core-table references", () => {
    expect(() => assertReadOnly("SELECT * FROM main.x")).toThrow(GuardError);
    expect(() => assertReadOnly("SELECT * FROM commit")).toThrow(GuardError);
    expect(() => assertReadOnly("SELECT * FROM revision")).toThrow(GuardError);
  });
});

describe("assertWriteSafe", () => {
  it("passes INSERT/UPDATE/DELETE", () => {
    assertWriteSafe("INSERT INTO messages (a) VALUES (?)");
    assertWriteSafe("UPDATE messages SET a = ? WHERE id = ?");
    assertWriteSafe("DELETE FROM messages WHERE id = ?");
  });

  it("rejects DDL, PRAGMA/ATTACH, multiple statements, qualified and core refs", () => {
    expect(() => assertWriteSafe("CREATE TABLE t (a)")).toThrow(GuardError);
    expect(() => assertWriteSafe("ATTACH DATABASE 'x' AS y")).toThrow(
      GuardError,
    );
    expect(() => assertWriteSafe("INSERT INTO t VALUES (1); DELETE FROM t"))
      .toThrow(GuardError);
    expect(() => assertWriteSafe("INSERT INTO main.t VALUES (1)")).toThrow(
      GuardError,
    );
    expect(() => assertWriteSafe("DELETE FROM commit")).toThrow(GuardError);
  });
});

// Regression tests for guard bypasses found in code review.
describe("guard hardening (review findings)", () => {
  it("rejects quoted/bracketed core-table identifiers (read + write)", () => {
    expect(() => assertReadOnly('SELECT * FROM "commit"')).toThrow(GuardError);
    expect(() => assertReadOnly("SELECT * FROM [commit]")).toThrow(GuardError);
    expect(() => assertReadOnly("SELECT * FROM `commit`")).toThrow(GuardError);
    expect(() => assertWriteSafe('DELETE FROM "commit"')).toThrow(GuardError);
    expect(() => assertWriteSafe('UPDATE "head" SET x = 1')).toThrow(
      GuardError,
    );
    expect(() => assertWriteSafe("INSERT INTO [revision] VALUES (1)")).toThrow(
      GuardError,
    );
  });

  it("rejects quoted schema-qualified references", () => {
    expect(() => assertReadOnly('SELECT * FROM "main"."commit"')).toThrow(
      GuardError,
    );
    expect(() => assertReadOnly('SELECT sql FROM "main".sqlite_master'))
      .toThrow(
        GuardError,
      );
    expect(() => assertWriteSafe('INSERT INTO "main"."commit" VALUES (1)'))
      .toThrow(GuardError);
  });

  it("rejects sqlite_master / sqlite_schema / pragma_* introspection", () => {
    expect(() => assertReadOnly("SELECT * FROM sqlite_master")).toThrow(
      GuardError,
    );
    expect(() => assertReadOnly("SELECT * FROM sqlite_schema")).toThrow(
      GuardError,
    );
    expect(() => assertReadOnly("SELECT * FROM pragma_table_info('messages')"))
      .toThrow(GuardError);
  });

  it("rejects whitespace-around-dot and forbidden-schema prefixes", () => {
    expect(() => assertReadOnly("SELECT * FROM main . messages")).toThrow(
      GuardError,
    );
    expect(() => assertReadOnly("SELECT * FROM temp.x")).toThrow(GuardError);
  });

  it("still allows table.column references and plain table names", () => {
    assertReadOnly("SELECT t.a FROM messages t");
    assertReadOnly("SELECT * FROM messages");
    assertWriteSafe('INSERT INTO "messages" (a) VALUES (?)');
  });
});
