import { deepFreeze } from "@commonfabric/data-model/deep-freeze";
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

// Shallow-thaw a spine container to a mutable copy: clone only the top-level
// container (children stay identity-shared), always allocate (`force`), and
// leave the result mutable for the in-place spine write that follows. The
// boundary `deepFreeze()` re-freezes the assembled tree on the way out.
const SHALLOW_THAW_OPTS = {
  frozen: false,
  deep: false,
  force: true,
} as const;

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
    return cloneIfNecessary(value as FabricValue) as EntityDocument;
  }

  const baseRoot = (root ?? {}) as Record<string, unknown>;
  const nextRoot = cloneIfNecessary(
    baseRoot as FabricValue,
    SHALLOW_THAW_OPTS,
  ) as Record<string, unknown>;
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
      ? cloneIfNecessary(existing as FabricValue, SHALLOW_THAW_OPTS)
      : createPathContainer(nextSegment);
    setPathSegmentValue(currentClone, segment, nextChild);
    currentClone = nextChild as Record<string, unknown> | unknown[];
    currentBase = existing;
  }

  const last = path[path.length - 1]!;
  const nextValue = cloneIfNecessary(value as FabricValue);
  setPathSegmentValue(currentClone, last, nextValue);
  return deepFreeze(nextRoot) as EntityDocument;
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

  const nextRoot = cloneIfNecessary(
    root as FabricValue,
    SHALLOW_THAW_OPTS,
  ) as Record<string, unknown>;
  let currentClone: Record<string, unknown> | unknown[] = nextRoot;
  let currentBase: Record<string, unknown> | unknown[] = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const next = getPathSegmentValue(currentBase, segment) as
      | Record<string, unknown>
      | unknown[];
    const nextClone = cloneIfNecessary(
      next as FabricValue,
      SHALLOW_THAW_OPTS,
    ) as Record<string, unknown> | unknown[];
    setPathSegmentValue(currentClone, segment, nextClone);
    currentClone = nextClone;
    currentBase = next;
  }

  if (Array.isArray(currentClone)) {
    currentClone.splice(Number(last), 1);
  } else {
    delete currentClone[last];
  }

  return deepFreeze(nextRoot) as EntityDocument;
};
