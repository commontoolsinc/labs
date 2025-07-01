import { type JSONSchema } from "./builder/types.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { type DocImpl, isDoc } from "./doc.ts";
import { type Cell, createCell } from "./cell.ts";
import {
  type LegacyAlias,
  type LegacyDocCellLink,
  type SigilWriteRedirectLink,
  type URI,
} from "./sigil-types.ts";
import { type ReactivityLog } from "./scheduler.ts";
import { arrayEqual } from "./path-utils.ts";
import {
  isWriteRedirectLink,
  parseLink,
  parseToLegacyCellLink,
} from "./link-utils.ts";
import type {
  IStorageTransaction,
  IMemoryAddress,
} from "./storage/interface.ts";
// import { StorageTransaction } from "./storage/transaction-shim.ts"; // Not needed, use runtime.edit()
import type { IRuntime } from "./runtime.ts";
import { toURI } from "./uri-utils.ts";
import type { MemorySpace } from "@commontools/memory/interface";

/**
 * Track visited cell links and memoize results during path resolution
 * and link following to prevent redundant work.
 */
interface Visits {
  /** Tracks visited cell links to detect cycles */
  seen: LegacyDocCellLink[];
  /** Cache for resolvePath results */
  resolvePathCache: Map<string, LegacyDocCellLink>;
  /** Cache for followLinks results */
  followLinksCache: Map<string, LegacyDocCellLink>;
}

/**
 * Creates a new visits tracking object.
 */
export function createVisits(): Visits {
  return {
    seen: [],
    resolvePathCache: new Map(),
    followLinksCache: new Map(),
  };
}

/**
 * Creates a cache key for a doc and path combination.
 */
function createPathCacheKey<T>(
  doc: DocImpl<T>,
  path: PropertyKey[],
  aliases: boolean = false,
): string {
  return JSON.stringify([doc.space, doc.toJSON(), path, aliases]);
}

/**
 * Creates a cache key for a URI and path combination.
 */
function createPathCacheKeyFromURI(
  uri: URI,
  space: MemorySpace,
  path: PropertyKey[],
  aliases: boolean = false,
): string {
  return JSON.stringify([space, { "/": uri.slice(3) }, path, aliases]);
}

/**
 * Helper to create an IMemoryAddress from a URI and path
 */
function createMemoryAddress(
  uri: URI,
  path: PropertyKey[],
  space: MemorySpace,
): IMemoryAddress {
  // Add the 'value' path prefix for entity data
  const actualPath = path.length === 0 ? ["value"] : ["value", ...path];
  return {
    id: uri,
    space,
    path: actualPath.map(p => p.toString()),
    type: "application/json",
  };
}

/**
 * Read a value using the transaction API
 */
function readValueWithTransaction(
  tx: IStorageTransaction,
  uri: URI,
  path: PropertyKey[],
  space: MemorySpace,
): any {
  const address = createMemoryAddress(uri, path, space);
  const result = tx.read(address);
  
  if (result.error) {
    // Handle not found by returning undefined
    if (result.error.name === "NotFoundError") {
      return undefined;
    }
    throw new Error(`Transaction read failed: ${result.error.message}`);
  }
  
  return result.ok?.value;
}

export function resolveLinkToValue<T>(
  doc: DocImpl<T>,
  path: PropertyKey[],
  log?: ReactivityLog,
  schema?: JSONSchema,
  rootSchema?: JSONSchema,
): LegacyDocCellLink {
  const visits = createVisits();
  const ref = resolvePath(doc, path, log, schema, rootSchema, visits);
  return followLinks(ref, log, visits);
}

/**
 * Transaction-based version of resolveLinkToValue.
 * Resolves a path to its final value location, following all links.
 */
