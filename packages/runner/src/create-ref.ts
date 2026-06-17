import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { isRecord } from "@commonfabric/utils/types";
import { isOpaqueRef } from "./builder/types.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import { isCell } from "./cell.ts";
import { fromURI } from "./uri-utils.ts";
import { parseLink } from "./link-utils.ts";

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
 * Generates an entity ID.
 *
 * Derivation inputs must resolve: a Cell with no entityId or an OpaqueRef with
 * no value throws rather than minting a random substitute, so a derived id never
 * silently becomes non-deterministic (audit S14). A missing `cause`, by
 * contrast, deliberately mints a fresh random id.
 *
 * @param source - The source object.
 * @param cause - Optional causal source. If omitted, a random id is minted.
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
): EntityId {
  const seen = new Set<any>();

  // Unwrap query result proxies, replace docs with their ids and remove
  // functions and undefined values, since our data model doesn't support them.
  // TODO(danfuzz): Revisit this when `undefined` is fully supported.
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

    // Don't traverse into ids.
    if (isRecord(obj) && "/" in obj) return obj;

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

    if (isOpaqueRef(obj)) {
      const val = obj.export().value;
      if (val == null) {
        // An OpaqueRef feeding a derived id must carry a value; otherwise the
        // id would silently become non-deterministic (audit S14). Fail closed.
        throw new Error(
          "[createRef] OpaqueRef has no value; cannot derive a stable id",
        );
      }
      return val;
    }

    if (isCellResultForDereferencing(obj)) {
      // It'll traverse this and call .toJSON on the doc in the reference.
      obj = getCellOrThrow(obj);
    }

    // If referencing other docs, return their ids (or random as fallback).
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
    else if (obj === undefined) return null;
    else return obj;
  }

  return entityIdFrom(hashOf(traverse({ ...source, causal: cause })));
}

/**
 * Helper to consistently get an entity ID from various object types
 */
export function getEntityId(value: any): { "/": string } | undefined {
  if (typeof value === "string") {
    // Handle URI format with "of:" prefix
    if (value.startsWith("of:")) value = fromURI(value);
    return value.startsWith("{") ? JSON.parse(value) : { "/": value };
  }

  const link = parseLink(value);

  if (!link || !link.id) return undefined;

  const entityId = { "/": fromURI(link.id) };

  if (link.path && link.path.length > 0) {
    return createRef({ path: link.path }, entityId).toJSON!();
  } else return entityId;
}
