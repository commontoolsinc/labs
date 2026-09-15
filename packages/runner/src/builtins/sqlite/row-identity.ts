/**
 * What a `sqliteQuery` result row's entity document is keyed on. Each row is
 * stored as a document of its own under the query's result cell, and the key
 * chosen here, hashed with that cell's coordinates, is the document's id. A
 * key stands still across runs for a row that did not change, so a re-run
 * writes no document for it, and a key is drawn only from what a reader of the
 * result's row links may already see: the id is deterministic and the links
 * are unlabeled, so a key built from a confidential value would let such a
 * reader confirm a guess at that value by recomputing the id.
 */

import { hashStringOf } from "@commonfabric/data-model";
import {
  columnDeclaresIfc,
  type SqliteResultColumn,
} from "@commonfabric/memory/v2";

/**
 * A row's key. A row carrying no confidentiality is keyed on its content, so
 * equal rows share a document and a row keeps its document wherever it lands
 * in the result. A row with per-column labels is keyed on its origin table's
 * primary key when the projection carries the whole key from one table, no
 * key column is labeled, the row's key holds no `NULL`, and no two rows share
 * a key; a row without such a key is keyed on its position. A row under a
 * row label is keyed on its position and its label: a document's
 * confidentiality can never weaken, so a document may only ever hold rows of
 * one label, and the label is metadata every document carries in the open,
 * so the id gives away nothing the document does not. The keys that are not
 * content carry the selected database, its space and id, since a query's
 * `db` input can move from one database to another whose rows would
 * otherwise land on the same documents, and the handle's `tables`
 * declaration, so a stricter re-declaration of a label moves the row to a
 * new document that the commit writes and labels.
 */
export type ResultRowKey =
  | { readonly row: unknown }
  | {
    readonly database: ResultRowDatabase;
    readonly table: string;
    readonly key: Record<string, unknown>;
    readonly tables: unknown;
  }
  | {
    readonly database: ResultRowDatabase;
    readonly index: number;
    readonly tables: unknown;
    readonly label?: unknown;
  };

/** The database a result's rows were read from: its space and its id. */
export type ResultRowDatabase = {
  readonly space: string;
  readonly id: string;
};

const PRIMARY_KEY = /\bprimary\s+key\b/i;

/** The value a wire row holds for the output column `name`. */
function columnValue(row: unknown, name: string): unknown {
  if (Array.isArray(row)) {
    const entry = (row as Array<[string, unknown]>).find(([n]) => n === name);
    return entry?.[1];
  }
  return row !== null && typeof row === "object"
    ? Object.getOwnPropertyDescriptor(row, name)?.value
    : undefined;
}

/**
 * The output columns holding the unlabeled primary key of the one table every
 * attributed column of the projection comes from, or `undefined` when there
 * is no such key: two origin tables, a key column the projection leaves out,
 * a key column that declares `ifc`, or no column declared as a primary key.
 */
function unlabeledPrimaryKeyColumns(
  columns: readonly SqliteResultColumn[],
  tables: Record<string, unknown> | undefined,
): { table: string; outputs: Array<[string, string]> } | undefined {
  const origins = new Set<string>();
  for (const c of columns) if (c.table !== null) origins.add(c.table);
  if (origins.size !== 1) return undefined;
  const [table] = origins;
  const properties = (tables?.[table] as {
    properties?: Record<string, { sqlType?: unknown; ifc?: unknown }>;
  } | undefined)?.properties;
  if (!properties) return undefined;
  const outputs: Array<[string, string]> = [];
  for (const [column, spec] of Object.entries(properties)) {
    if (typeof spec?.sqlType !== "string" || !PRIMARY_KEY.test(spec.sqlType)) {
      continue;
    }
    if (columnDeclaresIfc(spec.ifc)) return undefined;
    const projected = columns.find((c) =>
      c.table === table && c.column === column
    );
    if (projected === undefined) return undefined;
    outputs.push([column, projected.output]);
  }
  return outputs.length > 0 ? { table, outputs } : undefined;
}

/**
 * Chooses the key of every row of one result, in row order. `columnLabeled`
 * says whether the projection carries a per-column label, and `rowLabel` is
 * the row label of the row at an index, or `undefined` for a row carrying
 * none. `columns` is the server's origin per output column, present whenever
 * the db declares any label, and `database` is the database the rows were
 * read from.
 */
export function resultRowKeys(options: {
  rows: readonly unknown[];
  columns: readonly SqliteResultColumn[] | undefined;
  tables: Record<string, unknown> | undefined;
  database: ResultRowDatabase;
  columnLabeled: boolean;
  rowLabel: (index: number) => unknown;
}): ResultRowKey[] {
  const { rows, columns, tables, database, columnLabeled, rowLabel } = options;
  const primaryKey = columnLabeled && columns !== undefined
    ? unlabeledPrimaryKeyColumns(columns, tables)
    : undefined;
  const keyed: ResultRowKey[] = rows.map((row, index) => {
    const label = rowLabel(index);
    if (label !== undefined) return { database, index, tables, label };
    if (!columnLabeled) return { row };
    if (primaryKey === undefined) return { database, index, tables };
    const key: Record<string, unknown> = {};
    for (const [column, output] of primaryKey.outputs) {
      const value = columnValue(row, output);
      // A key column that is not `INTEGER` admits `NULL`, and rows holding one
      // are distinct rows that no key tells apart, so such a row is keyed on
      // its position.
      if (value === null || value === undefined) {
        return { database, index, tables };
      }
      key[column] = value;
    }
    return { database, table: primaryKey.table, key, tables };
  });
  // A key that two rows share would put two rows in one document, so a result
  // in which that happens is keyed on position throughout. Key values are
  // compared by their Fabric hash: a wide integer key arrives as a `bigint`,
  // which the hash covers.
  const seen = new Set<string>();
  for (const key of keyed) {
    if (!("key" in key)) continue;
    const serialized = hashStringOf(
      primaryKey!.outputs.map(([column]) => key.key[column]),
    );
    if (seen.has(serialized)) {
      return rows.map((_, index) =>
        "row" in keyed[index] ? keyed[index] : { database, index, tables }
      );
    }
    seen.add(serialized);
  }
  return keyed;
}
