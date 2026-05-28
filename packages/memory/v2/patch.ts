import type { FabricValue } from "../interface.ts";
import { deepFreeze } from "@commonfabric/data-model/deep-freeze";
import {
  cloneIfNecessary,
  shallowMutableClone,
} from "@commonfabric/data-model/fabric-value";
import { isInstance, isObject } from "@commonfabric/utils/types";
import type { PatchOp } from "../v2.ts";
import { encodePointer, parsePointer } from "./path.ts";

type PatchObject = Record<string, FabricValue>;
type PatchContainer = PatchObject | FabricValue[];
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

/**
 * Deep-clones an incoming patch value for isolation, preserving
 * `FabricInstance` wrappers (e.g. `FabricError`, `FabricMap`).
 *
 * `structuredClone()` MUST NOT be used here: it silently demotes class
 * instances to plain objects. A demoted `FabricError` then fails the
 * `value instanceof FabricInstance` check in the wire/persistence codec
 * (`jsonFromValue`/`FabricInstanceHandler`), so it is serialized
 * generically and its wrapped native `Error` -- whose `message`/`stack`
 * are non-enumerable -- collapses to `{}`, losing the error entirely.
 *
 * `cloneIfNecessary()` deep-clones via the fabric value machinery
 * (`FabricInstance.deepClone()` for wrappers), preserving the class.
 * Its default options (`{ frozen: true, deep: true }`) return an
 * already-deep-frozen input by identity, so replayed engine passes over a
 * previously-frozen subtree reuse it in place; otherwise the value is
 * deep-cloned to a deep-frozen result. The assembled tree is deep-frozen
 * at the `applyPatch` boundary regardless.
 */
const cloneValue = (value: FabricValue): FabricValue => cloneIfNecessary(value);

/**
 * Applies a sequence of RFC 6902 JSON Patch operations (`replace`, `add`,
 * `remove`, `move`, `splice`) to a document tree, returning a new document
 * tree with the patches applied in order. JSON Pointer paths in the ops are
 * parsed via `parsePointer()` from `./path.ts`.
 *
 * Used during document materialization: `engine.ts` walks the stored patch
 * sequence for a branch and rebuilds the current document by replaying each
 * patch on top of the previous state (`applyPatchDocument` → `applyPatch`).
 * The function is therefore on the hot path for any read that reconstructs
 * a document from its stored patch list.
 *
 * Mutation discipline: each `applyOp` call uses `shallowMutableClone()` to
 * produce a new top-level copy of the container being modified, then
 * recurses into the path; containers off the modified path remain
 * frozen-by-reference. The returned tree is then fully deep-frozen at the
 * function boundary, completing the shallow-clone / mutate / deep-freeze
 * pattern: shallow clones at the immediate containers on the modified
 * path, deep-freeze of the assembled result before it leaves the function.
 * Callers can rely on the return value being deeply frozen.
 */
export const applyPatch = (
  state: FabricValue,
  ops: PatchOp[],
): FabricValue => {
  let current = state;
  for (const op of ops) {
    current = applyOp(current, op);
  }
  return deepFreeze(current);
};

const applyOp = (state: FabricValue, op: PatchOp): FabricValue => {
  switch (op.op) {
    case "replace":
      return replaceAtPath(state, parsePointer(op.path), op.value);
    case "add":
      return addAtPath(state, parsePointer(op.path), op.value);
    case "remove":
      return removeAtPath(state, parsePointer(op.path));
    case "move":
      return moveValue(state, parsePointer(op.from), parsePointer(op.path));
    case "splice":
      return spliceAtPath(
        state,
        parsePointer(op.path),
        op.index,
        op.remove,
        op.add,
      );
  }
};