export function resolveLinkToValueTx(
  tx: IStorageTransaction,
  runtime: IRuntime,
  uri: URI,
  space: MemorySpace,
  path: PropertyKey[],
  schema?: JSONSchema,
  rootSchema?: JSONSchema,
): { uri: URI; path: PropertyKey[]; space: MemorySpace; schema?: JSONSchema; rootSchema?: JSONSchema } {
  // TODO: Implement full transaction-based resolution
  // For now, use the existing implementation with a temporary doc
  const entityId = { "/": uri.slice(3) };
  const doc = runtime.documentMap.getDocByEntityId(space, entityId, false);
  if (!doc) {
    return { uri, path, space, schema, rootSchema };
  }
  
  const result = resolveLinkToValue(doc, path, undefined, schema, rootSchema);
  return {
    uri: toURI(result.cell.entityId),
    path: result.path,
    space: result.space || space,
    schema: result.schema,
    rootSchema: result.rootSchema,
  };
}

export function resolveLinkToWriteRedirect<T>(
  doc: DocImpl<T>,
  path: PropertyKey[],
  log?: ReactivityLog,
  schema?: JSONSchema,
  rootSchema?: JSONSchema,
): LegacyDocCellLink {
  const visits = createVisits();
  const ref = resolvePath(doc, path, log, schema, rootSchema, visits);
  return followLinks(ref, log, visits, true);
}

/**
 * Transaction-based version of resolveLinkToWriteRedirect.
 */
export function resolveLinkToWriteRedirectTx(
  tx: IStorageTransaction,
  runtime: IRuntime,
  uri: URI,
  space: MemorySpace,
  path: PropertyKey[],
  schema?: JSONSchema,
  rootSchema?: JSONSchema,
): { uri: URI; path: PropertyKey[]; space: MemorySpace; schema?: JSONSchema; rootSchema?: JSONSchema } {
  // TODO: Implement full transaction-based resolution
  // For now, use the existing implementation
  const entityId = { "/": uri.slice(3) };
  const doc = runtime.documentMap.getDocByEntityId(space, entityId, false);
  if (!doc) {
    return { uri, path, space, schema, rootSchema };
  }
  
  const result = resolveLinkToWriteRedirect(doc, path, undefined, schema, rootSchema);
  return {
    uri: toURI(result.cell.entityId),
    path: result.path,
    space: result.space || space,
    schema: result.schema,
    rootSchema: result.rootSchema,
  };
}

export function resolveLinks(
  ref: LegacyDocCellLink,
  log?: ReactivityLog,
): LegacyDocCellLink {
  const visits = createVisits();
  return followLinks(ref, log, visits);
}

function resolvePath<T>(
  doc: DocImpl<T>,
  path: PropertyKey[],
  log?: ReactivityLog,
  schema?: JSONSchema,
  rootSchema?: JSONSchema,
  visits: Visits = createVisits(),
): LegacyDocCellLink { // Follow aliases, doc links, etc. in path, so that we end up on the right
  // doc, meaning the one that contains the value we want to access without any
  // redirects in between.
  //
  // If the path points to a redirect itself, we don't want to follow it: Other
  // functions like followLinks will do that. We just want to skip the interim ones.
  //
  // All taken links are logged, but not the final one.
  //
  // Let's look at a few examples:
  //
  // Doc: { link }, path: [] --> no change
  // Doc: { link }, path: ["foo"] --> follow link, path: ["foo"]
  // Doc: { foo: { link } }, path: ["foo"] --> no change
  // Doc: { foo: { link } }, path: ["foo", "bar"] --> follow link, path: ["bar"]

  // Check if we already resolved this exact path
  const fullPathKey = createPathCacheKey(doc, path);
  const exactMatch = visits.resolvePathCache.get(fullPathKey);
  if (exactMatch) {
    return exactMatch;
  }

  // Try to find a cached result for a shorter path
  let startRef: LegacyDocCellLink = { cell: doc, path: [] };
  let keys = [...path];

  // Look for the longest matching prefix path in the cache
  for (let i = path.length - 1; i >= 0; i--) {
    const prefixPath = path.slice(0, i);
    const prefixKey = createPathCacheKey(doc, prefixPath);
    const prefixMatch = visits.resolvePathCache.get(prefixKey);

    if (prefixMatch) {
      startRef = prefixMatch;
      keys = [...path.slice(i)];
      break;
    }
  }

  const cfc = new ContextualFlowControl();
  let ref = startRef;

  while (keys.length) {
    // First follow all the aliases and links, _before_ accessing the key.
    ref = followLinks(ref, log, visits);

    // Now access the key.
    const key = keys.shift()!;

    const childPath = [...ref.path, key];
    let childSchema = ref.schema;
    if (
      ref.schema === undefined && schema !== undefined &&
      arrayEqual(path, childPath)
    ) {
      // Since path is childPath, restore schema
      childSchema = schema;
    } else {
      childSchema = cfc.getSchemaAtPath(
        ref.schema,
        [key.toString()],
        ref.rootSchema,
      );
    }
    ref = {
      cell: ref.cell,
      path: childPath,
      schema: childSchema,
      rootSchema: childSchema ? ref.rootSchema : undefined,
    };
  }

  // Cache the final result
  visits.resolvePathCache.set(fullPathKey, ref);
  return ref;
}

