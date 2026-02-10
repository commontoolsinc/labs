/**
 * JSON Patch implementation for Memory v2.
 *
 * Implements RFC 6902 JSON Patch operations plus a custom `splice` extension
 * for efficient array manipulation. All operations are immutable -- they
 * return new values rather than modifying in place.
 *
 * @see spec 01-data-model.md §6
 * @module v2-patch
 */

import type { JSONValue } from "@commontools/api";
import type { JSONPointer, PatchOp } from "./v2-types.ts";

/**
 * Apply a sequence of patch operations to a JSON value.
 * Operations are applied in order, left to right. If any operation
 * fails, an error is thrown and no partial result is returned.
 *
 * @param state - The current JSON value to patch.
 * @param ops - Ordered list of patch operations to apply.
 * @returns The patched JSON value.
 * @throws If any operation is invalid.
 *
 * @see spec 01-data-model.md §6.3
 */
export function applyPatch(state: JSONValue, ops: PatchOp[]): JSONValue {
  let current = state;
  for (const op of ops) {
    current = applyOp(current, op);
  }
  return current;
}

/**
 * Apply a single patch operation to a JSON value.
 *
 * @param state - The current JSON value.
 * @param op - The patch operation to apply.
 * @returns The new JSON value after the operation.
 * @throws If the operation is invalid.
 */
export function applyOp(state: JSONValue, op: PatchOp): JSONValue {
  switch (op.op) {
    case "replace":
      return applyReplace(state, op.path, op.value);
    case "add":
      return applyAdd(state, op.path, op.value);
    case "remove":
      return applyRemove(state, op.path);
    case "move":
      return applyMove(state, op.from, op.path);
    case "splice":
      return applySplice(state, op.path, op.index, op.remove, op.add);
    default:
      throw new PatchError(
        `Unknown patch operation: ${(op as { op: string }).op}`,
      );
  }
}

/**
 * Parse a JSON Pointer (RFC 6901) into path segments.
 *
 * @param pointer - A JSON Pointer string, e.g. "/foo/bar/0".
 * @returns Array of unescaped path segments.
 * @throws If the pointer is malformed.
 */
export function parsePath(pointer: JSONPointer): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new PatchError(
      `Invalid JSON Pointer: must start with "/" or be empty, got "${pointer}"`,
    );
  }
  return pointer
    .substring(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Navigate to a value at the given path segments.
 *
 * @param value - The root JSON value to navigate.
 * @param segments - Path segments to follow.
 * @returns The value at the path.
 * @throws If any segment along the path doesn't exist.
 */
export function getAtPath(value: JSONValue, segments: string[]): JSONValue {
  let current: JSONValue = value;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (current === null || typeof current !== "object") {
      throw new PatchError(
        `Cannot navigate path segment "${segment}" on ${typeof current} value`,
      );
    }
    if (Array.isArray(current)) {
      const index = parseArrayIndex(segment, current.length);
      if (index >= current.length) {
        throw new PatchError(
          `Array index ${index} out of bounds (length ${current.length})`,
        );
      }
      current = current[index];
    } else {
      if (!(segment in current)) {
        throw new PatchError(`Property "${segment}" does not exist`);
      }
      current = (current as Record<string, JSONValue>)[segment];
    }
  }
  return current;
}

/**
 * Immutably set a value at a given path, returning a new root.
 *
 * @param value - The root JSON value.
 * @param segments - Path segments to the target location.
 * @param newValue - The value to set.
 * @param allowInsert - If true, allow inserting into arrays and adding new object keys.
 * @returns A new root value with the modification applied.
 */
export function setAtPath(
  value: JSONValue,
  segments: string[],
  newValue: JSONValue,
  allowInsert = false,
): JSONValue {
  if (segments.length === 0) {
    return newValue;
  }

  const [segment, ...rest] = segments;

  if (value === null || typeof value !== "object") {
    throw new PatchError(
      `Cannot set path segment "${segment}" on ${typeof value} value`,
    );
  }

  if (Array.isArray(value)) {
    // Handle the special "-" index (append to end)
    if (segment === "-" && rest.length === 0 && allowInsert) {
      return [...value, newValue];
    }

    const index = parseArrayIndex(segment, value.length);

    if (rest.length === 0 && allowInsert && index === value.length) {
      // Insert at end (equivalent to "-")
      return [...value, newValue];
    }

    if (rest.length === 0 && allowInsert && index <= value.length) {
      // Insert at index
      const result = [...value];
      result.splice(index, 0, newValue);
      return result;
    }

    if (index >= value.length) {
      throw new PatchError(
        `Array index ${index} out of bounds (length ${value.length})`,
      );
    }

    const result = [...value];
    result[index] = rest.length === 0
      ? newValue
      : setAtPath(value[index], rest, newValue, allowInsert);
    return result;
  }

  const obj = value as Record<string, JSONValue>;

  if (!allowInsert && !(segment in obj) && rest.length === 0) {
    throw new PatchError(
      `Property "${segment}" does not exist (use "add" to create)`,
    );
  }

  return {
    ...obj,
    [segment]: rest.length === 0 ? newValue : setAtPath(
      segment in obj ? obj[segment] : ({} as JSONValue),
      rest,
      newValue,
      allowInsert,
    ),
  };
}

