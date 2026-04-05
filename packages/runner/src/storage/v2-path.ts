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

  const nextRoot = cloneIfNecessary((root ?? {}) as FabricValue, {
    frozen: false,
  }) as Record<string, unknown>;
  let current: Record<string, unknown> | unknown[] = nextRoot;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const nextSegment = path[index + 1]!;
    if (Array.isArray(current)) {
      const slot = Number(segment);
      const existing = current[slot];
      if (!isRecord(existing) && !Array.isArray(existing)) {
        current[slot] = createPathContainer(nextSegment);
      }
      current = current[slot] as Record<string, unknown> | unknown[];
      continue;
    }

    const existing = current[segment];
    if (!isRecord(existing) && !Array.isArray(existing)) {
      current[segment] = createPathContainer(nextSegment);
    }
    current = current[segment] as Record<string, unknown> | unknown[];
  }

  const last = path[path.length - 1]!;
  const nextValue = value === undefined
    ? undefined
    : cloneIfNecessary(value as FabricValue, { frozen: false });
  if (Array.isArray(current)) {
    current[Number(last)] = nextValue;
  } else {
    current[last] = nextValue;
  }
  return nextRoot as EntityDocument;
};

export const cloneWithoutPath = (
  root: EntityDocument | undefined,
  path: readonly string[],
): EntityDocument | undefined => {
  if (root === undefined || path.length === 0) {
    return undefined;
  }

  const nextRoot = cloneIfNecessary(root as FabricValue, {
    frozen: false,
  }) as Record<string, unknown>;
  let current: Record<string, unknown> | unknown[] = nextRoot;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    if (Array.isArray(current)) {
      const slot = Number(segment);
      const next = current[slot];
      if (!isRecord(next) && !Array.isArray(next)) {
        return nextRoot as EntityDocument;
      }
      current = next as Record<string, unknown> | unknown[];
      continue;
    }

    const next = current[segment];
    if (!isRecord(next) && !Array.isArray(next)) {
      return nextRoot as EntityDocument;
    }
    current = next as Record<string, unknown> | unknown[];
  }

  const last = path[path.length - 1]!;
  if (Array.isArray(current)) {
    const slot = Number(last);
    if (slot >= 0 && slot < current.length) {
      current.splice(slot, 1);
    }
  } else {
    delete current[last];
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
