import type { FabricValue } from "@commonfabric/api";
import { deepFreeze } from "@commonfabric/data-model/deep-freeze";
import {
  cloneForMutation,
  CloneForMutationError,
  cloneIfNecessary,
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
 * Mutation discipline: each op is applied via a copy-on-write descent. The
 * spine of containers from the root down to the mutated container is thawed to
 * fresh mutable copies (via `cloneForMutation()`), the leaf operation is applied
 * to that mutable container, and subtrees off the spine stay frozen-by-reference
 * (structural sharing). The assembled tree is then fully deep-frozen at the
 * `applyPatch` boundary, so callers can rely on the return value being deeply
 * frozen.
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

/**
 * Copy-on-write thaw of the spine of `root` down to `thawPath`, returning the
 * new root and the mutable container at `thawPath`. Subtrees off the spine are
 * shared by identity (structural sharing); the caller's input is left untouched
 * (`cloneForMutation` defaults to `force: true`). `cloneForMutation`'s typed
 * errors are translated into this module's path-style messages, and a
 * value-at-path that isn't a plain container is rejected (patch ops only mutate
 * objects/arrays). `fullPath` is used for error messages.
 */
const thawSpine = (
  root: FabricValue,
  thawPath: string[],
  fullPath: string[],
  options?: { createMissing?: boolean; nextKeyAfterPath?: string },
): { root: FabricValue; container: PatchContainer } => {
  let value: FabricValue;
  let pathValue: FabricValue;
  try {
    ({ value, pathValue } = cloneForMutation(root, thawPath, options));
  } catch (e) {
    if (e instanceof CloneForMutationError) {
      throw new Error(
        e.kind === "missing-segment"
          ? `missing path ${encodePointer(fullPath)}`
          : `path is not traversable at ${encodePointer(fullPath)}`,
      );
    }
    throw e;
  }
  if (!isContainer(pathValue)) {
    throw new Error(`path is not traversable at ${encodePointer(fullPath)}`);
  }
  return { root: value, container: pathValue };
};

const replaceAtPath = (
  root: FabricValue,
  path: string[],
  value: FabricValue,
): FabricValue => {
  if (path.length === 0) {
    return cloneValue(value);
  }
  const { root: newRoot, container } = thawSpine(root, path.slice(0, -1), path);
  const key = path[path.length - 1]!;
  if (Array.isArray(container)) {
    container[requireExistingArrayIndex(container, key, path)] = cloneValue(
      value,
    );
  } else {
    container[key] = cloneValue(value);
  }
  return newRoot;
};

/**
 * Read-only check of `add`'s spine: missing *object* keys are fine (they get
 * created during the mutating descent), but a present array must already contain
 * any index traversed through, and a present non-container can't be traversed.
 * This is what keeps `add` from fabricating missing array indices (which
 * `cloneForMutation`'s `createMissing` would otherwise do).
 */
const validateAddSpine = (root: FabricValue, path: string[]): void => {
  let current: FabricValue = root;
  // Becomes true once we pass a missing object key: everything below is freshly
  // created, so all containers from there down are empty.
  let creating = false;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!;
    if (creating) {
      // A freshly-created array is empty, so an intermediate array index (or the
      // `-` append marker) can never resolve to an existing element to traverse
      // into -- reject it rather than fabricate one. Plain object keys are fine;
      // they get created on the way down.
      if (isArraySegment(segment) || segment === "-") {
        throw new Error(`missing path ${encodePointer(path)}`);
      }
      continue;
    }
    if (Array.isArray(current)) {
      current = current[requireExistingArrayIndex(current, segment, path)];
    } else if (isPatchObject(current)) {
      if (!Object.hasOwn(current, segment)) {
        creating = true;
        continue;
      }
      current = current[segment];
    } else {
      throw new Error(`path is not traversable at ${encodePointer(path)}`);
    }
  }
};

const addAtPath = (
  root: FabricValue,
  path: string[],
  value: FabricValue,
): FabricValue => {
  if (path.length === 0) {
    return cloneValue(value);
  }
  validateAddSpine(root, path);
  const key = path[path.length - 1]!;
  const { root: newRoot, container } = thawSpine(
    root,
    path.slice(0, -1),
    path,
    {
      createMissing: true,
      nextKeyAfterPath: key,
    },
  );
  if (Array.isArray(container)) {
    if (key === "-") {
      container.push(cloneValue(value));
    } else {
      container.splice(
        parseArrayInsertIndex(key, container.length),
        0,
        cloneValue(value),
      );
    }
  } else {
    container[key] = cloneValue(value);
  }
  return newRoot;
};

const removeAtPath = (root: FabricValue, path: string[]): FabricValue => {
  if (path.length === 0) {
    throw new Error("root remove must be represented as a delete operation");
  }
  const { root: newRoot, container } = thawSpine(root, path.slice(0, -1), path);
  const key = path[path.length - 1]!;
  if (Array.isArray(container)) {
    container.splice(requireExistingArrayIndex(container, key, path), 1);
  } else {
    if (!Object.hasOwn(container, key)) {
      throw new Error(`missing object key at ${encodePointer(path)}`);
    }
    delete container[key];
  }
  return newRoot;
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
): FabricValue => {
  const { root: newRoot, container } = thawSpine(root, path, path);
  if (!Array.isArray(container)) {
    throw new Error(`splice target is not an array at ${encodePointer(path)}`);
  }
  if (index < 0 || remove < 0 || index > container.length) {
    throw new Error(`invalid splice at ${encodePointer(path)}`);
  }
  container.splice(index, remove, ...add.map((value) => cloneValue(value)));
  return newRoot;
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
