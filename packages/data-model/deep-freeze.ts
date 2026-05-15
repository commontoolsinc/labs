import {
  DEEP_FREEZE,
  FabricInstance,
  FabricPrimitive,
  FabricValue,
} from "./interface.ts";
import { isPlainObject } from "@commonfabric/utils/types";

/**
 * Cache of confirmed deep-frozen objects.
 */
const deepFrozenCache = new WeakSet<object>();

/**
 * Adds a value which has been determined to be deep-frozen to the cache.
 */
function addToDeepFrozenCache(obj: object) {
  deepFrozenCache.add(obj);
}

/**
 * Indicates whether or not the given object is already in the
 * `deepFrozenCache`.
 */
function isInDeepFrozenCache(obj: object): boolean {
  return deepFrozenCache.has(obj);
}

/**
 * Indicates whether or not a value is "necessarily frozen." As of this writing,
 * this is the same as asking if it's a primitive value, but with an emphasis on
 * the point. However, at some point we'll end up with special knowledge about
 * objects which are also "necessarily frozen" by construction, and this is the
 * place where we'll get to expand the logic accordingly.
 */
function isNecessarilyFrozenValue(value: unknown): boolean {
  return (value === null) || (typeof value !== "object");
}

/**
 * Indicates whether the given value is either _necessarily_ or _already known
 * to be_ deep-frozen.
 */
function isNecessarilyOrKnownDeepFrozen(value: unknown): boolean {
  // Note: The `as` cast here is safe because the antecedent being `false` means
  // that `value` must be an `object` consequent.
  return isNecessarilyFrozenValue(value) ||
    isInDeepFrozenCache(value as object);
}

/**
 * Returns `true` if the value is deeply frozen: either a primitive, or a
 * frozen object/array whose every nested value is also deeply frozen
 * (recursively). Caches results for fast repeat checks.
 *
 * Handles circular references and sparse arrays.
 */
export function isDeepFrozen(value: unknown): boolean {
  return isDeepFrozenInProgress(value);
}

/**
 * Performs the recursive deep-frozen check with cycle detection.
 */
function isDeepFrozenInProgress(
  value: unknown,
  inProgress?: Set<object>,
): boolean {
  if (isNecessarilyOrKnownDeepFrozen(value)) {
    return true;
  } else if (!Object.isFrozen(value)) {
    return false;
  }

  const obj = value as object;

  if (inProgress) {
    // We're in a recursive call, so notice if we're in fact already checking
    // `value`. If so, treat it as frozen for the sake of the rest of the check.
    // It will only end up getting marked as actually deep-frozen if the rest
    // of the call actually confirms.
    if (inProgress.has(obj)) return true;
  } else {
    // This is the base non-recursive call, and we have to set up the
    // `inProgress` set. This isn't done by default exactly so that the quick
    // checks at the top of this function don't incur object-creation overhead.
    inProgress = new Set<object>();
  }

  inProgress.add(obj);

  let result = true;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (!(i in obj)) continue; // sparse hole
      if (!isDeepFrozenInProgress(obj[i], inProgress)) {
        result = false;
        break;
      }
    }
  } else {
    for (const v of Object.values(obj)) {
      if (!isDeepFrozenInProgress(v, inProgress)) {
        result = false;
        break;
      }
    }
  }

  inProgress.delete(obj);
  if (result) {
    addToDeepFrozenCache(obj);
  }
  return result;
}

/**
 * Recursively freezes the given value in place. Dispatches on four arms, in
 * order:
 *
 * 1. Necessarily- or already-known-deep-frozen value (primitives and cached
 *    objects): short-circuit unchanged.
 * 2. `FabricPrimitive` instance: short-circuit unchanged -- these self-freeze
 *    at construction and have no outbound references.
 * 3. Value carrying the `[DEEP_FREEZE]` symbol method (e.g. a
 *    `FabricInstance` subclass): delegate generically to that method,
 *    handing recursion through as the `subFreeze` callback. `deepFreeze()`
 *    itself stays class-agnostic (no per-class knowledge).
 * 4. Plain object or array: recursively freeze children, then freeze the
 *    container.
 *
 * Arrays and plain objects are frozen after their children are recursively
 * frozen. Primitives pass through unchanged. Records the result in the
 * deep-frozen cache so subsequent `isDeepFrozen()` checks return in O(1).
 * Returns the (now-frozen) value.
 */
