import { isInstance, isRecord } from "@commonfabric/utils/types";
import {
  type FabricNativeObject,
  FabricSpecialObject,
  type FabricValue,
  type FabricValueLayer,
} from "./interface.ts";
import { FabricEpochNsec } from "./fabric-primitives/FabricEpochNsec.ts";
import {
  errorClassFromType,
  isConvertibleNativeInstance,
  UNSAFE_KEYS,
} from "./fabric-native-instances.ts";
import { FabricError } from "./fabric-instances/FabricError.ts";
import { FabricNativeWrapper } from "./fabric-instances/FabricNativeWrapper.ts";
import { FabricRegExp } from "./fabric-instances/FabricRegExp.ts";
import { FabricBytes } from "./fabric-primitives/FabricBytes.ts";
import { NATIVE_TAGS, tagFromNativeValue } from "./native-type-tags.ts";
import { isArrayWithOnlyIndexProperties } from "./array-utils.ts";
import { cloneHelper } from "./value-clone.ts";
import { isDeepFrozenFabricValue } from "./deep-freeze.ts";

/**
 * Helper for `shallowFabricFromNativeValueModern()`, which rejects native
 * objects with extra enumerable properties.
 */
function rejectExtraProperties(value: object, typeName: string): void {
  if (Object.keys(value).length > 0) {
    throw new Error(
      `Cannot store ${typeName} with extra enumerable properties`,
    );
  }
}

/**
 * Performs shallow conversion from JS values to `FabricValue`. Wraps `Error`
 * instances into `FabricError`; preserves `undefined`; optionally freezes
 * the result if it is an object or array. If the value is already a frozen
 * `FabricValue`, returns it as-is (identity optimization).
 *
 * This function is self-contained (does not delegate back to `shallowFabricFromNativeValue`)
 * to avoid circular dispatch when the `modernDataModel` flag is ON.
 *
 * Used when the `modernDataModel` flag is ON.
 *
 * @param value - The value to convert.
 * @param freeze - When `true` (default), freezes the result if it is an
 *   object or array. When `false`, wrapping and validation still occur but
 *   the result is left mutable.
 */
