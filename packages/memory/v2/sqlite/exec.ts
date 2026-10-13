// Engine-side SQLite execution: guarded query/write and additive DDL.
// Runs server-side (this package owns the @db/sqlite Database). Statement safety
// is enforced by the tokenizer-level guard; `_cf_link` encode/decode happens on
// the client (runner) before/after these calls.

import { type BindValue, Database } from "@db/sqlite";
import { fabricFromConvertibleJsValue } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { isPlainObject } from "@commonfabric/utils/types";
import type { SqliteNativeRow } from "../../v2.ts";
import { assertReadOnly, assertWriteSafe } from "./guard.ts";
import { type ColumnOrigin, columnOrigins } from "./column-origin.ts";
import { createTableSQL, type TableSchema } from "./schema.ts";

// Reserved schema names that may never be used as a pattern-db attach alias.
const RESERVED_ALIASES = new Set(["main", "temp"]);

/** Derive a safe attach alias from an opaque db id (e.g. an `of:fid1:abc…` entity
 *  id). The `cf_` prefix guarantees a valid leading identifier char. */
export function aliasForDbId(id: string): string {
  return `cf_${id.replace(/[^A-Za-z0-9]/g, "_")}`;
}

/** Validate an attach alias: a plain SQL identifier, not a reserved schema. */
export function assertSafeAlias(alias: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias) || RESERVED_ALIASES.has(alias)) {
    throw new TypeError(`invalid attach alias: ${alias}`);
  }
}

/**
 * ATTACH a cell-derived database file under an internal alias.
 *
 * Must be called OUTSIDE any open transaction — SQLite rejects ATTACH/DETACH
 * while a transaction is active. The commit-folded write path must therefore
 * attach the db *before* `BEGIN`.
 *
 * Caller owns attach/detach pairing: re-attaching an in-use alias throws, and
 * there is a connection-global limit (`SQLITE_MAX_ATTACHED`, default ~10) — an
 * LRU attach/detach cache manages this (spec 08-open-questions Q8a).
 */
export function attachDatabase(
  db: Database,
  alias: string,
  path: string,
): void {
  assertSafeAlias(alias);
  if (db.inTransaction) {
    throw new Error("attachDatabase must be called outside a transaction");
  }
  // Path is bound as a parameter; the alias is a validated literal (it cannot be
  // a bind parameter in ATTACH). Only the cell-derived WRITE path attaches here
  // (read-write, folded into the commit). Reads — cell-derived and injected
  // on-disk — run unattached on the read pool (ReadConnectionPool), which opens
  // each file `readonly`; that is where read-only enforcement now lives.
  db.exec(`ATTACH DATABASE ? AS ${alias}`, path);
}

/** DETACH a previously attached alias. Must be called outside a transaction and
 *  only when the alias is not in use (SQLite throws otherwise). */
export function detachDatabase(db: Database, alias: string): void {
  assertSafeAlias(alias);
  if (db.inTransaction) {
    throw new Error("detachDatabase must be called outside a transaction");
  }
  db.exec(`DETACH DATABASE ${alias}`);
}

export type SqliteParams = readonly unknown[] | Record<string, unknown>;

export type WriteResult = {
  changes: number;
  lastInsertRowid: number;
};

// @db/sqlite binds positional values as a rest list and named values as a single
// record argument. Top-level binary values stay as FabricBytes over the memory
// protocol and become Uint8Array only at this native database edge. Binary
// values nested in JSON structures become byte arrays before SQLite encodes
// the surrounding value.
// (Exported for the commit-time row-label evaluator, which prepares the same
// wire params against its RETURNING-instrumented statement.)
export function bindArgs(params?: SqliteParams): BindValue[] {
  if (params === undefined) return [];
  const bindValue = (value: unknown, nested = false): unknown => {
    if (value instanceof FabricBytes) {
      return nested ? [...value.slice()] : value.slice();
    }
    if (Array.isArray(value)) {
      return value.map((member) => bindValue(member, true));
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, member]) => [
          key,
          bindValue(member, true),
        ]),
      );
    }
    return value;
  };
  return (Array.isArray(params)
    ? params.map((value) => bindValue(value))
    : [Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, bindValue(value)]),
    )]) as BindValue[];
}

/**
 * A guarded read's result as the SQLite driver returns it: the output column
 * names, each row's values in column order, and, when asked for, each column's
 * TRUE origin. The values are the driver's own (string, number, bigint, null,
 * `Uint8Array`), which a structured clone carries between threads; {@link
 * rowsFromNative} converts them to the rows a caller sees.
 */
export type NativeQueryResult = {
  /** The statement's output column names, in result order. */
  names: string[];

  /** Each row's values, in the order of {@link names}. */
  values: unknown[][];

  /** Each result column's TRUE origin, present when it was asked for. */
  origins?: ColumnOrigin[];
};

