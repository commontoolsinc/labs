// CFC Phase 3.c: commit-time row-label re-derivation. The engine executes a
// folded `sqlite` write, reads the affected rows back by rowid, and runs the
// SHARED evaluator against each TRUE committed row — throwing (rolling back
// the WHOLE commit, cell ops included) on any rule-evaluation failure. This
// covers the shapes the runner gate cannot attribute (INSERT…SELECT, upsert,
// columnless INSERT, rule-input UPDATE); no-laundering stays runner-side.
// (Spec: docs/specs/sqlite-builtin/06-cfc.md, "server-side commit evaluation".)

import { assert, assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import { applyCommit, open, read } from "../v2/engine.ts";
import {
  aliasForDbId,
  attachDatabase,
  detachDatabase,
  ensureTables,
  runQuery,
} from "../v2/sqlite/exec.ts";
import { table } from "../v2/sqlite/schema.ts";
import {
  all,
  authoredBy,
  dbOwner,
  match,
  principal,
  whenMatches,
} from "../v2/sqlite/row-label.ts";
import {
  applySqliteCommitWrite,
  MAX_ROW_LABEL_EVAL_ROWS,
  RowLabelCommitError,
} from "../v2/sqlite/commit-eval.ts";
import type { Operation } from "../v2.ts";

const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;

// The mailbox-shaped rule: sender (required anchor) ∧ recipients; integrity
// (authored-by-sender) gated on the row's auth column.
const emails = table(
  {
    id: "integer primary key",
    from_addr: "text",
    to_addrs: "text",
    auth: "text",
    body: "text",
  },
  (f) => ({
    confidentiality: all(
      principal("mailto", match(f.from_addr, ADDR, { min: 1 })),
      principal("mailto", match(f.to_addrs, ADDR)),
    ),
    integrity: whenMatches(
      f.auth,
      /dmarc=pass/,
      authoredBy(principal("mailto", match(f.from_addr, ADDR, { min: 1 }))),
    ),
  }),
);

// Rule-less staging table in the SAME db: writes to it stay plain, and it
// feeds the INSERT…SELECT shapes.
const staging = table({
  id: "integer primary key",
  from_addr: "text",
  to_addrs: "text",
  auth: "text",
  body: "text",
});

const ownerOnly = table(
  { id: "integer primary key", note: "text" },
  () => ({ confidentiality: all(dbOwner()) }),
);

const TABLES = { emails, staging, ownerOnly };
const DB_ID = "of:commit-eval-db";
const OWNER = "did:key:owner";

const VALID = ["alice@a.example", "bob@b.example", "dmarc=pass", "hi"];
// from_addr is non-empty but yields no address-shaped match: strict-if-present
// fails closed at evaluation.
const VIOLATING = ["not an address", "bob@b.example", "", "boom"];

// --- applyCommit-level: atomic rollback with the cell ops -------------------

async function freshEngine() {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  return await open({ url: toFileUrl(path) });
}

async function withAttached(
  fn: (
    engine: Awaited<ReturnType<typeof open>>,
    commitSqlite: (
      localSeq: number,
      ops: Operation[],
    ) => ReturnType<typeof applyCommit>,
  ) => void | Promise<void>,
) {
  const engine = await freshEngine();
  const alias = aliasForDbId(DB_ID);
  attachDatabase(
    engine.database,
    alias,
    await Deno.makeTempFile({ suffix: ".sqlite" }),
  );
  ensureTables(engine.database, TABLES, alias);
  try {
    await fn(engine, (localSeq, operations) =>
      applyCommit(engine, {
        sessionId: "session:a",
        principal: "did:key:alice",
        space: "did:key:space",
        sqliteAttachments: new Map([[DB_ID, alias]]),
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations,
        },
      }));
  } finally {
    detachDatabase(engine.database, alias);
  }
}

const sqliteOp = (sql: string, params?: unknown[]): Operation => ({
  op: "sqlite",
  db: { id: DB_ID, tables: TABLES, owner: OWNER },
  sql,
  params,
});

Deno.test("INSERT…SELECT with a violating committed row rolls back the WHOLE commit", async () => {
  await withAttached((engine, commitSqlite) => {
    // Stage one valid and one violating row (staging is rule-less: plain path).
    commitSqlite(1, [
      sqliteOp(
        "INSERT INTO staging (from_addr, to_addrs, auth, body) VALUES " +
          "(?, ?, ?, ?), (?, ?, ?, ?)",
        [...VALID, ...VIOLATING],
      ),
    ]);
    // The copy commit carries a cell op too — BOTH must roll back.
    const error = assertThrows(() =>
      commitSqlite(2, [
        { op: "set", id: "entity:marker", value: { value: { copied: true } } },
        sqliteOp(
          "INSERT INTO emails (from_addr, to_addrs, auth, body) " +
            "SELECT from_addr, to_addrs, auth, body FROM staging",
        ),
      ])
    );
    assert(error instanceof RowLabelCommitError, String(error));
    assert(
      error.message.includes("strict-if-present"),
      `unexpected reason: ${error.message}`,
    );
    assertEquals(read(engine, { id: "entity:marker" }), null);
    assertEquals(
      runQuery(engine.database, "SELECT count(*) AS n FROM emails"),
      [{ n: 0 }],
    );
    // The staging rows themselves survived (their commit was separate).
    assertEquals(
      runQuery(engine.database, "SELECT count(*) AS n FROM staging"),
      [{ n: 2 }],
    );
  });
});

