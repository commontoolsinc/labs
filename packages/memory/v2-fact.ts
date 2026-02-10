/**
 * Memory v2 Fact Factory Functions
 *
 * Convenience factories for creating v2 operations with proper parent
 * references. Parallel to v1 fact.ts but for the v2 operation model.
 *
 * @see spec 03-commit-model.md §3.1
 * @module v2-fact
 */

import type {
  ClaimOperation,
  DeleteOperation,
  EntityId,
  JSONValue,
  PatchOp,
  PatchWriteOperation,
  SetOperation,
} from "./v2-types.ts";
import type { Reference } from "merkle-reference";
import { EMPTY } from "./v2-reference.ts";

/**
 * Create a set operation (full replacement).
 * If no parent is provided, uses EMPTY(id) indicating a new entity.
 */
export function setOp(
  id: EntityId,
  value: JSONValue,
  parent?: Reference,
): SetOperation {
  return { op: "set", id, value, parent: parent ?? EMPTY(id) };
}

/**
 * Create a patch operation (incremental change).
 * If no parent is provided, uses EMPTY(id).
 */
export function patchOp(
  id: EntityId,
  patches: PatchOp[],
  parent?: Reference,
): PatchWriteOperation {
  return { op: "patch", id, patches, parent: parent ?? EMPTY(id) };
}

/**
 * Create a delete operation (tombstone).
 * If no parent is provided, uses EMPTY(id).
 */
export function deleteOp(
  id: EntityId,
  parent?: Reference,
): DeleteOperation {
  return { op: "delete", id, parent: parent ?? EMPTY(id) };
}

/**
 * Create a claim operation (read assertion without mutation).
 * Parent is required since a claim asserts a specific state.
 */
export function claimOp(
  id: EntityId,
  parent: Reference,
): ClaimOperation {
  return { op: "claim", id, parent };
}
