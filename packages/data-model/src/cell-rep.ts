/**
 * The nascent "modern cell representation". This module owns the experiment
 * flag and the flag-dispatched production and recognition of the serialized
 * entity-id reference form.
 */

import { isRecord } from "@commonfabric/utils/types";
import { FabricHash } from "@/fabric-primitives/index.ts";

//
// Configuration flags
//

/**
 * Module-level flag for the modern cell representation.
 */
let modernCellRepEnabled = false;

/** Activates or deactivates the modern cell representation flag. */
export function setModernCellRepConfig(enabled?: boolean): void {
  if (enabled !== undefined) {
    modernCellRepEnabled = enabled ?? false;
  }
}

/** Returns whether the modern cell representation flag is currently enabled. */
export function getModernCellRepConfig(): boolean {
  return modernCellRepEnabled;
}

/** Restores the modern cell representation flag to its default. */
export function resetModernCellRepConfig(): void {
  modernCellRepEnabled = false;
}

//
// Entity-id reference form
//

/**
 * The serialized/extracted form of an entity-id reference, as produced by
 * `Cell.entityId` and `getEntityId` and consumed wherever such a reference is
 * read back. Its concrete shape is flag-dispatched: with the modern cell
 * representation _off_ it is a plain `{ "/": "<tag>:<hash>" }` object; with it
 * _on_ it is a straight {@link FabricHash}.
 *
 * This is distinct from the branded `EntityId` (an addressing `FabricHash`):
 * in modern mode the two coincide, but in legacy mode the serialized reference
 * is the plain object.
 *
 * Recognition ({@link isEntityRef}, {@link entityRefToString}) is strict — it
 * accepts only the form for the _currently active_ regime, never both. This is
 * deliberate: a stored hash carries no record of which input form produced it,
 * so legacy-hash and modern-hash data are a clean break, never intermixed
 * within one regime.
 */
export type EntityRef = FabricHash | { "/": string };

/**
 * Produces an {@link EntityRef} from a tagged hash string (e.g. `"fid1:…"`).
 */
export function entityRefFromString(taggedHash: string): EntityRef {
  return modernCellRepEnabled
    ? FabricHash.fromString(taggedHash)
    : { "/": taggedHash };
}

/** Produces an {@link EntityRef} from a {@link FabricHash}. */
export function entityRefFrom(hash: FabricHash): EntityRef {
  return modernCellRepEnabled ? hash : { "/": hash.taggedHashString };
}

/**
 * Recognizes an {@link EntityRef} for the currently active regime: a
 * {@link FabricHash} in modern mode, a `{ "/": string }` object in legacy mode.
 */
export function isEntityRef(value: unknown): value is EntityRef {
  return modernCellRepEnabled
    ? value instanceof FabricHash
    : isRecord(value) && typeof value["/"] === "string";
}

/**
 * Extracts the tagged hash string from an {@link EntityRef}. Throws if the
 * value is not a reference for the currently active regime.
 */
export function entityRefToString(value: EntityRef): string {
  if (modernCellRepEnabled) {
    if (value instanceof FabricHash) return value.taggedHashString;
  } else if (isRecord(value) && typeof value["/"] === "string") {
    return value["/"];
  }
  throw new Error(
    "Not an entity-id reference for the active cell-rep regime.",
  );
}