Deno.test("INSERT…SELECT whose committed rows all satisfy the rule lands with its cell op", async () => {
  await withAttached((engine, commitSqlite) => {
    commitSqlite(1, [
      sqliteOp(
        "INSERT INTO staging (from_addr, to_addrs, auth, body) VALUES (?, ?, ?, ?)",
        VALID,
      ),
    ]);
    commitSqlite(2, [
      { op: "set", id: "entity:marker", value: { value: { copied: true } } },
      sqliteOp(
        "INSERT INTO emails (from_addr, to_addrs, auth, body) " +
          "SELECT from_addr, to_addrs, auth, body FROM staging",
      ),
    ]);
    assertEquals(read(engine, { id: "entity:marker" }), {
      value: { copied: true },
    });
    assertEquals(
      runQuery(engine.database, "SELECT from_addr FROM emails"),
      [{ from_addr: "alice@a.example" }],
    );
  });
});

Deno.test("upsert re-derives from the POST-IMAGE: violating flip rolls back, valid flip lands", async () => {
  await withAttached((engine, commitSqlite) => {
    commitSqlite(1, [
      sqliteOp(
        "INSERT INTO emails (id, from_addr, to_addrs, auth, body) " +
          "VALUES (?, ?, ?, ?, ?)",
        [1, ...VALID],
      ),
    ]);
    const upsert = "INSERT INTO emails (id, from_addr, to_addrs, auth, body) " +
      "VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET " +
      "from_addr = excluded.from_addr";
    // Post-image from_addr matches nothing -> the rule refuses the row.
    assertThrows(
      () => commitSqlite(2, [sqliteOp(upsert, [1, ...VIOLATING])]),
      RowLabelCommitError,
    );
    assertEquals(
      runQuery(engine.database, "SELECT from_addr FROM emails WHERE id = 1"),
      [{ from_addr: "alice@a.example" }],
    );
    // A valid post-image is admitted (and the label the read side re-derives
    // follows the new value).
    commitSqlite(3, [
      sqliteOp(upsert, [1, "carol@c.example", "bob@b.example", "", "hi"]),
    ]);
    assertEquals(
      runQuery(engine.database, "SELECT from_addr FROM emails WHERE id = 1"),
      [{ from_addr: "carol@c.example" }],
    );
  });
});

Deno.test("UPDATE of a rule-input column is judged by the committed value", async () => {
  await withAttached((engine, commitSqlite) => {
    commitSqlite(1, [
      sqliteOp(
        "INSERT INTO emails (id, from_addr, to_addrs, auth, body) " +
          "VALUES (?, ?, ?, ?, ?)",
        [1, ...VALID],
      ),
    ]);
    assertThrows(
      () =>
        commitSqlite(2, [
          sqliteOp("UPDATE emails SET from_addr = ? WHERE id = ?", [
            "no address here",
            1,
          ]),
        ]),
      RowLabelCommitError,
    );
    assertEquals(
      runQuery(engine.database, "SELECT from_addr FROM emails WHERE id = 1"),
      [{ from_addr: "alice@a.example" }],
    );
    commitSqlite(3, [
      sqliteOp("UPDATE emails SET from_addr = ? WHERE id = ?", [
        "carol@c.example",
        1,
      ]),
    ]);
    assertEquals(
      runQuery(engine.database, "SELECT from_addr FROM emails WHERE id = 1"),
      [{ from_addr: "carol@c.example" }],
    );
  });
});

Deno.test("integrity stays unique: a display-name bait post-image fails closed", async () => {
  await withAttached((_engine, commitSqlite) => {
    // Two address-shaped tokens in from_addr + dmarc=pass: >1 match in an
    // integrity-bearing position must refuse (forged provenance subject).
    assertThrows(
      () =>
        commitSqlite(1, [
          sqliteOp(
            "INSERT INTO emails (from_addr, to_addrs, auth, body) " +
              "SELECT ?, ?, ?, ?",
            [
              '"bait@evil.example" <real@x.example>',
              "bob@b.example",
              "dmarc=pass",
              "hi",
            ],
          ),
        ]),
      RowLabelCommitError,
    );
  });
});

Deno.test("dbOwner() rule: owner present on the op passes, absent fails closed", async () => {
  await withAttached((engine, commitSqlite) => {
    commitSqlite(1, [
      sqliteOp("INSERT INTO ownerOnly (note) SELECT ?", ["hello"]),
    ]);
    assertEquals(
      runQuery(engine.database, "SELECT note FROM ownerOnly"),
      [{ note: "hello" }],
    );
    const noOwner: Operation = {
      op: "sqlite",
      db: { id: DB_ID, tables: TABLES },
      sql: "INSERT INTO ownerOnly (note) SELECT ?",
      params: ["nope"],
    };
    const error = assertThrows(() => commitSqlite(2, [noOwner]));
    assert(error instanceof RowLabelCommitError, String(error));
    assert(error.message.includes("dbOwner"), error.message);
    assertEquals(
      runQuery(engine.database, "SELECT count(*) AS n FROM ownerOnly"),
      [{ n: 1 }],
    );
  });
});

