/**
 * Recursively freeze an object tree in place. Primitives pass through
 * unchanged. Arrays and plain objects are frozen after their children are
 * recursively frozen.
 *
 * Already-frozen objects are still recursed into (their children may not be
 * frozen). A WeakMap cache could enable safe short-circuiting in the future,
 * but for now correctness requires the full walk.
 *
 * Handles sparse arrays correctly (only visits populated indices).
 */
/**
 * WeakMap cache of deep-frozen check results. Once an object is confirmed
 * deep-frozen, subsequent checks return `true` immediately.
 */
const deepFrozenCache = new WeakMap<object, boolean>();

/**
 * Returns `true` if the value is deeply frozen: either a primitive, or a
 * frozen object/array whose every nested value is also deeply frozen
 * (recursively). Caches results in a WeakMap for fast repeat checks.
 *
 * Handles circular references and sparse arrays.
 */
export function isDeepFrozen(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object") return true; // primitives

  return isDeepFrozenObject(value as object, new Set<object>());
}

/**
 * Internal recursive deep-frozen check with cycle detection.
 */
function isDeepFrozenObject(obj: object, inProgress: Set<object>): boolean {
  const cached = deepFrozenCache.get(obj);
  if (cached !== undefined) return cached;

  if (!Object.isFrozen(obj)) {
    deepFrozenCache.set(obj, false);
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
      if (el !== null && el !== undefined && typeof el === "object") {
        if (!isDeepFrozenObject(el as object, inProgress)) {
          result = false;
          break;
        }
      }
      // primitives are always frozen
    }
  } else {
    for (const v of Object.values(obj)) {
      if (v !== null && v !== undefined && typeof v === "object") {
        if (!isDeepFrozenObject(v as object, inProgress)) {
          result = false;
          break;
        }
      }
    }
  }

  inProgress.delete(obj);
  deepFrozenCache.set(obj, result);
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
    if (!alreadyFrozen) Object.freeze(value);
    return value;
  }

  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  if (!alreadyFrozen) Object.freeze(obj);
  return value;
}
