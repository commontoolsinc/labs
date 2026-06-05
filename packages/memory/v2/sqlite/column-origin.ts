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
// We bind the origin symbols against the SAME libsqlite3 `@db/sqlite` uses, via
// `DENO_SQLITE_PATH` (the one explicit knob `@db/sqlite` itself honors). We do
// NOT scan the filesystem, download, or probe the compile flags: we ASSUME the
// bundled prebuilt is built with SQLITE_ENABLE_COLUMN_METADATA (it is). If the
// lib can't be bound (path unset or symbols missing), `columnOrigins()` throws —
// a labeled query then fails loudly rather than silently mislabeling.

type OriginLib = {
  origin: Deno.DynamicLibrary<{
    sqlite3_column_origin_name: {
      parameters: ["pointer", "i32"];
      result: "pointer";
    };
    sqlite3_column_table_name: {
      parameters: ["pointer", "i32"];
      result: "pointer";
    };
  }>;
};

let cached: OriginLib | null | undefined;

const SYMBOLS = {
  sqlite3_column_origin_name: {
    parameters: ["pointer", "i32"],
    result: "pointer",
  },
  sqlite3_column_table_name: {
    parameters: ["pointer", "i32"],
    result: "pointer",
  },
} as const;

/** Bind the origin symbols against libsqlite3 (lazy, memoized). Null if the
 *  library path is unset or the symbols can't be opened. */
function lib(): OriginLib | null {
  if (cached !== undefined) return cached;
  const path = Deno.env.get("DENO_SQLITE_PATH");
  try {
    cached = path ? { origin: Deno.dlopen(path, SYMBOLS) } : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** True if column-origin metadata is reachable in this deployment. */
export function columnOriginAvailable(): boolean {
  return lib() !== null;
}

export interface ColumnOrigin {
  /** Origin table, or null for an expression/computed/compound column. */
  table: string | null;
  /** Origin column, or null when there is no single source column. */
  column: string | null;
}

const cstr = (p: Deno.PointerValue): string | null =>
  p === null ? null : new Deno.UnsafePointerView(p).getCString();

/**
 * Per-result-column TRUE origin for a prepared `@db/sqlite` statement. `count`
 * is the number of result columns (`stmt.columnNames().length`). A column with
 * no single source (expression, literal, some compound selects) reports
 * `{ table: null, column: null }` — callers MUST fail closed on that.
 *
 * Throws if the column-metadata FFI can't be bound (path unset / symbols
 * missing) — a labeled query fails loudly rather than silently mislabeling.
 */
export function columnOrigins(
  stmtHandle: Deno.PointerValue,
  count: number,
): ColumnOrigin[] {
  const l = lib();
  if (!l) {
    throw new Error(
      "sqlite: column-origin FFI unavailable — set DENO_SQLITE_PATH to the " +
        "libsqlite3 @db/sqlite uses (built with SQLITE_ENABLE_COLUMN_METADATA) " +
        "so CFC read-labeling can resolve column provenance",
    );
  }
  const out: ColumnOrigin[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      table: cstr(l.origin.symbols.sqlite3_column_table_name(stmtHandle, i)),
      column: cstr(l.origin.symbols.sqlite3_column_origin_name(stmtHandle, i)),
    });
  }
  return out;
}
