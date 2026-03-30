import { isInstance, isRecord } from "@commontools/utils/types";
import {
  FabricInstance,
  type FabricNativeObject,
  FabricPrimitive,
  FabricSpecialObject,
  type FabricValue,
  type FabricValueLayer,
} from "./interface.ts";
import { FabricEpochNsec } from "./fabric-epoch.ts";
import {
  FabricError,
  FabricNativeWrapper,
  FabricRegExp,
  isConvertibleNativeInstance,
  UNSAFE_KEYS,
} from "./fabric-native-instances.ts";
import { FabricBytes } from "./fabric-bytes.ts";
import { NATIVE_TAGS, tagFromNativeValue } from "./native-type-tags.ts";
import { isArrayWithOnlyIndexProperties } from "./array-utils.ts";

/** Reject native objects with extra enumerable properties. */
function rejectExtraProperties(value: object, typeName: string): void {
  if (Object.keys(value).length > 0) {
    throw new Error(
      `Cannot store ${typeName} with extra enumerable properties`,
    );
  }
}

/**
 * Shallow conversion from JS values to `FabricValue`. Wraps `Error`
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
  // Top-level type dispatch via tagFromNativeValue() -- O(1) constructor
  // switch with fallbacks for exotic Error subclasses, cross-realm arrays,
  // and null-prototype objects. Returns Primitive for non-objects.
  const tag = tagFromNativeValue(value);

  switch (tag) {
    // Special primitives are direct FabricDatum members -- always frozen,
    // pass through as-is regardless of the `freeze` argument.
    case NATIVE_TAGS.EpochNsec:
    case NATIVE_TAGS.EpochDays:
    case NATIVE_TAGS.ContentHash:
    case NATIVE_TAGS.FabricBytes:
      return value as FabricValueLayer;

    case NATIVE_TAGS.Error: {
      const wrapped = new FabricError(value as Error);
      if (freeze) Object.freeze(wrapped);
      return wrapped;
    }

    case NATIVE_TAGS.Date: {
      // Date instances are converted to FabricEpochNsec (nanoseconds from
      // epoch). Extra enumerable properties cause rejection ("death before
      // confusion").
      rejectExtraProperties(value as object, "Date");
      const nsec = BigInt((value as Date).getTime()) * 1_000_000n;
      const wrapped = new FabricEpochNsec(nsec);
      if (freeze) Object.freeze(wrapped);
      return wrapped;
    }

    case NATIVE_TAGS.RegExp: {
      // RegExp instances are wrapped in FabricRegExp. Extra enumerable
      // properties cause rejection ("death before confusion"). The
      // rejectExtraProperties check is done inside FabricRegExp's
      // DECONSTRUCT, but we also reject eagerly here at conversion time.
      rejectExtraProperties(value as object, "RegExp");
      const wrappedRegExp = new FabricRegExp(value as RegExp);
      if (freeze) Object.freeze(wrappedRegExp);
      return wrappedRegExp;
    }

    case NATIVE_TAGS.Uint8Array: {
      // Native Uint8Array instances are wrapped in FabricBytes.
      // FabricBytes self-freezes in its constructor (FabricPrimitive contract).
      return new FabricBytes(value as Uint8Array);
    }

    case NATIVE_TAGS.Array:
    case NATIVE_TAGS.Object:
      // Arrays and plain objects: delegate frozenness handling to cloneHelper.
      return cloneHelper(
        value as FabricValue,
        freeze,
        false,
        false,
        null,
      ) as FabricValueLayer;

    case NATIVE_TAGS.HasToJSON: {
      // Objects (or arrays/class instances) with a toJSON() method.
      // Call toJSON() and validate the result.
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
      // FabricInstance values (FabricError, UnknownValue, etc.)
      // are already valid FabricValue members. Delegate frozenness
      // handling to cloneHelper.
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
      // Primitives: null, undefined, boolean, string, number, bigint,
      // symbol, function. null is the only value here with typeof "object"
      // (actual objects are routed to other tags by tagFromNativeValue).
      switch (typeof value) {
        case "object":
          // Only null reaches here (typeof null === "object").
          return null;
        case "undefined":
          return undefined;
        case "boolean":
        case "string":
          return value;
        case "number":
          if (Number.isFinite(value)) {
            return Object.is(value, -0) ? 0 : value;
          }
          throw new Error("Cannot store non-finite number");
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
          throw new Error(`Cannot store ${typeof value}`);
        default:
          throw new Error(
            `Shouldn't happen: Unrecognized type ${typeof value}`,
          );
      }
    }

    default:
      // Unrecognized object types (Map, Set, Uint8Array, class instances
      // without toJSON, etc.) -- not valid FabricValue. Death before
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
 * Recursive conversion from JS values to `FabricValue`. Single-pass:
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
  // FabricValue, return it without copying.
  if (freeze && isDeepFrozenFabricValue(value)) {
    return value as FabricValue;
  }
  return fabricFromNativeValueRichInternal(
    value,
    new Map(),
    freeze,
  ) as FabricValue;
}

/**
 * Naive recursive check: is the value a deep-frozen FabricValue?
 * Returns `true` if the value is a primitive, or a frozen object/array
 * whose children are all also deep-frozen FabricValues.
 */
