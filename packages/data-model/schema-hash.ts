/**
 * Schema hashing dispatch layer.
 *
 * Provides `hashSchema` and `hashSchemaItem` — deterministic `FabricHash`
 * values for schemas and general schema-related items. Dispatches between
 * legacy `stableStringify` (schema-hash-legacy.ts) and canonical hashing
 * (schema-hash-modern.ts) based on a runtime flag.
 *
 * Follows the same inline-flag-test dispatch pattern used by
 * `fabric-value.ts`.
 */

import type { JSONSchema, JSONSchemaObj } from "@commontools/api";
import { FabricHash } from "./fabric-hash.ts";
import type { FabricValue } from "./interface.ts";
import { SchemaAndHash } from "./schema-and-hash.ts";
import {
  hashSchemaItemLegacy,
  hashSchemaLegacy,
} from "./schema-hash-legacy.ts";
import {
  hashSchemaItemModern,
  hashSchemaModern,
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
export function setSchemaHashConfig(enabled: boolean): void {
  modernSchemaHashEnabled = enabled;
  resetInternCache();
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
// Flag-dispatched public API
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash of a JSONSchema.
 * Structurally-equal schemas always produce the same hash.
 */
export function hashSchema(schema: JSONSchema): FabricHash {
  return modernSchemaHashEnabled
    ? hashSchemaModern(schema)
    : hashSchemaLegacy(schema);
}

/**
 * Compute a deterministic hash of a schema-related item (e.g. a
 * path selector, a value descriptor, etc.). Structurally-equal items
 * always produce the same hash.
 */
export function hashSchemaItem(item: FabricValue): FabricHash {
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
 * - `schemaToSah`: object schema → SchemaAndHash (WeakMap so schemas can be
 *   GC'd when no longer referenced elsewhere).
 * - `hashToSah`: hash string → { sah, ref } where `ref` is a WeakRef to the
 *   frozen schema (dead entries cleaned up by `schemaFinalizer` and on lookup).
 *   Entries with no `ref` are permanent (boolean interns).
 * - `schemaFinalizer`: FinalizationRegistry that removes stale `hashToSah`
 *   entries when interned schemas are garbage-collected.
 * - `booleanInterns`: prefab SchemaAndHash for `true` and `false` (boolean
 *   schemas are primitives — seeded into `hashToSah` as permanent entries).
 */
let schemaToSah = new WeakMap<JSONSchemaObj, SchemaAndHash>();
const hashToSah = new Map<
  string,
  { sah: SchemaAndHash; ref?: WeakRef<JSONSchemaObj> }
>();
let booleanInterns = {
  true: new SchemaAndHash(true, hashSchema(true)),
  false: new SchemaAndHash(false, hashSchema(false)),
};
let schemaFinalizer = new FinalizationRegistry<string>((hashStr) => {
  const entry = hashToSah.get(hashStr);
  if (entry && entry.ref && entry.ref.deref() === undefined) {
    hashToSah.delete(hashStr);
  }
});

/** Seeds `hashToSah` with the current boolean interns. */
function seedBooleanInterns(): void {
  hashToSah.set(booleanInterns.true.hashString, { sah: booleanInterns.true });
  hashToSah.set(booleanInterns.false.hashString, { sah: booleanInterns.false });
}

/**
 * Wipes all intern caches and re-seeds boolean interns with fresh hashes
 * for the current flag state. Called whenever `modernSchemaHashEnabled`
 * changes.
 */
function resetInternCache(): void {
  schemaToSah = new WeakMap();
  hashToSah.clear();
  schemaFinalizer = new FinalizationRegistry<string>((hashStr) => {
    const entry = hashToSah.get(hashStr);
    if (entry && entry.ref && entry.ref.deref() === undefined) {
      hashToSah.delete(hashStr);
    }
  });
  booleanInterns = {
    true: new SchemaAndHash(true, hashSchema(true)),
    false: new SchemaAndHash(false, hashSchema(false)),
  };
  seedBooleanInterns();
}

// Initial seed.
seedBooleanInterns();

/**
 * Intern a schema: freeze it, compute its hash, and cache the
 * bidirectional mapping. Returns the existing `SchemaAndHash` if the
 * schema (or a structurally-identical one with the same hash) has
 * already been interned.
 *
 * **Caching behaviour:** the cache key is the deep-frozen schema
 * object, not the caller's input. `toDeepFrozenSchema()` returns the
 * same reference if the input is already deep-frozen, so such schemas
 * hit the cache on repeated calls. For mutable inputs, a new frozen
 * copy is created each time — the identity-keyed WeakMap will miss,
 * but the hash-keyed reverse map will still find a structural match.
 */
export function internSchema(schema: JSONSchema): SchemaAndHash {
  // Boolean schemas are primitives — return prefab instances.
  if (typeof schema === "boolean") {
    return schema ? booleanInterns.true : booleanInterns.false;
  }

  // Object schema — check the WeakMap first.
  const cached = schemaToSah.get(schema);
  if (cached) return cached;

  // toDeepFrozenSchema returns the same reference if already deep-frozen.
  const frozen = toDeepFrozenSchema(schema) as JSONSchemaObj;

  // Check the hash-keyed reverse map (structurally-equal but different object).
  const hash = hashSchema(frozen);
  const hashStr = hash.toString();

  const entry = hashToSah.get(hashStr);
  if (entry) {
    // Permanent entries (booleans) have no ref; WeakRef entries need a liveness check.
    if (!entry.ref || entry.ref.deref() !== undefined) {
      // Still alive — reuse the cached SchemaAndHash.
      schemaToSah.set(schema, entry.sah);
      return entry.sah;
    }
    // WeakRef is dead — clean up.
    hashToSah.delete(hashStr);
  }

  // Not interned yet — create, cache, and return.
  const sah = new SchemaAndHash(frozen, hash);
  schemaToSah.set(frozen, sah);
  schemaToSah.set(schema, sah);
  hashToSah.set(hashStr, { sah, ref: new WeakRef(frozen) });
  schemaFinalizer.register(frozen, hashStr);

  return sah;
}

/**
 * Look up a previously interned schema by its hash. Accepts a
 * `FabricHash` or a plain string. Returns `undefined` if the schema
 * has not been interned or has been garbage-collected.
 */
export function findInternedSchema(
  hash: FabricHash | string,
): SchemaAndHash | undefined {
  const hashStr = typeof hash === "string" ? hash : hash.toString();

  const entry = hashToSah.get(hashStr);
  if (!entry) return undefined;

  // Permanent entries (booleans) have no ref.
  if (!entry.ref) return entry.sah;

  if (entry.ref.deref() === undefined) {
    // WeakRef is dead — clean up.
    hashToSah.delete(hashStr);
    return undefined;
  }

  return entry.sah;
}