const replaceAtPath = (
  root: FabricValue,
  path: string[],
  value: FabricValue,
  fullPath: string[] = path,
): FabricValue => {
  if (path.length === 0) {
    return cloneValue(value);
  }

  if (Array.isArray(root)) {
    const index = requireExistingArrayIndex(root, path[0]!, fullPath);
    const next = shallowMutableClone(root) as FabricValue[];
    if (path.length === 1) {
      next[index] = cloneValue(value);
      return next;
    }

    const child = root[index];
    if (!isContainer(child)) {
      throw new Error(`path is not traversable at ${encodePointer(fullPath)}`);
    }
    next[index] = replaceAtPath(child, path.slice(1), value, fullPath);
    return next;
  }

  if (!isPatchObject(root)) {
    throw new Error(`path is not traversable at ${encodePointer(fullPath)}`);
  }

  const next = shallowMutableClone(root) as PatchObject;
  const key = path[0]!;
  if (path.length === 1) {
    next[key] = cloneValue(value);
    return next;
  }

  if (!Object.hasOwn(root, key)) {
    throw new Error(`missing path ${encodePointer(fullPath)}`);
  }

  const child = root[key];
  if (!isContainer(child)) {
    throw new Error(`path is not traversable at ${encodePointer(fullPath)}`);
  }
  next[key] = replaceAtPath(child, path.slice(1), value, fullPath);
  return next;
};

const addAtPath = (
  root: FabricValue,
  path: string[],
  value: FabricValue,
  fullPath: string[] = path,
): FabricValue => {
  if (path.length === 0) {
    return cloneValue(value);
  }

  if (Array.isArray(root)) {
    const next = shallowMutableClone(root) as FabricValue[];
    const segment = path[0]!;
    if (path.length === 1) {
      if (segment === "-") {
        next.push(cloneValue(value));
      } else {
        const index = parseArrayInsertIndex(segment, root.length);
        next.splice(index, 0, cloneValue(value));
      }
      return next;
    }

    const index = requireExistingArrayIndex(root, segment, fullPath);
    const child = root[index];
    if (!isContainer(child)) {
      throw new Error(`path is not traversable at ${encodePointer(fullPath)}`);
    }
    next[index] = addAtPath(child, path.slice(1), value, fullPath);
    return next;
  }

  if (!isPatchObject(root)) {
    throw new Error(`path is not traversable at ${encodePointer(fullPath)}`);
  }

  const next = shallowMutableClone(root) as PatchObject;
  const key = path[0]!;
  if (path.length === 1) {
    next[key] = cloneValue(value);
    return next;
  }

  const child = Object.hasOwn(root, key)
    ? root[key]
    : createContainer(path[1]!);
  if (!isContainer(child)) {
    throw new Error(`path is not traversable at ${encodePointer(fullPath)}`);
  }

  next[key] = addAtPath(child, path.slice(1), value, fullPath);
  return next;
};

const removeAtPath = (
  root: FabricValue,
  path: string[],
  fullPath: string[] = path,
): FabricValue => {
  if (path.length === 0) {
    throw new Error("root remove must be represented as a delete operation");
  }

  if (Array.isArray(root)) {
    const index = requireExistingArrayIndex(root, path[0]!, fullPath);
    const next = shallowMutableClone(root) as FabricValue[];
    if (path.length === 1) {
      next.splice(index, 1);
      return next;
    }

    const child = root[index];
    if (!isContainer(child)) {
      throw new Error(`path is not traversable at ${encodePointer(fullPath)}`);
    }
    next[index] = removeAtPath(child, path.slice(1), fullPath);
    return next;
  }

  if (!isPatchObject(root)) {
    throw new Error(`path is not traversable at ${encodePointer(fullPath)}`);
  }

  const next = shallowMutableClone(root) as PatchObject;
  const key = path[0]!;
  if (path.length === 1) {
    if (!Object.hasOwn(root, key)) {
      throw new Error(`missing object key at ${encodePointer(fullPath)}`);
    }
    delete next[key];
    return next;
  }

  if (!Object.hasOwn(root, key)) {
    throw new Error(`missing path ${encodePointer(fullPath)}`);
  }

  const child = root[key];
  if (!isContainer(child)) {
    throw new Error(`path is not traversable at ${encodePointer(fullPath)}`);
  }
  next[key] = removeAtPath(child, path.slice(1), fullPath);
  return next;
};

