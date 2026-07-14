import {
  isInstance,
  isRecord,
  isUnsafeObjectKey,
} from "@commonfabric/utils/types";
import { isArrayWithOnlyIndexProperties } from "@commonfabric/utils/arrays";

import {
  type FabricNativeObject,
  FabricSpecialObject,
  type FabricValue,
  type FabricValueLayer,
} from "./interface.ts";
import { isFabricValueLayer } from "./type-check.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricNativeWrapper } from "@/fabric-instances/FabricNativeWrapper.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { NATIVE_TAGS, tagFromNativeValue } from "./native-type-tags.ts";
import { cloneHelper } from "./value-clone.ts";
import { deepFreeze, isDeepFrozenFabricValue } from "./deep-freeze.ts";
import { isAdmittedFabricFactory, sealFactoryState } from "./fabric-factory.ts";

/**
 * Helper for `shallowFabricFromNativeValue()`, which rejects native objects
 * with extra enumerable properties.
 */
function rejectExtraProperties(value: object, typeName: string): void {
  if (Object.keys(value).length > 0) {
    throw new Error(
      `Cannot store ${typeName} with extra enumerable properties`,
    );
  }
}

/**
 * Returns `true` if the value is a native JS object type that the fabric
 * system knows how to wrap. These are the "wild-west" instances that get
 * converted into `FabricNativeWrapper` subclasses, `FabricPrimitive` types,
 * or `FabricInstance` types by the conversion layer.
 *
 * Arrays, plain objects, objects with `toJSON()`, and system-defined special
 * primitives are recognized by `tagFromNativeValue()` but are NOT convertible
 * native instances -- they have their own handling paths in the conversion
 * layer.
 */
export function isConvertibleNativeInstance(value: object): boolean {
  switch (tagFromNativeValue(value)) {
    case NATIVE_TAGS.Error:
    case NATIVE_TAGS.Map:
    case NATIVE_TAGS.Set:
    case NATIVE_TAGS.Date:
    case NATIVE_TAGS.Uint8Array:
    case NATIVE_TAGS.RegExp:
      return true;
    default:
      return false;
  }
}

/** Map from Error subclass name to its constructor. */
const ERROR_CLASS_BY_TYPE: ReadonlyMap<string, ErrorConstructor> = new Map([
  ["TypeError", TypeError],
  ["RangeError", RangeError],
  ["SyntaxError", SyntaxError],
  ["ReferenceError", ReferenceError],
  ["URIError", URIError],
  ["EvalError", EvalError],
]);

/**
 * Helper for `FabricError`'s codec `decode()`, which returns the `Error`
 * constructor for the given type string (e.g. `"TypeError"`). Falls back
 * to the base `Error` constructor for unknown types.
 */
export function errorClassFromType(type: string): ErrorConstructor {
  return ERROR_CLASS_BY_TYPE.get(type) ?? Error;
}

/**
 * Performs shallow conversion from JS values to `FabricValue`. If the value is
 * already a frozen `FabricValue`, returns it as-is (identity optimization).
 *
 * @param value - The value to convert.
 * @param freeze - When `true` (default), freezes the result if it is an
 *   object or array. When `false`, wrapping and validation still occur but
 *   the result is left mutable. Factory atoms are always sealed and frozen.
 */
