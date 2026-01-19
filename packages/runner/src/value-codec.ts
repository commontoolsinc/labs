import { isInstance, isRecord } from "@commontools/utils/types";

/**
 * Indicates whether the given string to be used as a property name (for an
 * object or array) is syntactically valid as an array index per se.
 *
 * @param name - The property name to check
 * @returns `true` if `name` when used on an array would access an indexed
 *   element of that array.
 */
export function isArrayIndexPropertyName(name: string): boolean {
  if (name === "0") {
    // Easy and common special case, making the regex below simpler.
    return true;
  } else if (!/^[1-9][0-9]{0,9}$/.test(name)) {
    // It's not a string of digits starting with not-`0`.
    return false;
  } else if (name.length < 10) {
    // It's short enough that it can't possibly be out of range.
    return true;
  } else {
    // Need to actually check the value. We do this for pedantic correctness, on
    // the assumption that it will rarely if ever be encountered in practice.
    return Number(name) < (2 ** 31);
  }
}

/**
 * Converts specially-recognized class instances to their designated storable
 * form. Returns `null` if the value is not one of the recognized types.
 *
 * Currently recognized types:
 * - `Error` (and subclasses) → `{"@Error": {name, message, stack, ...}}`
 *
 * @param value - The value to check and potentially convert.
 * @returns The storable form of the instance, or `null` if not recognized.
 */
function specialInstanceToStorableValue(
  value: unknown,
): Record<string, unknown> | null {
  if (Error.isError(value)) {
    const error = value as Error;
    // Return a single-key object using the `@` prefix convention established
    // elsewhere in the system. The spread captures any custom enumerable
    // properties, followed by explicit assignment of the standard (but
    // non-enumerable) Error properties.
    return {
      "@Error": {
        ...error,
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      },
    };
  }

  return null;
}

/**
 * Checks whether a value has a callable `toJSON()` method.
 *
 * @param value - The value to check.
 * @returns `true` if the value has a `toJSON` method that is a function.
 */
function hasToJSONMethod(
  value: unknown,
): value is { toJSON: () => unknown } {
  return (
    value !== null &&
    "toJSON" in (value as object) &&
    typeof (value as { toJSON: unknown }).toJSON === "function"
  );
}

/**
 * Determines if the given value is considered "storable" by the system per se
 * (without invoking any conversions such as `.toJSON()`). This function does
 * not recursively validate nested values in arrays or objects.
 *
 * For the purposes of this system, storable values are values which are
 * JSON-encodable, _plus_ `undefined`. On the latter: A top-level `undefined`
 * indicates that the salient stored value is to be deleted. `undefined` as an
 * object property value is treated as if it were absent. Arrays must not
 * contain `undefined` elements (including holes); these get converted to `null`
 * during conversion to storable form.
 *
 * @param value - The value to check.
 * @returns `true` if the value is storable per se, `false` otherwise.
 */
export function isStorableValue(value: unknown): boolean {
  switch (typeof value) {
    case "boolean":
    case "string":
    case "undefined": {
      return true;
    }

    case "number": {
      // Finite numbers are storable. Note: `-0` is accepted because it gets
      // normalized to `0` during conversion (see `toStorableValue()`).
      // `NaN` and `Infinity` are not JSON-encodable and thus not storable.
      return Number.isFinite(value);
    }

    case "object": {
      if (value === null) {
        return true;
      } else if (Array.isArray(value)) {
        return isStorableArray(value);
      } else {
        return !isInstance(value);
      }
    }

    case "function":
    case "bigint":
    case "symbol":
    default: {
      return false;
    }
  }
}

/**
 * Converts a value to a storable (JSON-encodable) form. JSON-encodable values
 * pass through as-is. Functions and instances (non-plain objects) are converted
 * via `toJSON()` if available. Throws on non-encodable primitives (`bigint`,
 * `symbol`) or if a function/instance can't be converted.
 *
 * **Note:** This function does _not_ recursively visit the inner contents of
 * values (that is, it doesn't iterate over array or object contents).
 *
 * @param value - The value to convert.
 * @returns The storable value (original or converted).
 * @throws Error if the value can't be converted to a JSON-encodable form.
 */
export function toStorableValue(value: unknown): unknown {
  const typeName = typeof value;

  switch (typeName) {
    case "boolean":
    case "string":
    case "undefined": {
      return value;
    }

    case "number": {
      if (Number.isFinite(value)) {
        // Normalize `-0` to `0` to avoid JSON serialization quirks.
        return Object.is(value, -0) ? 0 : value;
      } else {
        throw new Error("Cannot store non-finite number");
      }
    }

    case "function":
    case "object": {
      if (value === null) {
        return null;
      }

      const valueObj = value as object;

      if (hasToJSONMethod(valueObj)) {
        const converted = valueObj.toJSON();

        if (!isStorableValue(converted)) {
          throw new Error(
            `\`toJSON()\` on ${typeName} returned something other than a storable value`,
          );
        }

        return converted;
      } else if (typeof valueObj === "function") {
        throw new Error(
          "Cannot store function per se (needs to have a `toJSON()` method)",
        );
      } else if (isInstance(valueObj)) {
        const special = specialInstanceToStorableValue(valueObj);
        if (special !== null) {
          return special;
        }
        throw new Error(
          "Cannot store instance per se (needs to have a `toJSON()` method)",
        );
      } else if (Array.isArray(valueObj)) {
        // Note that if the original `value` had a `toJSON()` method, that would
        // have triggered the `toJSON` clause above and so we won't end up here.
        if (!isArrayWithOnlyIndexProperties(valueObj)) {
          throw new Error(
            "Cannot store array with enumerable named properties.",
          );
        } else if (isStorableArray(valueObj)) {
          return valueObj;
        } else {
          // Array has holes or `undefined` elements. Densify and convert
          // `undefined` to `null`.
          return [...valueObj].map((v) => (v === undefined ? null : v));
        }
      } else {
        return valueObj;
      }
    }

    case "bigint":
    case "symbol": {
      throw new Error(`Cannot store ${typeName}`);
    }

    default: {
      throw new Error(`Shouldn't happen: Unrecognized type ${typeName}`);
    }
  }
}

