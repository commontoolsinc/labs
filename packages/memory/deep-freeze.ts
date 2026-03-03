/**
 * Recursively freeze an object tree in place. Primitives and already-frozen
 * objects pass through unchanged. Arrays and plain objects are frozen after
 * their children are recursively frozen.
 *
 * Handles sparse arrays correctly (only visits populated indices).
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  if (Object.isFrozen(value)) return value;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (i in value) {
        value[i] = deepFreeze(value[i]);
      }
    }
    Object.freeze(value);
    return value;
  }

  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    obj[key] = deepFreeze(obj[key]);
  }
  Object.freeze(obj);
  return value;
}