const moveValue = (
  root: FabricValue,
  from: string[],
  path: string[],
): FabricValue => {
  if (from.length === 0) {
    throw new Error("cannot move the root value");
  }
  if (isStrictPrefixPath(from, path)) {
    throw new Error("cannot move a value into its own descendant");
  }

  const extracted = getAtPath(root, from);
  return addAtPath(removeAtPath(root, from), path, extracted);
};

const spliceAtPath = (
  root: FabricValue,
  path: string[],
  index: number,
  remove: number,
  add: FabricValue[],
  fullPath: string[] = path,
): FabricValue => {
  if (path.length === 0) {
    if (!Array.isArray(root)) {
      throw new Error(
        `splice target is not an array at ${encodePointer(fullPath)}`,
      );
    }
    if (index < 0 || remove < 0 || index > root.length) {
      throw new Error(`invalid splice at ${encodePointer(fullPath)}`);
    }
    const next = shallowMutableClone(root) as FabricValue[];
    next.splice(index, remove, ...add.map((value) => cloneValue(value)));
    return next;
  }

  if (Array.isArray(root)) {
    const next = shallowMutableClone(root) as FabricValue[];
    const pathIndex = requireExistingArrayIndex(root, path[0]!, fullPath);
    const child = root[pathIndex];
    if (!isContainer(child)) {
      throw new Error(`path is not traversable at ${encodePointer(fullPath)}`);
    }
    next[pathIndex] = spliceAtPath(
      child,
      path.slice(1),
      index,
      remove,
      add,
      fullPath,
    );
    return next;
  }

  if (!isPatchObject(root)) {
    throw new Error(`path is not traversable at ${encodePointer(fullPath)}`);
  }

  const key = path[0]!;
  if (!Object.hasOwn(root, key)) {
    throw new Error(`missing path ${encodePointer(fullPath)}`);
  }

  const child = root[key];
  if (!isContainer(child)) {
    throw new Error(`path is not traversable at ${encodePointer(fullPath)}`);
  }

  const next = shallowMutableClone(root) as PatchObject;
  next[key] = spliceAtPath(child, path.slice(1), index, remove, add, fullPath);
  return next;
};

const getAtPath = (root: FabricValue, path: string[]): FabricValue => {
  let current: FabricValue = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[requireExistingArrayIndex(current, segment, path)];
    } else if (isPatchObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      throw new Error(`missing path ${encodePointer(path)}`);
    }
  }
  return current;
};

const createContainer = (nextSegment: string): PatchContainer => {
  return isArraySegment(nextSegment) || nextSegment === "-" ? [] : {};
};

const parseArrayIndex = (segment: string): number => {
  if (!isArraySegment(segment)) {
    throw new Error(`invalid array index: ${segment}`);
  }
  const index = Number(segment);
  if (index > MAX_ARRAY_INDEX) {
    throw new Error(`array index out of bounds: ${segment}`);
  }
  return index;
};

const parseArrayInsertIndex = (segment: string, length: number): number => {
  const index = parseArrayIndex(segment);
  if (index > length) {
    throw new Error(`array index out of bounds: ${segment}`);
  }
  return index;
};

const requireExistingArrayIndex = (
  array: FabricValue[],
  segment: string,
  path: string[],
): number => {
  const index = parseArrayIndex(segment);
  if (!Object.hasOwn(array, index)) {
    throw new Error(`missing path ${encodePointer(path)}`);
  }
  return index;
};

const isStrictPrefixPath = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length < path.length &&
  prefix.every((segment, index) => path[index] === segment);

const isArraySegment = (segment: string): boolean =>
  /^(0|[1-9]\d*)$/.test(segment);

const isPatchObject = (value: FabricValue): value is PatchObject =>
  isObject(value) && !isInstance(value);

const isContainer = (value: FabricValue): value is PatchContainer =>
  Array.isArray(value) || isPatchObject(value);