Deno.test("DELETE and rule-less-table writes stay plain on a rule-bearing db", async () => {
  await withAttached((engine, commitSqlite) => {
    commitSqlite(1, [
      sqliteOp(
        "INSERT INTO emails (id, from_addr, to_addrs, auth, body) " +
          "VALUES (?, ?, ?, ?, ?)",
        [1, ...VALID],
      ),
      // Violating VALUES land fine in the rule-less staging table.
      sqliteOp(
        "INSERT INTO staging (from_addr, to_addrs, auth, body) " +
          "SELECT ?, ?, ?, ?",
        VIOLATING,
      ),
    ]);
    commitSqlite(2, [sqliteOp("DELETE FROM emails WHERE id = ?", [1])]);
    assertEquals(
      runQuery(engine.database, "SELECT count(*) AS n FROM emails"),
      [{ n: 0 }],
    );
    assertEquals(
      runQuery(engine.database, "SELECT count(*) AS n FROM staging"),
      [{ n: 1 }],
    );
  });
});

// --- direct applySqliteCommitWrite: shape rejects + caps --------------------
// (No wrapping transaction here — these assert the THROW; rollback is the
// applyCommit-level tests' concern.)

function bareDb(): Database {
  const db = new Database(":memory:");
  ensureTables(db, TABLES);
  return db;
}

const bareOp = (
  sql: string,
  params?: unknown[],
  tables: Record<string, unknown> = TABLES,
) => ({
  op: "sqlite" as const,
  db: { id: DB_ID, tables, owner: OWNER },
  sql,
  params,
});

Deno.test("commit eval fails closed on the shapes it cannot attribute", () => {
  const db = bareDb();
  try {
    // CTE-fronted write: unrecognized leading keyword.
    assertThrows(
      () =>
        applySqliteCommitWrite(
          db,
          bareOp(
            "WITH x(v) AS (SELECT 'a@b.c') INSERT INTO emails (from_addr) " +
              "SELECT v FROM x",
          ),
        ),
      RowLabelCommitError,
      "unrecognized write shape",
    );
    // Undeclared target table in a rule-bearing db.
    assertThrows(
      () =>
        applySqliteCommitWrite(
          db,
          bareOp("INSERT INTO mystery (a) VALUES (?)", ["x"]),
        ),
      RowLabelCommitError,
      "undeclared table",
    );
    // A statement that already carries RETURNING.
    assertThrows(
      () =>
        applySqliteCommitWrite(
          db,
          bareOp(
            "INSERT INTO emails (from_addr, to_addrs) VALUES (?, ?) " +
              "RETURNING id",
            ["alice@a.example", "bob@b.example"],
          ),
        ),
      RowLabelCommitError,
      "RETURNING",
    );
    // An invalid wire-supplied spec never evaluates as "no label".
    const badTables = {
      emails: { ...emails, rowLabel: { version: 99 } },
    };
    assertThrows(
      () =>
        applySqliteCommitWrite(
          db,
          bareOp(
            "INSERT INTO emails (from_addr) VALUES (?)",
            ["alice@a.example"],
            badTables,
          ),
        ),
      RowLabelCommitError,
      "invalid rowLabel rule",
    );
  } finally {
    db.close();
  }
});

Deno.test("commit eval evaluates the columnless-INSERT default row", () => {
  const db = bareDb();
  try {
    // All-defaults row: from_addr is NULL, which the min:1 anchor refuses.
    assertThrows(
      () =>
        applySqliteCommitWrite(db, bareOp("INSERT INTO emails DEFAULT VALUES")),
      RowLabelCommitError,
      "at least 1",
    );
  } finally {
    db.close();
  }
});

Deno.test("commit eval caps the affected-row count (fail closed, not silent)", () => {
  const db = bareDb();
  try {
    // Seed staging beyond the cap directly (test-side; no guard involved).
    const insert = db.prepare("INSERT INTO staging (from_addr) VALUES (?)");
    db.exec("BEGIN");
    for (let i = 0; i <= MAX_ROW_LABEL_EVAL_ROWS; i++) {
      insert.run("alice@a.example");
    }
    db.exec("COMMIT");
    assertThrows(
      () =>
        applySqliteCommitWrite(
          db,
          bareOp(
            "INSERT INTO emails (from_addr) SELECT from_addr FROM staging",
          ),
        ),
      RowLabelCommitError,
      "cap",
    );
  } finally {
    db.close();
  }
});

Deno.test("a no-op write (UPDATE matching nothing) passes without evaluation", () => {
  const db = bareDb();
  try {
    const result = applySqliteCommitWrite(
      db,
      bareOp("UPDATE emails SET from_addr = ? WHERE id = ?", ["x", 42]),
    );
    assertEquals(result.changes, 0);
  } finally {
    db.close();
  }
});
