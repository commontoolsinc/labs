/**
 * Schema hashing dispatch layer.
 *
 * Provides `hashSchema` and `hashSchemaItem` — deterministic string
 * hashes for schemas and general schema-related items. Dispatches between
 * legacy `stableStringify` (schema-hash-legacy.ts) and canonical hashing
 * (schema-hash-modern.ts) based on a runtime flag.
 *
 * Also provides `internSchema` and `findInternedSchema` for schema
 * interning with bidirectional cache and GC-safe storage. These are
 * separate from the hot-path hash functions to avoid FabricHash
 * allocation overhead on every hash call.
 *
 * Follows the same inline-flag-test dispatch pattern used by
 * `fabric-value.ts`.
 *
 * DO NOT MERGE! This comment makes this PR not the same as `main`. Just to
 * force a diff and a build.
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { FabricHash } from "./fabric-hash.ts";
import type { FabricValue } from "./interface.ts";
import { SchemaAndHash } from "./schema-and-hash.ts";
import {
  hashSchemaItemLegacy,
  hashSchemaItemLegacyAsString,
  hashSchemaLegacyAsString,
} from "./schema-hash-legacy.ts";
import {
  hashSchemaItemModern,
  hashSchemaItemModernAsString,
  hashSchemaModernAsString,
} from "./schema-hash-modern.ts";
import { toDeepFrozenSchema } from "./schema-utils.ts";

// ---------------------------------------------------------------------------
// Modern schema hash mode flag
// ---------------------------------------------------------------------------

let modernSchemaHashEnabled = false;

/**
 * Activates or deactivates modern schema hash mode. Called by the `Runtime`
 * constructor to propagate `ExperimentalOptions.modernSchemaHash` into the
 * memory layer. Wipes the intern cache since cached hashes are
 * flag-dependent.
 */
export function setSchemaHashConfig(enabled?: boolean): void {
  if (enabled !== undefined) {
    modernSchemaHashEnabled = enabled;
    resetInternCache();
  }
}

/** Returns whether modern schema hash mode is currently enabled. */
export function getSchemaHashConfig(): boolean {
  return modernSchemaHashEnabled;
}

/**
 * Restores modern schema hash mode to its default (disabled). Called by
 * `Runtime.dispose()` to avoid leaking flags between runtime instances or
 * test runs. Wipes the intern cache since cached hashes are
 * flag-dependent.
 */
export function resetSchemaHashConfig(): void {
  modernSchemaHashEnabled = false;
  resetInternCache();
}

// ---------------------------------------------------------------------------
// Flag-dispatched public API (hot path — returns string, no FabricHash alloc)
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash of a JSONSchema.
 * Structurally-equal schemas always produce the same hash.
 * Returns a string for use as a map key or cache key.
 */
export function hashSchema(schema: JSONSchema): string {
  return modernSchemaHashEnabled
    ? hashSchemaModernAsString(schema)
    : hashSchemaLegacyAsString(schema);
}

/**
 * Compute a deterministic hash of a schema-related item (e.g. a
 * path selector, a value descriptor, etc.). Structurally-equal items
 * always produce the same hash. Returns a string.
 */
export function hashSchemaItem(item: FabricValue): string {
  return modernSchemaHashEnabled
    ? hashSchemaItemModernAsString(item)
    : hashSchemaItemLegacyAsString(item);
}

// ---------------------------------------------------------------------------
// Internal: FabricHash-returning hash for intern cache use only
// ---------------------------------------------------------------------------

/** Hash a schema-related item as a FabricHash (for intern cache). */
function _hashSchemaItemAsFabricHash(item: FabricValue): FabricHash {
  return modernSchemaHashEnabled
    ? hashSchemaItemModern(item)
    : hashSchemaItemLegacy(item);
}

// ---------------------------------------------------------------------------
// Schema interning
// ---------------------------------------------------------------------------

