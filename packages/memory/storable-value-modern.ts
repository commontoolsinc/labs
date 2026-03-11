import { isInstance, isRecord } from "@commontools/utils/types";
import type {
  StorableNativeObject,
  StorableValue,
  StorableValueLayer,
} from "./interface.ts";
import {
  isStorableInstance,
  type StorableInstance,
} from "./storable-protocol.ts";
import { SpecialPrimitiveValue } from "./special-primitive-value.ts";
import {
  isConvertibleNativeInstance,
  StorableEpochNsec,
  StorableError,
  StorableRegExp,
  UNSAFE_KEYS,
} from "./storable-native-instances.ts";
import {
  NATIVE_TAGS,
  type NativeTag,
  tagFromNativeValue,
} from "./type-tags.ts";
import { isArrayWithOnlyIndexProperties } from "./storable-value-utils.ts";

/**
 * Shallow-clone a `StorableValueLayer` to achieve a desired frozenness.
 *
 * Given a value that is already a valid storable value (or layer), returns it
 * with the requested frozenness, shallow-cloning only when the current
 * frozenness mismatches the requested `frozen` flag.
 *
 * - Primitives (including `SpecialPrimitiveValue`) are returned as-is --
 *   frozenness does not apply.
 * - `StorableInstance` values: delegated to the protocol's `shallowClone`
 *   method, which handles frozenness per each concrete class.
 * - Arrays: shallow-copied (preserving sparse holes) when frozenness differs.
 * - Plain objects: shallow-copied via spread when frozenness differs.
 * - `HasToJSON` and raw native instances: throw. These should not reach here;
 *   callers must resolve them before calling this function.
 *
 * This centralizes the clone-for-frozenness logic that was previously
 * sprinkled across `toRichStorableValue`.
 */
function shallowCloneIfNecessary(
  value: StorableValueLayer,
  frozen: boolean,
  tag?: NativeTag | null,
): StorableValueLayer {
  switch (tag ?? tagFromNativeValue(value)) {
    // Primitives (null, undefined, boolean, number, string, bigint) are
    // unaffected by frozenness.
    case NATIVE_TAGS.Primitive:
    // Special primitives behave like true primitives -- always frozen,
    // returned as-is regardless of the `frozen` argument.
    case NATIVE_TAGS.EpochNsec:
    case NATIVE_TAGS.EpochDays:
    case NATIVE_TAGS.ContentId:
      return value;

    case NATIVE_TAGS.Array: {
      if (Object.isFrozen(value) === frozen) return value;
      // Shallow-copy preserving sparse holes.
      const arr = value as unknown[];
      const copy = new Array(arr.length);
      for (let i = 0; i < arr.length; i++) {
        if (i in arr) copy[i] = arr[i];
      }
      return frozen ? Object.freeze(copy) : copy;
    }

    case NATIVE_TAGS.Object: {
      if (Object.isFrozen(value) === frozen) return value;
      // Plain object -- shallow-copy via spread.
      const copy = { ...(value as Record<string, unknown>) };
      return frozen ? Object.freeze(copy) : copy;
    }

    case NATIVE_TAGS.StorableInstance:
      // StorableInstance values delegate to the protocol's shallowClone
      // method, which handles frozenness per each concrete class.
      return (value as StorableInstance).shallowClone(
        frozen,
      ) as StorableValueLayer;

    case NATIVE_TAGS.HasToJSON:
      // HasToJSON is nascently deprecated; callers should resolve toJSON()
      // before reaching shallowCloneIfNecessary. Death before confusion!
      throw new Error("Cannot shallow-clone HasToJSON values");

    default:
      // Convertible native instances (Error, Map, Set, etc.) should never
      // reach here -- they are wrapped before being stored as
      // StorableValueLayer. If they do, something is wrong.
      throw new Error(
        `Cannot shallow-clone: ${
          (value as object).constructor?.name ?? "unknown"
        }`,
      );
  }
}

/** Reject native objects with extra enumerable properties. */
function rejectExtraProperties(value: object, typeName: string): void {
  if (Object.keys(value).length > 0) {
    throw new Error(
      `Cannot store ${typeName} with extra enumerable properties`,
    );
  }
}

/**
 * Shallow conversion from JS values to `StorableValue`. Wraps `Error`
 * instances into `StorableError`; preserves `undefined`; optionally freezes
 * the result if it is an object or array. If the value is already a frozen
 * `StorableValue`, returns it as-is (identity optimization).
 *
 * This function is self-contained (does not delegate back to `shallowStorableFromNativeValue`)
 * to avoid circular dispatch when the `richStorableValues` flag is ON.
 *
 * Used when the `richStorableValues` flag is ON.
 *
 * @param value - The value to convert.
 * @param freeze - When `true` (default), freezes the result if it is an
 *   object or array. When `false`, wrapping and validation still occur but
 *   the result is left mutable.
 */
