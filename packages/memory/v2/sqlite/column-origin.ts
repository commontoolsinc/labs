// Sound read-label provenance via SQLite column-origin metadata.
//
// `@db/sqlite` returns rows keyed by the SELECT's OUTPUT column names, which is
// unsound for CFC labeling: `SELECT body AS x` hides a confidential column, and
// `SELECT subject AS from_email` spoofs another column's name. The bundled
// libsqlite3 is compiled with SQLITE_ENABLE_COLUMN_METADATA, so we ask the
// engine for each result column's TRUE origin `(table, column)` via FFI on the
// prepared statement's `unsafeHandle`:
//   - alias  `from_email AS r`      -> origin (emails, from_email)   [resolved]
//   - spoof  `subject AS from_email`-> origin (emails, subject)      [defeated]
//   - expr   `upper(from_email)`    -> origin (null, null)           [fail closed]
//
// We are NOT switching SQLite implementations: the origin symbols live in the
// libsqlite3 `@db/sqlite` already loaded (compiled with
// SQLITE_ENABLE_COLUMN_METADATA) but `@db/sqlite` doesn't expose them, so
// `native-symbols.ts` binds them from that same image. Resolution is async, so
// call `ensureColumnOriginAvailable()` once before issuing labeled queries;
// `columnOrigins()` then reads the memoized symbols synchronously.

import {
  ensureNativeSymbols,
  nativeSymbols,
  nativeSymbolsUnavailableReason,
} from "./native-symbols.ts";

/**
 * Resolves and binds the column-origin symbols against `@db/sqlite`'s own
 * libsqlite3 (memoized, single-flight), and returns whether they are bound.
 * Callers that need provenance MUST await this before `columnOrigins()` and
 * fail loudly when it returns false.
 */
export async function ensureColumnOriginAvailable(): Promise<boolean> {
  await ensureNativeSymbols();
  return columnOriginAvailable();
}

/**
 * True if the column-origin symbols are bound — meaningful only AFTER
 * `ensureColumnOriginAvailable()` has resolved.
 */
export function columnOriginAvailable(): boolean {
  return originSymbols() !== undefined;
}

/**
 * Why the symbols could not be bound, once `ensureColumnOriginAvailable()` has
 * resolved false. Undefined while they are bound or unresolved.
 */
export function columnOriginUnavailableReason(): string | undefined {
  const symbols = nativeSymbols();
  if (symbols === undefined) return nativeSymbolsUnavailableReason();
  return originSymbols() === undefined
    ? "the libsqlite3 @db/sqlite loaded was built without " +
      "SQLITE_ENABLE_COLUMN_METADATA, so it exports no column-origin symbols"
    : undefined;
}

/** The two column-origin functions, when the library exports both. */
function originSymbols():
  | {
    tableName: (
      statement: Deno.PointerValue,
      column: number,
    ) => Deno.PointerValue;
    originName: (
      statement: Deno.PointerValue,
      column: number,
    ) => Deno.PointerValue;
  }
  | undefined {
  const symbols = nativeSymbols();
  const tableName = symbols?.sqlite3_column_table_name;
  const originName = symbols?.sqlite3_column_origin_name;
  if (!tableName || !originName) return undefined;
  return { tableName, originName };
}

export type ColumnOrigin = {
  /** Origin table, or null for an expression/computed/compound column. */
  table: string | null;

  /** Origin column, or null when there is no single source column. */
  column: string | null;
};

const cstr = (p: Deno.PointerValue): string | null =>
  p === null ? null : new Deno.UnsafePointerView(p).getCString();

/**
 * Per-result-column TRUE origin for a prepared `@db/sqlite` statement. `count`
 * is the number of result columns (`stmt.columnNames().length`). A column with
 * no single source (expression, literal, some compound selects) reports
 * `{ table: null, column: null }` — callers MUST fail closed on that.
 *
 * Throws if the lib isn't bound — call `ensureColumnOriginAvailable()` first; a
 * labeled query fails loudly rather than silently mislabeling.
 */
export function columnOrigins(
  stmtHandle: Deno.PointerValue,
  count: number,
): ColumnOrigin[] {
  const symbols = originSymbols();
  if (symbols === undefined) {
    throw new Error(
      "sqlite: column-origin FFI not bound — " +
        (columnOriginUnavailableReason() ??
          "ensureColumnOriginAvailable() must resolve before a labeled query " +
            "reads column provenance"),
    );
  }
  const out: ColumnOrigin[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      table: cstr(symbols.tableName(stmtHandle, i)),
      column: cstr(symbols.originName(stmtHandle, i)),
    });
  }
  return out;
}
