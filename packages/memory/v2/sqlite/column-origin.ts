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
// We are NOT switching SQLite implementations: this binds the SAME libsqlite3
// `@db/sqlite` already loaded (compiled with SQLITE_ENABLE_COLUMN_METADATA). The
// origin symbols live in that lib but `@db/sqlite` doesn't expose them, so we
// `Deno.dlopen` its file to declare them. We get its path the way `@db/sqlite`
// itself does — plug's `download({ cache: "use" })`, which on a cache hit just
// RETURNS the already-downloaded path (no network, no scanning) — with
// `DENO_SQLITE_PATH` as an optional override. Resolution is async, so call
// `ensureColumnOriginAvailable()` once before issuing labeled queries;
// `columnOrigins()` then reads the memoized handle synchronously.

import { download } from "@denosaurs/plug";

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
let pending: Promise<OriginLib | null> | undefined;

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

// The `@db/sqlite` prebuilt release. These options MUST match what `@db/sqlite`
// uses internally (and the version pinned in packages/memory/deno.jsonc) so
// plug's `download()` returns the SAME cached file `@db/sqlite` dlopen'd.
const SQLITE3_RELEASE = {
  name: "sqlite3",
  url: "https://github.com/denodrivers/sqlite3/releases/download/0.12.0/",
  suffixes: { aarch64: "_aarch64" },
  cache: "use",
} as const;

async function resolveLib(): Promise<OriginLib | null> {
  const tryOpen = (path: string): OriginLib | null => {
    try {
      return { origin: Deno.dlopen(path, SYMBOLS) };
    } catch {
      return null;
    }
  };
  const override = Deno.env.get("DENO_SQLITE_PATH");
  if (override) {
    const opened = tryOpen(override);
    if (opened) return opened;
  }
  try {
    return tryOpen(await download(SQLITE3_RELEASE));
  } catch {
    return null;
  }
}

/**
 * Resolve + dlopen the column-origin symbols against `@db/sqlite`'s own
 * libsqlite3 (memoized, single-flight). Async because the path comes from plug.
 * Callers that need provenance MUST await this before `columnOrigins()` and fail
 * loudly when it returns false.
 */
export async function ensureColumnOriginAvailable(): Promise<boolean> {
  if (cached === undefined) {
    pending ??= resolveLib();
    cached = await pending;
  }
  return cached !== null;
}

/** True if the column-origin lib is bound — meaningful only AFTER
 *  `ensureColumnOriginAvailable()` has resolved. */
export function columnOriginAvailable(): boolean {
  return !!cached;
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
 * Throws if the lib isn't bound — call `ensureColumnOriginAvailable()` first; a
 * labeled query fails loudly rather than silently mislabeling.
 */
export function columnOrigins(
  stmtHandle: Deno.PointerValue,
  count: number,
): ColumnOrigin[] {
  const l = cached ?? null;
  if (!l) {
    throw new Error(
      "sqlite: column-origin FFI not bound — ensureColumnOriginAvailable() must " +
        "resolve before a labeled query reads column provenance",
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
