import { refer } from "merkle-reference";
import { isRecord } from "@commontools/utils/types";
import { isOpaqueRef } from "./builder/types.ts";
import {
  getCellOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
import { isCell } from "./cell.ts";
import { fromURI } from "./uri-utils.ts";
import { parseLink } from "./link-utils.ts";

export type EntityId = {
  "/": string | Uint8Array;
  toJSON?: () => { "/": string };
};

/**
 * Generates an entity ID.
 *
 * @param source - The source object.
 * @param cause - Optional causal source. Otherwise a random n is used.
 */
export function createRef(
  source: Record<string | number | symbol, any> = {},
  cause: any = crypto.randomUUID(),
): EntityId {
  const seen = new Set<any>();

  // Unwrap query result proxies, replace docs with their ids and remove
  // functions and undefined values, since `merkle-reference` doesn't support
  // them.
  function traverse(obj: any): any {
    // Avoid cycles
    if (seen.has(obj)) return null;
    seen.add(obj);

    // Don't traverse into ids.
    if (isRecord(obj) && "/" in obj) return obj;

    // If there is a .toJSON method, replace obj with it, then descend.
    // TODO(seefeld): We have to accept functions for now as the recipe factory
    // is a function and has a .toJSON method. But we plan to move away from
    // that kind of serialization anyway, so once we did, remove this.
    if (
      (isRecord(obj) || typeof obj === "function") &&
      typeof obj.toJSON === "function"
    ) {
      obj = obj.toJSON() ?? obj;
    }

    if (isOpaqueRef(obj)) return obj.export().value ?? crypto.randomUUID();

    if (isQueryResultForDereferencing(obj)) {
      // It'll traverse this and call .toJSON on the doc in the reference.
      obj = getCellOrThrow(obj);
    }

    // If referencing other docs, return their ids (or random as fallback).
    if (isCell(obj)) return obj.entityId ?? crypto.randomUUID();
    else if (Array.isArray(obj)) return obj.map(traverse);
    else if (isRecord(obj)) {
      return Object.fromEntries(
        Object.entries(obj).map(([key, value]) => [key, traverse(value)]),
      );
    } else if (typeof obj === "function") return obj.toString();
    else if (obj === undefined) return null;
    else return obj;
  }

  return refer(traverse({ ...source, causal: cause }));
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
    return JSON.parse(
      JSON.stringify(createRef({ path: link.path }, entityId)),
    );
  } else return entityId;
}