function isDeepFrozenFabricValue(value: unknown): boolean {
  if (value === null || (typeof value !== "object")) return true; // primitives
  if (!Object.isFrozen(value)) return false;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (i in value && !isDeepFrozenFabricValue(value[i])) return false;
    }
    return true;
  }

  // `FabricPrimitive`s are by definition frozen and have no outbound
  // references.
  if (value instanceof FabricPrimitive) return true;

  // `FabricInstance`s might have references, but -- TODO(@danfuzz) -- we have
  // no way of handling them yet.
  if (value instanceof FabricInstance) {
    throw new Error(
      `Cannot yet handle instance of class ${value.constructor.name}`,
    );
  }

  for (const v of Object.values(value)) {
    if (!isDeepFrozenFabricValue(v)) return false;
  }
  return true;
}

/**
 * Internal recursive implementation for the rich path. Single-pass: checks,
 * wraps, and optionally freezes each node as it's built. By the time this
 * returns, the whole tree is converted and (if `freeze` is true) deep-frozen.
 * Unlike the legacy version, this never returns OMIT -- `undefined` values
 * are preserved.
 */
function fabricFromNativeValueRichInternal(
  original: unknown,
  converted: Map<object, unknown>,
  freeze: boolean,
): FabricValue {
  const isOriginalRecord = isRecord(original);

  if (isOriginalRecord && converted.has(original)) {
    const cached = converted.get(original);
    if (cached === PROCESSING) {
      throw new Error("Cannot store circular reference");
    }
    return cached as FabricValue;
  }

  if (isOriginalRecord) {
    converted.set(original, PROCESSING);
  }

  // Try to convert the top level via the rich shallow converter.
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

  // Primitives, null, and undefined don't need recursion or freezing.
  if (!isRecord(value)) {
    if (isOriginalRecord) {
      converted.set(original, value);
    }
    return value as FabricValue;
  }

  // TODO(danfuzz): Look into avoiding this special case for FabricError.
  // Ideally the recursive internals conversion would be handled generically
  // rather than requiring a type-specific branch here.
  //
  // FabricError wraps a raw Error whose internals (cause, custom
  // properties) may contain raw native types that aren't FabricValue.
  // We must recursively convert those internals NOW so that when
  // [DECONSTRUCT] runs at serialization time, all nested values are
  // already FabricValue. See spec: the conversion layer (not the
  // serializer) is responsible for ensuring this.
  if (value instanceof FabricError) {
    const convertedError = convertErrorInternals(
      value.error,
      converted,
      freeze,
    );
    const result = new FabricError(convertedError);
    if (freeze) Object.freeze(result);
    if (isOriginalRecord) {
      converted.set(original, result);
    }
    return result as FabricValue;
  }

  // FabricSpecialObject (primitives and protocol types) -- pass through
  // as-is. Primitives are always frozen; protocol types are managed by
  // the caller.
  if (value instanceof FabricSpecialObject) {
    if (isOriginalRecord) {
      converted.set(original, value);
    }
    return value as FabricValue;
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
        resultArray[i] = fabricFromNativeValueRichInternal(
          value[i],
          converted,
          freeze,
        );
      }
    }
    if (freeze) Object.freeze(resultArray);
    result = resultArray as FabricValue;
  } else {
    // Recurse into object properties. Preserve `undefined`-valued properties.
    // Use Object.create to preserve null prototypes (Object.fromEntries
    // always produces Object.prototype-backed results).
    const proto = Object.getPrototypeOf(value);
    const obj = Object.create(proto) as Record<string, FabricValue>;
    for (const [key, val] of Object.entries(value)) {
      obj[key] = fabricFromNativeValueRichInternal(
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
 * Creates a new Error with the same class and properties as the original,
 * but with `cause` and custom enumerable properties recursively converted
 * to `FabricValue`. This ensures that when `FabricError[DECONSTRUCT]`
 * runs at serialization time, all nested values are already `FabricValue`.
 *
 * We create a new Error rather than mutating the original because the
 * caller's Error should not be modified as a side effect of storing it.
 */
function convertErrorInternals(
  error: Error,
  converted: Map<object, unknown>,
  freeze: boolean,
): Error {
  // Construct the same Error subclass.
  const result = new (error.constructor as ErrorConstructor)(error.message);

  // Preserve name (covers custom names like "MyError").
  if (result.name !== error.name) {
    result.name = error.name;
  }

  // Preserve stack as-is (string, no conversion needed).
  if (error.stack !== undefined) {
    result.stack = error.stack;
  }

  // Recursively convert cause -- it could be a raw Error, Map, etc.
  if (error.cause !== undefined) {
    result.cause = fabricFromNativeValueRichInternal(
      error.cause,
      converted,
      freeze,
    );
  }

  // Recursively convert custom enumerable properties, skipping known Error
  // keys (handled above) and prototype-pollution-sensitive keys.
  const SKIP_KEYS = new Set(["name", "message", "stack", "cause"]);
  for (const key of Object.keys(error)) {
    if (SKIP_KEYS.has(key) || UNSAFE_KEYS.has(key)) continue;
    (result as unknown as Record<string, unknown>)[key] =
      fabricFromNativeValueRichInternal(
        (error as unknown as Record<string, unknown>)[key],
        converted,
        freeze,
      );
  }

  return result;
}

/**
 * Type guard that accepts `FabricInstance` values, `undefined`, and arrays
 * with `undefined` elements or sparse holes -- in addition to the base fabric
 * types (null, boolean, number, string, plain objects, dense arrays).
 *
 * MUST be self-contained (inline base-type checks, does NOT delegate back to
 * `isFabricValue()`) to avoid circular dispatch when the `modernDataModel`
 * flag is ON. See session 2 notes about the stack overflow this caused.
 *
 * Used when the `modernDataModel` flag is ON.
 */
export function isFabricValueModern(
  value: unknown,
): value is FabricValueLayer {
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
      // FabricSpecialObject -- already a valid FabricValue.
      if (value instanceof FabricSpecialObject) {
        return true;
      }
      if (Array.isArray(value)) {
        // In the rich path, arrays with `undefined` elements and sparse holes
        // are accepted. Only reject arrays with non-index properties.
        return isArrayWithOnlyIndexProperties(value);
      }
      // Plain objects are accepted; class instances are not (except
      // FabricInstance, handled above).
      const proto = Object.getPrototypeOf(value);
      return proto === null || proto === Object.prototype;
    }

    case "bigint": {
      return true;
    }

    case "function":
    case "symbol":
    default: {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// canBeStored: deep check for fabric compatibility
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `fabricFromNativeValue()` would succeed on the value --
 * i.e., the value is a `FabricValue`, a `FabricNativeObject`, or a deep
 * tree thereof.
 *
 * The distinction from `isFabricValue()` / `isFabricValueModern()`:
 * - `isFabricValueModern(x)` -- "is x already a `FabricValue`?"
 * - `canBeStored(x)` -- "could x be converted to a `FabricValue` via
 *   `fabricFromNativeValue()`?"
 *
 * `canBeStored` additionally accepts `FabricNativeObject` types and
 * objects/functions with `toJSON()` methods
 * that return fabric values. It checks recursively, so all nested values in
 * arrays and objects must also be fabric-compatible or convertible.
 */
export function canBeStoredRich(
  value: unknown,
): value is FabricValue | FabricNativeObject {
  return canBeStoredInternal(value, new Set());
}

// ---------------------------------------------------------------------------
// Unified clone: cloneIfNecessary
// ---------------------------------------------------------------------------

/**
 * Options for `cloneIfNecessary`.
 */
export interface CloneOptions {
  /** Whether the result should be frozen. Default: `true`. */
  frozen?: boolean;
  /** Whether to clone deeply or shallowly. Default: `true`. */
  deep?: boolean;
  /**
   * Force a copy to be made.
   *
   * - When `frozen = false`: defaults to `true` (always clone to guarantee
   *   mutable isolation).
   * - When `frozen = true`: defaults to `false` (clone only if necessary
   *   to achieve frozenness).
   * - `{ frozen: true, force: true }` is an error (pointless to force-copy
   *   something that will be immutable anyway).
   * - `{ frozen: false, force: false, deep: false }`: valid -- caller owns
   *   the reference and wants it mutable; thaws if frozen, returns as-is
   *   if already mutable.
   * - `{ frozen: false, force: false, deep: true }`: error -- ambiguous
   *   semantics for trees with mixed frozenness.
   */
  force?: boolean;
}

/**
 * Clone an already-valid `FabricValue` to achieve a desired frozenness,
 * with control over depth and copy semantics.
 *
 * Unlike `fabricFromNativeValue` (which converts native JS values into
 * fabric wrappers), this function assumes the input is already a valid
 * `FabricValue` and only adjusts frozenness by cloning where necessary.
 *
 * Callers must resolve `CloneOptions` defaults and validate before calling;
 * the dispatcher in `fabric-value.ts` handles that.
 *
 * @param value - An already-valid `FabricValue`.
 * @param frozen - Whether the result should be frozen.
 * @param deep - Whether to clone deeply or shallowly.
 * @param force - Whether to force a copy.
 */
export function cloneIfNecessaryRich(
  value: FabricValue,
  frozen: boolean,
  deep: boolean,
  force: boolean,
): FabricValue {
  return cloneHelper(value, frozen, deep, force, null);
}

/**
 * Track an object for circular reference detection during deep cloning.
 * Lazily allocates the `seen` set on first use, throws if a cycle is
 * detected, and adds the object to the set. Returns the (possibly
 * newly-allocated) set.
 */
function trackForCircularity(
  obj: object,
  seen: Set<object> | null,
): Set<object> {
  seen ??= new Set();
  if (seen.has(obj)) {
    throw new Error("Cannot deep-clone circular reference");
  }
  seen.add(obj);
  return seen;
}

/**
 * Unified clone helper for both shallow and deep modes.
 *
 * When `deep` is true, recursively clones containers and detects circular
 * references via `seen`. When `deep` is false, copies only the top-level
 * container (children are shared by reference).
 *
 * When `force` is false, returns the value as-is if its frozenness already
 * matches the requested state. When `force` is true, always copies (unless
 * the value is a primitive or special primitive).
 *
 * Deep mode uses `isDeepFrozenFabricValue` for identity optimization;
 * shallow mode uses `Object.isFrozen(value) === frozen`.
 */
function cloneHelper(
  value: FabricValue,
  frozen: boolean,
  deep: boolean,
  force: boolean,
  seen: Set<object> | null,
): FabricValue {
  // Identity optimization: when force is off, check if the value's frozenness
  // already matches the requested state. Deep mode uses isDeepFrozenFabricValue;
  // shallow mode uses Object.isFrozen(v) === frozen.
  function canReturnAsIs(v: FabricValue): boolean {
    if (force) return false;
    if (deep) {
      if (frozen && isDeepFrozenFabricValue(v)) return true;
      if (!frozen && !Object.isFrozen(v)) return true;
      return false;
    }
    return Object.isFrozen(v) === frozen;
  }

  switch (tagFromNativeValue(value)) {
    // Inherently immutable types -- frozenness is irrelevant, no cloning
    // needed regardless of force.
    case NATIVE_TAGS.Primitive:
    case NATIVE_TAGS.EpochNsec:
    case NATIVE_TAGS.EpochDays:
    case NATIVE_TAGS.ContentHash:
    case NATIVE_TAGS.FabricBytes:
      return value;

    case NATIVE_TAGS.FabricInstance:
      // Identity optimization: already-correct frozenness needs no clone.
      if (canReturnAsIs(value)) return value;
      return (value as FabricInstance).shallowClone(frozen) as FabricValue;

    case NATIVE_TAGS.Array: {
      if (canReturnAsIs(value)) return value;
      const arr = value as FabricValue[];
      if (deep) seen = trackForCircularity(arr, seen);
      const copy: FabricValue[] = new Array(arr.length);
      for (let i = 0; i < arr.length; i++) {
        if (i in arr) {
          copy[i] = deep
            ? cloneHelper(arr[i], frozen, deep, force, seen)
            : arr[i];
        }
      }
      if (deep) seen!.delete(arr);
      if (frozen) Object.freeze(copy);
      return copy;
    }

    case NATIVE_TAGS.Object: {
      if (canReturnAsIs(value)) return value;
      const obj = value as object;
      if (deep) seen = trackForCircularity(obj, seen);
      // Preserve null prototypes (e.g. Object.create(null)).
      const proto = Object.getPrototypeOf(obj);
      const copy = Object.create(proto) as Record<string, FabricValue>;
      if (deep) {
        for (const [key, val] of Object.entries(obj)) {
          copy[key] = cloneHelper(
            val as FabricValue,
            frozen,
            deep,
            force,
            seen,
          );
        }
        seen!.delete(obj);
      } else {
        Object.assign(copy, value as Record<string, unknown>);
      }
      if (frozen) Object.freeze(copy);
      return copy;
    }

    default:
      // All valid FabricValue types are handled above.
      throw new Error(
        `Cannot clone: ${(value as object).constructor?.name ?? typeof value}`,
      );
  }
}

function canBeStoredInternal(value: unknown, seen: Set<object>): boolean {
  // Primitives: null, boolean, string, number (finite), bigint, undefined.
  if (value === null || value === undefined) return true;

  switch (typeof value) {
    case "boolean":
    case "string":
    case "bigint":
    case "undefined": {
      return true;
    }

    case "number": {
      return Number.isFinite(value);
    }

    case "symbol":
    case "function": {
      // Functions are only fabric-compatible if they have toJSON().
      if (typeof value === "function" && hasToJSONMethod(value)) {
        const converted = value.toJSON();
        return canBeStoredInternal(converted, seen);
      }
      return false;
    }

    case "object": {
      // FabricSpecialObject -- already a valid FabricValue.
      if (value instanceof FabricSpecialObject) return true;

      // FabricNativeObject types would be wrapped by fabricFromNativeValue().
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
          if (i in value && !canBeStoredInternal(value[i], seen)) {
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
        const result = canBeStoredInternal(converted, seen);
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
        if (!canBeStoredInternal(val, seen)) {
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
// Deep unwrap: FabricValue -> native JS types (modern path)
// ---------------------------------------------------------------------------

/**
 * Deep unwrap: recursively walk a `FabricValue` tree, unwrapping any
 * `FabricNativeWrapper` values to their underlying native types via
 * `toNativeValue()`. Non-native `FabricInstance` values (Cell, Stream,
 * UnknownValue, etc.) pass through as-is.
 *
 * The freeze-state contract: the output's freeze state ALWAYS matches `frozen`.
 * Arrays and objects are copied and frozen/unfrozen accordingly. For
 * `FabricError`, the inner Error's `cause` and custom properties are also
 * recursively unwrapped (since they may contain `FabricInstance` wrappers).
 */
export function nativeFromFabricValueModern(
  value: FabricValue,
  frozen = true,
): unknown {
  if (value instanceof FabricError) {
    return deepUnwrapError(value.error, frozen);
  }

  if (value instanceof FabricNativeWrapper) {
    return value.toNativeValue(frozen);
  }

  // Remaining FabricSpecialObject values (not FabricNativeWrapper) pass
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
          value[i] as FabricValue,
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
      result[key] = nativeFromFabricValueModern(
        val as FabricValue,
        frozen,
      );
    }
  }
  if (frozen) Object.freeze(result);
  return result;
}

function deepUnwrapError(error: Error, frozen: boolean): Error {
  const copy = new (error.constructor as ErrorConstructor)(error.message);
  if (copy.name !== error.name) copy.name = error.name;
  if (error.stack !== undefined) copy.stack = error.stack;

  if (error.cause !== undefined) {
    copy.cause = nativeFromFabricValueModern(
      error.cause as FabricValue,
      frozen,
    );
  }

  const SKIP = new Set(["name", "message", "stack", "cause"]);
  for (const key of Object.keys(error)) {
    if (SKIP.has(key) || UNSAFE_KEYS.has(key)) continue;
    (copy as unknown as Record<string, unknown>)[key] =
      nativeFromFabricValueModern(
        (error as unknown as Record<string, unknown>)[key] as FabricValue,
        frozen,
      );
  }

  if (frozen) Object.freeze(copy);
  return copy;
}
