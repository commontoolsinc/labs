/**
 * The libsqlite3 symbols `@db/sqlite` loads but does not bind, bound from the
 * same library image it uses.
 *
 * Two features need them. CFC read labeling asks the engine for each result
 * column's TRUE origin (`sqlite3_column_table_name`,
 * `sqlite3_column_origin_name`; see `column-origin.ts`), and a read running on
 * another thread is cancelled with `sqlite3_interrupt`, the one SQLite call
 * documented as safe to make on a connection another thread is using (see
 * `read-worker-pool.ts`).
 *
 * The file opened is the one `@db/sqlite` picks, in its order:
 * `DENO_SQLITE_LOCAL`, then `DENO_SQLITE_PATH`, then plug's
 * `download({ cache: "use" })`, which on a cache hit just returns the
 * already-downloaded path (no network, no scanning). Exactly one of those is
 * opened. Opening a file other than the one `@db/sqlite` opened would give the
 * process a second libsqlite3 image, so a source that can't be opened reports
 * why and leaves these symbols unavailable. Resolution is async, so call
 * `ensureNativeSymbols()` once before reading `nativeSymbols()`.
 */

import { download } from "@denosaurs/plug";

const SYMBOLS = {
  sqlite3_column_origin_name: {
    parameters: ["pointer", "i32"],
    result: "pointer",
  },
  sqlite3_column_table_name: {
    parameters: ["pointer", "i32"],
    result: "pointer",
  },
  sqlite3_interrupt: {
    parameters: ["pointer"],
    result: "void",
  },
} as const;

/** The bound symbols, as `Deno.dlopen` returns them. */
export type NativeSymbols = Deno.DynamicLibrary<typeof SYMBOLS>["symbols"];

let cached: NativeSymbols | null | undefined;
let problem: string | undefined;
let pending: Promise<Resolution> | undefined;

/**
 * The `@db/sqlite` prebuilt release. `@db/sqlite` builds its own download URL
 * from its package version, so this must be the version the lockfile resolves
 * `@db/sqlite` to.
 *
 * Plug's cache is keyed by URL: a different version here names a different
 * file, and dlopen'ing that gives the process a second libsqlite3 image instead
 * of the one `@db/sqlite` loaded. Each image carries its own copy of SQLite's
 * global state, and `@db/sqlite` calls `sqlite3_initialize()` only on the image
 * it loaded, so a statement handle passed into the second image segfaults.
 * Calling `sqlite3_initialize()` on the second image stops the crash and is not
 * the repair: two initialized images still hold separate allocators and
 * mutexes, and would then share handles. The requirement is one image, so both
 * bindings must name one file. `deno test` in this package checks this version
 * against the lockfile.
 */
export const SQLITE3_RELEASE_VERSION = "0.13.0";

const SQLITE3_RELEASE = {
  name: "sqlite3",
  url:
    `https://github.com/denodrivers/sqlite3/releases/download/${SQLITE3_RELEASE_VERSION}/`,
  suffixes: { aarch64: "_aarch64" },
  cache: "use",
} as const;

/**
 * The libsqlite3 `@db/sqlite` loads. `local` is the build in its own checkout,
 * `path` is `$DENO_SQLITE_PATH`, `release` is the pinned prebuilt.
 */
export type LibrarySource =
  | { kind: "local" }
  | { kind: "path"; path: string }
  | { kind: "release" };

/**
 * `@db/sqlite` reads these vars behind a try/catch so a denied `--allow-env`
 * falls through to its default rather than throwing; this does the same. Only
 * a denied read is swallowed — `NotCapable` on current Deno,
 * `PermissionDenied` on older ones — and reported as the var being unset; any
 * other failure is unexpected and propagates.
 */
function readEnv(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch (e) {
    if (
      e instanceof Deno.errors.NotCapable ||
      e instanceof Deno.errors.PermissionDenied
    ) {
      return undefined;
    }
    throw e;
  }
}

/**
 * Which libsqlite3 `@db/sqlite` will load, in the branch order its own
 * `ffi.ts` uses: `DENO_SQLITE_LOCAL` outranks `DENO_SQLITE_PATH`, and with
 * neither set it takes the release its package version names.
 */
export function librarySource(
  getEnv: (key: string) => string | undefined = readEnv,
): LibrarySource {
  if (getEnv("DENO_SQLITE_LOCAL") === "1") return { kind: "local" };
  const path = getEnv("DENO_SQLITE_PATH");
  return path ? { kind: "path", path } : { kind: "release" };
}

type Resolution = { symbols: NativeSymbols } | { problem: string };

const describe = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Opens one source, or reports why it could not be opened. Only the source
 * `@db/sqlite` itself uses is ever opened: any other file would give the
 * process a second libsqlite3 image, so there is nothing to fall back to.
 */
export async function openSource(source: LibrarySource): Promise<Resolution> {
  if (source.kind === "local") {
    return {
      problem:
        "DENO_SQLITE_LOCAL=1 points @db/sqlite at the libsqlite3 built in its " +
        "own checkout, and that path is not derived here",
    };
  }
  let path: string;
  let label: string;
  if (source.kind === "path") {
    path = source.path;
    label = "$DENO_SQLITE_PATH";
  } else {
    label = `the pinned libsqlite3 release ${SQLITE3_RELEASE_VERSION}`;
    try {
      path = await download(SQLITE3_RELEASE);
    } catch (e) {
      return { problem: `${label} could not be resolved (${describe(e)})` };
    }
  }
  try {
    return { symbols: Deno.dlopen(path, SYMBOLS).symbols };
  } catch (e) {
    return {
      problem: `${label} names ${path}, whose column-origin and interrupt ` +
        `symbols could not be bound (${describe(e)}). A libsqlite3 built ` +
        `without SQLITE_ENABLE_COLUMN_METADATA does not export the ` +
        `column-origin ones.`,
    };
  }
}

/**
 * Resolves and dlopens the symbols against `@db/sqlite`'s own libsqlite3
 * (memoized per thread, single-flight), and returns whether they are bound.
 * Async because the path comes from plug. Callers MUST await this before
 * `nativeSymbols()`.
 */
export async function ensureNativeSymbols(): Promise<boolean> {
  if (cached === undefined) {
    pending ??= openSource(librarySource());
    const resolution = await pending;
    if ("symbols" in resolution) {
      cached = resolution.symbols;
    } else {
      cached = null;
      problem = resolution.problem;
    }
  }
  return cached !== null;
}

/**
 * The bound symbols, or `undefined` while they are unresolved or could not be
 * bound. Meaningful only after `ensureNativeSymbols()` has resolved.
 */
export function nativeSymbols(): NativeSymbols | undefined {
  return cached ?? undefined;
}

/**
 * Why the symbols could not be bound, once `ensureNativeSymbols()` has resolved
 * false. Undefined while they are bound or unresolved.
 */
export function nativeSymbolsUnavailableReason(): string | undefined {
  return cached === null ? problem : undefined;
}
