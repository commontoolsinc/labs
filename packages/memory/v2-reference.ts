/**
 * Reference computation and conversion helpers for Memory v2.
 *
 * Provides functions to compute content-addressed hashes for facts,
 * commits, and values, as well as helpers for the Empty reference
 * sentinel and wire-format conversion.
 *
 * @see spec 01-data-model.md §3
 * @module v2-reference
 */

import type { Reference } from "merkle-reference";
import * as Ref from "merkle-reference";
import { refer } from "./reference.ts";
import type { ClientCommit, EntityId, Fact, JSONValue } from "./v2-types.ts";

/**
 * Compute the content hash of a fact based on its logical content.
 *
 * - SetWrite: hash of `{ type, id, value, parent }`
 * - PatchWrite: hash of `{ type, id, ops, parent }`
 * - Delete: hash of `{ type, id, parent }`
 *
 * @see spec 01-data-model.md §3.1
 */
export function computeFactHash(fact: Fact): Reference {
  switch (fact.type) {
    case "set":
      return refer({
        type: fact.type,
        id: fact.id,
        value: fact.value,
        parent: fact.parent,
      }) as unknown as Reference;
    case "patch":
      return refer({
        type: fact.type,
        id: fact.id,
        ops: fact.ops,
        parent: fact.parent,
      }) as unknown as Reference;
    case "delete":
      return refer({
        type: fact.type,
        id: fact.id,
        parent: fact.parent,
      }) as unknown as Reference;
  }
}

/**
 * Compute the Empty reference for an entity. This is the genesis state
 * sentinel -- the `parent` value for the first fact in an entity's
 * causal chain.
 *
 * Computed as `refer({ id: entityId })`.
 *
 * @see spec 01-data-model.md §3.2
 */
export function EMPTY(entityId: EntityId): Reference {
  return refer({ id: entityId }) as unknown as Reference;
}

/**
 * Compute the content hash of a client commit.
 *
 * @see spec 03-commit-model.md §3.4
 */
export function computeCommitHash(commit: ClientCommit): Reference {
  return refer(commit) as unknown as Reference;
}

/**
 * Compute the content hash of a JSON value, for storage in the value table.
 *
 * @see spec 01-data-model.md §3
 */
export function computeValueHash(value: JSONValue): Reference {
  return refer(value) as unknown as Reference;
}

/**
 * Check if a reference is the Empty reference for a given entity.
 *
 * @see spec 01-data-model.md §3.2
 */
export function isEmptyReference(
  ref: Reference,
  entityId: EntityId,
): boolean {
  return ref.toString() === EMPTY(entityId).toString();
}

/**
 * Convert a Reference to the CID link format used in JSON wire protocol.
 *
 * @see spec 01-data-model.md §3.3
 */
export function toWireFormat(ref: Reference): { "/": string } {
  return Ref.toJSON(ref as unknown as Ref.Reference);
}

/**
 * Convert from CID link format (JSON wire protocol) to a Reference.
 *
 * @see spec 01-data-model.md §3.3
 */
export function fromWireFormat(link: { "/": string }): Reference {
  return Ref.fromJSON(link) as unknown as Reference;
}
