// TEST-ONLY helper. Production `column-origin.ts` binds the column-metadata FFI
// solely via `DENO_SQLITE_PATH` (no scanning, no download, no compile-flag
// probing). Tests that exercise real column provenance need that env var to
// point at the SAME libsqlite3 `@db/sqlite` uses, so here — in test code only —
// we resolve it deterministically through plug's `download()` (the exact
// mechanism `@db/sqlite` uses internally; a cache hit just returns the path).
//
// The release options MUST track the `@db/sqlite` version in
// packages/memory/deno.json (`jsr:@db/sqlite@^0.12.0`).
import { download } from "jsr:@denosaurs/plug@1";

let ensured: boolean | undefined;

/** Set `DENO_SQLITE_PATH` to the cached `@db/sqlite` prebuilt if unset, so the
 *  column-origin FFI can bind. Returns whether a path is available. Memoized. */
export async function ensureSqliteLibPath(): Promise<boolean> {
  if (ensured !== undefined) return ensured;
  if (Deno.env.get("DENO_SQLITE_PATH")) return (ensured = true);
  try {
    const path = await download({
      name: "sqlite3",
      url: "https://github.com/denodrivers/sqlite3/releases/download/0.12.0/",
      suffixes: { aarch64: "_aarch64" },
      cache: "use",
    });
    Deno.env.set("DENO_SQLITE_PATH", path);
    return (ensured = true);
  } catch {
    return (ensured = false);
  }
}
