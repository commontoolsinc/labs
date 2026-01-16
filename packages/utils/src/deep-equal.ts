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

  // Note: Even if they have the same `constructor`, it's technically possible
  // for `a` and `b` to have different prototypes, in which case it's possible
  // for this function to decide, ultimately, that they are "equal" in some
  // cases where, in some sort of plane of pure existence, we'd want to say they
  // aren't. However, practically speaking, all such cases are going to be from
  // some code intentionally doing something that's probably a bad idea for
  // other reasons, and we'll probably never actually encounter this in the real
  // world. And, very notably, in the case of stuff ending up here from
  // comparisons done regarding stored data, that's all normalized anyway, so
  // we'll only be getting plain objects, normal arrays, and trusted instances
  // made by the storage system.
  if (a.constructor !== b.constructor) return false;

  const keysA = Object.keys(a);
  const keysALength = keysA.length;
  const keysBLength = Object.keys(b).length;
  if (keysALength !== keysBLength) {
    return false;
  }

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (!(aIsArray || bIsArray)) {
    // General record (non-array object) comparison.
    return checkSpecificProps(a, b, keysA);
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
    const aValue = a[i];
    const bValue = b[i];

    indexCount++; // Assume non-hole to start. Might get reversed below.

    if (!deepEqual(aValue, bValue)) {
      return false;
    }

    if (aValue === undefined) {
      // Need to distinguish hole from a truly stored `undefined`.
      const aHasIt = Object.hasOwn(a, i);
      const bHasIt = Object.hasOwn(b, i);
      if ((aHasIt && !bHasIt) || (!aHasIt && bHasIt)) {
        return false;
      } else if (!aHasIt && !bHasIt) {
        // It's a hole.
        indexCount--;
      }
    }
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
  return checkSpecificProps(a, b, keysA.slice(indexCount));
}

/**
 * Helper for {@link deepEqual} that checks whether specific properties are
 * deeply equal between two records. Used for general object comparison and
 * for checking named (non-index) properties on arrays.
 *
 * @param a - First record (properties assumed to exist here)
 * @param b - Second record (properties checked via `hasOwn` before access)
 * @param keysToCheck - Property keys to compare
 * @returns `true` if all specified properties exist on `b` and are deeply equal
 */
function checkSpecificProps(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  keysToCheck: string[],
): boolean {
  for (const key of keysToCheck) {
    const aValue = a[key];
    const bValue = b[key];

    if (!deepEqual(aValue, bValue)) {
      return false;
    }

    if (aValue === undefined) {
      // Need to distinguish a missing property from a truly stored `undefined`.
      // Given how `keysToCheck` we know `a` definitely has the property, so we
      // just have to check `b`.
      if (!Object.hasOwn(b, key)) {
        // `a` has the property (because of how `keysToCheck` was constructed),
        // but `b` does not.
        return false;
      }
    }
  }

  return true;
}
