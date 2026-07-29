/**
 * Pure utility functions for checking array-index property names and
 * array index-only-ness.
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

  // Only accept in-range values: 0 to 0xFFFFFFFE (2^32 - 2) per the
  // ECMAScript spec. The value 0xFFFFFFFF (2^32 - 1) is reserved as
  // `array.length` for a max-length array and is not a valid index.
  return (num <= 0xFFFFFFFE);
}

/**
 * Indicates whether every one of the given array's own properties is an array
 * index, `length` aside. Named (string-keyed) properties and symbol-keyed
 * properties alike cause rejection, whether or not they are enumerable, because
 * none of them have any representation as array content. Returns `true` for
 * sparse arrays, whose holes are simply absent properties.
 *
 * Anything that isn't actually an array is rejected, including an array-_like_
 * object and one whose prototype is `Array.prototype`. Such a value can
 * perfectly well name `length` as its final own property, so the key-order
 * reasoning below says nothing about it. This also makes the function total:
 * it answers rather than throwing no matter what it is handed.
 *
 * **Note:** This function relies on the given array producing `Reflect.ownKeys()`
 * output which agrees with the JavaScript spec with regards to key ordering,
 * namely index keys in ascending numeric order, then the remaining string keys
 * in property-creation order, then symbol keys in property-creation order.
 * Built-in arrays of course do this, but it's possible for a `Proxy` to (a)
 * effectively purport to be an array, and yet (b) have an `ownKeys()` trap that
 * diverges from the behavior of built-in arrays. In such cases, this function
 * can return an incorrect answer, exactly because it depends on the
 * spec-defined ordering. The rationale for this implementation is that it's
 * reasonable to expect proxied arrays to implement `ownKeys()` in agreement
 * with the standard array order (even though the spec _does_ allow leeway with
 * regards to what `Proxy`s actually do), _and_ by making this assumption, this
 * function avoids having to inspect _every_ key.
 *
 * @param array The array to check.
 * @returns `true` if the array has only index properties, `false` otherwise.
 */
export function isArrayWithOnlyIndexProperties(array: unknown[]): boolean {
  // `Array.isArray()` sees through a `Proxy` to its target, so a proxied array
  // is still recognized as one here.
  if (!Array.isArray(array)) {
    return false;
  }

  // Given the key ordering described above, `length` -- which is created along
  // with the array itself, and so precedes every later-created string key --
  // is the last own key exactly when there is no other non-index key at all:
  // a named property would sort after it, and a symbol key after that.
  return Reflect.ownKeys(array).at(-1) === "length";
}
