import { isWalkableObjectOrArray } from "@commonfabric/data-model";
import type { FabricValue } from "@commonfabric/api";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";

export type ReadPathOptions = {
  allowArrayLength?: boolean;
};

export const isArrayIndexSegment = (segment: string): boolean =>
  isArrayIndexPropertyName(segment);

export const createPathContainer = (nextSegment: string): FabricValue =>
  isArrayIndexSegment(nextSegment) ? [] : {};

const hasOwnPathSegment = (
  value: Record<string, unknown> | unknown[],
  segment: string | number,
): boolean => Object.hasOwn(value, segment);

// Both descents below stop at a `FabricPrimitive`, so a path into one reports
// absent / `undefined` -- the same answer `getAtPath` in `traverse.ts` gives
// for the same address, and the whole story for a leaf that no path addresses
// anything inside of. A `FabricInstance` is refused rather than answered
// about, by the same predicate and for the same reason it is refused
// everywhere else.
export const hasValueAtPath = (
  root: FabricValue | undefined,
  path: readonly string[],
  options: ReadPathOptions = {},
): boolean => {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (options.allowArrayLength === true && segment === "length") {
        current = current.length;
        continue;
      }
      if (!isArrayIndexSegment(segment)) {
        return false;
      }
      const index = Number(segment);
      if (!hasOwnPathSegment(current, index)) {
        return false;
      }
      current = current[index];
      continue;
    }
    if (!isWalkableObjectOrArray(current)) {
      return false;
    }
    const record = current as Record<string, unknown>;
    if (!hasOwnPathSegment(record, segment)) {
      return false;
    }
    current = record[segment];
  }
  return true;
};

export const readValueAtPath = (
  root: FabricValue | undefined,
  path: readonly string[],
  options: ReadPathOptions = {},
): FabricValue | undefined => {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (options.allowArrayLength === true && segment === "length") {
        current = current.length;
        continue;
      }
      if (!isArrayIndexSegment(segment)) {
        return undefined;
      }
      const index = Number(segment);
      if (!hasOwnPathSegment(current, index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isWalkableObjectOrArray(current)) {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    if (!hasOwnPathSegment(record, segment)) {
      return undefined;
    }
    current = record[segment];
  }
  return current as FabricValue | undefined;
};
