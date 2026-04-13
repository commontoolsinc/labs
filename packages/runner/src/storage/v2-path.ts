import {
  cloneIfNecessary,
  isArrayIndexPropertyName,
} from "@commonfabric/data-model/fabric-value";
import type { EntityDocument } from "@commonfabric/memory/v2";
import type { FabricValue } from "@commonfabric/memory/interface";
import { isRecord } from "@commonfabric/utils/types";

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
    if (!isRecord(current)) {
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
    if (!isRecord(current)) {
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

const shallowCloneContainer = <
  Container extends Record<string, unknown> | unknown[],
>(
  value: Container,
): Container => {
  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    Object.assign(copy, value);
    return copy as Container;
  }

  const copy = Object.create(Object.getPrototypeOf(value)) as Record<
    string,
    unknown
  >;
  Object.assign(copy, value);
  return copy as Container;
};

const getPathSegmentValue = (
  value: Record<string, unknown> | unknown[],
  segment: string,
): unknown => Array.isArray(value) ? value[Number(segment)] : value[segment];

const setPathSegmentValue = (
  value: Record<string, unknown> | unknown[],
  segment: string,
  next: unknown,
): void => {
  if (Array.isArray(value)) {
    value[Number(segment)] = next;
    return;
  }
  value[segment] = next;
};

export const cloneWithValueAtPath = (
  root: EntityDocument | undefined,
  path: readonly string[],
  value: FabricValue | undefined,
): EntityDocument | undefined => {
  if (path.length === 0) {
    return value === undefined
      ? undefined
      : cloneIfNecessary(value as FabricValue, {
        frozen: false,
      }) as EntityDocument;
  }

  const baseRoot = (root ?? {}) as Record<string, unknown>;
  const nextRoot = shallowCloneContainer(baseRoot);
  let currentClone: Record<string, unknown> | unknown[] = nextRoot;
  let currentBase: unknown = baseRoot;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const nextSegment = path[index + 1]!;
    const existing = currentBase !== null && typeof currentBase === "object"
      ? getPathSegmentValue(
        currentBase as Record<string, unknown> | unknown[],
        segment,
      )
      : undefined;
    const nextChild = isRecord(existing) || Array.isArray(existing)
      ? shallowCloneContainer(existing)
      : createPathContainer(nextSegment);
    setPathSegmentValue(currentClone, segment, nextChild);
    currentClone = nextChild as Record<string, unknown> | unknown[];
    currentBase = existing;
  }

  const last = path[path.length - 1]!;
  const nextValue = value === undefined
    ? undefined
    : cloneIfNecessary(value as FabricValue, { frozen: false });
  setPathSegmentValue(currentClone, last, nextValue);
  return nextRoot as EntityDocument;
};

export const cloneWithoutPath = (
  root: EntityDocument | undefined,
  path: readonly string[],
): EntityDocument | undefined => {
  if (root === undefined || path.length === 0) {
    return undefined;
  }

  let parentBase: Record<string, unknown> | unknown[] = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const next = getPathSegmentValue(parentBase, segment);
    if (!isRecord(next) && !Array.isArray(next)) {
      return root;
    }
    parentBase = next as Record<string, unknown> | unknown[];
  }

  const last = path[path.length - 1]!;
  if (Array.isArray(parentBase)) {
    const slot = Number(last);
    if (slot < 0 || slot >= parentBase.length) {
      return root;
    }
  } else if (!hasOwnPathSegment(parentBase, last)) {
    return root;
  }

  const nextRoot = shallowCloneContainer(root);
  let currentClone: Record<string, unknown> | unknown[] = nextRoot;
  let currentBase: Record<string, unknown> | unknown[] = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const next = getPathSegmentValue(currentBase, segment) as
      | Record<string, unknown>
      | unknown[];
    const nextClone = shallowCloneContainer(next);
    setPathSegmentValue(currentClone, segment, nextClone);
    currentClone = nextClone;
    currentBase = next;
  }

  if (Array.isArray(currentClone)) {
    currentClone.splice(Number(last), 1);
  } else {
    delete currentClone[last];
  }

  return nextRoot as EntityDocument;
};

export const ensureParentContainers = (
  root: FabricValue,
  path: readonly string[],
  lastKey: string,
): FabricValue => {
  if (path.length === 0) {
    return root;
  }

  let current = root as Record<string, FabricValue> | FabricValue[];
  for (let index = 0; index < path.length; index += 1) {
    const key = path[index]!;
    const nextKey = path[index + 1] ?? lastKey;
    const container = createPathContainer(nextKey);

    if (Array.isArray(current)) {
      const slot = Number(key);
      const existing = current[slot];
      if (!isRecord(existing) && !Array.isArray(existing)) {
        current[slot] = container;
      }
      current = current[slot] as
        | Record<string, FabricValue>
        | FabricValue[];
      continue;
    }

    const existing = current[key];
    if (!isRecord(existing) && !Array.isArray(existing)) {
      current[key] = container;
    }
    current = current[key] as Record<string, FabricValue> | FabricValue[];
  }

  return root;
};
