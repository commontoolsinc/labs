// CFC Phase 3 (3.a-read), pure half: given a query result's TRUE column
// origins, the declared tables, and the rows, compute each row's per-row label
// (or refuse), and apply a declared output ceiling with onExceed fail|skip.
// No server, no FFI — the flush wires this to real results.
// Spec: docs/specs/sqlite-builtin/06-cfc.md ("Read — re-derive per row,
// attach, ceiling"; "Fail-closed rules").

import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import {
  computeRowLabelRead,
  resolveCeilingPlaceholders,
} from "../src/builtins/sqlite/row-label-read.ts";
import { table } from "@commonfabric/memory/sqlite/schema";
import {
  all,
  any,
  authoredBy,
  constant,
  dbOwner,
  match,
  principal,
  whenMatches,
} from "@commonfabric/memory/sqlite/row-label";

const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;
const OWNER = "did:key:zOwner";

const emailTables = {
  emails: table(
    { id: "integer", from: "text", to: "text", auth: "text", body: "text" },
    (f) => ({
      confidentiality: all(
        principal("mailto", match(f.from, ADDR, { min: 1 })),
        principal("mailto", match(f.to, ADDR)),
        dbOwner(),
      ),
      integrity: whenMatches(
        f.auth,
        /dmarc=pass/,
        authoredBy(principal("mailto", match(f.from, ADDR, { min: 1 }))),
      ),
    }),
  ),
};

const col = (output: string, table: string | null, column: string | null) => ({
  output,
  table,
  column,
});

const FULL_COLUMNS = [
  col("id", "emails", "id"),
  col("sender", "emails", "from"), // aliased — resolution is by ORIGIN
  col("to", "emails", "to"),
  col("auth", "emails", "auth"),
  col("body", "emails", "body"),
];

const ROWS = [
  {
    id: 1,
    sender: "alice@a.example",
    to: "bob@example.com",
    auth: "dmarc=pass",
    body: "hi",
  },
  {
    id: 2,
    sender: "carol@c.example",
    to: "dave@d.example, erin@e.example",
    auth: "",
    body: "yo",
  },
];

function expectOk(
  res: ReturnType<typeof computeRowLabelRead>,
): Exclude<ReturnType<typeof computeRowLabelRead>, { error: string }> {
  if ("error" in res) throw new Error(`unexpected error: ${res.error}`);
  return res;
}

function expectError(
  res: ReturnType<typeof computeRowLabelRead>,
  needle: string,
) {
  assert("error" in res, "expected {error}");
  assert(
    res.error.includes(needle),
    `error "${res.error}" should mention "${needle}"`,
  );
}