// Sentinel value used to indicate that a property should be omitted during
// conversion in `toDeepStorableValue()`.
const OMIT = Symbol("OMIT");

// Sentinel value used in the `converted` map to indicate an object is currently
// being processed (i.e., it's an ancestor in the tree). If we encounter this
// while recursing, we have a circular reference.
const PROCESSING = Symbol("PROCESSING");

/**
 * Recursively converts a value to storable (JSON-encodable) form. Like
 * `toStorableValue()` but also recursively processes array elements and object
 * properties.
 *
 * @param value - The value to convert.
 * @param converted - Map of original→result for caching and cycle detection.
 * @param inArray - Whether we're processing an array element (internal use).
 * @returns The storable value (original or converted).
 * @throws Error if the value (or any nested value) can't be converted.
 */
export function toDeepStorableValue(
  value: unknown,
  converted: Map<object, unknown> = new Map(),
  inArray: boolean = false,
): unknown {
  // Track the original value for cycle detection and caching. This is important
  // because `toStorableValue()` may return a different object (e.g., for sparse
  // arrays or values with `toJSON()`), but circular references and shared
  // references point to the original.
  const original = value;
  const isOriginalRecord = isRecord(original);

  if (isOriginalRecord) {
    const cached = converted.get(original);
    if (cached === PROCESSING) {
      throw new Error("Cannot store circular reference");
    }
    if (cached !== undefined) {
      // Already converted this object; return cached result. This handles
      // shared references efficiently and ensures consistent results since
      // `toJSON()` could return different values on repeated calls.
      return cached;
    }
    // Mark as currently processing (ancestor) before converting.
    converted.set(original, PROCESSING);
  }

  // Handle functions without `toJSON()`: At top level, throw. In arrays,
  // convert to `null`. In objects, omit the property. This matches
  // `JSON.stringify()` behavior.
  if (typeof value === "function" && !hasToJSONMethod(value)) {
    if (inArray) {
      return null;
    } else if (converted.size > 0) {
      // We're in a nested context (not top level) - omit this property.
      return OMIT;
    }
    throw new Error(
      "Cannot store function per se (needs to have a `toJSON()` method)",
    );
  }

  // Try to convert the top level to storable form.
  try {
    value = toStorableValue(value);
  } catch (e) {
    // Clean up converted map before propagating error.
    if (isOriginalRecord) {
      converted.delete(original);
    }
    throw e;
  }

  // Primitives and null don't need recursion.
  if (!isRecord(value)) {
    if (isOriginalRecord) {
      // Cache the primitive result for the original object (e.g., from toJSON).
      converted.set(original, value);
    }
    // `undefined` at non-top-level should be omitted (matches JSON.stringify).
    if (value === undefined && converted.size > 0) {
      return OMIT;
    }
    return value;
  }

  let result: unknown;

  // Recursively process arrays and objects.
  if (Array.isArray(value)) {
    result = value.map((element) =>
      toDeepStorableValue(element, converted, true)
    );
  } else {
    const entries: [string, unknown][] = [];
    for (const [key, val] of Object.entries(value)) {
      const convertedVal = toDeepStorableValue(val, converted, false);
      if (convertedVal !== OMIT) {
        entries.push([key, convertedVal]);
      }
    }
    result = Object.fromEntries(entries);
  }

  // Cache the result for the original object.
  if (isOriginalRecord) {
    converted.set(original, result);
  }

  return result;
}

/**
 * Helper which accepts an array and checks to see whether all of its enumerable
 * own properties are numeric indices (that is, it has no named properties).
 * Unlike {@link isStorableArray}, this returns `true` even for sparse arrays.
 *
 * @param array The array to check.
 * @returns `true` if the array has only numeric properties, `false` otherwise.
 */
function isArrayWithOnlyIndexProperties(array: unknown[]): boolean {
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

/**
 * Helper for other functions in this file, which accepts an array and checks to
 * see whether or not it in storable form. To be in storable form, an array must
 * have all numeric keys from `0` through `.length - 1`, it must have no other
 * (enumerable own) properties, and it must not contain any `undefined` elements.
 *
 * @param array The array to check.
 * @returns `true` if the array is in storable form, `false` otherwise.
 */
function isStorableArray(array: unknown[]): boolean {
  const len = array.length;

  // Quick check: key count must equal length. This fails if there are holes
  // (sparse array) or extra non-numeric properties.
  if (Object.keys(array).length !== len) {
    return false;
  }

  // Reject holes and `undefined` elements (neither should be present once a
  // value has been converted to storable form). Note: `array[i]` returns
  // `undefined` for holes, so this covers both cases.
  for (let i = 0; i < len; i++) {
    if (array[i] === undefined) {
      return false;
    }
  }

  return true;
}
