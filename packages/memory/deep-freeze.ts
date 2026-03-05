/**
 * Recursively freeze an object tree in place. Primitives pass through
 * unchanged. Arrays and plain objects are frozen after their children are
 * recursively frozen.
 *
 * Already-frozen objects are still recursed into (their children may not be
 * frozen). After freezing, the result is recorded in the `isDeepFrozen` cache
 * so subsequent checks return immediately.
 *
 * Handles sparse arrays correctly (only visits populated indices).
 */
/**
 * WeakMap cache of confirmed deep-frozen objects. Only `true` results are
 * cached -- `false` is never stored, because a currently-unfrozen object
 * may be frozen later and must not be permanently marked as non-frozen.
 */
const deepFrozenCache = new WeakMap<object, true>();

/**
 * Returns `true` if the value is deeply frozen: either a primitive, or a
 * frozen object/array whose every nested value is also deeply frozen
 * (recursively). Caches results in a WeakMap for fast repeat checks.
 *
 * Handles circular references and sparse arrays.
 */
export function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;

  return isDeepFrozenObject(value as object, new Set<object>());
}

/**
 * Internal recursive deep-frozen check with cycle detection.
 */
function isDeepFrozenObject(obj: object, inProgress: Set<object>): boolean {
  if (deepFrozenCache.has(obj)) return true;

  if (!Object.isFrozen(obj)) {
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
    deepFrozenCache.set(obj, true);
  }
  return result;
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
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
  deepFrozenCache.set(value as object, true);
  return value;
}
