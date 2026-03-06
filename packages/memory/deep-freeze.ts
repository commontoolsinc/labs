/**
 * Recursively freeze an object tree in place. Primitives pass through
 * unchanged. Arrays and plain objects are frozen after their children are
 * recursively frozen.
 *
 * Objects already confirmed as deep-frozen (present in the cache) are
 * returned immediately. Otherwise, already-frozen objects are still recursed
 * into (their children may not be frozen). After freezing, the result is
 * recorded in the cache so subsequent calls return in O(1).
 *
 * Handles sparse arrays correctly (only visits populated indices).
 */

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
 * Returns `true` if the value is deeply frozen: either a primitive, or a
 * frozen object/array whose every nested value is also deeply frozen
 * (recursively). Caches results fast repeat checks.
 *
 * Handles circular references and sparse arrays.
 */
export function isDeepFrozen(value: unknown): boolean {
  return isNecessarilyFrozenValue(value)
    || isDeepFrozenObject(value as object, new Set<object>());
}

/**
 * Internal recursive deep-frozen check with cycle detection.
 */
function isDeepFrozenObject(obj: object, inProgress: Set<object>): boolean {
  if (isInDeepFrozenCache(obj)) {
    return true;
  } else if (!Object.isFrozen(obj)) {
    return false;
  }

  // Cycle detection: if we're already checking this object, treat it as
  // frozen (all paths must confirm independently).
  if (inProgress.has(obj)) return true;
  inProgress.add(obj);

  let result = true;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (!(i in obj)) continue; // sparse hole
      const el = obj[i];
      if (el !== null && typeof el === "object") {
        if (!isDeepFrozenObject(el as object, inProgress)) {
          result = false;
          break;
        }
      }
      // primitives are always frozen
    }
  } else {
    for (const v of Object.values(obj)) {
      if (v !== null && typeof v === "object") {
        if (!isDeepFrozenObject(v as object, inProgress)) {
          result = false;
          break;
        }
      }
    }
  }

  inProgress.delete(obj);
  if (result) {
    addToDeepFrozenCache(obj);
  }
  return result;
}

export function deepFreeze<T>(value: T): T {
  if (isNecessarilyFrozenValue(value)
      || isInDeepFrozenCache(value as object)) {
    return value;
  }

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
