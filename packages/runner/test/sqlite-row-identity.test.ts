import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { table } from "@commonfabric/memory/sqlite/schema";

import { resultRowKeys } from "../src/builtins/sqlite/row-identity.ts";

const tables = {
  notes: table({
    id: "integer primary key",
    body: {
      type: "string",
      sqlType: "text",
      ifc: { confidentiality: ["secret"] },
    },
  }),
  tags: table({ id: "integer primary key", name: "text" }),
};

const notesColumns = [
  { output: "id", table: "notes", column: "id" },
  { output: "body", table: "notes", column: "body" },
];

const rows = [
  { id: 1, body: "a" },
  { id: 2, body: "b" },
];

const never = () => false;

describe("resultRowKeys()", () => {
  it("keys a row carrying no confidentiality on its content", () => {
    expect(
      resultRowKeys({
        rows,
        columns: undefined,
        tables: undefined,
        columnLabeled: false,
        rowLabeled: never,
      }),
    ).toEqual([{ row: rows[0] }, { row: rows[1] }]);
  });

  it("keys a column-labeled row on its origin table's unlabeled primary key", () => {
    expect(
      resultRowKeys({
        rows,
        columns: notesColumns,
        tables,
        columnLabeled: true,
        rowLabeled: never,
      }),
    ).toEqual([
      { table: "notes", key: { id: 1 }, tables },
      { table: "notes", key: { id: 2 }, tables },
    ]);
  });

  it("reads the key off an entry-list row", () => {
    expect(
      resultRowKeys({
        rows: [[["id", 7], ["body", "x"]]],
        columns: notesColumns,
        tables,
        columnLabeled: true,
        rowLabeled: never,
      }),
    ).toEqual([{ table: "notes", key: { id: 7 }, tables }]);
  });

  it("keys a row under a row label on its position", () => {
    expect(
      resultRowKeys({
        rows,
        columns: notesColumns,
        tables,
        columnLabeled: true,
        rowLabeled: (index) => index === 1,
      }),
    ).toEqual([
      { table: "notes", key: { id: 1 }, tables },
      { index: 1, tables },
    ]);
  });

  it("keys on position when the projection leaves the key out", () => {
    expect(
      resultRowKeys({
        rows: [{ body: "a" }],
        columns: [{ output: "body", table: "notes", column: "body" }],
        tables,
        columnLabeled: true,
        rowLabeled: never,
      }),
    ).toEqual([{ index: 0, tables }]);
  });

  it("keys on position when the key column is labeled", () => {
    const labeledKey = {
      notes: table({
        id: {
          type: "integer",
          sqlType: "integer primary key",
          ifc: { confidentiality: ["secret"] },
        },
        body: "text",
      }),
    };
    expect(
      resultRowKeys({
        rows,
        columns: notesColumns,
        tables: labeledKey,
        columnLabeled: true,
        rowLabeled: never,
      }),
    ).toEqual([{ index: 0, tables: labeledKey }, {
      index: 1,
      tables: labeledKey,
    }]);
  });

  it("keys on position when the projection spans two tables", () => {
    expect(
      resultRowKeys({
        rows: [{ id: 1, name: "t" }],
        columns: [
          { output: "id", table: "notes", column: "id" },
          { output: "name", table: "tags", column: "name" },
        ],
        tables,
        columnLabeled: true,
        rowLabeled: never,
      }),
    ).toEqual([{ index: 0, tables }]);
  });

  it("keys every row on position when two rows share a key", () => {
    expect(
      resultRowKeys({
        rows: [{ id: 1, body: "a" }, { id: 1, body: "b" }, {
          id: 2,
          body: "c",
        }],
        columns: notesColumns,
        tables,
        columnLabeled: true,
        rowLabeled: never,
      }),
    ).toEqual([{ index: 0, tables }, { index: 1, tables }, {
      index: 2,
      tables,
    }]);
  });

  it("keys on position when the origin table declares no primary key", () => {
    const keyless = { notes: table({ id: "integer", body: "text" }) };
    expect(
      resultRowKeys({
        rows: [rows[0]],
        columns: notesColumns,
        tables: keyless,
        columnLabeled: true,
        rowLabeled: never,
      }),
    ).toEqual([{ index: 0, tables: keyless }]);
  });
});
