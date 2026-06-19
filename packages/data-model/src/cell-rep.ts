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

//
// Cell reference form (the link sigil envelope)
//

/**
 * The link-sigil tag. This module is the sole place that names the literal;
 * everything else routes through {@link cellRefFrom} / {@link isCellRef} /
 * {@link cellRefInner}.
 */
export const LINK_V1_TAG = "link@1" as const;

/**
 * A cell reference: today the `{ "/": { "link@1": … } }` envelope wrapping a
 * link payload.
 *
 * Construction ({@link cellRefFrom}), recognition ({@link isCellRef}) and
 * extraction ({@link cellRefInner}) are gathered here so that this chokepoint
 * can later become the seam at which the modern cell representation dispatches
 * the envelope to a Fabric primitive (provisionally `FabricRef`) — the link
 * analog of {@link EntityRef}'s `{ "/": string }` → {@link FabricHash}. That
 * dispatch is intentionally NOT wired up yet: this pass only collapses the
 * scattered envelope sites onto these functions, so the eventual flag flip is a
 * localized edit here rather than a tree-wide change.
 *
 * When that dispatch lands, this type becomes a union (`FabricRef | { "/": …
 * }`) mirroring {@link EntityRef}. `Inner` is left open so this layer needn't
 * know the link payload's field types (URI / MemorySpace / JSONSchema — those
 * stay in `runner`).
 */
export type CellRef<Inner = unknown> = { "/": { [LINK_V1_TAG]: Inner } };

/** Wraps a link payload in the cell-ref envelope. */
export function cellRefFrom<Inner>(inner: Inner): CellRef<Inner> {
  return { "/": { [LINK_V1_TAG]: inner } };
}

/**
 * Recognizes a {@link CellRef}: the `{ "/": { "link@1": … } }` envelope, no
 * other props.
 */
export function isCellRef(value: unknown): value is CellRef {
  return isRecord(value) &&
    Object.keys(value).length === 1 &&
    isRecord(value["/"]) &&
    LINK_V1_TAG in value["/"];
}

/**
 * Extracts the inner link payload from a {@link CellRef}. Throws if the value
 * is not a cell reference.
 */
export function cellRefInner<Inner = unknown>(value: CellRef<Inner>): Inner {
  if (isCellRef(value)) return value["/"][LINK_V1_TAG] as Inner;
  throw new Error("Not a cell reference.");
}