describe("computeRowLabelRead — per-row labels from origins", () => {
  it("is a no-op for rule-less tables (Phase 2 behavior preserved)", () => {
    const res = expectOk(computeRowLabelRead({
      tables: { notes: table({ body: "text" }) },
      columns: [col("cnt", null, null)], // even an aggregate is fine here
      rows: [{ cnt: 2 }],
      owner: OWNER,
    }));
    assertEquals(res.labels, [undefined]);
    assertEquals(res.keep, undefined);
  });

  it("computes DISTINCT per-row labels, resolving inputs by origin (alias-proof)", () => {
    const res = expectOk(computeRowLabelRead({
      tables: emailTables,
      columns: FULL_COLUMNS,
      rows: ROWS,
      owner: OWNER,
    }));
    assertEquals(res.labels, [
      {
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
      {
        confidentiality: [
          "did:mailto:carol@c.example",
          "did:mailto:dave@d.example",
          "did:mailto:erin@e.example",
          OWNER,
        ],
      },
    ]);
  });

  it("a spoofed projection (subject AS from) does NOT satisfy the rule input — refuse", () => {
    const res = computeRowLabelRead({
      tables: emailTables,
      // `from` is absent; something else aliases ITSELF to the name "from".
      columns: [
        col("from", "emails", "body"),
        col("to", "emails", "to"),
        col("auth", "emails", "auth"),
      ],
      rows: ROWS,
      owner: OWNER,
    });
    expectError(res, "from");
  });

  it("a projection missing a rule input refuses (SELECT id, body)", () => {
    const res = computeRowLabelRead({
      tables: emailTables,
      columns: [col("id", "emails", "id"), col("body", "emails", "body")],
      rows: [{ id: 1, body: "x" }],
      owner: OWNER,
    });
    expectError(res, "from");
  });

  it("two result columns with the SAME origin are ambiguous — refuse", () => {
    const res = computeRowLabelRead({
      tables: emailTables,
      columns: [...FULL_COLUMNS, col("from2", "emails", "from")],
      rows: ROWS,
      owner: OWNER,
    });
    expectError(res, "ambiguous");
  });

  it("missing provenance (no res.columns) on a rule-bearing db refuses", () => {
    const res = computeRowLabelRead({
      tables: emailTables,
      columns: undefined,
      rows: ROWS,
      owner: OWNER,
    });
    expectError(res, "provenance");
  });

  it("an aggregate on the CONJUNCTIVE rule refuses — no common reader (COUNT(*))", () => {
    const res = computeRowLabelRead({
      tables: emailTables,
      columns: [col("cnt", null, null)],
      rows: [{ cnt: 2 }],
      owner: OWNER,
    });
    expectError(res, "aggregate");
  });

  it("an aggregate is allowed when the rule has a common reader (Epic E2)", () => {
    // A rule with an unconditional dbOwner() alternative → the owner reads
    // every row → soundly reads a COUNT(*). The aggregate row is labeled by
    // the common alternative (the owner), and a ceiling naming the owner fits.
    const orTables = {
      emails: table(
        { id: "integer", from: "text", to: "text", body: "text" },
        (f) => ({
          confidentiality: all(
            any(dbOwner(), principal("mailto", match(f.from, ADDR))),
            any(dbOwner(), principal("mailto", match(f.to, ADDR))),
          ),
        }),
      ),
    };
    const res = expectOk(computeRowLabelRead({
      tables: orTables,
      columns: [col("cnt", null, null)],
      rows: [{ cnt: 2 }],
      owner: OWNER,
    }));
    assertEquals(res.labels, [{ confidentiality: [OWNER] }]);

    // ...and it fits a ceiling naming the owner, but not one that omits it.
    const kept = expectOk(computeRowLabelRead({
      tables: orTables,
      columns: [col("cnt", null, null)],
      rows: [{ cnt: 2 }],
      owner: OWNER,
      ceiling: [OWNER],
    }));
    assertEquals(kept.keep, [true]);

    const missed = computeRowLabelRead({
      tables: orTables,
      columns: [col("cnt", null, null)],
      rows: [{ cnt: 2 }],
      owner: OWNER,
      ceiling: ["did:key:someone-else"],
    });
    expectError(missed, "ceiling");
  });

  it("an aggregate over an integrity-only table is public — no label, not a refusal (Epic E2)", () => {
    // A rule declaring ONLY integrity imposes no confidentiality, so a COUNT(*)
    // over it is readable by everyone: the aggregate carries no label rather
    // than refusing for "no common reader" (a confidentiality notion). This is
    // the "no confidentiality constraint" vs "constrained but no shared reader"
    // distinction that ruleCommonAlternatives returning [] alone cannot make.
    const integrityOnly = {
      notes: table(
        { id: "integer", from: "text", body: "text" },
        (f) => ({
          integrity: authoredBy(
            principal("mailto", match(f.from, ADDR, { min: 1 })),
          ),
        }),
      ),
    };
    const res = expectOk(computeRowLabelRead({
      tables: integrityOnly,
      columns: [col("cnt", null, null)],
      rows: [{ cnt: 5 }],
      owner: OWNER,
    }));
    assertEquals(res.labels, [undefined]);

    // ...and carrying no confidentiality it fits even an empty ceiling.
    const kept = expectOk(computeRowLabelRead({
      tables: integrityOnly,
      columns: [col("cnt", null, null)],
      rows: [{ cnt: 5 }],
      owner: OWNER,
      ceiling: [],
    }));
    assertEquals(kept.keep, [true]);
  });

  it("the common-alternative intersection matches object constants regardless of key order (Epic E2)", () => {
    // Two confidentiality-bearing tables whose only common reader is the SAME
    // object-valued constant, written with keys in different order. The
    // aggregate must intersect them by canonical atom key, not refuse as if
    // they were distinct atoms (the non-canonical JSON.stringify bug).
    const reader = { org: "acme", team: "research" };
    const readerReordered = { team: "research", org: "acme" };
    const twoTables = {
      a: table({ id: "integer", x: "text" }, () => ({
        confidentiality: all(constant(reader)),
      })),
      b: table({ id: "integer", y: "text" }, () => ({
        confidentiality: all(constant(readerReordered)),
      })),
    };
    const res = expectOk(computeRowLabelRead({
      tables: twoTables,
      columns: [col("cnt", null, null)],
      rows: [{ cnt: 3 }],
      owner: OWNER,
    }));
    // Kept as one shared reader, NOT dropped to a refusal.
    assertEquals(res.labels, [{ confidentiality: [reader] }]);
  });

  it("an aggregate with SEVERAL common readers is labeled by their OR-clause (Epic E2)", () => {
    // A single OR-clause with two static unconditional readers (owner AND a
    // public constant) → both are common, so the aggregate row carries an
    // any(owner, public) clause and fits a ceiling naming either.
    const twoReaders = {
      emails: table(
        { id: "integer", from: "text", body: "text" },
        (f) => ({
          confidentiality: any(
            dbOwner(),
            constant("did:key:public"),
            principal("mailto", match(f.from, ADDR)),
          ),
        }),
      ),
    };
    const res = expectOk(computeRowLabelRead({
      tables: twoReaders,
      columns: [col("cnt", null, null)],
      rows: [{ cnt: 4 }],
      owner: OWNER,
    }));
    assertEquals(res.labels, [
      { confidentiality: [{ anyOf: [OWNER, "did:key:public"] }] },
    ]);
    // Fits a ceiling naming the public reader alone (subsumption).
    const kept = expectOk(computeRowLabelRead({
      tables: twoReaders,
      columns: [col("cnt", null, null)],
      rows: [{ cnt: 4 }],
      owner: OWNER,
      ceiling: ["did:key:public"],
    }));
    assertEquals(kept.keep, [true]);
  });

  it("two confidentiality-bearing tables with DISJOINT readers refuse the aggregate (Epic E2)", () => {
    // Each table has a single static reader, but different ones — no principal
    // reads every row of both, so the aggregate (which could range over either)
    // has no guaranteed reader and must refuse (the acc.size===0 path, distinct
    // from a single rule with no reader at all).
    const disjoint = {
      a: table({ id: "integer", x: "text" }, () => ({
        confidentiality: constant("did:key:reader-a"),
      })),
      b: table({ id: "integer", y: "text" }, () => ({
        confidentiality: constant("did:key:reader-b"),
      })),
    };
    const res = computeRowLabelRead({
      tables: disjoint,
      columns: [col("cnt", null, null)],
      rows: [{ cnt: 2 }],
      owner: OWNER,
    });
    expectError(res, "aggregate");
  });

  it("a well-formed anyOf wire spec is accepted; a malformed one refuses (Epic E1)", () => {
    // A well-formed OR-clause validates and produces per-row labels...
    const okTables = JSON.parse(JSON.stringify(emailTables)) as Record<
      string,
      { rowLabel?: { confidentiality?: unknown } }
    >;
    okTables.emails.rowLabel!.confidentiality = { anyOf: [{ dbOwner: true }] };
    const ok = computeRowLabelRead({
      tables: okTables,
      columns: FULL_COLUMNS,
      rows: ROWS,
      owner: OWNER,
    });
    assert(!("error" in ok), "a well-formed anyOf should be accepted");
    // ...but an empty anyOf (no alternatives) still refuses.
    const badTables = JSON.parse(JSON.stringify(emailTables)) as Record<
      string,
      { rowLabel?: { confidentiality?: unknown } }
    >;
    badTables.emails.rowLabel!.confidentiality = { anyOf: [] };
    const bad = computeRowLabelRead({
      tables: badTables,
      columns: FULL_COLUMNS,
      rows: ROWS,
      owner: OWNER,
    });
    expectError(bad, "any");
  });

  it("a query joining TWO rule-bearing tables refuses (cross-rule joins deferred)", () => {
    const tables = {
      ...emailTables,
      contacts: table(
        { email: "text" },
        (f) => ({
          confidentiality: all(principal("mailto", match(f.email, ADDR))),
        }),
      ),
    };
    const res = computeRowLabelRead({
      tables,
      columns: [...FULL_COLUMNS, col("email", "contacts", "email")],
      rows: [{ ...ROWS[0], email: "x@y.example" }],
      owner: OWNER,
    });
    expectError(res, "rule-bearing");
  });

  it("a rule-bearing table not present in the projection leaves rows unlabeled", () => {
    const tables = {
      ...emailTables,
      notes: table({ body: "text" }),
    };
    const res = computeRowLabelRead({
      tables,
      columns: [col("body", "notes", "body")],
      rows: [{ body: "x" }],
      owner: OWNER,
    });
    const ok = expectOk(res);
    assertEquals(ok.labels, [undefined]);
  });

  it("an evaluator failure on any row refuses the whole query (min anchor)", () => {
    const res = computeRowLabelRead({
      tables: emailTables,
      columns: FULL_COLUMNS,
      rows: [{ id: 3, sender: "", to: "", auth: "", body: "" }],
      owner: OWNER,
    });
    expectError(res, "from");
  });
});

describe("computeRowLabelRead — output ceiling + onExceed", () => {
  const CEILING_ALL = [
    "did:mailto:alice@a.example",
    "did:mailto:bob@example.com",
    "did:mailto:carol@c.example",
    "did:mailto:dave@d.example",
    "did:mailto:erin@e.example",
    OWNER,
  ];

  it("fail (default): one row exceeding the ceiling refuses the query", () => {
    const res = computeRowLabelRead({
      tables: emailTables,
      columns: FULL_COLUMNS,
      rows: ROWS,
      owner: OWNER,
      ceiling: [
        "did:mailto:alice@a.example",
        "did:mailto:bob@example.com",
        OWNER,
      ],
    });
    expectError(res, "ceiling");
  });

  it("skip: rows exceeding the ceiling are dropped, the rest kept", () => {
    const res = expectOk(computeRowLabelRead({
      tables: emailTables,
      columns: FULL_COLUMNS,
      rows: ROWS,
      owner: OWNER,
      ceiling: [
        "did:mailto:alice@a.example",
        "did:mailto:bob@example.com",
        OWNER,
      ],
      onExceed: "skip",
    }));
    assertEquals(res.keep, [true, false]);
  });

  it("a ceiling listing every participant fits (conjunctive reading)", () => {
    const res = expectOk(computeRowLabelRead({
      tables: emailTables,
      columns: FULL_COLUMNS,
      rows: ROWS,
      owner: OWNER,
      ceiling: CEILING_ALL,
    }));
    assertEquals(res.keep, [true, true]);
  });

  it("static per-column confidentiality counts against the ceiling too", () => {
    const res = computeRowLabelRead({
      tables: emailTables,
      columns: FULL_COLUMNS,
      rows: ROWS,
      owner: OWNER,
      staticConfidentiality: ["pii"],
      ceiling: CEILING_ALL, // does not allow "pii"
    });
    expectError(res, "ceiling");
  });

  it("skip never applies when the projection has a null-origin column (can't un-count)", () => {
    const res = computeRowLabelRead({
      tables: { notes: table({ body: "text" }) },
      columns: [col("cnt", null, null)],
      rows: [{ cnt: 2 }],
      owner: OWNER,
      staticConfidentiality: ["secret"],
      ceiling: [OWNER],
      onExceed: "skip",
    });
    expectError(res, "aggregate");
  });

  it("ceiling applies to a rule-less per-column-labeled db as well", () => {
    const res = computeRowLabelRead({
      tables: { notes: table({ body: "text" }) },
      columns: [col("body", "notes", "body")],
      rows: [{ body: "x" }],
      owner: OWNER,
      staticConfidentiality: ["secret"],
      ceiling: [OWNER], // "secret" not allowed
    });
    expectError(res, "ceiling");
  });

  it("an invalid onExceed value refuses", () => {
    const res = computeRowLabelRead({
      tables: emailTables,
      columns: FULL_COLUMNS,
      rows: ROWS,
      owner: OWNER,
      ceiling: CEILING_ALL,
      onExceed: "ignore",
    });
    expectError(res, "onExceed");
  });
});

describe("resolveCeilingPlaceholders", () => {
  it("resolves acting-user and db-owner placeholders to concrete principals", () => {
    const res = resolveCeilingPlaceholders(
      [{ __ctCurrentPrincipal: true }, { __ctDbOwner: true }, "pii"],
      { actingPrincipal: "did:key:zMe", owner: OWNER },
    );
    if ("error" in res) throw new Error(res.error);
    assertEquals(res.atoms, ["did:key:zMe", OWNER, "pii"]);
  });

  it("an unresolvable placeholder fails closed", () => {
    const noActing = resolveCeilingPlaceholders(
      [{ __ctCurrentPrincipal: true }],
      { owner: OWNER },
    );
    assert("error" in noActing);
    const noOwner = resolveCeilingPlaceholders(
      [{ __ctDbOwner: true }],
      { actingPrincipal: "did:key:zMe" },
    );
    assert("error" in noOwner);
  });
});
