import { FabricInstance, FabricValue } from "./interface.ts";
import { NATIVE_TAGS, tagFromNativeValue } from "./native-type-tags.ts";
import { isDeepFrozenFabricValue } from "./deep-freeze.ts";
import type { Immutable } from "@commonfabric/utils/types";

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

  return cloneHelperModern(value, frozen, deep, force) as T;
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
export function cloneHelperModern(
  value: FabricValue,
  frozen: boolean,
  deep: boolean,
  force: boolean,
  seen: Set<object> | null = null,
): FabricValue {
  // Identity optimization: when `force` is off, check if the value's frozenness
  // already matches the requested state. Deep mode uses
  // `isDeepFrozenFabricValue()`; shallow mode uses `Object.isFrozen(v) ===
  // frozen`.
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

    case NATIVE_TAGS.FabricInstance: {
      // Identity optimization: already-correct frozenness needs no clone.
      if (canReturnAsIs(value)) {
        return value;
      } else if (deep) {
        return (value as FabricInstance).deepClone(frozen);
      } else {
        return (value as FabricInstance).shallowClone(frozen);
      }
    }

    case NATIVE_TAGS.Array: {
      if (canReturnAsIs(value)) return value;
      const arr = value as FabricValue[];
      if (deep) seen = trackForCircularity(arr, seen);
      const copy: FabricValue[] = new Array(arr.length);
      for (let i = 0; i < arr.length; i++) {
        if (i in arr) {
          copy[i] = deep
            ? cloneHelperModern(arr[i], frozen, deep, force, seen)
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
          copy[key] = cloneHelperModern(
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
