// CFC write-ceiling logic (pure): a value bound to a labeled column must fit the
// column's ifc.maxConfidentiality. Reader is faked so the decision logic is
// tested without the runtime label machinery (the real reader is
// cfcLabelViewForCell, exercised end-to-end elsewhere).

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { checkSqliteWriteCeiling } from "../src/builtins/sqlite/write-ceiling.ts";

// `emails.body` is capped at confidentiality {support}; everything else uncapped.
const TABLES = {
  emails: {
    properties: {
      from_email: { ifc: {} },
      subject: {},
      body: { ifc: { maxConfidentiality: ["support"] } },
    },
  },
};

// Fake label reader: a value's confidentiality is looked up by identity.
const labels = new Map<unknown, readonly unknown[]>();
const reader = (v: unknown) => labels.get(v) ?? [];
const SECRET = { tag: "secret-value" }; // confidentiality {alice} (exceeds cap)
const SUPPORTED = { tag: "supported-value" }; // confidentiality {support} (fits)
labels.set(SECRET, ["alice"]);
labels.set(SUPPORTED, ["support"]);

const check = (sql: string, params: unknown) =>
  checkSqliteWriteCeiling(
    sql,
    params as ReadonlyArray<unknown> | Record<string, unknown>,
    TABLES,
    reader,
  );

describe("checkSqliteWriteCeiling", () => {
  it("rejects a value more confidential than the column allows", () => {
    expect(check("INSERT INTO emails (body) VALUES (?)", [SECRET]))
      .toMatch(/maxConfidentiality/);
  });

  it("allows a value within the column ceiling", () => {
    expect(check("INSERT INTO emails (body) VALUES (?)", [SUPPORTED]))
      .toBeUndefined();
  });

  it("allows an over-confidential value into an UNCAPPED column", () => {
    expect(check("INSERT INTO emails (subject) VALUES (?)", [SECRET]))
      .toBeUndefined();
  });

  it("ignores unlabeled values entirely", () => {
    expect(check("INSERT INTO emails (body) VALUES (?)", ["plain text"]))
      .toBeUndefined();
  });

  it("checks each column in a multi-column INSERT", () => {
    // SECRET -> body (capped) is the violation; SUPPORTED -> subject is fine.
    expect(
      check("INSERT INTO emails (subject, body) VALUES (?, ?)", [
        SUPPORTED,
        SECRET,
      ]),
    ).toMatch(/"body"/);
  });

  it("does NOT check a labeled value used only as a WHERE filter", () => {
    // The value isn't stored in a column, so the column ceiling doesn't apply.
    expect(check("UPDATE emails SET subject = ? WHERE body = ?", [
      "ok",
      SECRET,
    ])).toBeUndefined();
  });

  it("enforces the ceiling on a simple UPDATE SET", () => {
    expect(check("UPDATE emails SET body = ? WHERE id = ?", [SECRET, 1]))
      .toMatch(/maxConfidentiality/);
  });

  it("FAILS CLOSED: labeled value whose target column can't be determined", () => {
    // Columnless INSERT -> parseWriteParamColumns returns undefined -> reject the
    // labeled value rather than store it unverified.
    expect(check("INSERT INTO emails VALUES (?, ?, ?)", [SECRET, "a", "b"]))
      .toMatch(/cannot be determined/);
  });

  it("named params: the key is the column", () => {
    expect(check("INSERT INTO emails (body) VALUES (:body)", { body: SECRET }))
      .toMatch(/maxConfidentiality/);
    expect(
      check("INSERT INTO emails (body) VALUES (:body)", { body: SUPPORTED }),
    )
      .toBeUndefined();
  });

  it("no tables / no ifc -> no-op", () => {
    expect(
      checkSqliteWriteCeiling(
        "INSERT INTO emails (body) VALUES (?)",
        [SECRET],
        undefined,
        reader,
      ),
    ).toBeUndefined();
  });
});
