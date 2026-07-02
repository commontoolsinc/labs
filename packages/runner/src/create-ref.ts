import { hashOf } from "@commonfabric/data-model/value-hash";
import {
  BaseFabricPrimitive,
  type EntityKind,
  FabricHash,
  withEntityKind,
} from "@commonfabric/data-model/fabric-primitives";
import {
  type EntityRef,
  entityRefFrom,
  entityRefFromString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
import { isRecord } from "@commonfabric/utils/types";
import { isReactive } from "./builder/types.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import { isCell } from "./cell.ts";
import { fromURI } from "./uri-utils.ts";
import { isSigilLink, parseLink } from "./link-utils.ts";

declare const ENTITY_ID_BRAND: unique symbol;

/**
 * An entity id: a {@link FabricHash} that specifically names a cell/document
 * within a space (as produced by {@link createRef}), as opposed to an arbitrary
 * content/value/schema hash. The brand is type-only — at runtime an `EntityId`
 * is just a `FabricHash` — and exists to keep "this hash is an entity id" a
 * distinct, intentional thing in the type system. Construct via
 * {@link entityIdFrom} (or {@link createRef}).
 */
export type EntityId = FabricHash & { readonly [ENTITY_ID_BRAND]: true };

/** Brands a content-hash string (or `FabricHash`) as an {@link EntityId}. */
export function entityIdFrom(hash: string | FabricHash): EntityId {
  return (typeof hash === "string"
    ? FabricHash.fromString(hash)
    : hash) as EntityId;
}

/**
 * Options for {@link createRef}.
 */
export type CreateRefOptions = {
  /**
   * Entity kind minted into BOTH the hash preimage and the visible tag
   * (`fid2:computed:<hash>`), so the two representations cannot diverge and
   * a kind change necessarily names a different entity. See
   * `docs/specs/computed-cell-identity.md`.
   */
  kind?: EntityKind;
};

/**
 * Generates an entity ID.
 *
 * Derivation inputs must resolve: a Cell with no entityId or a Reactive with
 * no value throws rather than minting a random substitute, so a derived id never
 * silently becomes non-deterministic (audit S14). A missing `cause`, by
 * contrast, deliberately mints a fresh random id.
 *
 * @param source - The source object.
 * @param cause - Optional causal source. If omitted, a random id is minted.
 * @param options - Optional kind; see {@link CreateRefOptions}.
 */
export function createRef(
  source: Record<string | number | symbol, any> = {},
  cause: any = (() => {
    console.error(
      "[createRef] NO CAUSE — falling back to randomUUID",
      new Error().stack,
    );
    return crypto.randomUUID();
  })(),
  options?: CreateRefOptions,
): EntityId {
  const seen = new Set<any>();

  // Unwrap query result proxies and replace docs with their ids; functions are
  // stringified, since our data model doesn't support them as values.
  function traverse(obj: any): any {
    // Avoid cycles — only track objects/arrays/functions (not primitives).
    // Primitives use value equality in Set, so repeated strings like
    // "primary" would be incorrectly deduplicated, causing hash collisions
    // for patterns that differ only in the position of repeated values.
    if (
      obj !== null && (typeof obj === "object" || typeof obj === "function")
    ) {
      if (seen.has(obj)) return null;
      seen.add(obj);
    }

    // Don't traverse into atomic values or already-serialized references. A
    // `FabricPrimitive` (a `FabricHash` id, `FabricBytes`, a date, …) is an
    // atomic value and must be hashed via its own codec — descending into one
    // would decompose it to its (empty) enumerable props and collide distinct
    // values. A serialized entity-ref or sigil link is a reference to another
    // cell, recognized through the cell-rep / sigil chokepoint predicates rather
    // than the raw `{ "/": ... }` shape.
    //
    // TODO(danfuzz): the other data-model special-object type, `FabricInstance`
    // (a container that holds other values), is not handled here. Unlike a
    // primitive it *does* need descending into — but by its actual contents,
    // which the generic enumerable-prop traversal below won't do correctly. This
    // site will need attention once FabricInstances see real use.
    if (obj instanceof BaseFabricPrimitive) return obj;
    if (isSigilLink(obj) || isEntityRef(obj)) return obj;

    // If there is a .toJSON method, replace obj with it, then descend.
    // TODO(seefeld): We have to accept functions for now as the pattern factory
    // is a function and has a .toJSON method. But we plan to move away from
    // that kind of serialization anyway, so once we did, remove this.
    if (
      (isRecord(obj) || typeof obj === "function") &&
      typeof obj.toJSON === "function"
    ) {
      obj = obj.toJSON() ?? obj;
    }

    if (isReactive(obj)) {
      const val = obj.export().value;
      if (val == null) {
        // An Reactive feeding a derived id must carry a value; otherwise the
        // id would silently become non-deterministic (audit S14). Fail closed.
        throw new Error(
          "[createRef] Reactive has no value; cannot derive a stable id",
        );
      }
      return val;
    }

    if (isCellResultForDereferencing(obj)) {
      // It'll traverse this and call .toJSON on the doc in the reference.
      obj = getCellOrThrow(obj);
    }

    // If referencing other docs, return their ids.
    if (isCell(obj)) {
      const id = obj.entityId;
      if (id == null) {
        // A Cell referenced from a derived id must have an entityId; otherwise
        // the id would silently become non-deterministic (audit S14). Fail
        // closed rather than mint a random substitute.
        throw new Error(
          "[createRef] Cell has no entityId; cannot derive a stable id",
        );
      }
      return id;
    } else if (Array.isArray(obj)) return obj.map(traverse);
    else if (isRecord(obj)) {
      return Object.fromEntries(
        Object.entries(obj).map(([key, value]) => [key, traverse(value)]),
      );
    } else if (typeof obj === "function") return obj.toString();
    else return obj;
  }

  const kind = options?.kind;
  // The kind changes the preimage SHAPE, not just a key: an untagged preimage
  // always carries a top-level `causal` key, while the kind envelope never
  // does, so no untagged id can collide bytes-for-bytes with a kind-tagged one
  // (guards code paths that compare `hashString`/bytes instead of the full
  // tagged form).
  const preimage = kind === undefined
    ? { ...source, causal: cause }
    : { entityKind: kind, inner: { ...source, causal: cause } };
  const hash = hashOf(traverse(preimage));
  return entityIdFrom(kind === undefined ? hash : withEntityKind(hash, kind));
}

/**
 * Helper to consistently get an entity ID from various object types
 */
export function getEntityId(value: any): EntityRef | undefined {
  if (typeof value === "string") {
    // Handle URI format with "of:" prefix
    if (value.startsWith("of:")) value = fromURI(value);
    return entityRefFromString(value);
  }

  const link = parseLink(value);

  if (!link || !link.id) return undefined;

  const baseRef = entityRefFromString(fromURI(link.id));

  if (link.path && link.path.length > 0) {
    return entityRefFrom(createRef({ path: link.path }, baseRef));
  } else return baseRef;
}