// Follows links and returns the last one, which is pointing to a value. It'll
// log all taken links, so not the returned one, and thus nothing if the ref
// already pointed to a value.
export function followLinks(
  ref: LegacyDocCellLink,
  log: ReactivityLog | undefined,
  visits: Visits,
  onlyWriteRedirects = false,
): LegacyDocCellLink {
  // Check if we already followed these links
  const cacheKey = createPathCacheKey(ref.cell, ref.path, onlyWriteRedirects);
  const cached = visits.followLinksCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let nextRef: LegacyDocCellLink | undefined;
  let result = ref;

  do {
    const resolvedRef = resolvePath(
      result.cell,
      result.path,
      log,
      result.schema,
      result.rootSchema,
      visits,
    );

    // Add schema back if we didn't get a new one
    if (!resolvedRef.schema && result.schema) {
      result = { ...resolvedRef, schema: result.schema };
      if (result.rootSchema) resolvedRef.rootSchema = result.rootSchema;
    } else {
      result = resolvedRef;
    }

    const target = result.cell.getAtPath(result.path);

    nextRef = !onlyWriteRedirects || isWriteRedirectLink(target)
      ? parseToLegacyCellLink(
        target,
        createCell(
          result.cell,
          [], // Use empty path to reference the document itself
          undefined,
          undefined,
          undefined,
          true,
        ),
      )
      : undefined;

    if (nextRef !== undefined) {
      // Add schema back if we didn't get a new one
      if (!nextRef.schema && result.schema) {
        nextRef = {
          ...nextRef,
          schema: result.schema,
        };
        if (result.rootSchema) nextRef.rootSchema = result.rootSchema;
      }

      // Log all the refs that were followed, but not the final value they point to.
      log?.reads.push({ ...result });

      result = nextRef;

      // Detect cycles (at this point these are all references that point to something)
      if (
        visits.seen.some((r) =>
          r.cell === result.cell && arrayEqual(r.path, result.path)
        )
      ) {
        throw new Error(
          `Reference cycle detected ${
            JSON.stringify(result.cell.entityId ?? "unknown")
          }/[${result.path.join(", ")}] ${JSON.stringify(visits.seen)}`,
        );
      }
      visits.seen.push(result);
    }
  } while (nextRef);

  // Cache the result
  visits.followLinksCache.set(cacheKey, result);
  return result;
}