export function shallowFabricFromNativeValueModern(
  value: unknown,
  freeze = true,
): FabricValueLayer {
  // Top-level type dispatch via `tagFromNativeValue()` -- O(1) constructor
  // switch with fallbacks for exotic `Error` subclasses, cross-realm arrays,
  // and null-prototype objects. Returns `Primitive` for non-objects.
  const tag = tagFromNativeValue(value);

  switch (tag) {
    // Special primitives are direct `FabricValue` members -- always frozen,
    // pass through as-is regardless of the `freeze` argument.
    case NATIVE_TAGS.EpochNsec:
    case NATIVE_TAGS.EpochDays:
    case NATIVE_TAGS.ContentHash:
    case NATIVE_TAGS.FabricBytes:
      return value as FabricValueLayer;

    case NATIVE_TAGS.Error: {
      // Shallow conversion: wrap the native `Error` without recursing into its
      // internals (`cause`, custom properties). The result is therefore only a
      // *shallow* `FabricError` -- its `.cause` may still be a raw `Error`.
      // Callers that need a proper (fully-`FabricValue`) `FabricError` must use
      // the deep `fabricFromNativeValue()` instead; the cell write paths do so
      // at the points where they treat a `FabricError` as an atomic leaf.
      const wrapped = FabricError.fromNativeError(value as Error);
      if (freeze) Object.freeze(wrapped);
      return wrapped;
    }

    case NATIVE_TAGS.Date: {
      // `Date` instances are converted to `FabricEpochNsec` (nanoseconds from
      // epoch). Extra enumerable properties cause rejection ("death before
      // confusion").
      rejectExtraProperties(value as object, "Date");
      const nsec = BigInt((value as Date).getTime()) * 1_000_000n;
      const wrapped = new FabricEpochNsec(nsec);
      if (freeze) Object.freeze(wrapped);
      return wrapped;
    }

    case NATIVE_TAGS.RegExp: {
      // `RegExp` instances are wrapped in `FabricRegExp`. Extra enumerable
      // properties cause rejection ("death before confusion"). The
      // `rejectExtraProperties()` check is done inside `FabricRegExp`'s
      // `[DECONSTRUCT]`, but we also reject eagerly here at conversion time.
      rejectExtraProperties(value as object, "RegExp");
      const wrappedRegExp = new FabricRegExp(value as RegExp);
      if (freeze) Object.freeze(wrappedRegExp);
      return wrappedRegExp;
    }

    case NATIVE_TAGS.Uint8Array: {
      // Native `Uint8Array` instances are wrapped in `FabricBytes`.
      // `FabricBytes` self-freezes in its constructor (`FabricPrimitive` contract).
      return new FabricBytes(value as Uint8Array);
    }

    case NATIVE_TAGS.Array:
    case NATIVE_TAGS.Object:
      // Arrays and plain objects: delegate frozenness handling to `cloneHelper()`.
      return cloneHelper(
        value as FabricValue,
        freeze,
        false,
        false,
        null,
      ) as FabricValueLayer;

    case NATIVE_TAGS.HasToJSON: {
      // Objects (or arrays/class instances) with a `toJSON()` method.
      // Call `toJSON()` and validate the result.
      const converted = (value as { toJSON: () => unknown }).toJSON();
      if (!isFabricValueModern(converted)) {
        throw new Error(
          `\`toJSON()\` on ${typeof value} returned something other than a fabric value`,
        );
      }
      return cloneHelper(
        converted as FabricValue,
        freeze,
        false,
        false,
        null,
      ) as FabricValueLayer;
    }

    case NATIVE_TAGS.FabricInstance: {
      // `FabricInstance` values (`FabricError`, `UnknownValue`, etc.)
      // are already valid `FabricValue` members. Delegate frozenness
      // handling to `cloneHelper()`.
      return cloneHelper(
        value as FabricValue,
        freeze,
        false,
        false,
        null,
      ) as FabricValueLayer;
    }

    // deno-lint-ignore no-fallthrough
    case NATIVE_TAGS.Primitive: {
      // Primitives: `null`, `undefined`, `boolean`, `string`, `number`,
      // `bigint`, `symbol`, `function`. `null` is the only value here with
      // `typeof "object"` (actual objects are routed to other tags by
      // `tagFromNativeValue()`).
      switch (typeof value) {
        case "object":
          // Only `null` reaches here (`typeof null === "object"`).
          return null;
        case "undefined":
        case "boolean":
        case "string":
        case "number":
        case "bigint":
          return value;
        case "function":
          if (hasToJSONMethod(value)) {
            const converted = value.toJSON();
            if (!isFabricValueModern(converted)) {
              throw new Error(
                `\`toJSON()\` on function returned something other than a fabric value`,
              );
            }
            return converted;
          }
          throw new Error(
            "Cannot store function per se (needs to have a `toJSON()` method)",
          );
        case "symbol":
          // Registry-interned symbols are valid fabric primitives; unique
          // ones have no portable representation and are rejected.
          if (Symbol.keyFor(value) === undefined) {
            throw new Error("Cannot store unique (uninterned) symbol");
          }
          return value;
        default:
          throw new Error(
            `Shouldn't happen: Unrecognized type ${typeof value}`,
          );
      }
    }

    default:
      // Unrecognized object types (`Map`, `Set`, `Uint8Array`, class instances
      // without `toJSON()`, etc.) -- not valid `FabricValue`. Death before
      // confusion!
      throw new Error(
        `Cannot store ${
          (value as object).constructor?.name ?? typeof value
        } (not a recognized fabric type)`,
      );
  }
}

/**
 * Checks whether a value has a callable `toJSON()` method.
 *
 * TODO: Remove `toJSON()` support once all callers have migrated to
 * `[DECONSTRUCT]`. See spec Section 7.1.
 *
 * This function is a TypeScript type guard for `{ toJSON: () => unknown }`.
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

// Sentinel value used to indicate an object is currently being processed
// (ancestor in the tree). If we encounter this while recursing, we have a
// circular reference.
const PROCESSING = Symbol("PROCESSING");

/**
 * Performs recursive conversion from JS values to `FabricValue`. Single-pass:
 * wraps `Error` instances into `FabricError`, preserves `undefined`, and
 * deep-freezes each node as it's built (no separate freeze pass). If the
 * input is already a deep-frozen `FabricValue`, returns it as-is (identity
 * optimization).
 *
 * Used when the `modernDataModel` flag is ON.
 *
 * @param value - The value to convert.
 * @param freeze - When `true` (default), deep-freezes the result tree.
 *   When `false`, wrapping and validation still occur but the result is
 *   left mutable.
 */
