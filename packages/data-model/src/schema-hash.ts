/**
 * Schema hashing. This provides schema-specific hashing functions, including
 * an interning (uniquing) system specifc to schemas.
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";

import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { SchemaAndHash } from "./SchemaAndHash.ts";
import { toDeepFrozenSchema } from "./schema-utils.ts";
import { hashOf, hashStringOf } from "./value-hash.ts";

//
// Hash computation
//
// Passes through to `value-hash.ts`.
//

/**
 * Computes a deterministic hash of a JSONSchema. Structurally-equal schemas
 * always produce the same hash. Returns a string for use as a map key or cache
 * key. This accepts `undefined` as a convenience for contexts where that value
 * is useful to mean "no relevant schema," or "missing schema," and so on.
 *
 * This function is a pass-through to `hashStringOf()`, just with a narrower
 * argument type.
 */
export function hashSchema(schema: JSONSchema | undefined): string {
  return hashStringOf(schema);
}

//
// Schema interning
//

/**
 * Bidirectional intern cache for schemas.
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
 *   schemas are primitives and can't be `WeakMap`/`WeakRef` targets).
 */
const schemaToSah = new WeakMap<JSONSchemaObj, SchemaAndHash>();
const hashToRef = new Map<string, WeakRef<JSONSchemaObj> | boolean>();

const booleanInterns = {
  true: new SchemaAndHash(true, hashOf(true)),
  false: new SchemaAndHash(false, hashOf(false)),
};

const schemaFinalizer = new FinalizationRegistry<string>((hashStr) => {
  const ref = hashToRef.get(hashStr);
  if ((typeof ref === "object") && (ref.deref() === undefined)) {
    hashToRef.delete(hashStr);
  }
});

// Seeds `hashToRef` with intern records for `boolean` schemas.
hashToRef.set(booleanInterns.true.taggedHashString, true);
hashToRef.set(booleanInterns.false.taggedHashString, false);

/**
 * Helper for `internSchema()`, which always returns a `SchemaAndHash`.
 */
function internSchemaReturningSchemaAndHash(schema: JSONSchema): SchemaAndHash {
  // Boolean schemas are primitives — return prefab instances.
  if (typeof schema === "boolean") {
    return schema ? booleanInterns.true : booleanInterns.false;
  }

  // At this point `schema` is a `JSONSchemaObj`.

  const cached = schemaToSah.get(schema);
  if (cached) return cached;

  // `toDeepFrozenSchema()` returns the same reference if already deep-frozen or
  // if no sub-properties needed to be cloned to achieve frozenness.
  const frozen = toDeepFrozenSchema(schema, true) as JSONSchemaObj;

  // Check the hash-keyed reverse map (structurally-equal but different object).
  const hash = hashOf(frozen);
  const hashStr = hash.toString();

  const maybeRef = hashToRef.get(hashStr);

  if (typeof maybeRef === "object") {
    const existing = maybeRef.deref();
    if (existing !== undefined) {
      const existingSah = schemaToSah.get(existing)!;

      // If possible, cache the result for the caller's schema, so future calls
      // with the same object hit the `WeakMap` at the top instead of re-hashing
      // every time. We only do this when the input was already deep-frozen or
      // was itself deep-frozen via the assignment to `frozen` above, because
      // mutable objects could be changed after caching, producing stale hits.
      const inputIsFrozen = frozen === schema;
      if (inputIsFrozen) {
        schemaToSah.set(frozen, existingSah);
      }

      return existingSah;
    }

    // The `WeakRef`'s referent got collected. Clean up.
    hashToRef.delete(hashStr);

    // ...and fall through to add `frozen` to the cache.
  } else if (typeof maybeRef === "boolean") {
    // Shouldn't happen! This implies a hash collision between a `boolean`
    // schema and an `object` schema.
    throw new Error(
      "Shouldn't happen: Schema hash collision, object vs. boolean.",
    );
  }

  // Not interned yet (or interned but later collected).

  const sah = new SchemaAndHash(frozen, hash);
  schemaToSah.set(frozen, sah);
  hashToRef.set(hashStr, new WeakRef(frozen));
  schemaFinalizer.register(frozen, hashStr);

  return sah;
}

/**
 * Interns a schema: freezes it, computes its hash, and caches the bidirectional
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
export function internSchema<T extends JSONSchema>(
  schema: T,
  wantSchemaAndHash?: false,
): T;
export function internSchema<T extends JSONSchema>(
  schema: T,
  wantSchemaAndHash: true,
): SchemaAndHash;
export function internSchema<T extends JSONSchema>(
  schema: T,
  wantSchemaAndHash?: boolean,
): JSONSchema | SchemaAndHash;
export function internSchema<T extends JSONSchema>(
  schema: T,
  wantSchemaAndHash: boolean = false,
): JSONSchema | SchemaAndHash {
  const sahResult = internSchemaReturningSchemaAndHash(schema);
  return wantSchemaAndHash ? sahResult : sahResult.schema;
}

/**
 * Looks up a previously interned schema by its hash. Accepts a
 * `FabricHash` or a plain string. Returns `undefined` if the schema
 * has not been interned or has been garbage-collected. If found, returns the
 * corresponding full `SchemaAndHash`.
 */
export function findInternedSchema(
  hash: FabricHash | string,
): SchemaAndHash | undefined {
  const hashStr = typeof hash === "string" ? hash : hash.toString();

  const refOrBoolean = hashToRef.get(hashStr);

  switch (typeof refOrBoolean) {
    case "boolean": {
      return refOrBoolean ? booleanInterns.true : booleanInterns.false;
    }

    case "undefined": {
      return undefined;
    }

    case "object": {
      if (refOrBoolean === null) {
        // Shouldn't happen!
        throw new Error("Unexpected `null` reference in schema intern table.");
      }

      const schema = refOrBoolean.deref();

      if (schema === undefined) {
        // The `WeakRef`'s referent got collected. Clean up.
        hashToRef.delete(hashStr);
        return undefined;
      }

      // The `!` below is valid because we know that `schemaToSah` definitely
      // has a mapping for `schema`. Otherwise, we wouldn't have found a
      // `refOrBoolean` to look up.
      return schemaToSah.get(schema)!;
    }

    default: {
      // Shouldn't happen!
      throw new Error(
        `Unexpected type in schema intern table: ${typeof refOrBoolean}`,
      );
    }
  }
}

/**
 * Indicates whether or not the given `schema` is already interned. This returns
 * `false` even if there is already a schema in the intern cache that is
 * equivalent to the given one, unless `schema` is in fact the one that is in
 * the cache.
 */
export function isInternedSchema(schema: JSONSchema): boolean {
  if (typeof schema === "boolean") {
    return true;
  }

  return schemaToSah.has(schema);
}

/**
 * Interns (and thus deep-freezes) the given schema, returning its hash
 * string. Equivalent to `internSchema(schema, true).taggedHashString`, but
 * names the operation and avoids the non-obvious `true` (`wantSchemaAndHash`)
 * argument at call sites.
 */
export function internSchemaAsTaggedHashString(schema: JSONSchema): string {
  return internSchema(schema, true).taggedHashString;
}
