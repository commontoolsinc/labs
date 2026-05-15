// Re-export everything from `interface.ts` so that `fabric-value` remains the
// canonical public surface for all type declarations and the `FabricInstance`
// base class.
export {
  DECONSTRUCT,
  type FabricArray,
  type FabricClass,
  FabricInstance,
  type FabricNativeObject,
  type FabricObject,
  FabricPrimitive,
  type FabricValue,
  type FabricValueConverter,
  type FabricValueLayer,
  RECONSTRUCT,
  type ReconstructionContext,
  type SerializationContext,
} from "./interface.ts";

import type {
  FabricInstance,
  FabricNativeObject,
  FabricValue,
  FabricValueLayer,
} from "./interface.ts";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import type { Immutable } from "@commonfabric/utils/types";
import {
  fabricFromNativeValueModern,
  isDeepFrozenFabricValue,
  isFabricCompatibleModern,
  isFabricValueModern,
  nativeFromFabricValueModern,
  shallowFabricFromNativeValueModern,
} from "./fabric-value-modern.ts";
import {
  fabricFromNativeValueLegacy,
  isFabricCompatibleLegacy,
  isFabricValueLegacy,
  shallowFabricFromNativeValueLegacy,
} from "./fabric-value-legacy.ts";
export {
  isArrayIndexPropertyName,
  isArrayWithOnlyIndexProperties,
} from "./array-utils.ts";
import { NATIVE_TAGS, tagFromNativeValue } from "./native-type-tags.ts";

/**
 * Options for `cloneIfNecessary()`.
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

//
// Configuration flags
//

/**
 * Module-level flag for modern data model mode, set by the `Runtime`
 * constructor via `setDataModelConfig()`. When enabled, fabric value
 * functions use the extended type system (`bigint`, `Map`, `Set`,
 * `Uint8Array`, `Date`, etc.).
 */
let modernDataModelEnabled = false;

/**
 * Activates or deactivates modern data model mode. Called by the `Runtime`
 * constructor to propagate `ExperimentalOptions.modernDataModel` into the
 * memory layer.
 */
export function setDataModelConfig(enabled?: boolean): void {
  if (enabled !== undefined) {
    modernDataModelEnabled = enabled ?? false;
  }
}

/** Returns whether modern data model mode is currently enabled. */
export function getDataModelConfig(): boolean {
  return modernDataModelEnabled;
}

/**
 * Restores modern data model mode to its default (disabled). Called by
 * `Runtime.dispose()` to avoid leaking flags between runtime instances or
 * test runs.
 */
export function resetDataModelConfig(): void {
  modernDataModelEnabled = false;
}

//
// Flag-dispatched functions
//

/**
 * Converts a native JS value to fabric form (deep, recursive).
 *
 * Flag OFF (legacy): performs deep conversion via `fabricFromNativeValueLegacy()`.
 * Flag ON (modern): wraps native types (`Error`, `Date`, `RegExp`, etc.) into
 * fabric wrappers and deep-freezes via `fabricFromNativeValueModern()`.
 *
 * @param freeze - When `true` (default), deep-freezes the result. Only
 *   applies when `modernDataModel` is ON; the legacy path does not
 *   freeze.
 */
export function fabricFromNativeValue(
  value: unknown,
  freeze = true,
): FabricValue {
  return modernDataModelEnabled
    ? fabricFromNativeValueModern(value, freeze)
    : fabricFromNativeValueLegacy(value);
}

/**
 * Recursively walks a `FabricValue` tree, unwrapping any
 * `FabricNativeWrapper` values to their underlying native types via
 * `toNativeValue()`. Non-native `FabricInstance` values (`Cell`, `Stream`,
 * `UnknownValue`, etc.) pass through as-is.
 *
 * Flag OFF (legacy): identity passthrough (legacy values contain no
 * `FabricNativeWrapper` instances). Flag ON (modern): delegates to
 * `nativeFromFabricValueModern()`.
 *
 * @param frozen - When `true` (default), deep-freezes the result. Only
 *   applies when `modernDataModel` is ON; the legacy path is a
 *   passthrough regardless.
 */
export function nativeFromFabricValue(
  value: FabricValue,
  frozen = true,
): FabricValue {
  return modernDataModelEnabled
    ? nativeFromFabricValueModern(value, frozen) as FabricValue
    : value;
}

/**
 * Determines if the given value is considered "fabric-compatible" by the system per se
 * (without invoking any conversions such as `toJSON()`). This function does
 * not recursively validate nested values in arrays or objects.
 *
 * Flag OFF (legacy): fabric values are JSON-encodable values plus
 * `undefined`. Flag ON (modern): delegates to `isFabricValueModern()` which
 * accepts the extended type system.
 *
 * @param value - The value to check.
 * @returns `true` if the value is fabric-compatible per se, `false` otherwise.
 *
 * This function is a TypeScript type guard for `FabricValueLayer`.
 */
export function isFabricValue(
  value: unknown,
): value is FabricValueLayer {
  return modernDataModelEnabled
    ? isFabricValueModern(value)
    : isFabricValueLegacy(value);
}

