import { isOpaqueRef } from "@commontools/common-builder";
import {
  type DocImpl,
  isQueryResultForDereferencing,
  isDocLink,
  isCell,
  isDoc,
  getDocLinkOrThrow,
  type DocLink,
  getDoc,
} from "./cell.js";
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
  source: Object = {},
  cause: any = crypto.randomUUID(),
): EntityId => {
  try {
    // Unwrap query result proxies, replace cells with their ids and remove
    // functions and undefined values, since `merkle-reference` doesn't support
    // them.
    const seen = new Set<any>();
    function traverse(obj: any): any {
      // Avoid cycles
      if (seen.has(obj)) return null;
      seen.add(obj);

      // Don't traverse into ids.
      if (typeof obj === "object" && obj !== null && "/" in obj) return obj;

      // If there is a .toJSON method, replace obj with it, then descend.
      if (
        typeof obj === "object" &&
        obj !== null &&
        typeof obj.toJSON === "function"
      ) {
        obj = obj.toJSON() ?? obj;
      }

      if (isOpaqueRef(obj)) return obj.export().value ?? crypto.randomUUID();

      if (isQueryResultForDereferencing(obj))
        // It'll traverse this and call .toJSON on the cell in the reference.
        obj = getDocLinkOrThrow(obj);

      // If referencing other cells, return their ids (or random as fallback).
      if (isDoc(obj) || isCell(obj)) return obj.entityId ?? crypto.randomUUID();
      else if (Array.isArray(obj)) return obj.map(traverse);
      else if (typeof obj === "object" && obj !== null)
        return Object.fromEntries(
          Object.entries(obj).map(([key, value]) => [key, traverse(value)]),
        );
      else if (typeof obj === "function") return obj.toString();
      else if (obj === undefined) return null;
      else return obj;
    }
    return refer(traverse({ ...source, causal: cause }));
  } catch (e) {
    // HACK: merkle-reference currently fails in a jsdom vitest environment, so
    // we replace the id with a random UUID.

    // @ts-ignore
    if (typeof process !== "undefined" && process.env.VITEST) {
      // We're in Vitest, so use a random UUID
      console.warn("Using random UUID as fallback for entity ID");
      return crypto.randomUUID() as unknown as EntityId;
    } else {
      // We're not in Vitest, so re-throw the error
      throw e;
    }
  }
};

/**
 * Extracts an entity ID from a cell or cell representation. Creates a stable
 * derivative entity ID for path references.
 *
 * @param value - The value to extract the entity ID from.
 * @returns The entity ID, or undefined if the value is not a cell.
 */
export const getEntityId = (value: any): EntityId | undefined => {
  if (typeof value === "string") return JSON.parse(value) as EntityId;
  if (typeof value === "object" && value !== null && "/" in value)
    return value as EntityId;

  let ref: DocLink | undefined = undefined;

  if (isQueryResultForDereferencing(value)) ref = getDocLinkOrThrow(value);
  else if (isDocLink(value)) ref = value;
  else if (isCell(value)) ref = value.getAsDocLink();
  else if (isDoc(value)) ref = { cell: value, path: [] };

  if (!ref?.cell.entityId) return undefined;

  if (ref.path.length > 0)
    return createRef({ path: ref.path }, ref.cell.entityId);
  else return ref.cell.entityId;
};

export function getDocByEntityId<T = any>(
  entityId: EntityId | string,
  createIfNotFound = true,
): DocImpl<T> | undefined {
  const id = typeof entityId === "string" ? entityId : JSON.stringify(entityId);
  let doc = entityIdToDocMap.get(id);
  if (doc) return doc;
  if (!createIfNotFound) return undefined;

  doc = getDoc<T>();
  if (typeof entityId === "string") entityId = JSON.parse(entityId) as EntityId;
  doc.entityId = entityId;
  setDocByEntityId(entityId, doc);
  return doc;
}

export const setDocByEntityId = (entityId: EntityId, cell: DocImpl<any>) => {
  entityIdToDocMap.set(JSON.stringify(entityId), cell);
};

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

const entityIdToDocMap = new CleanableMap<DocImpl<any>>();
