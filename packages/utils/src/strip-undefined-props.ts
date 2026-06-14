import { isPlainObject } from "./types.ts";

/**
 * Returns a copy of `value` with `undefined`-valued properties removed,
 * recursively through plain-object values. Non-plain-object values
 * (primitives, arrays, class instances) are returned as-is; only own
 * enumerable string-keyed properties of plain objects are walked.
 *
 * Intended use is to canonicalize an object shape for stable comparison
 * (e.g. content-hashing), where a property that's present-but-`undefined`
 * should be treated the same as an omitted property. The fabric-value layer
 * preserves `undefined`-valued properties, so callers that need this
 * normalization must apply it directly.
 */
export function stripUndefinedProps(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined) continue;
    // Use `defineProperty` rather than `out[key] = ...` so that a special
    // key like `"__proto__"` is written as a plain own data property
    // rather than triggering the prototype setter on `out` (which would
    // pollute the prototype chain of the returned object).
    Object.defineProperty(out, key, {
      value: isPlainObject(val)
        ? stripUndefinedProps(val as Record<string, unknown>)
        : val,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}
