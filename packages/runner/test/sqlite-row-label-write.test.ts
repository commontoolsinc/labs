// CFC Phase 3 (3.a-write), pure half: the db.exec gate for rule-bearing
// tables. An attributable INSERT evaluates the rule over its bound values
// (prospective row label) and verifies no-laundering: every labeled input must
// be captured by the computed row label. Everything unattributable on a
// rule-bearing table fails closed (server-side commit evaluation, 3.c, is the
// follow-up that lifts this).
// Spec: docs/specs/sqlite-builtin/06-cfc.md ("Write — the runner gate").

import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { checkSqliteRowLabelWrite } from "../src/builtins/sqlite/row-label-write.ts";
import { table } from "@commonfabric/memory/sqlite/schema";
import {
  all,
  authoredBy,
  constant,
  dbOwner,
  match,
  principal,
  whenMatches,
} from "@commonfabric/memory/sqlite/row-label";

const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;
const OWNER = "did:key:zOwner";

const tables = {
  emails: table(
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
        dbOwner(),
      ),
      integrity: whenMatches(
        f.auth,
        /dmarc=pass/,
        authoredBy(principal("mailto", match(f.from_addr, ADDR, { min: 1 }))),
      ),
    }),
  ),
  notes: table({ id: "integer primary key", body: "text" }),
};

const unlabeled = (_v: unknown): readonly unknown[] => [];

function expectError(
  res: ReturnType<typeof checkSqliteRowLabelWrite>,
  needle: string,
) {
  assert("error" in res, "expected {error}");
  assert(
    res.error.includes(needle),
    `error "${res.error}" should mention "${needle}"`,
  );
}

function expectOk(
  res: ReturnType<typeof checkSqliteRowLabelWrite>,
): Exclude<ReturnType<typeof checkSqliteRowLabelWrite>, { error: string }> {
  if ("error" in res) throw new Error(`unexpected error: ${res.error}`);
  return res;
}

describe("checkSqliteRowLabelWrite — INSERT evaluates the rule", () => {
  it("computes the prospective row label from the bound values", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      sql:
        "INSERT INTO emails (from_addr, to_addrs, auth, body) VALUES (?, ?, ?, ?)",
      params: ["alice@a.example", "bob@example.com", "dmarc=pass", "hi"],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies, [{
      table: "emails",
      label: {
        confidentiality: [
          "did:mailto:alice@a.example",
          "did:mailto:bob@example.com",
          OWNER,
        ],
        integrity: [
          {
            kind: "claimed-authored-by",
            subject: "did:mailto:alice@a.example",
          },
        ],
      },
    }]);
  });

  it("a column omitted from the INSERT evaluates as NULL (cc-only style)", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      sql: "INSERT INTO emails (from_addr, body) VALUES (?, ?)",
      params: ["alice@a.example", "hi"],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies?.[0].label.confidentiality, [
      "did:mailto:alice@a.example",
      OWNER,
    ]);
  });

  it("a multi-row INSERT yields one policy per row, each with its own label", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      sql: "INSERT INTO emails (from_addr, to_addrs) VALUES (?, ?), (?, ?)",
      params: [
        "alice@a.example",
        "bob@example.com",
        "carol@c.example",
        "dave@d.example",
      ],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies?.length, 2);
    assertEquals(res.policies?.[0].label.confidentiality, [
      "did:mailto:alice@a.example",
      "did:mailto:bob@example.com",
      OWNER,
    ]);
    assertEquals(res.policies?.[1].label.confidentiality, [
      "did:mailto:carol@c.example",
      "did:mailto:dave@d.example",
      OWNER,
    ]);
  });

  it("the rule's min anchor fails closed on a missing sender", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "INSERT INTO emails (to_addrs) VALUES (?)",
        params: ["bob@example.com"],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      }),
      "from_addr",
    );
  });

  it("no-laundering: a labeled value captured by the row label passes", () => {
    const res = checkSqliteRowLabelWrite({
      sql: "INSERT INTO emails (from_addr, to_addrs, body) VALUES (?, ?, ?)",
      params: ["alice@a.example", "bob@example.com", "secret body"],
      tables,
      owner: OWNER,
      confidentialityOf: (v) =>
        v === "secret body" ? ["did:mailto:bob@example.com"] : [],
    });
    expectOk(res);
  });

  it("no-laundering: a labeled value NOT captured by the row label fails closed", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "INSERT INTO emails (from_addr, to_addrs, body) VALUES (?, ?, ?)",
        params: ["alice@a.example", "bob@example.com", "mallory's secret"],
        tables,
        owner: OWNER,
        confidentialityOf: (v) =>
          v === "mallory's secret" ? ["did:mailto:mallory@evil.example"] : [],
      }),
      "captured",
    );
  });

  it("a non-plain value bound to a rule input fails closed", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "INSERT INTO emails (from_addr, to_addrs) VALUES (?, ?)",
        params: [{ some: "cell-like" }, "bob@example.com"],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      }),
      "from_addr",
    );
  });

  it("INSERT…SELECT (unattributable) on a rule-bearing table fails closed", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "INSERT INTO emails (from_addr) SELECT from_addr FROM emails",
        params: [],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      }),
      "emails",
    );
  });
});