export function deepFreeze<T>(value: T): T {
  // Arm 1: necessarily- or already-known-deep-frozen.
  if (isNecessarilyOrKnownDeepFrozen(value)) {
    return value;
  }

  // Arm 2: `FabricPrimitive`s are by definition frozen (they self-freeze at
  // construction) and have no outbound references.
  if (value instanceof FabricPrimitive) {
    return value;
  }

  // Arm 3: anything carrying the `[DEEP_FREEZE]` symbol method freezes itself
  // in place via that method, recursing through the `deepFreeze` callback.
  // The duck-typed check keeps `deepFreeze()` free of per-class knowledge.
  const deepFreezable = value as {
    [DEEP_FREEZE]?: (subFreeze: (value: FabricValue) => FabricValue) => unknown;
  };
  if (typeof deepFreezable[DEEP_FREEZE] === "function") {
    return deepFreezable[DEEP_FREEZE]((v) => deepFreeze(v)) as T;
  }

  // Arm 4: plain object or array -- recurse into children, then freeze.
  const alreadyFrozen = Object.isFrozen(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (i in value) deepFreeze(value[i]);
    }
  } else {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      deepFreeze(obj[key]);
    }
  }

  if (!alreadyFrozen) Object.freeze(value);
  addToDeepFrozenCache(value as object);
  return value;
}

/**
 * Indicates whether the value is a deep-frozen `FabricValue`. Returns `true` if
 * the value is a primitive, or a frozen object/array whose children are all
 * also deep-frozen `FabricValue`s.
 */
export function isDeepFrozenFabricValue(value: unknown): value is FabricValue {
  // TODO(@danfuzz): A function `isFabricValue()` should ultimately get
  // extracted from this function, which does just the recursive type check.
  // Note that, as of this writing, the existing function with that name (a)
  // only does a single layer check, and (b) is only ever exercised in unit
  // tests, so it should be safe to replace it.

  switch (typeof value) {
    case "function": {
      return false;
    }

    case "object": {
      if (value === null) {
        return true;
      } else if (!isDeepFrozen(value)) {
        return false;
      }

      // Continue below the `switch`.
      break;
    }

    default: {
      // It's a primitive. Return here for efficiency, rather than do the
      // heavyweight setup for recursive tracing.
      return true;
    }
  }

  // At this point, it's known to be a deep-frozen value with internal
  // structure, but we don't know if it's actually a `FabricValue`.

  const seen = new Set();
  const checkValue = (item: unknown): boolean => {
    if (item === null || (typeof item !== "object")) {
      // It's a primitive.
      return true;
    } else if (seen.has(item)) {
      return true;
    }

    seen.add(item);

    if (item instanceof FabricPrimitive) {
      // `FabricPrimitive`s are by definition frozen and have no outbound
      // references.
      return true;
    } else if (item instanceof FabricInstance) {
      // `FabricInstance`s might have references, but -- TODO(@danfuzz) -- we
      // have no way of handling them yet.
      throw new Error(
        `Cannot yet handle instance of class ${item.constructor.name}`,
      );
    } else if (Array.isArray(item)) {
      for (let i = 0; i <= item.length; i++) {
        if (i in item && !checkValue(item[i])) return false;
      }
      return true;
    } else if (isPlainObject(item)) {
      for (const v of Object.values(item)) {
        if (!checkValue(v)) return false;
      }
      return true;
    } else {
      // It's an instance of a class that isn't covered by the `FabricValue`
      // type definition.
      return false;
    }
  };

  return checkValue(value);
}