/**
 * Bidirectional intern cache for schemas.
 *
 * All intern state is flag-dependent (legacy vs modern produce different
 * hashes) and is wiped whenever the flag changes via `resetInternCache()`.
 *
 * The cache is split into two maps to avoid strong retention:
 *
 * - `schemaToSah`: `WeakMap<JSONSchemaObj, SchemaAndHash>` — forward lookup.
 *   When the schema object is GC'd, the entry (and with it the
 *   `SchemaAndHash`) becomes unreachable.
 * - `hashToRef`: `Map<string, WeakRef<JSONSchemaObj>>` — reverse lookup
 *   (hash string → schema). Stores only a `WeakRef`, so the schema is not
 *   retained. Dead refs are cleaned up by `schemaFinalizer` and on lookup.
 *
 * To look up by hash: deref the `WeakRef` from `hashToRef`, then look up
 * the `SchemaAndHash` from `schemaToSah`. This ensures `SchemaAndHash` is
 * only reachable while the schema object itself is alive.
 *
 * - `booleanInterns`: prefab `SchemaAndHash` for `true` and `false` (boolean
 *   schemas are primitives and can't be WeakMap/WeakRef targets, so they
 *   are stored separately and seeded into `hashToRef` with a dummy strong-
 *   referenced sentinel object).
 */
let schemaToSah = new WeakMap<JSONSchemaObj, SchemaAndHash>();
const hashToRef = new Map<string, WeakRef<JSONSchemaObj>>();

// Dummy sentinel objects for boolean interns (kept alive by booleanSentinels).
let booleanSentinels = {
  true: Object.freeze({ cacheSentinel: true }) as JSONSchemaObj,
  false: Object.freeze({ cacheSentinel: false }) as JSONSchemaObj,
};
let booleanInterns = {
  true: new SchemaAndHash(true, _hashSchemaItemAsFabricHash(true)),
  false: new SchemaAndHash(false, _hashSchemaItemAsFabricHash(false)),
};
let schemaFinalizer = new FinalizationRegistry<string>((hashStr) => {
  const ref = hashToRef.get(hashStr);
  if (ref && ref.deref() === undefined) {
    hashToRef.delete(hashStr);
  }
});

/** Seeds the caches with the current boolean interns. */
function seedBooleanInterns(): void {
  // Use sentinel objects as WeakMap keys and WeakRef targets for booleans.
  schemaToSah.set(booleanSentinels.true, booleanInterns.true);
  schemaToSah.set(booleanSentinels.false, booleanInterns.false);
  hashToRef.set(
    booleanInterns.true.hashString,
    new WeakRef(booleanSentinels.true),
  );
  hashToRef.set(
    booleanInterns.false.hashString,
    new WeakRef(booleanSentinels.false),
  );
}

/**
 * Wipes all intern caches and re-seeds boolean interns with fresh hashes
 * for the current flag state. Called whenever `modernSchemaHashEnabled`
 * changes.
 */
function resetInternCache(): void {
  schemaToSah = new WeakMap();
  hashToRef.clear();
  schemaFinalizer = new FinalizationRegistry<string>((hashStr) => {
    const ref = hashToRef.get(hashStr);
    if (ref && ref.deref() === undefined) {
      hashToRef.delete(hashStr);
    }
  });
  booleanSentinels = {
    true: Object.freeze({ cacheSentinel: true }) as JSONSchemaObj,
    false: Object.freeze({ cacheSentinel: false }) as JSONSchemaObj,
  };
  booleanInterns = {
    true: new SchemaAndHash(true, _hashSchemaItemAsFabricHash(true)),
    false: new SchemaAndHash(false, _hashSchemaItemAsFabricHash(false)),
  };
  seedBooleanInterns();
}

// Initial seed.
seedBooleanInterns();

/**
 * Intern a schema: Freeze it, compute its hash, and cache the bidirectional
 * mapping. Returns the actual interned schema object or, optionally, the full
 * `SchemaAndHash`. The returned schema object is the same as (`===` to) the
 * given `schema` only if an identical schema was not already interned.
 *
 * If given a non-deep-frozen `schema`, this function will _always_ make it
 * deep-frozen as a side effect. Callers must be okay with this! This design is
 * motivated by the desire to minimize unnecessary cloning of objects, colored
 * by the observation that most mutable schemas are built by starting with an
 * effectively -- if not actually -- deep-immutable schema and selectively
 * shallow-cloned as mutable, for the express purpose of tactical modification
 * and then immediately treated once again as deep-immutable.
 */