export function fabricFromNativeValueModern(
  value: unknown,
  freeze = true,
): FabricValue {
  // Identity optimization: if the value is already a deep-frozen
  // `FabricValue`, return it without copying.
  if (freeze && isDeepFrozenFabricValue(value)) {
    return value;
  }
  return fabricFromNativeValueModernInternal(
    value,
    new Map(),
    freeze,
  );
}

/**
 * Helper for `fabricFromNativeValueModern()`, which performs the recursive
 * conversion for the modern path. Single-pass: checks, wraps, and optionally
 * freezes each node as it's built. By the time this returns, the whole tree
 * is converted and (if `freeze` is true) deep-frozen. Unlike the legacy
 * version, this never returns `OMIT` -- `undefined` values are preserved.
 */
function fabricFromNativeValueModernInternal(
  original: unknown,
  converted: Map<object, FabricValue>,
  freeze: boolean,
): FabricValue {
  const isOriginalRecord = isRecord(original);

  if (isOriginalRecord && converted.has(original)) {
    const cached = converted.get(original);
    if (cached === PROCESSING) {
      throw new Error("Cannot store circular reference");
    }
    return cached;
  }

  if (isOriginalRecord) {
    converted.set(original, PROCESSING);
  }

  // Try to convert the top level via the modern shallow converter.
  // Pass freeze=false: the deep path handles freezing its own newly-built
  // results; the shallow converter should not freeze anything.
  let value: FabricValueLayer;
  try {
    value = shallowFabricFromNativeValueModern(original, false);
  } catch (e) {
    if (isOriginalRecord) {
      converted.delete(original);
    }
    throw e;
  }

  // Primitives, `null`, and `undefined` don't need recursion or freezing.
  if (!isRecord(value)) {
    if (isOriginalRecord) {
      converted.set(original, value);
    }
    return value;
  }

  // `FabricError` has `FabricValue`-typed state slots (`cause`, `extra`) by
  // type contract, but the shallow conversion above copied them through from
  // the native `Error` as-is (where they may be raw `Error`, `Map`, etc.).
  // Rebuild via the deep recursion so the resulting `FabricError`'s slots
  // really are `FabricValue`.
  if (value instanceof FabricError) {
    const result = rebuildFabricErrorDeep(value, converted, freeze);
    if (freeze) Object.freeze(result);
    if (isOriginalRecord) {
      converted.set(original, result);
    }
    return result;
  }

  // `FabricSpecialObject` (primitives and protocol types) -- pass through
  // as-is. Primitives are always frozen; protocol types are managed by
  // the caller.
  if (value instanceof FabricSpecialObject) {
    if (isOriginalRecord) {
      converted.set(original, value);
    }
    return value;
  }

  let result: FabricValue;

  if (Array.isArray(value)) {
    // Recurse into array elements. Preserve `undefined` elements as-is.
    const resultArray: FabricValue[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        // Sparse hole -- preserve it by setting length without assigning.
        // This keeps the hole distinct from `undefined`.
        resultArray.length = i + 1;
      } else {
        resultArray[i] = fabricFromNativeValueModernInternal(
          value[i],
          converted,
          freeze,
        );
      }
    }
    if (freeze) Object.freeze(resultArray);
    result = resultArray;
  } else {
    // Recurse into object properties. Preserve `undefined`-valued properties.
    // Use `Object.create()` to preserve null prototypes (`Object.fromEntries()`
    // always produces `Object.prototype`-backed results).
    const proto = Object.getPrototypeOf(value);
    const obj = Object.create(proto) as Record<string, FabricValue>;
    for (const [key, val] of Object.entries(value)) {
      obj[key] = fabricFromNativeValueModernInternal(
        val,
        converted,
        freeze,
      );
    }
    if (freeze) Object.freeze(obj);
    result = obj;
  }

  if (isOriginalRecord) {
    converted.set(original, result);
  }

  return result;
}

