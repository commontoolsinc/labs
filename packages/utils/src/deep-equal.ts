import { isRecord } from "./types.ts";

/**
 * Performs a deep equality comparison between two values.
 *
 * - Handles primitives, arrays, and plain objects
 * - Uses `Object.is()` for primitive comparison (handles NaN and -0 correctly)
 * - Does not handle circular references (will cause stack overflow)
 * - Does not compare symbol-keyed properties
 *
 * @param a - First value to compare
 * @param b - Second value to compare
 * @returns True if the values are deeply equal
 */
export function deepEqual(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (isRecord(a) && isRecord(b)) {
    if (a.constructor !== b.constructor) return false;
    const keysA = Object.keys(a);
    if (keysA.length !== Object.keys(b).length) return false;
    for (const key of keysA) {
      if (!Object.hasOwn(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}
