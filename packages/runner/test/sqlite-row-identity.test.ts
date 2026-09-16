import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteResultColumn } from "@commonfabric/memory/v2";

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
};

const notesColumns: SqliteResultColumn[] = [
  { output: "id", table: "notes", column: "id" },
  { output: "body", table: "notes", column: "body" },
];

const rows = [
  { id: 1, body: "a" },
  { id: 2, body: "b" },
];

const never = () => undefined;

const database = { space: "did:key:zTestSpace", id: "of:notes-db" };

/** The key of a row keyed on its position under `projection`. */
const positional = (
  projection: readonly SqliteResultColumn[],
  index: number,
  label?: unknown,
) => ({
  database,
  projection,
  index,
  tables,
  ...(label !== undefined && { label }),
});

describe("resultRowKeys()", () => {
  it("keys a row carrying no confidentiality on its content", () => {
    expect(
      resultRowKeys({
        rows,
        columns: undefined,
        tables: undefined,
        database,
        columnLabeled: false,
        rowLabel: never,
      }),
    ).toEqual([{ row: rows[0] }, { row: rows[1] }]);
  });

  it("keys a column-labeled row on its position", () => {
    expect(
      resultRowKeys({
        rows,
        columns: notesColumns,
        tables,
        database,
        columnLabeled: true,
        rowLabel: never,
      }),
    ).toEqual([positional(notesColumns, 0), positional(notesColumns, 1)]);
  });

  it("keys a row under a row label on its position and its label", () => {
    const label = { confidentiality: ["did:mailto:bob@b.example"] };
    expect(
      resultRowKeys({
        rows,
        columns: notesColumns,
        tables,
        database,
        columnLabeled: false,
        rowLabel: (index) => index === 1 ? label : undefined,
      }),
    ).toEqual([{ row: rows[0] }, positional(notesColumns, 1, label)]);
  });

  it("keys the same row of another database on a different key", () => {
    const other = { space: database.space, id: "of:other-db" };
    const [first] = resultRowKeys({
      rows: [rows[0]],
      columns: notesColumns,
      tables,
      database,
      columnLabeled: true,
      rowLabel: never,
    });
    const [second] = resultRowKeys({
      rows: [rows[0]],
      columns: notesColumns,
      tables,
      database: other,
      columnLabeled: true,
      rowLabel: never,
    });
    expect(first).toEqual(positional(notesColumns, 0));
    expect(second).not.toEqual(first);
  });

  it("keys the same row of another projection on a different key", () => {
    const aliased: SqliteResultColumn[] = [
      { output: "id", table: "notes", column: "id" },
      { output: "value", table: "notes", column: "body" },
    ];
    const [first] = resultRowKeys({
      rows: [rows[0]],
      columns: notesColumns,
      tables,
      database,
      columnLabeled: true,
      rowLabel: never,
    });
    const [second] = resultRowKeys({
      rows: [{ id: 1, value: "a" }],
      columns: aliased,
      tables,
      database,
      columnLabeled: true,
      rowLabel: never,
    });
    expect(second).toEqual(positional(aliased, 0));
    expect(second).not.toEqual(first);
  });
});
