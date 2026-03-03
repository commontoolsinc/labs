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
export function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  const alreadyFrozen = Object.isFrozen(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (i in value) {
        const frozen = deepFreeze(value[i]);
        if (!alreadyFrozen) value[i] = frozen;
      }
    }
    if (!alreadyFrozen) Object.freeze(value);
    return value;
  }

  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const frozen = deepFreeze(obj[key]);
    if (!alreadyFrozen) obj[key] = frozen;
  }
  if (!alreadyFrozen) Object.freeze(obj);
  return value;
}
