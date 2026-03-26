import type { StorableDatum } from "../interface.ts";
import type { PatchOp } from "../v2.ts";
import { encodePointer, parsePointer } from "./path.ts";

type PatchObject = Record<string, StorableDatum>;
type PatchContainer = PatchObject | StorableDatum[];
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

export const applyPatch = (
  state: StorableDatum,
  ops: PatchOp[],
): StorableDatum => {
  // Clone once up front, then mutate the working copy per op.
  let current = structuredClone(state);
  for (const op of ops) {
    current = applyOp(current, op);
  }
  return current;
};

const applyOp = (state: StorableDatum, op: PatchOp): StorableDatum => {
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
  root: StorableDatum,
  path: string[],
  value: StorableDatum,
): StorableDatum => {
  if (path.length === 0) {
    return structuredClone(value);
  }

  const { parent, key } = getExistingParent(root, path);
  if (Array.isArray(parent)) {
    const index = parseArrayIndex(key);
    parent[index] = structuredClone(value);
  } else {
    parent[key] = structuredClone(value);
  }
  return root;
};

const addAtPath = (
  root: StorableDatum,
  path: string[],
  value: StorableDatum,
): StorableDatum => {
  if (path.length === 0) {
    return structuredClone(value);
  }

  const { parent, key } = getCreatableParent(root, path);
  if (Array.isArray(parent)) {
    if (key === "-") {
      parent.push(structuredClone(value));
    } else {
      const index = parseArrayInsertIndex(key, parent.length);
      parent.splice(index, 0, structuredClone(value));
    }
  } else {
    parent[key] = structuredClone(value);
  }
  return root;
};

const removeAtPath = (root: StorableDatum, path: string[]): StorableDatum => {
  if (path.length === 0) {
    throw new Error("root remove must be represented as a delete operation");
  }

  const { parent, key } = getExistingParent(root, path);
  if (Array.isArray(parent)) {
    const index = parseArrayIndex(key);
    parent.splice(index, 1);
  } else if (Object.hasOwn(parent, key)) {
    delete parent[key];
  } else {
    throw new Error(`missing object key at ${encodePointer(path)}`);
  }
  return root;
};

const moveValue = (
  root: StorableDatum,
  from: string[],
  path: string[],
): StorableDatum => {
  if (from.length === 0) {
    throw new Error("cannot move the root value");
  }
  if (isStrictPrefixPath(from, path)) {
    throw new Error("cannot move a value into its own descendant");
  }

  const extracted = structuredClone(getAtPath(root, from));
  removeAtPath(root, from);
  return addAtPath(root, path, extracted);
};

const spliceAtPath = (
  root: StorableDatum,
  path: string[],
  index: number,
  remove: number,
  add: StorableDatum[],
): StorableDatum => {
  const target = path.length === 0 ? root : getAtPath(root, path);
  if (!Array.isArray(target)) {
    throw new Error(`splice target is not an array at ${encodePointer(path)}`);
  }
  if (index < 0 || remove < 0 || index > target.length) {
    throw new Error(`invalid splice at ${encodePointer(path)}`);
  }
  target.splice(
    index,
    remove,
    ...add.map((value) => structuredClone(value)),
  );
  return root;
};

const getAtPath = (root: StorableDatum, path: string[]): StorableDatum => {
  let current: StorableDatum = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[requireExistingArrayIndex(current, segment, path)];
    } else if (isObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      throw new Error(`missing path ${encodePointer(path)}`);
    }
  }
  return current;
};

const getExistingParent = (
  root: StorableDatum,
  path: string[],
): { parent: PatchContainer; key: string } => {
  const key = path[path.length - 1]!;
  let current: StorableDatum = root;

  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(current)) {
      current = current[requireExistingArrayIndex(current, segment, path)];
    } else if (isObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      throw new Error(`missing path ${encodePointer(path)}`);
    }

    if (!isContainer(current)) {
      throw new Error(`path is not traversable at ${encodePointer(path)}`);
    }
  }

  if (!isContainer(current)) {
    throw new Error(`path is not traversable at ${encodePointer(path)}`);
  }

  if (Array.isArray(current)) {
    requireExistingArrayIndex(current, key, path);
  }

  return { parent: current, key };
};

const getCreatableParent = (
  root: StorableDatum,
  path: string[],
): { parent: PatchContainer; key: string } => {
  const key = path[path.length - 1]!;
  let current: StorableDatum = root;

  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const next = path[index + 1]!;

    if (Array.isArray(current)) {
      current = current[requireExistingArrayIndex(current, segment, path)];
    } else if (isObject(current)) {
      if (!Object.hasOwn(current, segment)) {
        current[segment] = createContainer(next);
      }
      current = current[segment];
    } else {
      throw new Error(`path is not traversable at ${encodePointer(path)}`);
    }

    if (!isContainer(current)) {
      throw new Error(`path is not traversable at ${encodePointer(path)}`);
    }
  }

  if (!isContainer(current)) {
    throw new Error(`path is not traversable at ${encodePointer(path)}`);
  }

  return { parent: current, key };
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
  array: StorableDatum[],
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

const isObject = (value: StorableDatum): value is PatchObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const isContainer = (value: StorableDatum): value is PatchContainer =>
  Array.isArray(value) || isObject(value);
