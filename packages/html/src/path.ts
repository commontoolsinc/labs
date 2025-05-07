import * as logger from "./logger.ts";
import { isObject } from "../../utils/src/types.ts";

/** A keypath is an array of property keys */
export type KeyPath = Array<PropertyKey>;
export type NonEmptyKeyPath = [PropertyKey, ...PropertyKey[]];

export type Keyable<T, K extends keyof T> = {
  key(key: K): T[K];
};

export const isKeyable = (value: unknown): value is Keyable<any, any> => {
  return isObject(value) && "key" in value && typeof value.key === "function";
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
export const path = <T>(parent: T, keyPath: Array<PropertyKey>): unknown => {
  if (parent == null) {
    return undefined;
  }
  if (keyPath.length === 0) {
    return parent;
  }
  const key = keyPath.shift()!;
  if (isKeyable(parent)) {
    const child = parent.key(key);
    logger.debug({
      msg: "call .key()",
      fn: "path()",
      parent,
      key,
      child,
    });
    return path(child, keyPath);
  }
  // We checked the length, so we know this is not undefined.
  const child = getProp(parent, key);
  logger.debug({
    msg: "get prop",
    fn: "path()",
    parent,
    key,
    child,
  });
  return path(child, keyPath);
};

export default path;