// Follows aliases and returns cell reference describing the last alias.
// Only logs interim aliases, not the first one, and not the non-alias value.
export function followWriteRedirects<T = any>(
  writeRedirect: LegacyAlias | SigilWriteRedirectLink,
  base: DocImpl<T> | Cell<T>,
  log?: ReactivityLog,
): LegacyDocCellLink {
  if (isDoc(base)) base = base.asCell();
  else base = base as Cell<T>; // Makes TS happy

  if (isWriteRedirectLink(writeRedirect)) {
    const link = parseLink(writeRedirect, base);
    return followLinks(
      {
        cell: base.getDoc().runtime.documentMap.getDocByEntityId(
          link.space!,
          link.id!,
        ),
        path: link.path,
        space: link.space,
        schema: link.schema,
        rootSchema: link.rootSchema,
      } as LegacyDocCellLink,
      log,
      createVisits(),
      true,
    );
  } else {
    throw new Error(
      `Write redirect expected: ${JSON.stringify(writeRedirect)}`,
    );
  }
}

/**
 * Transaction-based version of resolveLinkToValue.
 * Resolves a URI and path to the final value location, following links.
 */
export function resolveLinkToValueWithTransaction(
  runtime: IRuntime,
  uri: URI,
  space: MemorySpace,
  path: PropertyKey[],
  log?: ReactivityLog,
  schema?: JSONSchema,
  rootSchema?: JSONSchema,
): { uri: URI; path: PropertyKey[]; space: MemorySpace; schema?: JSONSchema; rootSchema?: JSONSchema } {
  // For now, we need to get the doc to maintain compatibility
  const entityId = { "/": uri.slice(3) };
  const doc = runtime.documentMap.getDocByEntityId(space, entityId, false);
  if (!doc) {
    // Return the original if doc not found
    return { uri, path, space, schema, rootSchema };
  }
  
  // Use the existing function
  const result = resolveLinkToValue(doc, path, log, schema, rootSchema);
  
  // Convert back to URI-based result
  return {
    uri: toURI(result.cell.entityId),
    path: result.path,
    space: result.space || space,
    schema: result.schema,
    rootSchema: result.rootSchema,
  };
}

/**
 * Transaction-based version of resolveLinkToWriteRedirect.
 */
export function resolveLinkToWriteRedirectWithTransaction(
  runtime: IRuntime,
  uri: URI,
  space: MemorySpace,
  path: PropertyKey[],
  log?: ReactivityLog,
  schema?: JSONSchema,
  rootSchema?: JSONSchema,
): { uri: URI; path: PropertyKey[]; space: MemorySpace; schema?: JSONSchema; rootSchema?: JSONSchema } {
  // For now, we need to get the doc to maintain compatibility
  const entityId = { "/": uri.slice(3) };
  const doc = runtime.documentMap.getDocByEntityId(space, entityId, false);
  if (!doc) {
    // Return the original if doc not found
    return { uri, path, space, schema, rootSchema };
  }
  
  // Use the existing function
  const result = resolveLinkToWriteRedirect(doc, path, log, schema, rootSchema);
  
  // Convert back to URI-based result
  return {
    uri: toURI(result.cell.entityId),
    path: result.path,
    space: result.space || space,
    schema: result.schema,
    rootSchema: result.rootSchema,
  };
}

/**
 * Transaction-based version of followLinks that works with URIs.
 */
function followLinksWithTransaction(
  runtime: IRuntime,
  uri: URI,
  space: MemorySpace,
  path: PropertyKey[],
  log: ReactivityLog | undefined,
  visits: Visits,
  onlyWriteRedirects = false,
  schema?: JSONSchema,
  rootSchema?: JSONSchema,
): { uri: URI; path: PropertyKey[]; space: MemorySpace; schema?: JSONSchema; rootSchema?: JSONSchema } {
  // For compatibility, convert to doc and use existing function
  const entityId = { "/": uri.slice(3) };
  const doc = runtime.documentMap.getDocByEntityId(space, entityId, false);
  if (!doc) {
    return { uri, path, space, schema, rootSchema };
  }
  
  const ref: LegacyDocCellLink = { cell: doc, path, space, schema, rootSchema };
  const result = followLinks(ref, log, visits, onlyWriteRedirects);
  
  return {
    uri: toURI(result.cell.entityId),
    path: result.path,
    space: result.space || space,
    schema: result.schema,
    rootSchema: result.rootSchema,
  };
}