/**
 * Runs a single guarded read-only SELECT on `db` with already-bound `args`
 * (see {@link bindArgs}), returning the driver's values unconverted. With
 * `withOrigins`, also reads each result column's TRUE origin, which needs the
 * column-origin symbols bound on this thread (`ensureColumnOriginAvailable()`)
 * and throws when they are not.
 */
export function runNativeQuery(
  db: Database,
  sql: string,
  args: BindValue[],
  withOrigins: boolean,
): NativeQueryResult {
  assertReadOnly(sql);
  const stmt = db.prepare(sql);
  try {
    const names = stmt.columnNames();
    const origins = withOrigins
      ? columnOrigins(stmt.unsafeHandle, names.length)
      : undefined;
    const values = stmt.values<unknown[]>(...args);
    return origins === undefined ? { names, values } : {
      names,
      values,
      origins,
    };
  } finally {
    stmt.finalize();
  }
}

/**
 * Calls `started`, then `read`, on `db`, so that a `sqlite3_interrupt` sent to
 * `db` once `started` has been called stops `read`'s statement, and returns
 * what `read` returns.
 *
 * SQLite clears a pending interrupt when a statement starts on a connection
 * running no other, so without help an interrupt sent after `started` and
 * before `read`'s first step would be lost. A statement held running across
 * `read` keeps it pending until `read`'s statement sees it. An interrupt sent
 * once this has returned is cleared by the next statement to start on `db`.
 */
export function runInterruptibly<T>(
  db: Database,
  started: () => void,
  read: () => T,
): T {
  const held = db.prepare("SELECT 1");
  try {
    held.iter().next();
    started();
    return read();
  } finally {
    held.finalize();
  }
}

/** Converts a {@link NativeQueryResult}'s values to rows keyed by output name. */
export function rowsFromNative<Row extends SqliteNativeRow = SqliteNativeRow>(
  result: NativeQueryResult,
): Row[] {
  return result.values.map((values) =>
    Object.fromEntries(
      result.names.map((key, index) => [
        key,
        fabricFromConvertibleJsValue(values[index]),
      ]),
    ) as Row
  );
}

/**
 * Pairs each output column of a {@link NativeQueryResult} with its origin, a
 * missing origin reading as `null` (no single source column). The result must
 * carry origins.
 */
export function columnsFromNative(result: NativeQueryResult): QueryColumn[] {
  const { origins } = result;
  if (origins === undefined) {
    throw new Error("sqlite: the query result carries no column origins");
  }
  return result.names.map((output, i) => ({
    output,
    table: origins[i]?.table ?? null,
    column: origins[i]?.column ?? null,
  }));
}

/** Run a single guarded read-only SELECT and return all rows. */
export function runQuery<Row extends SqliteNativeRow = SqliteNativeRow>(
  db: Database,
  sql: string,
  params?: SqliteParams,
): Row[] {
  return rowsFromNative<Row>(runNativeQuery(db, sql, bindArgs(params), false));
}

/** A result column's output name plus its TRUE source `(table, column)` origin
 *  (null for an expression/computed/compound column). */
export type QueryColumn = {
  output: string;
  table: string | null;
  column: string | null;
};

/**
 * Like {@link runQuery}, but also returns each result column's TRUE origin
 * (resolved by the engine via SQLite column-metadata — see `column-origin.ts`),
 * so CFC read-labeling can map an aliased/joined result column back to the
 * declared `(table, column)` it came from, soundly. Only used when the db
 * declares per-column `ifc` (zero overhead otherwise — callers use `runQuery`).
 */
export function runQueryWithOrigins<
  Row extends SqliteNativeRow = SqliteNativeRow,
>(
  db: Database,
  sql: string,
  params?: SqliteParams,
): { rows: Row[]; columns: QueryColumn[] } {
  const result = runNativeQuery(db, sql, bindArgs(params), true);
  return {
    rows: rowsFromNative<Row>(result),
    columns: columnsFromNative(result),
  };
}

/** Run a single guarded INSERT/UPDATE/DELETE. */
export function runWrite(
  db: Database,
  sql: string,
  params?: SqliteParams,
): WriteResult {
  assertWriteSafe(sql);
  const changes = db.prepare(sql).run(...bindArgs(params));
  // `lastInsertRowId` is connection-global; correct here because the engine uses
  // one synchronous connection per space (no interleaving between run and read).
  return { changes, lastInsertRowid: db.lastInsertRowId };
}

/**
 * Additive table reconciliation (Phase 2 V1): create missing tables. Destructive
 * or ambiguous changes to existing tables are out of scope and intentionally not
 * applied here; a future migration step handles them (refuse-by-default + opt-in
 * callback — see spec 08-open-questions Q9).
 */
export function ensureTables(
  db: Database,
  tables: Record<string, TableSchema>,
  alias?: string,
): void {
  if (alias !== undefined) assertSafeAlias(alias);
  for (const [name, schema] of Object.entries(tables)) {
    db.exec(createTableSQL(name, schema, alias));
  }
}
