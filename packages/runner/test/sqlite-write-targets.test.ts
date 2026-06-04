// Unit tests for parseWriteParamColumns: maps each positional `?` to its target
// column for the CFC write-ceiling check. Security-critical → fail closed on
// anything it can't confidently attribute.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { parseWriteParamColumns } from "../src/builtins/sqlite/write-targets.ts";

describe("parseWriteParamColumns — determinable shapes", () => {
  it("INSERT with explicit column list", () => {
    expect(parseWriteParamColumns("INSERT INTO t (a, b) VALUES (?, ?)"))
      .toEqual(["a", "b"]);
  });

  it("INSERT cycles columns across multi-row VALUES", () => {
    expect(
      parseWriteParamColumns("INSERT INTO t (a, b) VALUES (?, ?), (?, ?)"),
    ).toEqual(["a", "b", "a", "b"]);
  });

  it("UPDATE SET maps SET params; WHERE params are null", () => {
    expect(
      parseWriteParamColumns("UPDATE t SET a = ?, b = ? WHERE id = ?"),
    ).toEqual(["a", "b", null]);
  });

  it("UPDATE with a COMPLEX WHERE — SET still mapped, all WHERE params null", () => {
    expect(
      parseWriteParamColumns(
        "UPDATE t SET body = ? WHERE id = ? AND (score > ? OR tag IN (?, ?))",
      ),
    ).toEqual(["body", null, null, null, null]);
  });

  it("UPDATE with quoted/bracketed SET identifiers", () => {
    expect(parseWriteParamColumns('UPDATE t SET "wei rd" = ? WHERE id = ?'))
      .toEqual(["wei rd", null]);
  });

  it("DELETE — every param is a filter (null), no column write", () => {
    expect(parseWriteParamColumns("DELETE FROM t WHERE a = ? AND b = ?"))
      .toEqual([null, null]);
  });

  it("no placeholders → empty mapping", () => {
    expect(parseWriteParamColumns("DELETE FROM t WHERE a = 1")).toEqual([]);
  });

  it("is not fooled by `?`/keywords/commas inside string literals", () => {
    expect(
      parseWriteParamColumns(
        "UPDATE t SET a = ? WHERE note = 'x, where set ? y' AND id = ?",
      ),
    ).toEqual(["a", null]);
  });
});

describe("parseWriteParamColumns — fail closed (undefined)", () => {
  const failsClosed = (sql: string) =>
    expect(parseWriteParamColumns(sql)).toBeUndefined();

  it("columnless INSERT", () => failsClosed("INSERT INTO t VALUES (?, ?)"));
  it("INSERT … SELECT", () =>
    failsClosed("INSERT INTO t (a) SELECT x FROM u WHERE y = ?"));
  it("upsert DO UPDATE binds in the conflict clause", () =>
    failsClosed(
      "INSERT INTO t (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET b = ?",
    ));
  it("UPDATE with a non-`?` SET expression", () =>
    failsClosed("UPDATE t SET a = b + ? WHERE id = ?"));
  it("UPDATE with a subquery in SET", () =>
    failsClosed("UPDATE t SET a = (SELECT x FROM u WHERE z = ?) WHERE id = ?"));
  it("UPDATE tuple assignment", () =>
    failsClosed("UPDATE t SET (a, b) = (?, ?) WHERE id = ?"));
  it("named params (positional attribution unsafe)", () =>
    failsClosed("UPDATE t SET a = :a WHERE id = :id"));
  it("numbered params", () =>
    failsClosed("INSERT INTO t (a, b) VALUES (?1, ?2)"));
  it("WITH-prefixed write (unparsed shape)", () =>
    failsClosed("WITH c AS (SELECT 1) UPDATE t SET a = ? WHERE id = ?"));
});
