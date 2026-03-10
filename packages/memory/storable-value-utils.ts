/**
 * Pure utility functions for storable value array index checking. These are
 * used by both the legacy and modern storable value modules, so they live
 * here to avoid circular imports between those modules and the dispatch
 * module.
 */

/**
 * Character code for digit `0`.
 */
const CHAR_CODE_0 = "0".charCodeAt(0);

/**
 * Indicates whether the given string to be used as a property name (for an
 * object or array) is syntactically valid as an array index per se.
 *
 * @param name - The property name to check
 * @returns `true` if `name` when used on an array would access an indexed
 *   element of that array.
 */
export function isArrayIndexPropertyName(name: string): boolean {
  switch (name[0]) {
    case undefined: {
      // Empty string.
      return false;
    }
    case "0": {
      // Only valid if the string is `0` per se.
      return (name === "0");
    }
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
    case "7":
    case "8":
    case "9": {
      // `break` for more detailed check below.
      break;
    }
    default: {
      return false;
    }
  }

  const length = name.length;

  if (length > 10) {
    // Don't bother with anything more if the name is too long to possibly be a
    // valid index.
    return false;
  }

  // Check that all characters are (normal) digits, and parse it for a final
  // range check. (NB: Benchmarking shows that doing it this way is
  // significantly faster than using a regex test and a final `parseInt()` for
  // the range check.
  let num = 0;
  for (let i = 0; i < length; i++) {
    const digit = name.charCodeAt(i) - CHAR_CODE_0;
    if ((digit < 0) || (digit > 9)) {
      return false;
    }
    num = (num * 10) + digit;
  }

  // Only accept in-range values: 0 to 2^32 - 2 (0xFFFFFFFE) per the
  // ECMAScript spec. The value 2^32 - 1 (4294967295) is reserved as
  // `array.length` for a max-length array and is not a valid index.
  return (num <= 0xFFFFFFFE);
}

/**
 * Helper which accepts an array and checks to see whether all of its enumerable
 * own properties are numeric indices (that is, it has no named properties).
 * Unlike `isStorableArray`, this returns `true` even for sparse arrays.
 *
 * @param array The array to check.
 * @returns `true` if the array has only numeric properties, `false` otherwise.
 */
export function isArrayWithOnlyIndexProperties(array: unknown[]): boolean {
  const len = array.length;
  const keys = Object.keys(array);

  // Quick check: more keys than length means there must be named properties.
  if (keys.length > len) {
    return false;
  }

  // Verify all keys are valid indices (non-negative integers < length).
  return !keys.some((k) => {
    const n = Number(k);
    return !Number.isInteger(n) || n < 0 || n >= len;
  });
}
