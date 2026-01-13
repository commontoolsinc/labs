import { isInstance, isRecord } from "@commontools/utils/types";

/**
 * Determines if the given value is considered "storable" by the system per se
 * (without invoking any conversions such as `.toJSON()`), but without taking
 * into consideration the contents of values (that is, it doesn't iterate over
 * array or object contents to make its determination).
 *
 * For the purposes of this system, storable values are values which are
 * JSON-encodable, _plus_ `undefined`. On the latter: A top-level `undefined`
 * indicates that the salient stored value is to be deleted. `undefined` at an
 * array index is treated as `null`. `undefined` as an object property value is
 * treated as if it were absent.
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

      if ("toJSON" in valueObj && typeof valueObj.toJSON === "function") {
        const converted = valueObj.toJSON();

        if (!isStorableValue(converted)) {
          throw new Error(
            `\`toJSON()\` on ${typeName} returned something other than a storable value`,
          );
        }

        return converted;
      } else if (typeof valueObj === "function" || isInstance(valueObj)) {
        throw new Error(
          `Cannot store ${typeName} per se (needs to have a \`toJSON()\` method)`,
        );
      } else if (Array.isArray(valueObj)) {
        // Note that if the original `value` had a `toJSON()` method, that would
        // have triggered the `toJSON` clause above and so we won't end up here.
        if (isStorableArray(valueObj)) {
          return valueObj;
        } else if (isArrayWithOnlyIndexProperties(valueObj)) {
          // `valueObj` is non-storable only because it is sparse. Just densify
          // it.
          return [...valueObj];
        } else {
          throw new Error(
            "Cannot store array with enumerable named properties.",
          );
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

// TODO(@danfuzz): This sentinel is used to indicate a property should be
// omitted, matching `JSON.stringify()` behavior for functions. Once the
// codebase is tightened up to not store function properties, this sentinel and
// the code that uses it can be removed.
const OMIT = Symbol("OMIT");

/**
 * Recursively converts a value to storable (JSON-encodable) form. Like
 * `toStorableValue()` but also recursively processes array elements and object
 * properties.
 *
 * @param value - The value to convert.
 * @param seen - Set for circularity detection (internal use).
 * @param inArray - Whether we're processing an array element (internal use).
 * @returns The storable value (original or converted).
 * @throws Error if the value (or any nested value) can't be converted.
 */
export function toDeepStorableValue(
  value: unknown,
  seen: Set<object> = new Set(),
  inArray: boolean = false,
): unknown {
  // Try to convert the top level to storable form.
  try {
    value = toStorableValue(value);
  } catch (e) {
    // TODO(@danfuzz): This block matches `JSON.stringify()` behavior where
    // functions without `toJSON()` become `null` in arrays or get omitted from
    // objects. Once the codebase is tightened up to not pass such values to
    // `setRaw()`, this block should be removed (letting the error propagate).
    if (e instanceof Error && e.message.includes("function per se")) {
      if (inArray) {
        return null;
      } else if (seen.size > 0) {
        // We're inside an object (seen contains ancestors) - omit this property.
        return OMIT;
      }
      // At top level - let the error propagate.
    }
    throw e;
  }

  // Primitives and null don't need recursion.
  if (!isRecord(value)) {
    return value;
  }

  // Check for circular references. We only keep current ancestors in `seen`,
  // so finding a value there means we have a true cycle (not just a shared
  // reference).
  if (seen.has(value)) {
    throw new Error("Cannot store circular reference");
  }
  seen.add(value);

  let result: unknown;

  // Recursively process arrays and objects.
  if (Array.isArray(value)) {
    result = value.map((element) => toDeepStorableValue(element, seen, true));
  } else {
    // TODO(@danfuzz): The OMIT check here is part of the temporary
    // `JSON.stringify()` compatibility behavior for functions. Once tightened
    // up, this can be simplified back to a plain
    // `Object.fromEntries(Object.entries(...).map(...))`.
    const entries: [string, unknown][] = [];
    for (const [key, val] of Object.entries(value)) {
      const converted = toDeepStorableValue(val, seen, false);
      if (converted !== OMIT) {
        entries.push([key, converted]);
      }
    }
    result = Object.fromEntries(entries);
  }

  // Remove from seen after processing - only ancestors should be in the set.
  seen.delete(value);

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
 * have all numeric keys from `0` through `.length - 1`, and it must have no
 * other (enumerable own) properties.
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

  // Verify all indices from 0 through length-1 exist (no holes). This catches
  // the edge case where holes and extra properties balance out the count.
  for (let i = 0; i < len; i++) {
    if (!(i in array)) {
      return false;
    }
  }

  return true;
}
