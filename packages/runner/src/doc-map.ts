import { refer } from "merkle-reference/json";
import { isRecord } from "@commontools/utils/types";
import { URI } from "@commontools/memory/interface";
import { isOpaqueRef } from "./builder/types.ts";
import { getLogger } from "@commontools/utils/logger";
import { createDoc, type DocImpl, isDoc } from "./doc.ts";
import {
  getCellOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
import { isCell } from "./cell.ts";
import { parseLink } from "./link-utils.ts";
import type { IDocumentMap, IRuntime, MemorySpace } from "./runtime.ts";
import { fromURI } from "./uri-utils.ts";

const logger = getLogger("doc-map", { level: "debug", enabled: false });

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
    if (isRecord(obj) && "/" in obj && !isDoc(obj)) return obj;

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

  const entityId = refer(traverse({ ...source, causal: cause }));

  // CT823: Log ID creation with context
  const idStr = JSON.stringify(entityId);
  const sourcePreview = JSON.stringify(source).substring(0, 100);
  logger.info(() => [`[CT823-CREATE-ID] Created entity ID: ${idStr}, source preview: ${sourcePreview}, cause: ${cause}, timestamp: ${Date.now()}`]);

  return entityId;
}

/**
 * Extracts an entity ID from a cell or cell representation.
 *
 * @param value - The value to extract the entity ID from.
 * @returns The entity ID, or undefined if the value is not a cell or doc.
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

export class DocumentMap implements IDocumentMap {
  private entityIdToDocMap = new Map<string, DocImpl<any>>();

  constructor(readonly runtime: IRuntime) { }

  private _getDocKey(space: string, entityId: EntityId): string {
    return space + "/" + JSON.stringify(normalizeEntityId(entityId));
  }

  getDocByEntityId<T = any>(
    space: MemorySpace,
    entityId: EntityId | URI,
    createIfNotFound?: true,
    sourceIfCreated?: DocImpl<any>,
  ): DocImpl<T>;
  getDocByEntityId<T = any>(
    space: MemorySpace,
    entityId: EntityId | URI,
    createIfNotFound: false,
    sourceIfCreated?: DocImpl<any>,
  ): DocImpl<T> | undefined;
  getDocByEntityId<T = any>(
    space: MemorySpace,
    entityId: EntityId | URI,
    createIfNotFound = true,
    sourceIfCreated?: DocImpl<any>,
  ): DocImpl<T> | undefined {
    const normalizedId = normalizeEntityId(entityId);

    let doc = this.entityIdToDocMap.get(this._getDocKey(space, normalizedId));
    if (doc) return doc;
    if (!createIfNotFound) return undefined;

    doc = createDoc<T>(undefined as T, normalizedId, space, this.runtime);
    doc.sourceCell = sourceIfCreated;
    return doc;
  }

  registerDoc<T>(entityId: EntityId, doc: DocImpl<T>, space: string): void {
    this.entityIdToDocMap.set(this._getDocKey(space, entityId), doc);
  }

  cleanup(): void {
    this.entityIdToDocMap.clear();
  }

  /**
   * Get or create a document with the specified value, cause, and space
   */
  getDoc<T>(value: T, cause: any, space: MemorySpace): DocImpl<T> {
    // Generate entity ID from value and cause
    const entityId = createRef(
      isRecord(value)
        ? (value as object)
        : value !== undefined
          ? { value }
          : {},
      cause,
    );
    const existing = this.getDocByEntityId<T>(space, entityId, false);
    if (existing) return existing;

    return createDoc(value, entityId, space, this.runtime);
  }
}

function normalizeEntityId(entityId: EntityId | URI): EntityId {
  if (typeof entityId === "string") {
    if (entityId.startsWith("of:")) {
      return { "/": fromURI(entityId) };
    }
    return JSON.parse(entityId) as EntityId;
  } else if (isRecord(entityId) && "/" in entityId) {
    return entityId;
  } else {
    throw new Error("Invalid entity ID: " + JSON.stringify(entityId));
  }
}
