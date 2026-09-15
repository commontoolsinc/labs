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

import type { SqliteResultColumn } from "@commonfabric/memory/v2";

/**
 * A row's key. A row carrying no confidentiality is keyed on its content, so
 * equal rows share a document and a row keeps its document wherever it lands
 * in the result. A row carrying a per-column label is keyed on its position,
 * and a row under a row label on its position and its label: a document's
 * confidentiality can never weaken, so a document may only ever hold rows of
 * one label, and the label is metadata every document carries in the open,
 * so the id gives away nothing the document does not. Position rather than a
 * declared primary key, because the declaration is the handle's claim and
 * not a verified constraint of the table: a table created before the key was
 * declared keeps whatever rows it holds, and two rows sharing a declared key
 * would share a document, so a link retained to one would come to resolve to
 * the other. The positional keys carry the selected database, its space and
 * id, since a query's `db` input can move to another database whose rows
 * would otherwise land on the same documents; the projection, each output
 * column and its origin, since a query's `sql` input can move to a
 * projection whose columns carry other labels; and the handle's `tables`
 * declaration, so a stricter re-declaration of a label moves the row to a new
 * document that the commit writes and labels.
 */
export type ResultRowKey =
  | { readonly row: unknown }
  | {
    readonly database: ResultRowDatabase;
    readonly projection: readonly SqliteResultColumn[] | undefined;
    readonly index: number;
    readonly tables: unknown;
    readonly label?: unknown;
  };

/** The database a result's rows were read from: its space and its id. */
export type ResultRowDatabase = {
  readonly space: string;
  readonly id: string;
};

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
  return rows.map((row, index) => {
    const label = rowLabel(index);
    if (label !== undefined) {
      return { database, projection: columns, index, tables, label };
    }
    if (!columnLabeled) return { row };
    return { database, projection: columns, index, tables };
  });
}
