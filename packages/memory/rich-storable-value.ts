import { isInstance, isRecord } from "@commontools/utils/types";
import type {
  StorableNativeObject,
  StorableValue,
  StorableValueLayer,
} from "./interface.ts";

/**
 * Shallow conversion that preserves `Error` instances and `undefined`. For
 * arrays, does NOT convert `undefined` elements to `null` and does NOT densify
 * sparse arrays. For all other types, applies the same conversion logic as
 * the legacy `toStorableValue()` path.
 *
 * This function is self-contained (does not delegate back to `toStorableValue`)
 * to avoid circular dispatch when the `richStorableValues` flag is ON.
 *
 * Used when the `richStorableValues` flag is ON. See Section 5.1 of the
 * StorableDatum widening design doc.
 */
export function toRichStorableValue(value: unknown): StorableValueLayer {
  // Error instances pass through as-is (late serialization).
  if (Error.isError(value)) {
    return value as Error;
  }

  // `undefined` passes through as-is.
  if (value === undefined) {
    return undefined;
  }

  // For arrays, return as-is without converting `undefined` to `null` or
  // densifying sparse arrays.
  if (Array.isArray(value)) {
    return value;
  }

  // For all remaining types, apply the same logic as legacy toStorableValue.
  return toRichStorableValueBase(value);
}

/**
 * Checks whether a value has a callable `toJSON()` method.
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
 * Handles the non-Error, non-undefined, non-array cases for `toRichStorableValue`.
 * Mirrors the logic of `toStorableValueLegacy` for these types.
 */
function toRichStorableValueBase(value: unknown): StorableValueLayer {
  switch (typeof value) {
    case "boolean":
    case "string": {
      return value;
    }

    case "number": {
      if (Number.isFinite(value)) {
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

      if (hasToJSONMethod(value)) {
        const converted = value.toJSON();
        if (!isRichStorableValue(converted)) {
          throw new Error(
            `\`toJSON()\` on ${typeof value} returned something other than a storable value`,
          );
        }
        return converted;
      } else if (typeof value === "function") {
        throw new Error(
          "Cannot store function per se (needs to have a `toJSON()` method)",
        );
      } else if (isInstance(value)) {
        // Error is handled above in toRichStorableValue; any other instance
        // without toJSON is not storable.
        throw new Error(
          "Cannot store instance per se (needs to have a `toJSON()` method)",
        );
      } else {
        // Plain object -- pass through.
        return value;
      }
    }

    case "bigint":
    case "symbol": {
      throw new Error(`Cannot store ${typeof value}`);
    }

    default: {
      throw new Error(`Shouldn't happen: Unrecognized type ${typeof value}`);
    }
  }
}

// Sentinel value used to indicate an object is currently being processed
// (ancestor in the tree). If we encounter this while recursing, we have a
// circular reference.
const PROCESSING = Symbol("PROCESSING");

/**
 * Recursive conversion that preserves `Error` instances and `undefined` at all
 * nesting levels. Uses `toRichStorableValue()` for leaf conversion. In object
 * recursion, does NOT omit `undefined`-valued properties (preserves them). In
 * array recursion, does NOT convert `undefined` to `null`.
 *
 * This is a standalone recursive walker (duplication of
 * `toDeepStorableValueInternal()`) per the design doc Section 5.4 decision:
 * the two behavioral differences are scattered throughout the function, making
 * parameterization more invasive than duplication.
 *
 * Used when the `richStorableValues` flag is ON.
 */
export function toDeepRichStorableValue(value: unknown): StorableValue {
  return toDeepRichStorableValueInternal(value, new Map()) as StorableValue;
}

/**
 * Internal recursive implementation for the rich path. Unlike the legacy
 * version, this never returns OMIT -- `undefined` values are preserved.
 */
function toDeepRichStorableValueInternal(
  original: unknown,
  converted: Map<object, unknown>,
): StorableValue {
  const isOriginalRecord = isRecord(original);

  if (isOriginalRecord && converted.has(original)) {
    const cached = converted.get(original);
    if (cached === PROCESSING) {
      throw new Error("Cannot store circular reference");
    }
    return cached as StorableValue;
  }

  if (isOriginalRecord) {
    converted.set(original, PROCESSING);
  }

  // Try to convert the top level via the rich shallow converter.
  let value: StorableValueLayer;
  try {
    value = toRichStorableValue(original);
  } catch (e) {
    if (isOriginalRecord) {
      converted.delete(original);
    }
    throw e;
  }

  // Primitives, null, undefined, and Error don't need recursion.
  if (!isRecord(value)) {
    if (isOriginalRecord) {
      converted.set(original, value);
    }
    return value as StorableValue;
  }

  // Error instances pass through as-is (no recursion into properties).
  if (Error.isError(value)) {
    if (isOriginalRecord) {
      converted.set(original, value);
    }
    return value as StorableValue;
  }

  let result: StorableValue;

  if (Array.isArray(value)) {
    // Recurse into array elements. Preserve `undefined` elements as-is.
    const resultArray: StorableValue[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        // Sparse hole -- preserve it by setting length without assigning.
        // This keeps the hole distinct from `undefined`.
        resultArray.length = i + 1;
      } else {
        resultArray[i] = toDeepRichStorableValueInternal(
          value[i],
          converted,
        );
      }
    }
    result = resultArray as StorableValue;
  } else {
    // Recurse into object properties. Preserve `undefined`-valued properties.
    const entries: [string, StorableValue][] = [];
    for (const [key, val] of Object.entries(value)) {
      const convertedVal = toDeepRichStorableValueInternal(val, converted);
      entries.push([key, convertedVal]);
    }
    result = Object.fromEntries(entries) as StorableValue;
  }

  if (isOriginalRecord) {
    converted.set(original, result);
  }

  return result;
}

