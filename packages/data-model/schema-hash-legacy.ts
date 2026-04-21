/**
 * Legacy schema hashing via deterministic JSON stringification.
 *
 * Used by `schema-hash.ts` as the legacy dispatch target; will be
 * replaced by canonical hashing (via `hashOfModern`) behind a flag.
 */

import type { JSONSchema } from "@commonfabric/api";
import { LRUCache } from "@commonfabric/utils/cache";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import { sha256 } from "@commonfabric/content-hash";
import { FabricHash } from "./fabric-hash.ts";
import type { FabricValue } from "./interface.ts";

/**
 * `TextEncoder` to use throughout this module.
 */
const textEncoder = new TextEncoder();

/**
 * Cache of already-computed hashes for objects.
 */
const hashCache = new WeakMap<object, FabricHash>();

/**
 * LRU cache for primitive value hashes. Primitives (strings, numbers,
 * bigints) can't be `WeakMap` keys, so they use a bounded cache.
 * The legacy `merkle-reference` uses a 50K-entry LRU with a reported 97%+
 * hit rate -- we match that sizing.
 */
const primitiveHashCache = new LRUCache<string | number, FabricHash>({
  capacity: 50_000,
});

/**
 * Computes the canonical hashable string of a value.
 */
function computeHashableString(value: unknown): string {
  switch (typeof value) {
    case "boolean": {
      return value ? "T" : "F";
    }

    case "string": {
      return `s${value.length}:${value}`;
    }

    case "number": {
      return `#${value}`;
    }

    case "undefined": {
      return "u";
    }

    case "object": {
      if (value === null) {
        return "n";
      } else if (Array.isArray(value)) {
        return "[" + value.map(computeHashableString).join(",") + "]";
      } else if (value instanceof Date) {
        return `D${value.getTime()}`;
      } else if (value instanceof RegExp) {
        return `R${value.toString()}`;
      } else {
        // Object keys are sorted for deterministic output so structurally-equal
        // objects always hash identically.
        const keys = Object.keys(value).sort();
        return "{" +
          keys.map((k) =>
            k + ":" +
            computeHashableString((value as Record<string, unknown>)[k])
          ).join(",") +
          "}";
      }
    }

    default: {
      throw new Error(`Cannot hash value of type ${typeof value}`);
    }
  }
}

/**
 * Computes the hash for a value based on a canonical string representation.
 */
function computeHash(value: unknown): FabricHash {
  const hashable = computeHashableString(value);
  const encoded = textEncoder.encode(hashable);
  const hashed = sha256(encoded);

  return new FabricHash(hashed, "legacy");
}

/** Pre-computed constant hashes (these values never change). */
const NULL_HASH = computeHash(null);
const UNDEFINED_HASH = computeHash(undefined);
const TRUE_HASH = computeHash(true);
const FALSE_HASH = computeHash(false);

/**
 * Computes the legacy content hash of a value, or finds a cached result for
 * same. Results are cached either via a `WeakMap` (for identity-bearing values)
 * or an LRU cache, so repeated hashing of the same value is O(1).
 */
function computeOrFindHash(value: unknown): FabricHash {
  switch (typeof value) {
    case "boolean":
      return value ? TRUE_HASH : FALSE_HASH;

    case "string":
    case "number": {
      const cached = primitiveHashCache.get(value);
      if (cached !== undefined) return cached;
      const result = computeHash(value);
      primitiveHashCache.put(value, result);
      return result;
    }

    case "undefined":
      return UNDEFINED_HASH;

    case "object": {
      if (value === null) return NULL_HASH;
      const cached = hashCache.get(value);
      if (cached !== undefined) return cached;
      const result = computeHash(value);
      hashCache.set(value, result);
      return result;
    }

    default: {
      throw new Error(`Cannot hash value of type ${typeof value}`);
    }
  }
}

/** Legacy hash of a JSONSchema, returned as a string. */
export function hashSchemaLegacyAsString(schema: JSONSchema): string {
  return computeOrFindHash(schema).hashString;
}

/** Legacy hash of a schema-related item, returned as a string. */
export function hashSchemaItemLegacyAsString(item: FabricValue): string {
  return computeOrFindHash(item).hashString;
}

/** Legacy hash of a schema-related item, returned as a FabricHash. */
export function hashSchemaItemLegacy(
  item: FabricValue,
): FabricHash {
  return computeOrFindHash(item);
}
