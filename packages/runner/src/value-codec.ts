import { isInstance, isRecord } from "@commontools/utils/types";

/**
 * Determines if the given value is JSON-encodable per se (without conversion),
 * but without taking into consideration the contents of values (that is, it
 * doesn't iterate over array or object contents to make its determination).
 *
 * @param value - The value to check.
 * @returns `true` if the value is JSON-encodable per se, `false` otherwise.
 */
export function isStorableValue(value: unknown): boolean {
  switch (typeof value) {
    case "boolean":
    case "string": {
      return true;
    }

    // TODO(@danfuzz): `undefined` isn't JSON-encodable; this case should be
    // moved to the `false` block below. See the related TODO item in
    // `toStorableValue()` below.
    case "undefined": {
      return true;
    }

    case "number": {
      if (Number.isFinite(value) && !Object.is(value, -0)) {
        return true;
      }
      // TODO(@danfuzz): `NaN` isn't JSON-encodable; this case should return
      // `false`. See the related TODO item in `toStorableValue()` below.
      if (Number.isNaN(value)) {
        return true;
      }
      return false;
    }

    case "object": {
      // `null`, plain objects, and arrays are storable. Instances are not.
      return !isInstance(value);
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
    case "string": {
      return value;
    }

    case "number": {
      if (Number.isFinite(value) && !Object.is(value, -0)) {
        return value;
      } else {
        if (Number.isNaN(value)) {
          // TODO(@danfuzz): This is allowed for now, even though it isn't
          // JSON-encodable, specifically because there is a test which
          // explicitly expects `NaN` to become `null`. To be clear, this _does_
          // match the behavior of `JSON.stringify()`, however in the spirit of
          // "Death before confusion!" I think the test in question should get
          // tweaked, and then this `if` statement should be removed.
          return null;
        }
        throw new Error("Cannot store non-finite number or negative zero");
      }
    }

    case "function": {
      // Break out for the more involved work.
      break;
    }

    case "object": {
      if (!isInstance(value)) {
        return value;
      }

      // Break out for the more involved work.
      break;
    }

    // TODO(@danfuzz): This is allowed for now, even though it isn't
    // JSON-encodable, specifically because many tests try to store `undefined`
    // in `Cell`s. I believe the right answer is to stop doing that and then
    // make this case be part of the error block below.
    case "undefined": {
      return undefined;
      // throw new Error(`Cannot store ${typeName}`);
    }

    case "bigint":
    case "symbol": {
      throw new Error(`Cannot store ${typeName}`);
    }

    default: {
      throw new Error(`Shouldn't happen: Unrecognized type ${typeName}`);
    }
  }

  const valueObj = value as object; // Safe, given the `switch` above.

  if (!("toJSON" in valueObj && typeof valueObj.toJSON === "function")) {
    throw new Error(
      `Cannot store ${typeName} per se (needs to have a \`toJSON()\` method)`,
    );
  }

  const converted = valueObj.toJSON();

  if (!isStorableValue(converted)) {
    throw new Error(
      `\`toJSON()\` on ${typeName} returned something other than a \`JSONValue\``,
    );
  }

  return converted;
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
