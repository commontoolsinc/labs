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
  tags: table({ id: "integer primary key", name: "text" }),
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

/** The key of a row keyed on `notes`'s primary key under `projection`. */
const keyed = (
  projection: readonly SqliteResultColumn[],
  id: unknown,
  declared: unknown = tables,
) => ({ database, projection, table: "notes", key: { id }, tables: declared });

/** The key of a row keyed on its position under `projection`. */
const positional = (
  projection: readonly SqliteResultColumn[],
  index: number,
  declared: unknown = tables,
  label?: unknown,
) => ({
  database,
  projection,
  index,
  tables: declared,
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

  it("keys a column-labeled row on its origin table's unlabeled primary key", () => {
    expect(
      resultRowKeys({
        rows,
        columns: notesColumns,
        tables,
        database,
        columnLabeled: true,
        rowLabel: never,
      }),
    ).toEqual([keyed(notesColumns, 1), keyed(notesColumns, 2)]);
  });

  it("reads the key off an entry-list row", () => {
    expect(
      resultRowKeys({
        rows: [[["id", 7], ["body", "x"]]],
        columns: notesColumns,
        tables,
        database,
        columnLabeled: true,
        rowLabel: never,
      }),
    ).toEqual([keyed(notesColumns, 7)]);
  });

  it("keys a row under a row label on its position and its label", () => {
    const label = { confidentiality: ["did:mailto:bob@b.example"] };
    expect(
      resultRowKeys({
        rows,
        columns: notesColumns,
        tables,
        database,
        columnLabeled: true,
        rowLabel: (index) => index === 1 ? label : undefined,
      }),
    ).toEqual([
      keyed(notesColumns, 1),
      positional(notesColumns, 1, tables, label),
    ]);
  });

  it("keys on position when the projection leaves the key out", () => {
    const projection: SqliteResultColumn[] = [
      { output: "body", table: "notes", column: "body" },
    ];
    expect(
      resultRowKeys({
        rows: [{ body: "a" }],
        columns: projection,
        tables,
        database,
        columnLabeled: true,
        rowLabel: never,
      }),
    ).toEqual([positional(projection, 0)]);
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
        database,
        columnLabeled: true,
        rowLabel: never,
      }),
    ).toEqual([
      positional(notesColumns, 0, labeledKey),
      positional(notesColumns, 1, labeledKey),
    ]);
  });

  it("keys on position when the projection spans two tables", () => {
    const projection: SqliteResultColumn[] = [
      { output: "id", table: "notes", column: "id" },
      { output: "name", table: "tags", column: "name" },
    ];
    expect(
      resultRowKeys({
        rows: [{ id: 1, name: "t" }],
        columns: projection,
        tables,
        database,
        columnLabeled: true,
        rowLabel: never,
      }),
    ).toEqual([positional(projection, 0)]);
  });

  it("keys every keyed row on position when two rows share a key", () => {
    expect(
      resultRowKeys({
        rows: [{ id: 1, body: "a" }, { id: 1, body: "b" }, {
          id: 2,
          body: "c",
        }],
        columns: notesColumns,
        tables,
        database,
        columnLabeled: true,
        rowLabel: never,
      }),
    ).toEqual([
      positional(notesColumns, 0),
      positional(notesColumns, 1),
      positional(notesColumns, 2),
    ]);
  });

  it("keeps a row-label key when duplicate keys move the rest to position", () => {
    const label = { confidentiality: ["did:mailto:bob@b.example"] };
    expect(
      resultRowKeys({
        rows: [{ id: 1, body: "a" }, { id: 1, body: "b" }, {
          id: 2,
          body: "c",
        }],
        columns: notesColumns,
        tables,
        database,
        columnLabeled: true,
        rowLabel: (index) => index === 2 ? label : undefined,
      }),
    ).toEqual([
      positional(notesColumns, 0),
      positional(notesColumns, 1),
      positional(notesColumns, 2, tables, label),
    ]);
  });

  it("keys a wide integer key that arrives as a `bigint`", () => {
    const wide = 2n ** 62n;
    expect(
      resultRowKeys({
        rows: [{ id: wide, body: "a" }, { id: wide + 1n, body: "b" }],
        columns: notesColumns,
        tables,
        database,
        columnLabeled: true,
        rowLabel: never,
      }),
    ).toEqual([keyed(notesColumns, wide), keyed(notesColumns, wide + 1n)]);
  });

  it("keys a row whose key holds `NULL` on its position", () => {
    const textKey = {
      notes: table({ slug: "text primary key", body: "text" }),
    };
    const projection: SqliteResultColumn[] = [
      { output: "slug", table: "notes", column: "slug" },
      { output: "body", table: "notes", column: "body" },
    ];
    expect(
      resultRowKeys({
        rows: [{ slug: "a", body: "x" }, { slug: null, body: "y" }],
        columns: projection,
        tables: textKey,
        database,
        columnLabeled: true,
        rowLabel: never,
      }),
    ).toEqual([
      {
        database,
        projection,
        table: "notes",
        key: { slug: "a" },
        tables: textKey,
      },
      positional(projection, 1, textKey),
    ]);
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
    expect(first).toEqual(keyed(notesColumns, 1));
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
    expect(second).toEqual(keyed(aliased, 1));
    expect(second).not.toEqual(first);
  });

  it("keys on position when the origin table declares no primary key", () => {
    const keyless = { notes: table({ id: "integer", body: "text" }) };
    expect(
      resultRowKeys({
        rows: [rows[0]],
        columns: notesColumns,
        tables: keyless,
        database,
        columnLabeled: true,
        rowLabel: never,
      }),
    ).toEqual([positional(notesColumns, 0, keyless)]);
  });
});
