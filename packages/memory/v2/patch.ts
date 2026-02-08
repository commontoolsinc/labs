/**
 * Memory v2 Patch Operations
 *
 * Implements JSON Patch (RFC 6902 subset) plus a custom `splice` extension
 * for efficient array manipulation.
 *
 * From spec §01 §6.
 */

import type {
  AddOp,
  JSONPointer,
  JSONValue,
  MoveOp,
  PatchOp,
  RemoveOp,
  ReplaceOp,
  SpliceOp,
} from "./types.ts";

/**
 * Parse a JSON Pointer (RFC 6901) into path segments.
 * "" → [], "/foo" → ["foo"], "/foo/0/bar" → ["foo", "0", "bar"]
 */
export function parsePointer(pointer: JSONPointer): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer: must start with "/" or be empty`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Navigate to the parent of the target location, returning the parent
 * value and the final key.
 */
function navigateToParent(
  root: JSONValue,
  segments: string[],
): { parent: JSONValue; key: string } {
  if (segments.length === 0) {
    throw new Error("Cannot navigate to parent of root");
  }

  let current = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (Array.isArray(current)) {
      const idx = parseInt(seg, 10);
      if (isNaN(idx) || idx < 0 || idx >= current.length) {
        throw new Error(`Invalid array index: ${seg}`);
      }
      current = current[idx];
    } else if (current !== null && typeof current === "object") {
      if (!(seg in current)) {
        throw new Error(`Path not found: ${seg}`);
      }
      current = (current as Record<string, JSONValue>)[seg];
    } else {
      throw new Error(`Cannot navigate into primitive at segment: ${seg}`);
    }
  }

  return { parent: current, key: segments[segments.length - 1] };
}

/**
 * Deep clone a JSON value so we can safely mutate.
 */
function clone(value: JSONValue): JSONValue {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Apply a single replace operation.
 * Replaces the value at the target location.
 */
function applyReplace(state: JSONValue, op: ReplaceOp): JSONValue {
  const segments = parsePointer(op.path);

  // Replace root
  if (segments.length === 0) {
    return clone(op.value);
  }

  const result = clone(state);
  const { parent, key } = navigateToParent(result, segments);

  if (Array.isArray(parent)) {
    const idx = parseInt(key, 10);
    if (isNaN(idx) || idx < 0 || idx >= parent.length) {
      throw new Error(`Invalid array index for replace: ${key}`);
    }
    parent[idx] = clone(op.value);
  } else if (parent !== null && typeof parent === "object") {
    if (!(key in (parent as Record<string, JSONValue>))) {
      throw new Error(`Path not found for replace: ${key}`);
    }
    (parent as Record<string, JSONValue>)[key] = clone(op.value);
  } else {
    throw new Error(`Cannot replace on primitive`);
  }

  return result;
}

/**
 * Apply a single add operation.
 * Adds a value at the target location.
 * If the target is an array and key is "-", appends to the end.
 */
function applyAdd(state: JSONValue, op: AddOp): JSONValue {
  const segments = parsePointer(op.path);

  // Add at root replaces the whole document
  if (segments.length === 0) {
    return clone(op.value);
  }

  const result = clone(state);
  const { parent, key } = navigateToParent(result, segments);

  if (Array.isArray(parent)) {
    if (key === "-") {
      parent.push(clone(op.value));
    } else {
      const idx = parseInt(key, 10);
      if (isNaN(idx) || idx < 0 || idx > parent.length) {
        throw new Error(`Invalid array index for add: ${key}`);
      }
      parent.splice(idx, 0, clone(op.value));
    }
  } else if (parent !== null && typeof parent === "object") {
    (parent as Record<string, JSONValue>)[key] = clone(op.value);
  } else {
    throw new Error(`Cannot add to primitive`);
  }

  return result;
}

/**
 * Apply a single remove operation.
 */
function applyRemove(state: JSONValue, op: RemoveOp): JSONValue {
  const segments = parsePointer(op.path);

  if (segments.length === 0) {
    throw new Error(`Cannot remove root`);
  }

  const result = clone(state);
  const { parent, key } = navigateToParent(result, segments);

  if (Array.isArray(parent)) {
    const idx = parseInt(key, 10);
    if (isNaN(idx) || idx < 0 || idx >= parent.length) {
      throw new Error(`Invalid array index for remove: ${key}`);
    }
    parent.splice(idx, 1);
  } else if (parent !== null && typeof parent === "object") {
    if (!(key in (parent as Record<string, JSONValue>))) {
      throw new Error(`Path not found for remove: ${key}`);
    }
    delete (parent as Record<string, JSONValue>)[key];
  } else {
    throw new Error(`Cannot remove from primitive`);
  }

  return result;
}

/**
 * Get value at a JSON Pointer path.
 */
function getAtPointer(root: JSONValue, pointer: JSONPointer): JSONValue {
  const segments = parsePointer(pointer);
  let current = root;
  for (const seg of segments) {
    if (Array.isArray(current)) {
      const idx = parseInt(seg, 10);
      if (isNaN(idx) || idx < 0 || idx >= current.length) {
        throw new Error(`Invalid array index: ${seg}`);
      }
      current = current[idx];
    } else if (current !== null && typeof current === "object") {
      if (!(seg in current)) {
        throw new Error(`Path not found: ${seg}`);
      }
      current = (current as Record<string, JSONValue>)[seg];
    } else {
      throw new Error(`Cannot navigate into primitive at segment: ${seg}`);
    }
  }
  return current;
}

/**
 * Remove value at a JSON Pointer path (mutates).
 */
function removeAtPointer(root: JSONValue, pointer: JSONPointer): void {
  const segments = parsePointer(pointer);
  const { parent, key } = navigateToParent(root, segments);

  if (Array.isArray(parent)) {
    const idx = parseInt(key, 10);
    parent.splice(idx, 1);
  } else if (parent !== null && typeof parent === "object") {
    delete (parent as Record<string, JSONValue>)[key];
  }
}

/**
 * Set value at a JSON Pointer path (mutates).
 */
function setAtPointer(
  root: JSONValue,
  pointer: JSONPointer,
  value: JSONValue,
): void {
  const segments = parsePointer(pointer);
  const { parent, key } = navigateToParent(root, segments);

  if (Array.isArray(parent)) {
    if (key === "-") {
      parent.push(value);
    } else {
      const idx = parseInt(key, 10);
      parent.splice(idx, 0, value);
    }
  } else if (parent !== null && typeof parent === "object") {
    (parent as Record<string, JSONValue>)[key] = value;
  }
}

/**
 * Apply a single move operation.
 * Moves a value from one location to another.
 */
function applyMove(state: JSONValue, op: MoveOp): JSONValue {
  const result = clone(state);

  // Get the value at the source location
  const value = clone(getAtPointer(result, op.from));

  // Remove from source
  removeAtPointer(result, op.from);

  // Add at destination
  setAtPointer(result, op.path, value);

  return result;
}

/**
 * Apply a single splice operation (custom extension).
 * Removes `remove` elements at `index` in the target array,
 * and inserts `add` elements at that position.
 */
function applySplice(state: JSONValue, op: SpliceOp): JSONValue {
  const segments = parsePointer(op.path);

  const result = clone(state);
  let target: JSONValue;

  if (segments.length === 0) {
    target = result;
  } else {
    target = getAtPointer(result, op.path);
  }

  if (!Array.isArray(target)) {
    throw new Error(`Splice target is not an array`);
  }

  if (op.index < 0 || op.index > target.length) {
    throw new Error(
      `Splice index ${op.index} out of bounds for array of length ${target.length}`,
    );
  }

  const addItems = op.add.map((item) => clone(item));
  target.splice(op.index, op.remove, ...addItems);

  return result;
}

/**
 * Apply a single patch operation to a state value.
 */
export function applyOp(state: JSONValue, op: PatchOp): JSONValue {
  switch (op.op) {
    case "replace":
      return applyReplace(state, op);
    case "add":
      return applyAdd(state, op);
    case "remove":
      return applyRemove(state, op);
    case "move":
      return applyMove(state, op);
    case "splice":
      return applySplice(state, op);
    default:
      throw new Error(
        `Unknown patch operation: ${(op as { op: string }).op}`,
      );
  }
}

/**
 * Apply a sequence of patch operations to a state value.
 * Operations are applied in order, left to right.
 * If any operation fails, the entire patch fails.
 */
export function applyPatch(state: JSONValue, ops: PatchOp[]): JSONValue {
  let current = state;
  for (const op of ops) {
    current = applyOp(current, op);
  }
  return current;
}