/**
 * Creates a new `Error` with the same class and properties as the original,
 * but with `.cause` and custom enumerable properties recursively converted
 * to `FabricValue`. This ensures that when `FabricError[DECONSTRUCT]`
 * runs at serialization time, all nested values are already `FabricValue`.
 *
 * We create a new `Error` rather than mutating the original because the
 * caller's `Error` should not be modified as a side effect of storing it.
 */
function rebuildFabricErrorDeep(
  shallow: FabricError,
  converted: Map<object, FabricValue>,
  freeze: boolean,
): FabricError {
  // Recursively convert `.cause` -- it could be a raw `Error`, `Map`, etc.
  const cause = shallow.cause !== undefined
    ? fabricFromNativeValueModernInternal(shallow.cause, converted, freeze)
    : undefined;

  // Recursively convert custom enumerable properties.
  const extras: Array<[string, FabricValue]> = [];
  for (const [key, value] of shallow.extraEntries()) {
    extras.push([
      key,
      fabricFromNativeValueModernInternal(value, converted, freeze),
    ]);
  }

  return new FabricError({
    type: shallow.type,
    name: shallow.name,
    message: shallow.message,
    stack: shallow.stack,
    cause,
    extras,
  });
}

/**
 * Indicates whether the value is a fabric value, accepting `FabricInstance`
 * values, `undefined`, and arrays with `undefined` elements or sparse holes
 * -- in addition to the base fabric types (`null`, `boolean`, `number`,
 * `string`, plain objects, dense arrays).
 *
 * MUST be self-contained (inline base-type checks, does NOT delegate back to
 * `isFabricValue()`) to avoid circular dispatch when the `modernDataModel`
 * flag is ON. See session 2 notes about the stack overflow this caused.
 *
 * Used when the `modernDataModel` flag is ON.
 *
 * This function is a TypeScript type guard for `FabricValueLayer`.
 */
