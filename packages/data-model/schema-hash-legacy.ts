/**
 * Legacy schema hashing via deterministic JSON stringification.
 *
 * This is the original `stableStringify` implementation extracted from
 * `packages/runner/src/traverse.ts`. It produces a canonical string
 * representation of a value with sorted object keys and per-identity
 * WeakMap caching.
 *
 * Used by `schema-hash.ts` as the legacy dispatch target; will be
 * replaced by canonical hashing (via `modernHash`) behind a flag.
 */

import type { JSONSchema, SchemaPathSelector } from "@commontools/api";

const _hashCache = new WeakMap<object, string>();

/**
 * Produces a canonical string representation for use as a hash key.
 * Object keys are sorted for deterministic output so structurally-equal
 * objects always hash identically. Results are cached per object identity
 * via WeakMap, so repeated hashing of the same schema object is O(1).
 */
function stableStringify(value: unknown): string {
  if (value === null) return "n";
  if (value === undefined) return "u";
  const t = typeof value;
  if (t === "boolean") return value ? "T" : "F";
  if (t === "number") return `#${value}`;
  if (t === "string") return `s${(value as string).length}:${value}`;

  const obj = value as object;
  const cached = _hashCache.get(obj);
  if (cached !== undefined) return cached;

  let result: string;
  if (Array.isArray(obj)) {
    result = "[" + obj.map(stableStringify).join(",") + "]";
  } else if (obj instanceof Date) {
    result = `D${(obj as Date).getTime()}`;
  } else if (obj instanceof RegExp) {
    result = `R${(obj as RegExp).toString()}`;
  } else {
    const keys = Object.keys(obj).sort();
    result = "{" +
      keys.map((k) =>
        k + ":" + stableStringify((obj as Record<string, unknown>)[k])
      ).join(",") +
      "}";
  }

  _hashCache.set(obj, result);
  return result;
}

/** Legacy hash of a JSONSchema. */
export function hashSchemaLegacy(schema: JSONSchema): string {
  return stableStringify(schema);
}

/** Legacy hash of a SchemaPathSelector. */
export function hashSchemaPathSelectorLegacy(
  selector: SchemaPathSelector,
): string {
  return stableStringify(selector);
}
