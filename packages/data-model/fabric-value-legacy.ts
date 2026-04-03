import { isInstance, isRecord } from "@commonfabric/utils/types";
import type {
  FabricNativeObject,
  FabricValue,
  FabricValueLayer,
} from "./fabric-value.ts";
import { isArrayWithOnlyIndexProperties } from "./array-utils.ts";

/**
 * Converts specially-recognized class instances to their designated fabric
 * form. Returns `null` if the value is not one of the recognized types.
 *
 * Currently recognized types:
 * - `Error` (and subclasses) → `{"@Error": {name, message, stack, ...}}`
 *
 * @param value - The value to check and potentially convert.
 * @returns The fabric form of the instance, or `null` if not recognized.
 */
function specialInstanceToFabricValue(
  value: unknown,
): FabricValueLayer | null {
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
 * TODO: Remove `toJSON()` support once all callers have migrated to
 * `[DECONSTRUCT]`. See spec Section 7.1.
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
 * Legacy implementation of `isFabricValue()` for the JSON-only type system.
 * Determines if the given value is considered "fabric-compatible" per se (without
 * invoking any conversions such as `.toJSON()`).
 *
 * @param value - The value to check.
 * @returns `true` if the value is fabric-compatible per se, `false` otherwise.
 */
export function isFabricValueLegacy(
  value: unknown,
): value is FabricValueLayer {
  switch (typeof value) {
    case "boolean":
    case "string":
    case "undefined": {
      return true;
    }

    case "number": {
      // Finite numbers are fabric-compatible. Note: `-0` is accepted because it gets
      // normalized to `0` during conversion (see `shallowFabricFromNativeValue()`).
      // `NaN` and `Infinity` are not JSON-encodable and thus not fabric-compatible.
      return Number.isFinite(value);
    }

    case "object": {
      if (value === null) {
        return true;
      } else if (Array.isArray(value)) {
        return isFabricArray(value);
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
 * Legacy implementation of `isFabricCompatible()` for the JSON-only type system.
 * In legacy mode, equivalent to `isFabricValueLegacy()` since the legacy
 * path doesn't support `FabricNativeObject` types.
 *
 * @param value - The value to check.
 * @returns `true` if the value can be stored, `false` otherwise.
 */
export function isFabricCompatibleLegacy(
  value: unknown,
): value is FabricValue | FabricNativeObject {
  return isFabricValueLegacy(value);
}

/**
 * Legacy implementation of `cloneIfNecessary()`. As a legacy version, this is
 * an intentionally simplified implementation meant to capture only the truly
 * necessary behavior to keep the system running without the modern-data flag
 * turned on. Details:
 *
 * * This function just returns the given `value` in many cases that ideally
 *   would do something else. Specifically, this function _only_ ever does
 *   something nontrivial when asked for a mutable (`frozen === false`) result. *
 * * This function does not try to do anything smart about circular values; they
 *   _will_ cause the stack to blow out.
 * * Given a plain object which is to be cloned, this function always returns
 *   a result which has a non-`null` prototype.
 * * When producing a clone with `deep === true`, this just uses the built-in
 *   `structuredClone()` function (which would be incorrect given arbitrary
 *   modern-data values).
 *
 * Callers must resolve `CloneOptions` defaults and validate before calling;
 * the dispatcher in `fabric-value.ts` handles that.
 *
 * @param value - An already-valid `FabricValue`.
 * @param frozen - Whether the result should be frozen.
 * @param deep - Whether to clone deeply or shallowly.
 * @param force - Whether to force a copy.
 */
export function cloneIfNecessaryLegacy(
  value: FabricValue,
  frozen: boolean,
  deep: boolean,
  force: boolean,
): FabricValue {
  const needClone = force || Object.isFrozen(value);
  if (frozen || !needClone) {
    return value;
  }

  if (deep) {
    return structuredClone(value);
  } else if (Array.isArray(value)) {
    const arr = value as FabricValue[];
    const copy: FabricValue[] = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      if (i in arr) copy[i] = arr[i];
    }
    return copy;
  } else {
    return { ...(value as Record<string, unknown>) } as FabricValue;
  }
}

/**
 * Legacy implementation of `shallowFabricFromNativeValue()` for the
 * JSON-only type system. Converts a value to fabric form without recursing
 * into nested values.
 *
 * @param value - The value to convert.
 * @returns The fabric value (original or converted).
 * @throws Error if the value can't be converted to a JSON-encodable form.
 */
export function shallowFabricFromNativeValueLegacy(
  value: unknown,
): FabricValueLayer {
  switch (typeof value) {
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

      if (hasToJSONMethod(value)) {
        const converted = value.toJSON();

        if (!isFabricValueLegacy(converted)) {
          throw new Error(
            `\`toJSON()\` on ${typeof value} returned something other than a fabric value`,
          );
        }

        return converted;
      } else if (typeof value === "function") {
        throw new Error(
          "Cannot store function per se (needs to have a `toJSON()` method)",
        );
      } else if (isInstance(value)) {
        const special = specialInstanceToFabricValue(value);
        if (special !== null) {
          return special;
        }
        throw new Error(
          "Cannot store instance per se (needs to have a `toJSON()` method)",
        );
      } else if (Array.isArray(value)) {
        // Note that if the original `value` had a `toJSON()` method, that would
        // have triggered the `toJSON` clause above and so we won't end up here.
        if (!isArrayWithOnlyIndexProperties(value)) {
          throw new Error(
            "Cannot store array with enumerable named properties.",
          );
        } else if (isFabricArray(value)) {
          return value;
        } else {
          // Array has holes or `undefined` elements. Preserve holes (sparse
          // slots) and convert `undefined` values to `null`.
          const arr = value as unknown[];
          const result = new Array(arr.length);
          arr.forEach((v, i) => {
            result[i] = v === undefined ? null : v;
          });
          return result;
        }
      } else if (isRecord(value)) {
        return value;
      } else {
        throw new Error(
          "Shouldn't happen: Encontered non-null, non-array, non-record object value",
        );
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

// Sentinel value used to indicate that a property should be omitted during
// conversion in `fabricFromNativeValueLegacy()`.
const OMIT = Symbol("OMIT");

// Sentinel value used in the `converted` map to indicate an object is currently
// being processed (i.e., it's an ancestor in the tree). If we encounter this
// while recursing, we have a circular reference.
const PROCESSING = Symbol("PROCESSING");

/**
 * Legacy implementation of deep fabric value conversion for the JSON-only
 * type system. Recursively converts a value to fabric (JSON-encodable) form.
 *
 * @param value - The value to convert.
 * @returns The fabric value (original or converted).
 * @throws Error if the value (or any nested value) can't be converted.
 */
export function fabricFromNativeValueLegacy(value: unknown): FabricValue {
  // The internal helper can return OMIT for nested values that should be
  // omitted, but at the top level this never happens (OMIT is only returned
  // when converted.size > 0, i.e., in nested calls).
  return fabricFromNativeValueLegacyInternal(
    value,
    new Map(),
    false,
  ) as FabricValue;
}

/**
 * Internal recursive implementation. Can return `OMIT` for nested values that
 * should be omitted from objects (functions without toJSON, undefined).
 */
function fabricFromNativeValueLegacyInternal(
  original: unknown,
  converted: Map<object, unknown>,
  inArray: boolean,
): FabricValue | typeof OMIT {
  // Track the original value for cycle detection and caching. This is important
  // because `shallowFabricFromNativeValue()` may return a different object (e.g., for sparse
  // arrays or values with `toJSON()`), but circular references and shared
  // references point to the original.
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
      return cached as FabricValue;
    }
    // Mark as currently processing (ancestor) before converting.
    converted.set(original, PROCESSING);
  }

  // Handle functions without `toJSON()`: At top level, throw. In arrays,
  // convert to `null`. In objects, omit the property. This matches
  // `JSON.stringify()` behavior.
  if (typeof original === "function" && !hasToJSONMethod(original)) {
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

  // Try to convert the top level to fabric form. Calls the legacy function
  // directly since `fabricFromNativeValueLegacyInternal()` is part of the
  // legacy path.
  let value: FabricValueLayer;
  try {
    value = shallowFabricFromNativeValueLegacy(original);
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
    // In arrays, return `null` instead of OMIT to match JSON.stringify semantics
    // (which coerces undefined to null in array positions).
    if (value === undefined && converted.size > 0) {
      return inArray ? null : OMIT;
    }
    // At this point, value is a primitive (null, boolean, number, string) or
    // undefined - all valid FabricValue types.
    return value as FabricValue;
  }

  let result: FabricValue;

  // Recursively process arrays and objects.
  if (Array.isArray(value)) {
    const arr = new Array(value.length);
    value.forEach((v, i) => {
      arr[i] = fabricFromNativeValueLegacyInternal(v, converted, true);
    });
    result = arr as FabricValue;
  } else {
    const entries: [string, FabricValue][] = [];
    for (const [key, val] of Object.entries(value)) {
      const convertedVal = fabricFromNativeValueLegacyInternal(
        val,
        converted,
        false,
      );
      if (convertedVal !== OMIT) {
        entries.push([key, convertedVal]);
      }
    }
    result = Object.fromEntries(entries) as FabricValue;
  }

  // Cache the result for the original object.
  if (isOriginalRecord) {
    converted.set(original, result);
  }

  return result;
}

/**
 * Helper for other functions in this file, which accepts an array and checks to
 * see whether or not it in fabric form. To be in fabric form, an array must
 * have only numeric index properties (no extra named properties) and must not
 * contain any explicit `undefined` values at populated indices. Sparse holes
 * are allowed.
 *
 * @param array The array to check.
 * @returns `true` if the array is in fabric form, `false` otherwise.
 */
function isFabricArray(array: unknown[]): boolean {
  // Reject extra non-numeric properties by checking that all keys are valid
  // array indices. Sparse arrays have fewer keys than length, which is fine.
  if (!isArrayWithOnlyIndexProperties(array)) {
    return false;
  }

  // Reject `undefined` elements at populated indices. Holes (missing indices)
  // are allowed — they are preserved as sparse slots.
  for (let i = 0; i < array.length; i++) {
    if (i in array && array[i] === undefined) {
      return false;
    }
  }

  return true;
}