describe("checkSqliteRowLabelWrite — UPDATE / DELETE / rule-less", () => {
  it("UPDATE of a non-input column with unlabeled values passes (label unchanged)", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      sql: "UPDATE emails SET body = ? WHERE id = ?",
      params: ["new body", 1],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies, undefined);
  });

  it("UPDATE touching a rule INPUT column fails closed (needs 3.c)", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "UPDATE emails SET to_addrs = ? WHERE id = ?",
        params: ["eve@evil.example", 1],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      }),
      "to_addrs",
    );
  });

  it("UPDATE with a labeled value fails closed (capture unverifiable without the row)", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "UPDATE emails SET body = ? WHERE id = ?",
        params: ["secret", 1],
        tables,
        owner: OWNER,
        confidentialityOf: (v) => (v === "secret" ? ["x"] : []),
      }),
      "labeled",
    );
  });

  it("DELETE passes (no stored values)", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      sql: "DELETE FROM emails WHERE id = ?",
      params: [1],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies, undefined);
  });

  it("rule-less tables are untouched (Phase 2 behavior)", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      sql: "INSERT INTO notes (body) VALUES (?)",
      params: ["x"],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies, undefined);
  });

  it("an unattributable write in a db WITH rule-bearing tables fails closed", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "INSERT INTO unknown_table (x) VALUES (?)",
        params: ["v"],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      }),
      "fail closed",
    );
  });

  it("dbOwner() in the rule with no owner on the ref fails closed", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "INSERT INTO emails (from_addr) VALUES (?)",
        params: ["alice@a.example"],
        tables,
        owner: undefined,
        confidentialityOf: unlabeled,
      }),
      "dbOwner",
    );
  });
});

describe("checkSqliteRowLabelWrite — review-round soundness fixes", () => {
  // A rule whose confidentiality is entirely data-dependent: rows that don't
  // match the gate compute an EMPTY label.
  const gatedTables = {
    drafts: table(
      { id: "integer primary key", flag: "text", body: "text" },
      (f) => ({
        confidentiality: whenMatches(f.flag, /locked/, constant("sealed")),
      }),
    ),
  };

  it("an EMPTY computed row label captures nothing — labeled inputs fail closed", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "INSERT INTO drafts (flag, body) VALUES (?, ?)",
        params: ["open", "secret payload"],
        tables: gatedTables,
        owner: OWNER,
        confidentialityOf: (v) => (v === "secret payload" ? ["x"] : []),
      }),
      "empty",
    );
  });

  it("the same labeled input passes when the gate fires (non-empty label captures it)", () => {
    const res = checkSqliteRowLabelWrite({
      sql: "INSERT INTO drafts (flag, body) VALUES (?, ?)",
      params: ["locked", "secret payload"],
      tables: gatedTables,
      owner: OWNER,
      confidentialityOf: (v) => (v === "secret payload" ? ["sealed"] : []),
    });
    expectOk(res);
  });

  it("a param-less LITERAL UPDATE of a rule input column fails closed", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "UPDATE emails SET to_addrs = 'eve@evil.example' WHERE id = 1",
        params: [],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      }),
      "to_addrs",
    );
  });

  it("a param-less literal UPDATE of a NON-input column also fails closed (unattributable SET)", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "UPDATE emails SET body = 'plain' WHERE id = 1",
        params: [],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      }),
      "fail closed",
    );
  });
});

