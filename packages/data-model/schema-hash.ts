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
 * memory layer.
 */
export function setSchemaHashConfig(enabled: boolean): void {
  modernSchemaHashEnabled = enabled;
}

/**
 * Restores modern schema hash mode to its default (disabled). Called by
 * `Runtime.dispose()` to avoid leaking flags between runtime instances or
 * test runs.
 */
export function resetSchemaHashConfig(): void {
  modernSchemaHashEnabled = false;
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
 * - `schemaToHash`: object schema → hash string (WeakMap so schemas can be
 *   GC'd when no longer referenced elsewhere).
 * - `hashToSchema`: hash string → WeakRef to interned schema (dead entries
 *   cleaned up by `schemaFinalizer` and on lookup).
 * - `schemaFinalizer`: FinalizationRegistry that removes stale `hashToSchema`
 *   entries when interned schemas are garbage-collected.
 * - `booleanInterns`: cached SchemaAndHash for `true` and `false` (boolean
 *   schemas are primitives and can't be WeakMap/WeakRef targets).
 */
const schemaToHash = new WeakMap<JSONSchemaObj, string>();
const hashToSchema = new Map<string, WeakRef<JSONSchemaObj>>();
const booleanInterns: { true?: SchemaAndHash; false?: SchemaAndHash } = {};

/** Removes dead `hashToSchema` entries when interned schemas are GC'd. */
const schemaFinalizer = new FinalizationRegistry<string>((hashStr) => {
  const ref = hashToSchema.get(hashStr);
  // Only delete if the entry still points to a dead ref — a new schema with
  // the same hash may have replaced it.
  if (ref && ref.deref() === undefined) {
    hashToSchema.delete(hashStr);
  }
});

/**
 * Intern a schema: freeze it, compute its hash, and cache the
 * bidirectional mapping. Returns the existing `SchemaAndHash` if the
 * schema (or a structurally-identical one with the same hash) has
 * already been interned.
 */
export function internSchema(schema: JSONSchema): SchemaAndHash {
  // Boolean schemas are primitives — handle separately.
  if (typeof schema === "boolean") {
    const key = schema ? "true" : "false";
    const existing = booleanInterns[key];
    if (existing) return existing;
    const frozen = toDeepFrozenSchema(schema);
    const sah = new SchemaAndHash(frozen, hashSchema(frozen));
    booleanInterns[key] = sah;
    return sah;
  }

  // Object schema — check the WeakMap first.
  const cachedHashStr = schemaToHash.get(schema);
  if (cachedHashStr !== undefined) {
    const ref = hashToSchema.get(cachedHashStr);
    if (ref) {
      const cached = ref.deref();
      if (cached !== undefined) {
        // Reconstruct SchemaAndHash from the cached mapping.
        return new SchemaAndHash(
          cached,
          hashSchema(cached),
        );
      }
      // WeakRef is dead — clean up.
      hashToSchema.delete(cachedHashStr);
    }
  }

  // Not interned yet — freeze, hash, and cache.
  const frozen = toDeepFrozenSchema(schema) as JSONSchemaObj;
  const hash = hashSchema(frozen);
  const hashStr = hash.toString();

  schemaToHash.set(frozen, hashStr);
  hashToSchema.set(hashStr, new WeakRef(frozen));
  schemaFinalizer.register(frozen, hashStr);

  return new SchemaAndHash(frozen, hash);
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

  // Check boolean interns first.
  for (const sah of [booleanInterns.true, booleanInterns.false]) {
    if (sah && sah.hashString === hashStr) return sah;
  }

  const ref = hashToSchema.get(hashStr);
  if (!ref) return undefined;

  const schema = ref.deref();
  if (schema === undefined) {
    // WeakRef is dead — clean up.
    hashToSchema.delete(hashStr);
    return undefined;
  }

  return new SchemaAndHash(schema, hashSchema(schema));
}
