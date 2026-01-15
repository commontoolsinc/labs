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

  if (!(isRecord(a) && isRecord(b))) {
    return false;
  }

  // At this point, we're looking at a pair of non-null records (e.g. plain
  // objects, arrays, or instances).

  if (a.constructor !== b.constructor) return false;

  const keysA = Object.keys(a);
  const keysALength = keysA.length;
  const keysBLength = Object.keys(b).length;
  if (keysALength !== keysBLength) {
    return false;
  }

  // Common code for array and record-general equality checks.
  function checkProps(keysToCheck: string[]) {
    for (const key of keysToCheck) {
      if (!(Object.hasOwn(b, key) && deepEqual(a[key], b[key]))) {
        return false;
      }
    }

    return true;
  }

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (!(aIsArray || bIsArray)) {
    // General record (non-array object) comparison.
    return checkProps(keysA);
  }

  if (!(aIsArray && bIsArray)) {
    // One array and one non-array. Not equal!
    return false;
  }

  // Special-case handling for arrays, because the overwhelming majority of
  // cases is non-sparse arrays with no additional enumerable own properties.

  const lengthA = a.length;
  if (lengthA !== b.length) {
    return false;
  }

  let indexCount = 0; // Counts non-hole indexed properties.
  for (let i = 0; i < lengthA; i++) {
    const aHasIt = Object.hasOwn(a, i);
    const bHasIt = Object.hasOwn(b, i);
    if (aHasIt && bHasIt) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
      indexCount++;
    } else if (aHasIt || bHasIt) {
      return false;
    }
    // else both have a hole here, and so remain "equal" at this point.
  }

  if (indexCount === keysALength) {
    // All properties are accounted for as array indices. That is, there are
    // no named properties.
    return true;
  }

  // Ok, here's the "fun" part: We know how many indexed properties there are,
  // and ES (as of ES2015) guarantees that all the indexed properties are
  // listed first in the result from `Object.keys()`, so we slice those off
  // and just check the remainder.
  return checkProps(keysA.slice(indexCount));
}
