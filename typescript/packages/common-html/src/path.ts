import { isObject } from "./contract.js";
import * as logger from "./logger.js";

/** A keypath is an array of property keys */
export type KeyPath = Array<PropertyKey>;
export type NonEmptyKeyPath = [PropertyKey, ...PropertyKey[]];

export type Pathable = {
  path(keyPath: NonEmptyKeyPath): unknown;
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
 * Get path on value using a keypath.
 * If value is pathable, uses path method.
 * Otherwise, gets properties along path.
 */
export const path = (value: unknown, keyPath: Array<PropertyKey>): unknown => {
  if (value == null) {
    return undefined;
  }
  if (keyPath.length === 0) {
    return value;
  }
  if (isPathable(value)) {
    const part = value.path(keyPath as NonEmptyKeyPath);
    logger.debug("path: call path()", value, keyPath, part);
    return part;
  }
  const [key, ...restPath] = keyPath;
  // We checked the length, so we know this is not undefined.
  const part = getProp(value, key);
  logger.debug("path: get prop", value, key, part);
  return path(part, restPath);
};

export default path;
