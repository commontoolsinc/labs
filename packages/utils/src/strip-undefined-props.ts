/**
 * Returns a copy of `value` with `undefined`-valued properties removed,
 * recursively through plain-object values. Non-plain-object values
 * (primitives, arrays, class instances) are returned as-is; only own
 * enumerable string-keyed properties of plain objects are walked.
 *
 * Intended use is to canonicalize an object shape for stable comparison
 * (e.g. content-hashing), where a property that's present-but-`undefined`
 * should be treated the same as an omitted property. This matches the
 * JSON-style normalization that the legacy fabric-value layer applied
 * implicitly; under the modern layer, `undefined`-valued properties are
 * preserved, so callers that need this normalization must apply it
 * directly.
 */
export function stripUndefinedProps(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined) continue;
    out[key] = isPlainObject(val)
      ? stripUndefinedProps(val as Record<string, unknown>)
      : val;
  }
  return out;
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