export function toRichStorableValue(
  value: unknown,
  freeze = true,
): StorableValueLayer {
  // Top-level type dispatch via tagFromNativeValue() -- O(1) constructor
  // switch with fallbacks for exotic Error subclasses, cross-realm arrays,
  // and null-prototype objects. Returns Primitive for non-objects.
  const tag = tagFromNativeValue(value);

  switch (tag) {
    // Special primitives are direct StorableDatum members -- always frozen,
    // pass through as-is regardless of the `freeze` argument.
    case NATIVE_TAGS.EpochNsec:
    case NATIVE_TAGS.EpochDays:
    case NATIVE_TAGS.ContentId:
      return value as StorableValueLayer;

    case NATIVE_TAGS.Error: {
      const wrapped = new StorableError(value as Error);
      if (freeze) Object.freeze(wrapped);
      return wrapped;
    }

    case NATIVE_TAGS.Date: {
      // Date instances are converted to StorableEpochNsec (nanoseconds from
      // epoch). Extra enumerable properties cause rejection ("death before
      // confusion").
      rejectExtraProperties(value as object, "Date");
      const nsec = BigInt((value as Date).getTime()) * 1_000_000n;
      const wrapped = new StorableEpochNsec(nsec);
      if (freeze) Object.freeze(wrapped);
      return wrapped;
    }

    case NATIVE_TAGS.RegExp: {
      // RegExp instances are wrapped in StorableRegExp. Extra enumerable
      // properties cause rejection ("death before confusion"). The
      // rejectExtraProperties check is done inside StorableRegExp's
      // DECONSTRUCT, but we also reject eagerly here at conversion time.
      rejectExtraProperties(value as object, "RegExp");
      const wrappedRegExp = new StorableRegExp(value as RegExp);
      if (freeze) Object.freeze(wrappedRegExp);
      return wrappedRegExp;
    }

    case NATIVE_TAGS.Array:
    case NATIVE_TAGS.Object:
      // Arrays and plain objects: delegate frozenness handling to
      // shallowCloneIfNecessary, passing the already-computed tag.
      return shallowCloneIfNecessary(
        value as StorableValueLayer,
        freeze,
        tag,
      );

    case NATIVE_TAGS.HasToJSON: {
      // Objects (or arrays/class instances) with a toJSON() method.
      // Call toJSON() and validate the result.
      const converted = (value as { toJSON: () => unknown }).toJSON();
      if (!isRichStorableValue(converted)) {
        throw new Error(
          `\`toJSON()\` on ${typeof value} returned something other than a storable value`,
        );
      }
      return shallowCloneIfNecessary(
        converted as StorableValueLayer,
        freeze,
      );
    }

    case NATIVE_TAGS.StorableInstance: {
      // StorableInstance values (StorableError, UnknownStorable, etc.)
      // are already valid StorableValue members. Delegate frozenness to
      // the protocol's shallowClone method.
      return shallowCloneIfNecessary(
        value as StorableValueLayer,
        freeze,
        tag,
      );
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
            if (!isRichStorableValue(converted)) {
              throw new Error(
                `\`toJSON()\` on function returned something other than a storable value`,
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
      // without toJSON, etc.) -- not valid StorableValue. Death before
      // confusion!
      throw new Error(
        `Cannot store ${
          (value as object).constructor?.name ?? typeof value
        } (not a recognized storable type)`,
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
 * Recursive conversion from JS values to `StorableValue`. Single-pass:
 * wraps `Error` instances into `StorableError`, preserves `undefined`, and
 * deep-freezes each node as it's built (no separate freeze pass). If the
 * input is already a deep-frozen `StorableValue`, returns it as-is (identity
 * optimization).
 *
 * Used when the `richStorableValues` flag is ON.
 *
 * @param value - The value to convert.
 * @param freeze - When `true` (default), deep-freezes the result tree.
 *   When `false`, wrapping and validation still occur but the result is
 *   left mutable.
 */
export function toDeepRichStorableValue(
  value: unknown,
  freeze = true,
): StorableValue {
  // Identity optimization: if the value is already a deep-frozen
  // StorableValue, return it without copying.
  if (freeze && isDeepFrozenStorableValue(value)) {
    return value as StorableValue;
  }
  return toDeepRichStorableValueInternal(
    value,
    new Map(),
    freeze,
  ) as StorableValue;
}

/**
 * Naive recursive check: is the value a deep-frozen StorableValue?
 * Returns `true` if the value is a primitive, or a frozen object/array
 * whose children are all also deep-frozen StorableValues.
 */
function isDeepFrozenStorableValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object") return true; // primitives
  if (!Object.isFrozen(value)) return false;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (i in value && !isDeepFrozenStorableValue(value[i])) return false;
    }
    return true;
  }

  // Special primitives are simple frozen value wrappers.
  if (value instanceof SpecialPrimitiveValue) {
    return true;
  }

  // StorableInstance -- check if frozen; don't recurse into its properties
  // (it's a protocol type, not a plain data container).
  if (isStorableInstance(value)) return true;

  for (const v of Object.values(value)) {
    if (!isDeepFrozenStorableValue(v)) return false;
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
function toDeepRichStorableValueInternal(
  original: unknown,
  converted: Map<object, unknown>,
  freeze: boolean,
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
  // Pass freeze=false: the deep path handles freezing its own newly-built
  // results; the shallow converter should not freeze anything.
  let value: StorableValueLayer;
  try {
    value = toRichStorableValue(original, false);
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
    return value as StorableValue;
  }

  // TODO(danfuzz): Look into avoiding this special case for StorableError.
  // Ideally the recursive internals conversion would be handled generically
  // rather than requiring a type-specific branch here.
  //
  // StorableError wraps a raw Error whose internals (cause, custom
  // properties) may contain raw native types that aren't StorableValue.
  // We must recursively convert those internals NOW so that when
  // [DECONSTRUCT] runs at serialization time, all nested values are
  // already StorableValue. See spec: the conversion layer (not the
  // serializer) is responsible for ensuring this.
  if (value instanceof StorableError) {
    const convertedError = convertErrorInternals(
      value.error,
      converted,
      freeze,
    );
    const result = new StorableError(convertedError);
    if (freeze) Object.freeze(result);
    if (isOriginalRecord) {
      converted.set(original, result);
    }
    return result as StorableValue;
  }

  // Special primitives are direct StorableDatum members -- always frozen,
  // pass through as-is regardless of the `freeze` argument.
  if (value instanceof SpecialPrimitiveValue) {
    if (isOriginalRecord) {
      converted.set(original, value);
    }
    return value as StorableValue;
  }

  // Other StorableInstance values (Cell, Stream, UnknownStorable, etc.)
  // don't need recursion -- their [DECONSTRUCT] implementations return
  // proper StorableValue. We do not freeze protocol objects; they are
  // managed by the caller.
  if (isStorableInstance(value)) {
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
          freeze,
        );
      }
    }
    if (freeze) Object.freeze(resultArray);
    result = resultArray as StorableValue;
  } else {
    // Recurse into object properties. Preserve `undefined`-valued properties.
    const entries: [string, StorableValue][] = [];
    for (const [key, val] of Object.entries(value)) {
      const convertedVal = toDeepRichStorableValueInternal(
        val,
        converted,
        freeze,
      );
      entries.push([key, convertedVal]);
    }
    const obj = Object.fromEntries(entries);
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
 * to `StorableValue`. This ensures that when `StorableError[DECONSTRUCT]`
 * runs at serialization time, all nested values are already `StorableValue`.
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
    result.cause = toDeepRichStorableValueInternal(
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
      toDeepRichStorableValueInternal(
        (error as unknown as Record<string, unknown>)[key],
        converted,
        freeze,
      );
  }

  return result;
}

/**
 * Type guard that accepts `StorableInstance` values, `undefined`, and arrays
 * with `undefined` elements or sparse holes -- in addition to the base storable
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
      // Special primitives are direct StorableDatum members.
      if (value instanceof SpecialPrimitiveValue) {
        return true;
      }
      // StorableInstance values (including StorableError, UnknownStorable,
      // etc.) are accepted -- they are valid StorableValue members via the
      // StorableInstance arm of StorableDatum.
      if (isStorableInstance(value)) {
        return true;
      }
      if (Array.isArray(value)) {
        // In the rich path, arrays with `undefined` elements and sparse holes
        // are accepted. Only reject arrays with non-index properties.
        return isArrayWithOnlyIndexProperties(value);
      }
      // Plain objects are accepted; class instances are not (except
      // StorableInstance, handled above).
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
// canBeStored: deep check for storability (StorableValue | StorableNativeObject)
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `toDeepStorableValue()` would succeed on the value --
 * i.e., the value is a `StorableValue`, a `StorableNativeObject`, or a deep
 * tree thereof.
 *
 * The distinction from `isStorableValue()` / `isRichStorableValue()`:
 * - `isRichStorableValue(x)` -- "is x already a `StorableValue`?"
 * - `canBeStored(x)` -- "could x be converted to a `StorableValue` via
 *   `toDeepStorableValue()`?"
 *
 * `canBeStored` additionally accepts `StorableNativeObject` types (Error, Map,
 * Set, Date, Uint8Array, Blob) and objects/functions with `toJSON()` methods
 * that return storable values. It checks recursively, so all nested values in
 * arrays and objects must also be storable or convertible.
 */
export function canBeStored(
  value: unknown,
): value is StorableValue | StorableNativeObject {
  return canBeStoredInternal(value, new Set());
}

/**
 * Internal recursive implementation with cycle detection.
 */
/**
 * Deep-clone an already-valid `StorableValue` to achieve a desired frozenness.
 *
 * Unlike `storableFromNativeValue` (which converts native JS values like
 * `Error`, `Date`, `Map` into storable wrappers), this function assumes the
 * input is already a valid `StorableValue` and only adjusts frozenness by
 * cloning where necessary.
 *
 * - If `frozen` is `true` (default) and the value is already deep-frozen,
 *   returns it as-is (identity optimization).
 * - Primitives (including `SpecialPrimitiveValue`) pass through unchanged.
 * - `StorableInstance` nodes delegate to the protocol's `shallowClone`.
 * - Arrays and plain objects are recursively cloned only when frozenness
 *   differs from the requested state.
 *
 * @param value - An already-valid `StorableValue`.
 * @param frozen - When `true` (default), returns a deep-frozen copy.
 *   When `false`, returns a mutable deep copy.
 */
export function deepCloneIfNecessaryRich(
  value: StorableValue,
  frozen = true,
): StorableValue {
  return deepCloneIfNecessaryInternal(value, frozen, null);
}

/**
 * Internal recursive implementation for `deepCloneIfNecessaryRich`. Uses
 * `switch (tagFromNativeValue(value))` for type dispatch, consistent with
 * `shallowCloneIfNecessary` and `toRichStorableValue`.
 *
 * The `isDeepFrozenStorableValue` check is here (not in the entry point) so
 * that partial deep-frozen subtrees within a larger mutable structure are
 * preserved as-is during recursion.
 *
 * @param seen - Tracks ancestor objects for circular reference detection.
 *   Lazily initialized on first use to avoid allocating a Set for values
 *   that are already deep-frozen.
 */
function deepCloneIfNecessaryInternal(
  value: StorableValue,
  frozen: boolean,
  seen: Set<object> | null,
): StorableValue {
  // Identity optimization: if we want frozen output and this subtree is
  // already deep-frozen, return it as-is. This applies at every level of
  // recursion, preserving deep-frozen subtrees within larger structures.
  if (frozen && isDeepFrozenStorableValue(value)) {
    return value;
  }

  switch (tagFromNativeValue(value)) {
    // Primitives (null, undefined, boolean, number, string, bigint) pass
    // through -- frozenness doesn't apply.
    case NATIVE_TAGS.Primitive:
    // Special primitives are always frozen, returned as-is.
    case NATIVE_TAGS.EpochNsec:
    case NATIVE_TAGS.EpochDays:
    case NATIVE_TAGS.ContentId:
      return value;

    case NATIVE_TAGS.StorableInstance:
      // Delegate to the protocol's shallowClone method.
      return (value as StorableInstance).shallowClone(frozen);

    case NATIVE_TAGS.Array: {
      const arr = value as StorableValue[];
      seen ??= new Set();
      if (seen.has(arr)) {
        throw new Error("Cannot deep-clone circular reference");
      }
      seen.add(arr);
      const copy: StorableValue[] = new Array(arr.length);
      for (let i = 0; i < arr.length; i++) {
        if (i in arr) {
          copy[i] = deepCloneIfNecessaryInternal(arr[i], frozen, seen);
        }
      }
      seen.delete(arr);
      if (frozen) Object.freeze(copy);
      return copy;
    }

    case NATIVE_TAGS.Object: {
      const obj = value as object;
      seen ??= new Set();
      if (seen.has(obj)) {
        throw new Error("Cannot deep-clone circular reference");
      }
      seen.add(obj);
      // Preserve null prototypes (e.g. Object.create(null)).
      const proto = Object.getPrototypeOf(obj);
      const copy = Object.create(proto) as Record<string, StorableValue>;
      for (const [key, val] of Object.entries(obj)) {
        copy[key] = deepCloneIfNecessaryInternal(
          val as StorableValue,
          frozen,
          seen,
        );
      }
      seen.delete(obj);
      if (frozen) Object.freeze(copy);
      return copy;
    }

    default:
      // deepCloneIfNecessary operates on already-valid StorableValues.
      // Unrecognized types should never reach here.
      throw new Error(
        `Cannot deep-clone: ${
          (value as object).constructor?.name ?? typeof value
        }`,
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
      // Functions are only storable if they have toJSON().
      if (typeof value === "function" && hasToJSONMethod(value)) {
        const converted = value.toJSON();
        return canBeStoredInternal(converted, seen);
      }
      return false;
    }

    case "object": {
      // StorableInstance values are already StorableValue.
      if (isStorableInstance(value)) return true;

      // StorableNativeObject types: Error, Map, Set, Date, Uint8Array.
      // These would be wrapped by toDeepStorableValue().
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

      // Class instances without toJSON() are not storable.
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
