/**
 * The nascent "modern cell representation". This module owns the experiment
 * flag and the flag-dispatched production and recognition of the serialized
 * entity-id reference form.
 */

import { isRecord } from "@commonfabric/utils/types";
import { FabricHash } from "@/fabric-primitives/index.ts";
import type { FabricObject } from "@/interface.ts";

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
// Link reference form (the link sigil envelope)
//

/**
 * The link-sigil tag. This module is the sole place that names the literal;
 * everything else routes through {@link linkRefFrom} / {@link isLinkRef} /
 * {@link linkRefPayload}.
 */
export const LINK_V1_TAG = "link@1" as const;

/**
 * A link reference: today the `{ "/": { "link@1": … } }` envelope wrapping a
 * link payload.
 *
 * Construction ({@link linkRefFrom}), recognition ({@link isLinkRef}) and
 * extraction ({@link linkRefPayload}) are gathered here so that this chokepoint
 * can later become the seam at which the modern cell representation dispatches
 * the envelope to a Fabric primitive (provisionally `FabricLink`) — the link
 * analog of {@link EntityRef}'s `{ "/": string }` → {@link FabricHash}. That
 * dispatch is intentionally NOT wired up yet: this pass only collapses the
 * scattered envelope sites onto these functions, so the eventual flag flip is a
 * localized edit here rather than a tree-wide change.
 *
 * When that dispatch lands, this type becomes a union (`FabricLink | { "/": …
 * }`) mirroring {@link EntityRef}. `Payload` is bounded by {@link FabricObject}
 * (the payload is always a stored/serialized fabric record) but otherwise open,
 * so this layer needn't know the exact field types (URI / MemorySpace /
 * JSONSchema — those stay in `runner`).
 */
export type LinkRef<Payload extends FabricObject> = {
  "/": { [LINK_V1_TAG]: Payload };
};

/** Wraps a link payload in the link-ref envelope. */
export function linkRefFrom<Payload extends FabricObject>(
  payload: Payload,
): LinkRef<Payload> {
  return { "/": { [LINK_V1_TAG]: payload } };
}

/**
 * Recognizes a {@link LinkRef}: the `{ "/": { "link@1": … } }` envelope, no
 * other props.
 */
export function isLinkRef(value: unknown): value is LinkRef<FabricObject> {
  return isRecord(value) &&
    Object.keys(value).length === 1 &&
    isRecord(value["/"]) &&
    LINK_V1_TAG in value["/"];
}

/**
 * Extracts the link payload from a {@link LinkRef}. Throws if the value is not
 * a link reference.
 */
export function linkRefPayload<Payload extends FabricObject>(
  value: LinkRef<Payload>,
): Payload {
  if (isLinkRef(value)) return value["/"][LINK_V1_TAG] as Payload;
  throw new Error("Not a link reference.");
}
