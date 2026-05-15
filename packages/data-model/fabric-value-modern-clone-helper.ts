/**
 * This file exists as an intermediate stepping stone as the modern data model
 * gets rolled out. Once the experiment flag is retired, the modern code will
 * end up fully merged into `fabric-value.ts`, including the contents of this
 * file.
 */

import { FabricInstance, FabricValue } from "./interface.ts";
import { NATIVE_TAGS, tagFromNativeValue } from "./native-type-tags.ts";
import { isDeepFrozenFabricValue } from "./fabric-value-modern.ts";


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
export function cloneHelperModern(
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