describe("checkSqliteRowLabelWrite — 3.c relaxation (serverCommitEval)", () => {
  const base = {
    tables,
    owner: OWNER,
    confidentialityOf: unlabeled,
    serverCommitEval: true,
  };

  it("admits INSERT…SELECT with unlabeled inputs (server derives; no policies)", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      ...base,
      sql: "INSERT INTO emails (from_addr) SELECT from_addr FROM emails",
      params: [],
    }));
    assertEquals(res.policies, undefined);
  });

  it("admits an upsert with unlabeled bound values", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      ...base,
      sql: "INSERT INTO emails (id, from_addr) VALUES (?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET from_addr = excluded.from_addr",
      params: [1, "alice@a.example"],
    }));
    assertEquals(res.policies, undefined);
  });

  it("admits a columnless INSERT (VALUES and DEFAULT VALUES forms)", () => {
    expectOk(checkSqliteRowLabelWrite({
      ...base,
      sql: "INSERT INTO emails VALUES (?, ?, ?, ?, ?)",
      params: [1, "alice@a.example", "bob@example.com", "", "hi"],
    }));
    expectOk(checkSqliteRowLabelWrite({
      ...base,
      sql: "INSERT INTO emails DEFAULT VALUES",
      params: [],
    }));
  });

  it("admits an UPDATE that writes a rule-input column (post-image is the server's)", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      ...base,
      sql: "UPDATE emails SET to_addrs = ? WHERE id = ?",
      params: ["carol@c.example", 1],
    }));
    assertEquals(res.policies, undefined);
  });

  it("no-laundering STAYS runner-side: a labeled value on a relaxed shape fails closed", () => {
    // The server never sees input-value labels, so the runner cannot defer
    // the capture check — a labeled bound value on a shape the runner cannot
    // evaluate keeps failing closed even with the capability.
    expectError(
      checkSqliteRowLabelWrite({
        ...base,
        sql: "INSERT INTO emails (from_addr, body) SELECT ?, ? FROM emails",
        params: ["alice@a.example", "secret"],
        confidentialityOf: (v) => (v === "secret" ? ["x"] : []),
      }),
      "labeled",
    );
    expectError(
      checkSqliteRowLabelWrite({
        ...base,
        sql: "UPDATE emails SET to_addrs = ? WHERE id = ?",
        params: ["secret", 1],
        confidentialityOf: (v) => (v === "secret" ? ["x"] : []),
      }),
      "labeled",
    );
  });

  it("shapes 3.c does NOT cover keep failing closed with the capability on", () => {
    // Named params: bound values can't be attributed for the laundering check.
    expectError(
      checkSqliteRowLabelWrite({
        ...base,
        sql: "INSERT INTO emails (from_addr) VALUES (:f)",
        params: { f: "alice@a.example" },
      }),
      "named params",
    );
    // Literal/expression SET stays unattributable.
    expectError(
      checkSqliteRowLabelWrite({
        ...base,
        sql: "UPDATE emails SET to_addrs = 'eve@evil.example' WHERE id = 1",
        params: [],
      }),
      "fail closed",
    );
    // Undeclared target table.
    expectError(
      checkSqliteRowLabelWrite({
        ...base,
        sql: "INSERT INTO unknown_table (x) VALUES (?)",
        params: ["v"],
      }),
      "undeclared",
    );
  });

  it("an attributable INSERT still evaluates runner-side (policies recorded)", () => {
    // The relaxation must not disable the 3.a fast path: evaluable shapes
    // keep computing prospective labels for the sink-request seam.
    const res = expectOk(checkSqliteRowLabelWrite({
      ...base,
      sql: "INSERT INTO emails (from_addr, to_addrs) VALUES (?, ?)",
      params: ["alice@a.example", "bob@example.com"],
    }));
    assertEquals(res.policies?.length, 1);
  });
});