/**
 * Type guard that accepts `Error` instances, `undefined`, and arrays with
 * `undefined` elements or sparse holes -- in addition to the base storable
 * types (null, boolean, number, string, plain objects, dense arrays).
 *
 * MUST be self-contained (inline base-type checks, does NOT delegate back to
 * `isStorableValue()`) to avoid circular dispatch when the `richStorableValues`
 * flag is ON. See session 2 notes about the stack overflow this caused.
 *
 * Used when the `richStorableValues` flag is ON.
 */
export function isRichStorableValue(
  value: unknown,
): value is StorableValueLayer {
  switch (typeof value) {
    case "boolean":
    case "string":
    case "undefined": {
      return true;
    }

    case "number": {
      return Number.isFinite(value);
    }

    case "object": {
      if (value === null) {
        return true;
      }
      // Error instances are accepted in the rich path.
      if (Error.isError(value)) {
        return true;
      }
      if (Array.isArray(value)) {
        // In the rich path, arrays with `undefined` elements and sparse holes
        // are accepted. Only reject arrays with non-index properties.
        return isRichStorableArray(value);
      }
      // Plain objects are accepted; class instances are not (except Error,
      // handled above).
      const proto = Object.getPrototypeOf(value);
      return proto === null || proto === Object.prototype;
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
 * Checks whether an array is acceptable in the rich storable path. Unlike
 * `isStorableArray` in storable-value.ts, this accepts `undefined` elements
 * and sparse holes. It only rejects arrays with non-index properties.
 */
function isRichStorableArray(array: unknown[]): boolean {
  const len = array.length;
  const keys = Object.keys(array);

  // More keys than length means there must be named (non-index) properties.
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
 * Returns `true` if `toDeepRichStorableValue()` would succeed on the value.
 * Checks whether the value is a `StorableValue`, a `StorableNativeObject`,
 * or a deep tree thereof.
 *
 * Stub: delegates to `isRichStorableValue()` for now. The three-layer rework
 * PR replaces this with a full recursive implementation that handles
 * `StorableNativeObject` types (Error, Map, Set, Date, Uint8Array, Blob,
 * toJSON-capable objects) and cycle detection.
 */
export function canBeStored(
  value: unknown,
): value is StorableValue | StorableNativeObject {
  return isRichStorableValue(value);
}