export function isFabricValueModern(
  value: unknown,
): value is FabricValueLayer {
  switch (typeof value) {
    case "boolean":
    case "string":
    case "number":
    case "bigint":
    case "undefined": {
      return true;
    }

    case "object": {
      if (value === null) {
        return true;
      }
      // `FabricSpecialObject` -- already a valid `FabricValue`.
      if (value instanceof FabricSpecialObject) {
        return true;
      }
      if (Array.isArray(value)) {
        // In the modern path, arrays with `undefined` elements and sparse holes
        // are accepted. Only reject arrays with non-index properties.
        return isArrayWithOnlyIndexProperties(value);
      }
      // Plain objects are accepted; class instances are not (except
      // `FabricInstance`, handled above).
      const proto = Object.getPrototypeOf(value);
      return proto === null || proto === Object.prototype;
    }

    case "symbol": {
      // Registry-interned symbols are valid fabric values; unique ones are not.
      return Symbol.keyFor(value) !== undefined;
    }

    case "function":
    default: {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// `isFabricCompatible()`: deep check for fabric compatibility
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `fabricFromNativeValue()` would succeed on the value --
 * i.e., the value is a `FabricValue`, a `FabricNativeObject`, or a deep
 * tree thereof.
 *
 * The distinction from `isFabricValue()` / `isFabricValueModern()`:
 * - `isFabricValueModern(x)` -- "is x already a `FabricValue`?"
 * - `isFabricCompatible(x)` -- "could x be converted to a `FabricValue` via
 *   `fabricFromNativeValue()`?"
 *
 * `isFabricCompatible()` additionally accepts `FabricNativeObject` types and
 * objects/functions with `toJSON()` methods
 * that return fabric values. It checks recursively, so all nested values in
 * arrays and objects must also be fabric-compatible or convertible.
 *
 * This function is a TypeScript type guard for `FabricValue | FabricNativeObject`.
 */
export function isFabricCompatibleModern(
  value: unknown,
): value is FabricValue | FabricNativeObject {
  return isFabricCompatibleInternal(value, new Set());
}

// ---------------------------------------------------------------------------
// Unified clone: `cloneIfNecessary()`
// ---------------------------------------------------------------------------

function isFabricCompatibleInternal(
  value: unknown,
  seen: Set<object>,
): boolean {
  // Primitives: `null`, `boolean`, `string`, `number`, `bigint`, `undefined`.
  if (value === null || value === undefined) return true;

  switch (typeof value) {
    case "boolean":
    case "string":
    case "number":
    case "bigint":
    case "undefined": {
      return true;
    }

    case "symbol": {
      // Registry-interned symbols are fabric-compatible; unique ones are not.
      return Symbol.keyFor(value) !== undefined;
    }

    case "function": {
      // Functions are only fabric-compatible if they have toJSON().
      if (hasToJSONMethod(value)) {
        const converted = value.toJSON();
        return isFabricCompatibleInternal(converted, seen);
      }
      return false;
    }

    case "object": {
      // `FabricSpecialObject` -- already a valid `FabricValue`.
      if (value instanceof FabricSpecialObject) return true;

      // `FabricNativeObject` types would be wrapped by `fabricFromNativeValue()`.
      if (isConvertibleNativeInstance(value)) {
        return true;
      }

      // Cycle detection for arrays and objects.
      if (seen.has(value)) return false;
      seen.add(value);

      if (Array.isArray(value)) {
        // Check array structure (no named properties).
        if (!isArrayWithOnlyIndexProperties(value)) {
          seen.delete(value);
          return false;
        }
        // Check all elements recursively.
        for (let i = 0; i < value.length; i++) {
          if (i in value && !isFabricCompatibleInternal(value[i], seen)) {
            seen.delete(value);
            return false;
          }
        }
        seen.delete(value);
        return true;
      }

      // Objects with toJSON() -- check the converted result.
      if (hasToJSONMethod(value)) {
        const converted = value.toJSON();
        const result = isFabricCompatibleInternal(converted, seen);
        seen.delete(value);
        return result;
      }

      // Class instances without toJSON() are not fabric-compatible.
      if (isInstance(value)) {
        seen.delete(value);
        return false;
      }

      // Plain objects -- check all property values recursively.
      for (const val of Object.values(value)) {
        if (!isFabricCompatibleInternal(val, seen)) {
          seen.delete(value);
          return false;
        }
      }
      seen.delete(value);
      return true;
    }

    default: {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Deep unwrap: `FabricValue` -> native JS types (modern path)
// ---------------------------------------------------------------------------

/**
 * Recursively walks a `FabricValue` tree, unwrapping any
 * `FabricNativeWrapper` values to their underlying native types via
 * `toNativeValue()`. Non-native `FabricInstance` values (`Cell`, `Stream`,
 * `UnknownValue`, etc.) pass through as-is.
 *
 * The freeze-state contract: the output's freeze state ALWAYS matches `frozen`.
 * Arrays and objects are copied and frozen/unfrozen accordingly. For
 * `FabricError`, the inner `Error`'s `.cause` and custom properties are also
 * recursively unwrapped (since they may contain `FabricInstance` wrappers).
 */
export function nativeFromFabricValueModern(
  value: FabricValue,
  frozen = true,
): unknown {
  if (value instanceof FabricError) {
    return deepUnwrapFabricError(value, frozen);
  }

  if (value instanceof FabricNativeWrapper) {
    return value.toNativeValue(frozen);
  }

  // Remaining `FabricSpecialObject` values (not `FabricNativeWrapper`) pass
  // through unchanged.
  if (value instanceof FabricSpecialObject) return value;

  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        result.length = i + 1;
      } else {
        result[i] = nativeFromFabricValueModern(
          value[i],
          frozen,
        );
      }
    }
    if (frozen) Object.freeze(result);
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (!UNSAFE_KEYS.has(key)) {
      result[key] = nativeFromFabricValueModern(val, frozen);
    }
  }
  if (frozen) Object.freeze(result);
  return result;
}

function deepUnwrapFabricError(fe: FabricError, frozen: boolean): Error {
  const type = fe.type;
  const name = fe.name ?? type;
  const ErrorClass = errorClassFromType(type);
  const copy = new ErrorClass(fe.message);
  if (copy.name !== name) copy.name = name;
  if (fe.stack !== undefined) copy.stack = fe.stack;

  if (fe.cause !== undefined) {
    copy.cause = nativeFromFabricValueModern(fe.cause, frozen);
  }

  for (const [key, value] of fe.extraEntries()) {
    (copy as unknown as Record<string, unknown>)[key] =
      nativeFromFabricValueModern(value, frozen);
  }

  if (frozen) Object.freeze(copy);
  return copy;
}
