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

/** The stored shape of an injected on-disk source's handle cell. */
export interface DiskHandleValue {
  id: string;
  tables?: Record<string, unknown>;
  scope?: string;
  owner?: string;
  rev?: number;
}

/**
 * A plain, inline copy of a stored contract, or `{}` when there is nothing
 * well-formed to keep.
 *
 * The caller reads `prior` off a live cell, so `tables` can be a proxy over
 * stored data. A handle's contract must be written INLINE — a query-side load
 * resolves no links inside it — so the value that goes back is a materialized
 * copy rather than the proxy itself.
 */
function inlineTables(tables: unknown): Record<string, unknown> {
  if (tables === null || typeof tables !== "object" || Array.isArray(tables)) {
    return {};
  }
  try {
    const copy = JSON.parse(JSON.stringify(tables)) as unknown;
    return copy !== null && typeof copy === "object" && !Array.isArray(copy)
      ? copy as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * The handle value a link action should write for the on-disk source at `id`,
 * or `undefined` to leave an already-committed handle exactly as it stands.
 *
 * A first link seeds an EMPTY contract: v1 does not migrate external files, so
 * the on-disk db owns its schema and the server skips `ensureTables` for a
 * registered source. A RE-link must not re-seed that empty contract over a
 * handle whose `tables` someone has since declared. `tables[].ifc` carries the
 * per-column read labels, and a store's effective label is monotone (§8.12.1) —
 * it may strengthen, never weaken. Overwriting a declared contract with `{}`
 * lowers every column's read label to nothing, and because a contract-less
 * query still returns its rows (`labelResultSchema` labels nothing rather than
 * refusing), the downgrade is silent: same rows, no label, no error.
 *
 * The handle's other fields are as fixed as its labels. `owner` resolves
 * `dbOwner()` row admission, `scope` partitions the db, and `rev` is what every
 * handle hasher reads to decide a query has new inputs — so a re-link that
 * dropped them would rotate row admission and re-issue every live query.
 * Preserving the whole prior value keeps all four properties together.
 */
export function diskHandleSeed(
  id: string,
  prior: DiskHandleValue | undefined,
): DiskHandleValue | undefined {
  // "Committed" is decided by the handle's own `id` BEING the one this
  // (space, path) derives — not by the doc being present, and not by the field
  // merely holding a string. A doc holding `null`, a partial value with no
  // `id`, an empty string, or an id that names a different source is not a
  // handle any query can use: `readDbRef` refuses a value whose `id` is not a
  // string, and an id that does resolve reaches another source's registry
  // entry. Treating any of them as committed leaves the link pointing at a
  // handle that can never resolve this file, and nothing re-seeds it.
  if (prior?.id === id) return undefined;

  // A repair rewrites the one field this function can derive and preserves the
  // rest, because dropping a field is the direction that loses something. The
  // contract is why: carrying a declared `tables` onto the repaired id can only
  // over-label, which monotonicity permits, while dropping it lowers every
  // column's read label to nothing — the same silent downgrade the re-link rule
  // above exists to prevent. `owner`, `scope` and `rev` travel for the reason
  // that paragraph gives. Only a well-formed contract is worth carrying: a
  // `tables` that is not an object declares no labels to preserve.
  const seed: DiskHandleValue = {
    id,
    tables: inlineTables(prior?.tables),
    rev: typeof prior?.rev === "number" ? prior.rev : 0,
  };
  if (typeof prior?.scope === "string") seed.scope = prior.scope;
  if (typeof prior?.owner === "string") seed.owner = prior.owner;
  return seed;
}
