/**
 * Memory v2 Content Addressing
 *
 * Wraps the existing merkle-reference system for v2 fact hashing.
 * From spec §01 §3.
 */

import { refer } from "../reference.ts";
import type { View } from "merkle-reference";
import type {
  Delete,
  EntityId,
  Fact,
  PatchWrite,
  Reference,
  SetWrite,
} from "./types.ts";

// Re-export the core refer function
export { fromString, refer } from "../reference.ts";

/**
 * Compute the Empty reference for an entity.
 * This represents the genesis state before any writes.
 */
export function emptyRef(entityId: EntityId): Reference {
  return refer({ id: entityId }) as unknown as Reference;
}

/**
 * Compute the content hash of a fact.
 * The hash covers the logical content only.
 */
export function hashFact(fact: Fact): Reference {
  switch (fact.type) {
    case "set":
      return refer({
        type: fact.type,
        id: fact.id,
        value: (fact as SetWrite).value,
        parent: fact.parent,
      }) as unknown as Reference;
    case "patch":
      return refer({
        type: fact.type,
        id: fact.id,
        ops: (fact as PatchWrite).ops,
        parent: fact.parent,
      }) as unknown as Reference;
    case "delete":
      return refer({
        type: fact.type,
        id: (fact as Delete).id,
        parent: fact.parent,
      }) as unknown as Reference;
  }
}

/**
 * Check if a reference is the empty reference for an entity.
 */
export function isEmpty(ref: Reference, entityId: EntityId): boolean {
  return ref.toString() === emptyRef(entityId).toString();
}

/**
 * Compute a hash for a commit.
 */
export function hashCommit(commit: {
  version: number;
  branch: string;
  operations: unknown[];
  reads: unknown;
}): Reference {
  return refer(commit) as unknown as Reference;
}

/**
 * The well-known sentinel hash used for the empty/deleted value in the value table.
 */
export const EMPTY_VALUE_HASH = "__empty__";

/**
 * Convert a Reference to its string representation.
 */
export function refToString(ref: Reference | View<unknown>): string {
  return ref.toString();
}
