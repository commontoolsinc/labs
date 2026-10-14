/**
 * Diagnostic statements over a SQLite table whose cost does not grow with the
 * table: whether it holds a row, and how many of its first rows carry a value
 * in each of some columns. They are for code that inspects a database it does
 * not own — a connector store another process writes, which can run to
 * gigabytes with full-text and blob tables — where an exact `count(*)` walks
 * the whole table unless an index serves it, and over a full-text table walks
 * it always.
 *
 * Each statement is one read-only `SELECT` the statement guard accepts. It
 * names the table and its columns only through {@link quoteIdentifier}, and
 * gives every figure an alias built here, so nothing a column is called can
 * collide with a figure. Beside each builder is the reader for the row its
 * statement returns, which returns `undefined` for a row that does not carry
 * the figures: a read that failed is never mistaken for an empty table.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import { quoteIdentifier } from "./schema.ts";

/**
 * The most rows {@link fillSampleSql} reads from one table. Large enough that a
 * column filled on a meaningful share of a table shows up in the sample, and
 * small enough that reading it is constant work beside any query worth running
 * against the table.
 */
export const FILL_SAMPLE_LIMIT = 1000;

/** What {@link readFillSample} reads off a fill sample's row. */
export interface FillSample {
  /**
   * How many rows the sample read: every row the table holds, up to
   * {@link FILL_SAMPLE_LIMIT}. `0` is a table that holds no row, and
   * {@link FILL_SAMPLE_LIMIT} is one that holds at least that many and says
   * nothing about how many more.
   */
  readonly sampled: number;

  /**
   * Per column asked about, in the order asked, how many of the sampled rows
   * hold a value there rather than NULL.
   */
  readonly nonNull: readonly number[];
}

/**
 * A statement returning one row that says whether `table` holds any row.
 * `EXISTS` stops at the first row it finds, so this reads at most one row
 * whatever the table holds.
 */
export const tablePresenceSql = (table: string): string =>
  `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(table)}) AS "present"`;

/**
 * Whether the row {@link tablePresenceSql} returned says its table holds a row,
 * or `undefined` when `row` does not carry the answer.
 */
export const readTablePresence = (row: unknown): boolean | undefined => {
  if (!isObjectNotArray(row)) {
    return undefined;
  }
  return row.present === 1 ? true : row.present === 0 ? false : undefined;
};

/**
 * A statement returning one row that says how many rows a sample of `table`
 * read and how many of them hold a value in each of `columns`.
 *
 * The sample is the first {@link FILL_SAMPLE_LIMIT} rows a scan of the table
 * yields, in whatever order the scan yields them, so the cost is the same
 * whatever the table holds. Those are the first rows rather than a random
 * draw: a column with no value in any of them may still hold values in rows
 * past them, and a figure here is never a total.
 *
 * Each column is tested through `typeof()`, which SQLite answers from a row's
 * header without loading the value, so a column of long text or blobs costs
 * no more to sample than an integer one.
 */
export const fillSampleSql = (
  table: string,
  columns: readonly string[],
): string => {
  const figures = columns.map((_, index) => quoteIdentifier(figureName(index)));
  const counted = figures.map((figure) => `count(${figure}) AS ${figure}`);
  const tested = columns.length === 0
    ? ["1"]
    : columns.map((column, index) =>
      `nullif(typeof(${quoteIdentifier(column)}), 'null') AS ${figures[index]}`
    );
  return `SELECT ${['count(*) AS "sampled"', ...counted].join(", ")} ` +
    `FROM (SELECT ${tested.join(", ")} FROM ${quoteIdentifier(table)} ` +
    `LIMIT ${FILL_SAMPLE_LIMIT})`;
};

/**
 * What the row {@link fillSampleSql} returned for `columnCount` columns says,
 * or `undefined` when `row` does not carry every figure that statement asks
 * for.
 */
export const readFillSample = (
  row: unknown,
  columnCount: number,
): FillSample | undefined => {
  if (!isObjectNotArray(row) || !isCount(row.sampled)) {
    return undefined;
  }
  const nonNull: number[] = [];
  for (let index = 0; index < columnCount; index++) {
    const count = row[figureName(index)];
    if (!isCount(count)) {
      return undefined;
    }
    nonNull.push(count);
  }
  return { sampled: row.sampled, nonNull };
};

/**
 * The name {@link fillSampleSql} gives the figure for the column at `index`.
 * Built here rather than taken from the column, so no column name can collide
 * with `sampled` or with another column's figure.
 */
const figureName = (index: number): string => `c${index}`;

/** Whether `value` is a count a statement here can return. */
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
