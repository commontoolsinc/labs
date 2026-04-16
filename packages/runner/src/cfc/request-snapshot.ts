export function createFrozenRequestSnapshot<T>(value: T): T {
  const snapshot = structuredClone(value);

  const freeze = (target: unknown, seen = new Set<object>()): unknown => {
    if (
      !target || (typeof target !== "object" && typeof target !== "function")
    ) {
      return target;
    }
    if (seen.has(target as object)) {
      return target;
    }
    seen.add(target as object);

    for (const key of Reflect.ownKeys(target as object)) {
      const descriptor = Object.getOwnPropertyDescriptor(
        target as object,
        key,
      );
      if (!descriptor || !("value" in descriptor)) {
        continue;
      }
      freeze(descriptor.value, seen);
    }

    return Object.freeze(target);
  };

  return freeze(snapshot) as T;
}