export function internSchema(
  schema: JSONSchema,
  wantSchemaAndHash?: false,
): JSONSchema;
export function internSchema(
  schema: JSONSchema,
  wantSchemaAndHash: true,
): SchemaAndHash;
export function internSchema(
  schema: JSONSchema,
  wantSchemaAndHash?: boolean,
): JSONSchema | SchemaAndHash;
export function internSchema(
  schema: JSONSchema,
  wantSchemaAndHash: boolean = false,
): JSONSchema | SchemaAndHash {
  const sahResult = internSchemaReturningSchemaAndHash(schema);
  return wantSchemaAndHash ? sahResult : sahResult.schema;
}

/**
 * Helper for `internSchema()` which always returns a `SchemaAndHash`.
 */
function internSchemaReturningSchemaAndHash(schema: JSONSchema): SchemaAndHash {
  // Boolean schemas are primitives — return prefab instances.
  if (typeof schema === "boolean") {
    return schema ? booleanInterns.true : booleanInterns.false;
  }

  // Object schema — check the WeakMap first.
  const cached = schemaToSah.get(schema);
  if (cached) return cached;

  // `toDeepFrozenSchema()` returns the same reference if already deep-frozen.
  const frozen = toDeepFrozenSchema(schema, true) as JSONSchemaObj;

  // Check the hash-keyed reverse map (structurally-equal but different object).
  const hash = _hashSchemaItemAsFabricHash(frozen);
  const hashStr = hash.toString();

  const ref = hashToRef.get(hashStr);
  if (ref) {
    const existing = ref.deref();
    if (existing !== undefined) {
      const existingSah = schemaToSah.get(existing)!;

      // Cache the caller's schema so future calls with the same object
      // hit the WeakMap at the top instead of re-hashing every time.
      // We only do this when the input was already deep-frozen
      // (frozen === schema), because mutable objects could be changed
      // after caching, producing stale hits.
      const inputIsFrozen = frozen === schema;
      if (inputIsFrozen) {
        schemaToSah.set(frozen, existingSah);
      }

      return existingSah;
    }
    // WeakRef is dead — clean up.
    hashToRef.delete(hashStr);
  }

  // Not interned yet — create, cache, and return.
  const sah = new SchemaAndHash(frozen, hash);
  schemaToSah.set(frozen, sah);
  hashToRef.set(hashStr, new WeakRef(frozen));
  schemaFinalizer.register(frozen, hashStr);

  return sah;
}

/**
 * Look up a previously interned schema by its hash. Accepts a
 * `FabricHash` or a plain string. Returns `undefined` if the schema
 * has not been interned or has been garbage-collected. If found, returns either
 * the `schema` or full `SchemaAndHash` depending on the `wantSchemaAndHash`
 * argument.
 */
export function findInternedSchema(
  hash: FabricHash | string,
  wantSchemaAndHash?: false,
): JSONSchema | undefined;
export function findInternedSchema(
  hash: FabricHash | string,
  wantSchemaAndHash: true,
): SchemaAndHash | undefined;
export function findInternedSchema(
  hash: FabricHash | string,
  wantSchemaAndHash?: boolean,
): JSONSchema | SchemaAndHash | undefined;
export function findInternedSchema(
  hash: FabricHash | string,
  wantSchemaAndHash: boolean = false,
): JSONSchema | SchemaAndHash | undefined {
  const hashStr = typeof hash === "string" ? hash : hash.toString();

  const ref = hashToRef.get(hashStr);
  if (!ref) return undefined;

  const schema = ref.deref();
  if (schema === undefined) {
    // WeakRef is dead — clean up.
    hashToRef.delete(hashStr);
    return undefined;
  }

  // Note: Because of the special treatment of `boolean` schemas, we can't just
  // return `schema` here when `wantSchemaAndHash = false`.
  const resultSah = schemaToSah.get(schema);
  return wantSchemaAndHash ? resultSah : resultSah!.schema;
}

/**
 * Indicates whether or not the given `schema` is already interned. This returns
 * `false` even if there is already a schema in the intern cache that is
 * equivalent to the given one.
 */
export function isInternedSchema(schema: JSONSchema): boolean {
  if (typeof schema === "boolean") {
    return true;
  }

  return schemaToSah.has(schema);
}
