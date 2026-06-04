// SPIKE — sound read-label provenance via SQLite column-origin metadata.
//
// `@db/sqlite` returns rows keyed by the SELECT's OUTPUT column names, which is
// unsound for CFC labeling: `SELECT body AS x` hides a confidential column, and
// `SELECT subject AS from_email` spoofs another column's name. The bundled
// libsqlite3 is compiled with SQLITE_ENABLE_COLUMN_METADATA, so we can ask the
// engine for each result column's TRUE origin `(table, column)` via FFI on the
// prepared statement's `unsafeHandle`:
//   - alias  `from_email AS r`      -> origin (emails, from_email)   [resolved]
//   - spoof  `subject AS from_email`-> origin (emails, subject)      [defeated]
//   - expr   `upper(from_email)`    -> origin (null, null)           [fail closed]
//
// Production note: bind these symbols against the SAME libsqlite3 `@db/sqlite`
// loaded. The robust path is to set `DENO_SQLITE_PATH` to a vendored lib (which
// also guarantees the column-metadata compile flag) and dlopen that exact path.
// This spike falls back to discovering the plug-cached prebuilt.

let cached:
  | {
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
  }
  | null
  | undefined;

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

function denoDirCandidates(): string[] {
  const home = Deno.env.get("HOME") ?? "";
  return [
    Deno.env.get("DENO_DIR"),
    home && `${home}/Library/Caches/deno`, // macOS
    home && `${home}/.cache/deno`, // linux
  ].filter((p): p is string => !!p);
}

function* plugLibCandidates(): Generator<string> {
  for (const dir of denoDirCandidates()) {
    const plug = `${dir}/plug`;
    let entries: Array<{ name: string; path: string }>;
    try {
      entries = [...walkSyncFiles(plug)];
    } catch {
      continue;
    }
    for (const f of entries) {
      if (/\.(dylib|so|dll)$/.test(f.name)) yield f.path;
    }
  }
}

// Minimal recursive file walk (avoid a dep for the spike).
function* walkSyncFiles(
  root: string,
): Generator<{ name: string; path: string }> {
  for (const e of Deno.readDirSync(root)) {
    const path = `${root}/${e.name}`;
    if (e.isDirectory) yield* walkSyncFiles(path);
    else if (e.isFile) yield { name: e.name, path };
  }
}

/** Resolve and dlopen the column-origin symbols against libsqlite3. */
function lib() {
  if (cached !== undefined) return cached;
  const tryOpen = (path: string) => {
    try {
      return { origin: Deno.dlopen(path, SYMBOLS) };
    } catch {
      return null;
    }
  };
  const explicit = Deno.env.get("DENO_SQLITE_PATH");
  if (explicit) {
    cached = tryOpen(explicit);
    if (cached) return cached;
  }
  for (const path of plugLibCandidates()) {
    const opened = tryOpen(path);
    if (opened) {
      cached = opened;
      return cached;
    }
  }
  cached = null; // column-metadata FFI unavailable in this deployment
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
 * Returns all-null origins if column-metadata FFI is unavailable (so callers
 * can detect that and fail closed wholesale rather than mislabel).
 */
export function columnOrigins(
  stmtHandle: Deno.PointerValue,
  count: number,
): ColumnOrigin[] {
  const l = lib();
  const out: ColumnOrigin[] = [];
  for (let i = 0; i < count; i++) {
    if (!l) {
      out.push({ table: null, column: null });
      continue;
    }
    out.push({
      table: cstr(l.origin.symbols.sqlite3_column_table_name(stmtHandle, i)),
      column: cstr(l.origin.symbols.sqlite3_column_origin_name(stmtHandle, i)),
    });
  }
  return out;
}
