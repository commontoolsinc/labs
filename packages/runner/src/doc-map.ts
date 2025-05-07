import { isOpaqueRef } from "@commontools/builder";
import { createDoc, type DocImpl, isDoc } from "./doc.ts";
import {
  getCellLinkOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
import { type CellLink, isCell, isCellLink } from "./cell.ts";
import { refer } from "merkle-reference";

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
export const createRef = (
  source: Record<string | number | symbol, any> = {},
  cause: any = crypto.randomUUID(),
): EntityId => {
  const seen = new Set<any>();

  // Unwrap query result proxies, replace docs with their ids and remove
  // functions and undefined values, since `merkle-reference` doesn't support
  // them.
  function traverse(obj: any): any {
    // Avoid cycles
    if (seen.has(obj)) return null;
    seen.add(obj);

    // Don't traverse into ids.
    if (typeof obj === "object" && obj !== null && "/" in obj) return obj;

    // If there is a .toJSON method, replace obj with it, then descend.
    if (
      typeof obj === "object" && obj !== null &&
      typeof obj.toJSON === "function"
    ) {
      obj = obj.toJSON() ?? obj;
    }

    if (isOpaqueRef(obj)) return obj.export().value ?? crypto.randomUUID();

    if (isQueryResultForDereferencing(obj)) {
      // It'll traverse this and call .toJSON on the doc in the reference.
      obj = getCellLinkOrThrow(obj);
    }

    // If referencing other docs, return their ids (or random as fallback).
    if (isDoc(obj) || isCell(obj)) return obj.entityId ?? crypto.randomUUID();
    else if (Array.isArray(obj)) return obj.map(traverse);
    else if (typeof obj === "object" && obj !== null) {
      return Object.fromEntries(
        Object.entries(obj).map(([key, value]) => [key, traverse(value)]),
      );
    } else if (typeof obj === "function") return obj.toString();
    else if (obj === undefined) return null;
    else return obj;
  }

  return refer(traverse({ ...source, causal: cause }));
};

/**
 * Extracts an entity ID from a cell or cell representation. Creates a stable
 * derivative entity ID for path references.
 *
 * @param value - The value to extract the entity ID from.
 * @returns The entity ID, or undefined if the value is not a cell or doc.
 */
export const getEntityId = (value: any): { "/": string } | undefined => {
  if (typeof value === "string") {
    return value.startsWith("{") ? JSON.parse(value) : { "/": value };
  }
  if (typeof value === "object" && value !== null && "/" in value) {
    return JSON.parse(JSON.stringify(value));
  }

  let ref: CellLink | undefined = undefined;

  if (isQueryResultForDereferencing(value)) ref = getCellLinkOrThrow(value);
  else if (isCellLink(value)) ref = value;
  else if (isCell(value)) ref = value.getAsCellLink();
  else if (isDoc(value)) ref = { cell: value, path: [] };

  if (!ref?.cell.entityId) return undefined;

  if (ref.path.length > 0) {
    return JSON.parse(
      JSON.stringify(createRef({ path: ref.path }, ref.cell.entityId)),
    );
  } else return JSON.parse(JSON.stringify(ref.cell.entityId));
};

/**
 * A map that holds weak references to its values per space.
 */
class SpaceAwareCleanableMap<T extends object> {
  private maps = new Map<string, CleanableMap<T>>();

  set(space: string, key: string, value: T) {
    let map = this.maps.get(space);
    if (!map) {
      map = new CleanableMap<T>();
      this.maps.set(space, map);
    }
    map.set(key, value);
  }

  get(space: string, key: string): T | undefined {
    return this.maps.get(space)?.get(key);
  }
}

const entityIdToDocMap = new SpaceAwareCleanableMap<DocImpl<any>>();

/**
 * A map that holds weak references to its values. Triggers a cleanup of the map
 * when any item was garbage collected, so that the weak references themselves
 * can be garbage collected.
 */
class CleanableMap<T extends object> {
  private map = new Map<string, WeakRef<T>>();
  private cleanupScheduled = false;

  set(key: string, value: T) {
    this.map.set(key, new WeakRef(value));
  }

  get(key: string): T | undefined {
    const ref = this.map.get(key);
    if (ref) {
      const value = ref.deref();
      if (value === undefined) {
        this.scheduleCleanup();
      }
      return value;
    }
    return undefined;
  }

  private scheduleCleanup() {
    if (!this.cleanupScheduled) {
      this.cleanupScheduled = true;
      queueMicrotask(() => {
        this.cleanup();
        this.cleanupScheduled = false;
      });
    }
  }

  private cleanup() {
    for (const [key, ref] of this.map) {
      if (ref.deref() === undefined) {
        this.map.delete(key);
      }
    }
  }
}

export function getDocByEntityId<T = any>(
  space: string,
  entityId: EntityId | string,
  createIfNotFound = true,
  sourceIfCreated?: DocImpl<any>,
): DocImpl<T> | undefined {
  const id = typeof entityId === "string" ? entityId : JSON.stringify(entityId);
  let doc = entityIdToDocMap.get(space, id);
  if (doc) return doc;
  if (!createIfNotFound) return undefined;

  if (typeof entityId === "string") entityId = JSON.parse(entityId) as EntityId;
  doc = createDoc<T>(undefined as T, entityId, space);
  doc.sourceCell = sourceIfCreated;
  return doc;
}

export const setDocByEntityId = (
  space: string,
  entityId: EntityId,
  doc: DocImpl<any>,
) => {
  // throw if doc already exists
  if (entityIdToDocMap.get(space, JSON.stringify(entityId))) {
    throw new Error("Doc already exists");
  }

  entityIdToDocMap.set(space, JSON.stringify(entityId), doc);
};
