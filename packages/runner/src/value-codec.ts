import { isInstance } from "@commontools/utils/types";

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