/**
 * Returns `true` if `fabricFromNativeValue()` would succeed on the value.
 * Checks whether the value is a `FabricValue`, a `FabricNativeObject`,
 * or a deep tree thereof.
 *
 * Flag OFF (legacy): equivalent to `isFabricValue()` (non-recursive).
 * Flag ON (modern): delegates to `isFabricCompatibleModern()` which recursively
 * validates nested values.
 *
 * @param value - The value to check.
 * @returns `true` if the value can be stored, `false` otherwise.
 *
 * This function is a TypeScript type guard for `FabricValue | FabricNativeObject`.
 */
export function isFabricCompatible(
  value: unknown,
): value is FabricValue | FabricNativeObject {
  return modernDataModelEnabled
    ? isFabricCompatibleModern(value)
    : isFabricCompatibleLegacy(value);
}

/**
 * Converts a value to fabric form without recursing into nested values.
 * JSON-encodable values pass through as-is. Functions and instances are
 * converted via `toJSON()` if available.
 *
 * Flag OFF (legacy): JSON-only type system. Flag ON (modern): delegates to
 * `shallowFabricFromNativeValueModern()` which handles the extended type system.
 *
 * @param value - The value to convert.
 * @param freeze - When `true` (default), freezes the result if it is an
 *   object or array. Only applies when `modernDataModel` is ON.
 * @returns The fabric value (original or converted).
 * @throws Error if the value can't be converted to fabric form.
 */
export function shallowFabricFromNativeValue(
  value: unknown,
  freeze = true,
): FabricValueLayer {
  return modernDataModelEnabled
    ? shallowFabricFromNativeValueModern(value, freeze)
    : shallowFabricFromNativeValueLegacy(value);
}

/**
 * Compares two fabric values for equality.
 *
 * Flag OFF (legacy): uses `JSON.stringify()` comparison, matching the behavior of
 * the original `JSON.parse(JSON.stringify(...))` round-trip (strips `undefined`,
 * coerces `NaN` to `null`, etc.).
 *
 * Flag ON (modern): uses deep structural equality that correctly handles
 * undefined, sparse arrays, and other extended types.
 */
export function valueEqual(a: unknown, b: unknown): boolean {
  return modernDataModelEnabled
    ? deepEqual(a, b)
    : JSON.stringify(a) === JSON.stringify(b);
}

//
// Non-flag-dispatched functions
//

/**
 * Clones an already-valid `FabricValue` to achieve a desired frozenness,
 * with control over depth and copy semantics.
 *
 * Unlike `fabricFromNativeValue()` (which converts native JS values into
 * fabric wrappers), this function assumes the input is already a valid
 * `FabricValue` and only adjusts frozenness by cloning where necessary.
 *
 * Both flag states use modern clone semantics; the legacy dispatch target
 * delegates to the modern implementation.
 *
 * @param value - An already-valid `FabricValue`.
 * @param options - See `CloneOptions`. Defaults: `{ frozen: true, deep: true }`.
 */
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options?: CloneOptions & { frozen?: true },
): Immutable<T>;
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options: CloneOptions & { frozen: false },
): T;
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options?: CloneOptions,
): T;
export function cloneIfNecessary<T extends FabricValue>(
  value: T,
  options?: CloneOptions,
): T {
  const frozen = options?.frozen ?? true;
  const deep = options?.deep ?? true;
  const force = options?.force ?? (frozen ? false : true);

  if (frozen && force) {
    throw new Error(
      "cloneIfNecessary: { frozen: true, force: true } is invalid " +
        "(pointless to force-copy an immutable value)",
    );
  }

  if (!frozen && !force && deep) {
    throw new Error(
      "cloneIfNecessary: { frozen: false, force: false, deep: true } is invalid " +
        "(ambiguous: mixed-frozenness trees have no clear shallow-thaw semantics)",
    );
  }

  return cloneIfNecessaryModern(value, frozen, deep, force) as T;
}

/**
 * Clones an assumed-valid `FabricValue` to achieve a desired frozenness,
 * with control over depth and copy semantics.
 *
 * Unlike `fabricFromNativeValue()` (which converts native JS values into
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
export function cloneIfNecessaryModern(
  value: FabricValue,
  frozen: boolean,
  deep: boolean,
  force: boolean,
): FabricValue {
  return cloneHelper(value, frozen, deep, force, null);
}

/**
 * Tracks an object for circular reference detection during deep cloning.
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
 * Performs the unified clone for both shallow and deep modes.
 *
 * When `deep` is true, recursively clones containers and detects circular
 * references via `seen`. When `deep` is false, copies only the top-level
 * container (children are shared by reference).
 *
 * When `force` is false, returns the value as-is if its frozenness already
 * matches the requested state. When `force` is true, always copies (unless
 * the value is a primitive or special primitive).
 *
 * Deep mode uses `isDeepFrozenFabricValue()` for identity optimization;
 * shallow mode uses `Object.isFrozen(value) === frozen`.
 */
function cloneHelper(
  value: FabricValue,
  frozen: boolean,
  deep: boolean,
  force: boolean,
  seen: Set<object> | null,
): FabricValue {
  // Identity optimization: when `force` is off, check if the value's frozenness
  // already matches the requested state. Deep mode uses `isDeepFrozenFabricValue()`;
  // shallow mode uses `Object.isFrozen(v) === frozen`.
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
      // Preserve null prototypes (e.g. `Object.create(null)`).
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
      // All valid `FabricValue` types are handled above.
      throw new Error(
        `Cannot clone: ${(value as object).constructor?.name ?? typeof value}`,
      );
  }
}
