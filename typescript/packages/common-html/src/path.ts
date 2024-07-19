import { isObject } from "./util.js";

/** A keypath is an array of property keys */
export type KeyPath = Array<PropertyKey>;

export type Pathable = {
  path(keyPath: KeyPath): unknown;
};

/** Does value have a path method? */
export const isPathable = (value: unknown): value is Pathable => {
  return isObject(value) && "path" in value && typeof value.path === "function";
};

/** Get value at prop. Returns undefined if key is not accessible. */
export const getProp = (value: unknown, key: PropertyKey): unknown => {
  if (value == null) {
    return undefined;
  }
  return value[key as keyof typeof value] ?? undefined;
};

/**
 * Get deep value using a key path.
 * Follows property path. Returns undefined if any key is not found.
 */
export const get = <T>(value: T, keyPath: KeyPath): unknown => {
  let subject = value as unknown;
  for (const key of keyPath) {
    subject = getProp(subject, key);
    if (subject == null) {
      return undefined;
    }
  }
  return subject;
};

/**
 * Get path on value using a keypath.
 * If value is pathable, uses path method.
 * Otherwise, gets properties along path.
 */
export const path = <T>(value: T, keyPath: KeyPath): unknown => {
  if (isPathable(value)) {
    return value.path(keyPath);
  }
  return get(value, keyPath);
};

export default path;
