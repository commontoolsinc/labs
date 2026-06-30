// Read-only, crash-consistent snapshots of space SQLite stores for offline
// autopsy (the `cf inspect --remote` workflow). This is the sanctioned way to
// extract a space's durable store over the wire:
//
//   * It never mutates the source DB — `VACUUM INTO` only reads the source and
//     writes a brand-new single-file copy.
//   * It never runs the engine's migration path (which DDLs the store on open);
//     we open `@db/sqlite` directly, the same read-only discipline the
//     state-inspector uses.
//   * It produces ONE consistent file even though the live server keeps the
//     store in WAL mode — `VACUUM INTO` checkpoints into the copy, so the result
//     has no `-wal`/`-shm` companions to ship.
//
// `store` here is the SAME value the toolshed hands `MemoryServer` (its
// `#store`). The server resolves each space's file via `resolveSpaceStoreUrl`,
// so we MUST resolve through the same helper rather than assuming files sit
// directly under `store` — directory mode nests them one more `engine-v3/` deep.

import { Database } from "@db/sqlite";
import * as Path from "@std/path";
import {
  resolveSpaceStoreDirUrl,
  resolveSpaceStoreUrl,
} from "./storage-path.ts";
import type { MemorySpace } from "../interface.ts";

const SQLITE_SUFFIX = ".sqlite";

export interface SpaceStoreInfo {
  /** Canonical space DID (decoded from the on-disk filename). */
  space: string;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * List the space stores for a memory `store` (the value passed to
 * `MemoryServer`). Resolves the actual per-space directory via the shared
 * `resolveSpaceStoreDirUrl`, so it matches the server's on-disk layout exactly.
 * Newest-first by mtime.
 */
export function listSpaceStores(store: URL): SpaceStoreInfo[] {
  const dir = Path.fromFileUrl(resolveSpaceStoreDirUrl(store));
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return []; // missing/unreadable dir → no spaces
  }
  const out: SpaceStoreInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(SQLITE_SUFFIX)) continue;
    const encoded = entry.name.slice(0, -SQLITE_SUFFIX.length);
    let space: string;
    try {
      space = decodeURIComponent(encoded);
    } catch {
      continue; // not a store filename we wrote
    }
    let stat: Deno.FileInfo;
    try {
      stat = Deno.statSync(Path.join(dir, entry.name));
    } catch {
      continue;
    }
    out.push({
      space,
      sizeBytes: stat.size,
      mtimeMs: stat.mtime?.getTime() ?? 0,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Resolve the on-disk sqlite path for a space within `store`, or null if it does
 * not exist. Uses the same `resolveSpaceStoreUrl` the server uses (so the path
 * always matches), and that helper's `encodeStoreSubject` rejects path-traversal
 * in the space id (`/`, `\`, `..`, NUL) — an attacker-supplied id can't escape.
 */
export function spaceStorePath(
  store: URL,
  space: string,
): string | null {
  let path: string;
  try {
    path = Path.fromFileUrl(resolveSpaceStoreUrl(store, space as MemorySpace));
  } catch {
    return null; // invalid space id
  }
  try {
    return Deno.statSync(path).isFile ? path : null;
  } catch {
    return null;
  }
}

/**
 * Write a crash-consistent single-file copy of the space store at `sourcePath`
 * to `destPath` via `VACUUM INTO`. Does not mutate the source and runs no
 * migrations. Safe while the server holds the source open in WAL mode.
 */
export function snapshotSpaceStore(sourcePath: string, destPath: string): void {
  // `VACUUM INTO` is documented to work against a read-only source connection
  // (it is the recommended hot-backup-to-file mechanism). Opening read-only
  // guarantees we cannot mutate the live store even by accident.
  const db = new Database(sourcePath, { readonly: true });
  try {
    const stmt = db.prepare("VACUUM main INTO ?");
    try {
      stmt.run(destPath);
    } finally {
      stmt.finalize();
    }
  } finally {
    db.close();
  }
}