export function shallowFabricFromNativeValue(
  value: unknown,
  freeze = true,
): FabricValueLayer {
  // Admitted callable factories are already Fabric values. This check must
  // precede native function dispatch so a legacy `toJSON()` property cannot
  // replace their canonical FactoryCodec representation.
  if (isAdmittedFabricFactory(value)) {
    return deepFreeze(value);
  }

  // Top-level type dispatch via `tagFromNativeValue()` -- O(1) constructor
  // switch with fallbacks for exotic `Error` subclasses, cross-realm arrays,
  // and null-prototype objects. Returns `Primitive` for non-objects.
  const tag = tagFromNativeValue(value);

  switch (tag) {
    // Special primitives are direct `FabricValue` members -- always frozen,
    // pass through as-is regardless of the `freeze` argument.
    case NATIVE_TAGS.EpochNsec:
    case NATIVE_TAGS.EpochDays:
    case NATIVE_TAGS.FabricBytes:
    case NATIVE_TAGS.FabricRegExp:
    case NATIVE_TAGS.Hash:
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
      // `RegExp` instances are converted to `FabricRegExp`, which rejects extra
      // enumerable properties and self-freezes in its constructor.
      return new FabricRegExp(value as RegExp);
    }

    case NATIVE_TAGS.Uint8Array: {
      // Native `Uint8Array` instances are wrapped in `FabricBytes`.
      // `FabricBytes` self-freezes in its constructor (`FabricPrimitive` contract).
      return new FabricBytes(value as Uint8Array);
    }

    case NATIVE_TAGS.Array: {
      // Arrays may only carry numeric index properties. An enumerable named
      // property has no fabric representation, so reject it outright rather
      // than silently dropping it ("death before confusion").
      if (!isArrayWithOnlyIndexProperties(value as unknown[])) {
        throw new Error(
          "Cannot store array with enumerable named properties",
        );
      }
      // Delegate frozenness handling to `cloneHelper()`.
      return cloneHelper(
        value as FabricValue,
        freeze,
        false,
        false,
        null,
      ) as FabricValueLayer;
    }

    case NATIVE_TAGS.Object:
      // Plain objects: delegate frozenness handling to `cloneHelper()`.
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
      if (!isFabricValueLayer(converted)) {
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
            if (!isFabricValueLayer(converted)) {
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
 * `[CODEC]`-based encoding. See spec Section 7.1.
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
 * Performs recursive conversion from JS values to `FabricValue`. If the input
 * is already a deep-frozen `FabricValue`, returns it as-is (identity
 * optimization).
 *
 * @param value - The value to convert.
 * @param freeze - When `true` (default), deep-freezes the result tree.
 *   When `false`, wrapping and validation still occur but the result is
 *   left mutable, except that factory atoms are always sealed and frozen.
 */
export function fabricFromNativeValue(
  value: unknown,
  freeze = true,
): FabricValue {
  // Identity optimization: if the value is already a deep-frozen
  // `FabricValue`, return it without copying.
  if (freeze && isDeepFrozenFabricValue(value)) {
    return value;
  }
  return fabricFromNativeValueInternal(
    value,
    new Map(),
    freeze,
  );
}

/**
 * Helper for `fabricFromNativeValue()`, which performs the recursive
 * conversion.
 */
function fabricFromNativeValueInternal(
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

  // Try to convert the top level via the shallow converter. Pass
  // `freeze=false`: the deep path handles freezing its own newly-built results;
  // the shallow converter should not freeze anything.
  let value: FabricValueLayer;
  try {
    value = shallowFabricFromNativeValue(original, false);
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
        resultArray[i] = fabricFromNativeValueInternal(
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
      obj[key] = fabricFromNativeValueInternal(
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
 * to `FabricValue`. This ensures that when `FabricError`'s `[CODEC]` encodes
 * at serialization time, all nested values are already `FabricValue`.
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
    ? fabricFromNativeValueInternal(shallow.cause, converted, freeze)
    : undefined;

  // Recursively convert custom enumerable properties.
  const extras: Array<[string, FabricValue]> = [];
  for (const [key, value] of shallow.extraEntries()) {
    extras.push([
      key,
      fabricFromNativeValueInternal(value, converted, freeze),
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
 * Returns `true` if `fabricFromNativeValue()` would succeed on the value, that
 * is, if the value is a `FabricValue`, a `FabricNativeObject`, or a deep tree
 * thereof.
 *
 * The distinction from `isFabricValueLayer()`:
 * - `isFabricValueLayer(x)`: "is x already a `FabricValue`?" but only a shallow
 *   check.
 * - `isFabricCompatible(x)`: "could x be converted to a `FabricValue` via
 *   `fabricFromNativeValue()`?"
 *
 * `isFabricCompatible()` additionally accepts `FabricNativeObject` types and
 * objects/functions with `toJSON()` methods that return fabric values. It
 * checks recursively, so all nested values in arrays and objects must also be
 * fabric-compatible or convertible.
 *
 * This function is a TypeScript type guard for `FabricValue | FabricNativeObject`.
 */
export function isFabricCompatible(
  value: unknown,
): value is FabricValue | FabricNativeObject {
  return isFabricCompatibleInternal(value, new Set());
}

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
      if (isAdmittedFabricFactory(value)) {
        try {
          // Conversion seals the atom through the same path. In particular, a
          // trusted live builder factory is not yet a Fabric-compatible value
          // while its complete content-addressed artifact ref is unavailable.
          sealFactoryState(value);
          return true;
        } catch {
          return false;
        }
      }
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

/**
 * Recursively walks a `FabricValue` tree, unwrapping any `FabricNativeWrapper`
 * values to their underlying native types via `toNativeValue()`. Non-native
 * `FabricInstance` values (e.g., `UnknownValue`) pass through as-is.
 *
 * The freeze-state contract: the output's freeze state matches `frozen`, except
 * that instances of classes that are defined to always be frozen and admitted
 * factory atoms are returned frozen, no matter the value of `frozen`.
 */
export function nativeFromFabricValue(
  value: FabricValue,
  frozen = true,
): FabricValue | FabricNativeObject {
  if (typeof value === "function") {
    if (!isAdmittedFabricFactory(value)) {
      throw new TypeError(
        "Cannot convert arbitrary function presented as a Fabric value",
      );
    }
    return deepFreeze(value);
  }

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
        result[i] = nativeFromFabricValue(
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
    if (!isUnsafeObjectKey(key)) {
      result[key] = nativeFromFabricValue(val, frozen);
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
    copy.cause = nativeFromFabricValue(fe.cause, frozen);
  }

  for (const [key, value] of fe.extraEntries()) {
    (copy as unknown as Record<string, unknown>)[key] = nativeFromFabricValue(
      value,
      frozen,
    );
  }

  if (frozen) Object.freeze(copy);
  return copy;
}
