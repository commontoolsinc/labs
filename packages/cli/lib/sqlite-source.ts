// Phase 7 — `cf piece link <piece>/<field> sqlite:<absPath>` source parsing +
// deterministic handle-id derivation (read-only on-disk SQLite source, v1).
//
// These are pure helpers (no I/O) so they unit-test in isolation. The link
// action (lib/piece.ts `linkSqliteDiskSource`) uses them to: derive a stable
// handle id from (space, absPath), create the handle cell at that id, register
// the on-disk source with the server, and link it into the target field.

import { createRef } from "@commonfabric/runner";

const SQLITE_SCHEME = "sqlite:";

export interface SqliteDiskSource {
  /** Absolute path to the on-disk SQLite file. */
  path: string;
}

/**
 * Recognize a `sqlite:<absPath>` link source. Returns `null` for any non-`sqlite:`
 * ref (so the caller falls back to the normal piece/path parse), and throws on a
 * malformed `sqlite:` ref (empty or non-absolute path) — those are operator
 * mistakes, not "not a sqlite source".
 */
export function parseSqliteSource(ref: string): SqliteDiskSource | null {
  if (!ref.startsWith(SQLITE_SCHEME)) return null;
  const path = ref.slice(SQLITE_SCHEME.length);
  if (path.length === 0) {
    throw new Error(
      `sqlite: source is missing a path (expected sqlite:/abs/path.db)`,
    );
  }
  if (!path.startsWith("/")) {
    throw new Error(
      `sqlite: source path must be absolute, got "${path}" (expected sqlite:/abs/path.db)`,
    );
  }
  return { path };
}

/**
 * Derive a stable handle id from `(space, absPath)`. Linking the same path in the
 * same space twice resolves to the same handle cell (idempotent). The returned
 * string is used BOTH as the handle cell's entity id (where cf creates it) and as
 * the db handle `value.id` (what `db.query`/`db.exec` send, and the key the server
 * disk-source registry is keyed by) — keeping them identical means a pattern read
 * of the linked handle resolves to the same id the server has a descriptor for.
 */
export function deriveDiskHandleId(space: string, absPath: string): string {
  const ref = createRef({ disk: { path: absPath } }, {
    space,
    scheme: "sqlite",
  });
  // The canonical id string is the tagged-hash form, matching
  // `entityRefToString(handle.entityId)` — the form the runtime uses for a db
  // handle's `value.id`.
  return ref.taggedHashString;
}