/**
 * Immutably remove a value at a given path, returning a new root.
 *
 * @param value - The root JSON value.
 * @param segments - Path segments to the target location.
 * @returns A new root value with the target removed.
 * @throws If the path doesn't exist.
 */
export function removeAtPath(
  value: JSONValue,
  segments: string[],
): JSONValue {
  if (segments.length === 0) {
    throw new PatchError("Cannot remove the root document");
  }

  const [segment, ...rest] = segments;

  if (value === null || typeof value !== "object") {
    throw new PatchError(
      `Cannot remove path segment "${segment}" on ${typeof value} value`,
    );
  }

  if (Array.isArray(value)) {
    const index = parseArrayIndex(segment, value.length);
    if (index >= value.length) {
      throw new PatchError(
        `Array index ${index} out of bounds (length ${value.length})`,
      );
    }

    if (rest.length === 0) {
      const result = [...value];
      result.splice(index, 1);
      return result;
    }

    const result = [...value];
    result[index] = removeAtPath(value[index], rest);
    return result;
  }

  const obj = value as Record<string, JSONValue>;

  if (!(segment in obj)) {
    throw new PatchError(`Property "${segment}" does not exist`);
  }

  if (rest.length === 0) {
    const { [segment]: _, ...remaining } = obj;
    return remaining as JSONValue;
  }

  return {
    ...obj,
    [segment]: removeAtPath(obj[segment], rest),
  };
}

// ---------------------------------------------------------------------------
// Internal operation implementations
// ---------------------------------------------------------------------------

function applyReplace(
  state: JSONValue,
  path: JSONPointer,
  value: JSONValue,
): JSONValue {
  const segments = parsePath(path);
  // Replace requires the target to exist
  getAtPath(state, segments); // Throws if path doesn't exist
  return setAtPath(state, segments, value);
}

function applyAdd(
  state: JSONValue,
  path: JSONPointer,
  value: JSONValue,
): JSONValue {
  const segments = parsePath(path);
  if (segments.length === 0) {
    // Adding to root replaces the entire document
    return value;
  }

  // Validate that the parent exists
  const parentSegments = segments.slice(0, -1);
  if (parentSegments.length > 0) {
    getAtPath(state, parentSegments); // Throws if parent doesn't exist
  }

  return setAtPath(state, segments, value, true);
}

function applyRemove(state: JSONValue, path: JSONPointer): JSONValue {
  const segments = parsePath(path);
  // Remove requires the target to exist
  getAtPath(state, segments); // Throws if path doesn't exist
  return removeAtPath(state, segments);
}

function applyMove(
  state: JSONValue,
  from: JSONPointer,
  path: JSONPointer,
): JSONValue {
  const fromSegments = parsePath(from);
  const value = getAtPath(state, fromSegments);
  const afterRemove = removeAtPath(state, fromSegments);
  const toSegments = parsePath(path);
  return setAtPath(afterRemove, toSegments, value, true);
}

function applySplice(
  state: JSONValue,
  path: JSONPointer,
  index: number,
  removeCount: number,
  addItems: JSONValue[],
): JSONValue {
  const segments = parsePath(path);
  const target = getAtPath(state, segments);

  if (!Array.isArray(target)) {
    throw new PatchError(
      `Splice target must be an array, got ${typeof target}`,
    );
  }

  if (index < 0 || index > target.length) {
    throw new PatchError(
      `Splice index ${index} out of bounds (length ${target.length})`,
    );
  }

  if (removeCount < 0) {
    throw new PatchError(`Splice remove count must be non-negative`);
  }

  const newArray = [...target];
  newArray.splice(index, removeCount, ...addItems);
  return setAtPath(state, segments, newArray);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Parse an array index from a JSON Pointer segment.
 * Returns a non-negative integer.
 */
function parseArrayIndex(segment: string, _length: number): number {
  if (segment === "-") {
    throw new PatchError(
      `The "-" index is not valid for this operation`,
    );
  }

  // Leading zeros are not allowed per RFC 6901, except for "0" itself
  if (segment.length > 1 && segment.startsWith("0")) {
    throw new PatchError(
      `Invalid array index "${segment}": leading zeros not allowed`,
    );
  }

  const index = Number(segment);
  if (!Number.isInteger(index) || index < 0) {
    throw new PatchError(
      `Invalid array index "${segment}": must be a non-negative integer`,
    );
  }

  return index;
}

/**
 * Error thrown when a patch operation fails.
 */
export class PatchError extends Error {
  override name = "PatchError" as const;

  constructor(message: string) {
    super(message);
  }
}
