import * as logger from "./logger.ts";
import { isObject } from "@commontools/utils/types";

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
  const traverse = (current: unknown, idx: number): unknown => {
    if (current == null) {
      return undefined;
    }
    if (idx >= keyPath.length) {
      return current;
    }
    const key = keyPath[idx];
    if (isKeyable(current)) {
      const child = current.key(key as any);
      logger.debug({
        msg: "call .key()",
        fn: "path()",
        parent: current,
        key,
        child,
      });
      return traverse(child, idx + 1);
    }
    const child = getProp(current, key);
    logger.debug({
      msg: "get prop",
      fn: "path()",
      parent: current,
      key,
      child,
    });
    return traverse(child, idx + 1);
  };

  return traverse(parent, 0);
};

export default path;
