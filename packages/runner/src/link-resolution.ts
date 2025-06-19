import { type JSONSchema } from "./builder/types.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { type DocImpl, isDoc } from "./doc.ts";
import {
  type Cell,
  type CellLink,
  createCell,
  type LegacyAlias,
  type SigilWriteRedirectLink,
} from "./cell.ts";
import { type ReactivityLog } from "./scheduler.ts";
import { arrayEqual } from "./type-utils.ts";
import {
  isWriteRedirectLink,
  parseLink,
  parseToLegacyCellLink,
} from "./link-utils.ts";

/**
 * Track visited cell links and memoize results during path resolution
 * and link following to prevent redundant work.
 */
interface Visits {
  /** Tracks visited cell links to detect cycles */
  seen: CellLink[];
  /** Cache for resolvePath results */
  resolvePathCache: Map<string, CellLink>;
  /** Cache for followLinks results */
  followLinksCache: Map<string, CellLink>;
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

export function resolveLinkToValue<T>(
  doc: DocImpl<T>,
  path: PropertyKey[],
  log?: ReactivityLog,
  schema?: JSONSchema,
  rootSchema?: JSONSchema,
): CellLink {
  const visits = createVisits();
  const ref = resolvePath(doc, path, log, schema, rootSchema, visits);
  return followLinks(ref, log, visits);
}

export function resolveLinkToAlias<T>(
  doc: DocImpl<T>,
  path: PropertyKey[],
  log?: ReactivityLog,
  schema?: JSONSchema,
  rootSchema?: JSONSchema,
): CellLink {
  const visits = createVisits();
  const ref = resolvePath(doc, path, log, schema, rootSchema, visits);
  return followLinks(ref, log, visits, true);
}

export function resolveLinks(ref: CellLink, log?: ReactivityLog): CellLink {
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
): CellLink { // Follow aliases, doc links, etc. in path, so that we end up on the right
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
  let startRef: CellLink = { cell: doc, path: [] };
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
  ref: CellLink,
  log: ReactivityLog | undefined,
  visits: Visits,
  onlyAliases = false,
): CellLink {
  // Check if we already followed these links
  const cacheKey = createPathCacheKey(ref.cell, ref.path, onlyAliases);
  const cached = visits.followLinksCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let nextRef: CellLink | undefined;
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

    nextRef = !onlyAliases || isWriteRedirectLink(target)
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
  alias: LegacyAlias | SigilWriteRedirectLink,
  docOrCell: DocImpl<T> | Cell<T>,
  log?: ReactivityLog,
): CellLink {
  if (isWriteRedirectLink(alias)) {
    const cell = isDoc(docOrCell) ? docOrCell.asCell() : docOrCell as Cell<T>;
    const link = parseLink(alias, cell)!;
    return followLinks(
      {
        cell: cell.getDoc().runtime.documentMap.getDocByEntityId(
          link.space!,
          link.id,
        ),
        path: link.path,
        space: link.space,
        schema: link.schema,
        rootSchema: link.rootSchema,
      } as CellLink,
      log,
      createVisits(),
      true,
    );
  } else {
    throw new Error(`Alias expected: ${JSON.stringify(alias)}`);
  }
}
