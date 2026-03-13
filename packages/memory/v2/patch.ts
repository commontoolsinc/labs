import type { JSONValue } from "../interface.ts";
import type { PatchOp } from "../v2.ts";

type JSONObject = Record<string, JSONValue>;
type JSONContainer = JSONObject | JSONValue[];

export const applyPatch = (state: JSONValue, ops: PatchOp[]): JSONValue => {
  let current = structuredClone(state);
  for (const op of ops) {
    current = applyOp(current, op);
  }
  return current;
};

const applyOp = (state: JSONValue, op: PatchOp): JSONValue => {
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
  root: JSONValue,
  path: string[],
  value: JSONValue,
): JSONValue => {
  if (path.length === 0) {
    return structuredClone(value);
  }

  const clone = structuredClone(root);
  const { parent, key } = getExistingParent(clone, path);
  if (Array.isArray(parent)) {
    const index = parseArrayIndex(key);
    parent[index] = structuredClone(value);
  } else {
    parent[key] = structuredClone(value);
  }
  return clone;
};

const addAtPath = (
  root: JSONValue,
  path: string[],
  value: JSONValue,
): JSONValue => {
  if (path.length === 0) {
    return structuredClone(value);
  }

  const clone = structuredClone(root);
  const { parent, key } = getCreatableParent(clone, path);
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
  return clone;
};

const removeAtPath = (root: JSONValue, path: string[]): JSONValue => {
  if (path.length === 0) {
    throw new Error("root remove must be represented as a delete operation");
  }

  const clone = structuredClone(root);
  const { parent, key } = getExistingParent(clone, path);
  if (Array.isArray(parent)) {
    const index = parseArrayIndex(key);
    parent.splice(index, 1);
  } else if (Object.hasOwn(parent, key)) {
    delete parent[key];
  } else {
    throw new Error(`missing object key at ${encodePointer(path)}`);
  }
  return clone;
};

const moveValue = (
  root: JSONValue,
  from: string[],
  path: string[],
): JSONValue => {
  if (from.length === 0) {
    throw new Error("cannot move the root value");
  }

  const extracted = structuredClone(getAtPath(root, from));
  const removed = removeAtPath(root, from);
  return addAtPath(removed, path, extracted);
};

const spliceAtPath = (
  root: JSONValue,
  path: string[],
  index: number,
  remove: number,
  add: JSONValue[],
): JSONValue => {
  const clone = structuredClone(root);
  const target = path.length === 0 ? clone : getAtPath(clone, path);
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
  return clone;
};

const getAtPath = (root: JSONValue, path: string[]): JSONValue => {
  let current: JSONValue = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[parseArrayIndex(segment)];
    } else if (isObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      throw new Error(`missing path ${encodePointer(path)}`);
    }
  }
  return current;
};

const getExistingParent = (
  root: JSONValue,
  path: string[],
): { parent: JSONContainer; key: string } => {
  const key = path[path.length - 1]!;
  let current: JSONValue = root;

  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(current)) {
      current = current[parseArrayIndex(segment)];
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
    parseArrayIndex(key);
  }

  return { parent: current, key };
};

const getCreatableParent = (
  root: JSONValue,
  path: string[],
): { parent: JSONContainer; key: string } => {
  const key = path[path.length - 1]!;
  let current: JSONValue = root;

  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const next = path[index + 1]!;

    if (Array.isArray(current)) {
      const slot = segment === "-"
        ? current.length
        : parseArrayInsertIndex(segment, current.length);
      if (slot === current.length) {
        current.push(createContainer(next));
      } else if (current[slot] === undefined) {
        current[slot] = createContainer(next);
      }
      current = current[slot];
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

const createContainer = (nextSegment: string): JSONContainer => {
  return isArraySegment(nextSegment) || nextSegment === "-" ? [] : {};
};

const parsePointer = (path: string): string[] => {
  if (path === "") {
    return [];
  }
  if (!path.startsWith("/")) {
    throw new Error(`invalid JSON pointer: ${path}`);
  }
  return path.slice(1).split("/").map((segment) =>
    segment.replaceAll("~1", "/").replaceAll("~0", "~")
  );
};

const encodePointer = (path: string[]): string => {
  return path.length === 0
    ? ""
    : `/${
      path.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
        .join("/")
    }`;
};

const parseArrayIndex = (segment: string): number => {
  if (!isArraySegment(segment)) {
    throw new Error(`invalid array index: ${segment}`);
  }
  return Number(segment);
};

const parseArrayInsertIndex = (segment: string, length: number): number => {
  const index = parseArrayIndex(segment);
  if (index > length) {
    throw new Error(`array index out of bounds: ${segment}`);
  }
  return index;
};

const isArraySegment = (segment: string): boolean => /^\d+$/.test(segment);

const isObject = (value: JSONValue): value is JSONObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isContainer = (value: JSONValue): value is JSONContainer =>
  Array.isArray(value) || isObject(value);
