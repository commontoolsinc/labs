import { isRecord } from "@commontools/utils/types";
import { type JSONSchema } from "./builder/types.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { type DocImpl, isDoc } from "./doc.ts";
import { type Cell, createCell } from "./cell.ts";
import {
  type LegacyAlias,
  type LegacyDocCellLink,
  LINK_V1_TAG,
  type SigilWriteRedirectLink,
  type URI,
} from "./sigil-types.ts";
import { arrayEqual } from "./path-utils.ts";
import {
  areNormalizedLinksSame,
  type CellLink,
  isWriteRedirectLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import type {
  IMemoryAddress,
  IStorageTransaction,
} from "./storage/interface.ts";
import type { IRuntime } from "./runtime.ts";
import type { MemorySpace } from "@commontools/memory/interface";

/**
 * Track visited cell links and memoize results during path resolution
 * and link following to prevent redundant work.
 */
interface Visits {
  /** Tracks visited cell links to detect cycles */
  seen: IMemoryAddress[];
  /** Cache for resolvePath results */
  resolvePathCache: Map<string, IMemoryAddress>;
  /** Cache for followLinks results */
  followLinksCache: Map<string, IMemoryAddress>;
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
  address: IMemoryAddress,
  aliases: boolean = false,
): string {
  return JSON.stringify([
    address.space,
    address.id,
    address.path,
    address.type,
    aliases,
  ]);
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
    path: actualPath.map((p) => p.toString()),
    type: "application/json",
  };
}

export function resolveLinkToValue<T>(
  tx: IStorageTransaction,
  address: IMemoryAddress,
): NormalizedFullLink {
  const visits = createVisits();
  const link = resolvePath(tx, address, visits);
  return followLinks(tx, link, visits);
}

export function resolveLinkToWriteRedirect<T>(
  tx: IStorageTransaction,
  address: IMemoryAddress,
): NormalizedFullLink {
  const visits = createVisits();
  const link = resolvePath(tx, address, visits);
  return followLinks(tx, link, visits, true);
}

export function resolveLinks(
  tx: IStorageTransaction,
  link: IMemoryAddress,
): NormalizedFullLink {
  const visits = createVisits();
  return followLinks(tx, link, visits);
}

function resolvePath<T>(
  tx: IStorageTransaction,
  link: NormalizedFullLink,
  visits: Visits = createVisits(),
): NormalizedFullLink {
  // Follow aliases, doc links, etc. in path, so that we end up on the right
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
  const fullPathKey = createPathCacheKey(link);
  const exactMatch = visits.resolvePathCache.get(fullPathKey);
  if (exactMatch) {
    return exactMatch;
  }

  // To resolve the path, we need to start at the empty path and traverse in
  let keys = [...link.path];
  link = { ...link, path: [] };

  // Try to find a cached result for a shorter path
  // Look for the longest matching prefix path in the cache
  for (let i = link.path.length - 1; i >= 0; i--) {
    const prefixKey = createPathCacheKey({
      ...link,
      path: link.path.slice(0, i),
    });
    const prefixMatch = visits.resolvePathCache.get(prefixKey);

    if (prefixMatch) {
      keys = [...link.path.slice(i)];
      link = { ...prefixMatch };
      break;
    }
  }

  const origSchema = { schema: link.schema, rootSchema: link.rootSchema };
  const cfc = new ContextualFlowControl();

  while (keys.length) {
    // First follow all the aliases and links, _before_ accessing the key.
    link = { ...followLinks(tx, link, visits) };

    // Now access the key.
    const key = keys.shift()!;

    link.path = [...link.path, key];
    if (
      link.schema === undefined && origSchema.schema !== undefined &&
      keys.length === 0
    ) {
      // Since path is childPath, restore schema
      link.schema = origSchema.schema;
      link.rootSchema = origSchema.rootSchema;
    } else {
      link.schema = cfc.getSchemaAtPath(
        link.schema,
        [key.toString()],
        link.rootSchema,
      );
    }
  }

  // Cache the final result
  visits.resolvePathCache.set(fullPathKey, link);
  return link;
}

/**
 * Read a value that might be a link.
 *
 * We're first checking for the deeper link paths, so that we're not reactive to
 * other changes in the doc. If it looks like it could be a link, read the whole
 * value, which might include siblings to the "/" and thus make the link
 * invalid. In these cases, we do need to be reactive to all changes there.
 *
 * @param tx - The storage transaction to read from.
 * @param link - The link to read.
 * @param onlyWriteRedirects - Whether to only read write redirects.
 * @returns The value that might be a link.
 */
export function readMaybeLink(
  tx: IStorageTransaction,
  link: NormalizedFullLink,
  onlyWriteRedirects = false,
): NormalizedFullLink | undefined {
  const readSubPath = (extraPath: string[]) =>
    tx.readValueOrThrow({ ...link, path: [...link.path, ...extraPath] });

  const maybeSigilLink = readSubPath(["/", LINK_V1_TAG]);
  if (
    // Sigil link:
    (isRecord(maybeSigilLink) &&
      (!onlyWriteRedirects || maybeSigilLink.overwrite === "redirect")) ||
    // Legacy cell link:
    (!onlyWriteRedirects && typeof readSubPath(["cell", "/"]) === "string" &&
      Array.isArray(readSubPath(["path"]))) ||
    // Legacy alias:
    Array.isArray(readSubPath(["$alias", "path"]))
  ) {
    return parseLink(readSubPath([]) as CellLink, link);
  } else {
    return undefined;
  }
}

// Follows links and returns the last one, which is pointing to a value. It'll
// log all taken links, so not the returned one, and thus nothing if the ref
// already pointed to a value.
export function followLinks(
  tx: IStorageTransaction,
  link: NormalizedFullLink,
  visits: Visits,
  onlyWriteRedirects = false,
): NormalizedFullLink {
  // Check if we already followed these links
  const cacheKey = createPathCacheKey(link, onlyWriteRedirects);
  const cached = visits.followLinksCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let nextLink: NormalizedFullLink | undefined;
  let result: NormalizedFullLink = link;

  do {
    const resolvedLink = resolvePath(tx, result, visits);

    // Add schema back if we didn't get a new one
    if (!resolvedLink.schema && result.schema) {
      result = {
        ...resolvedLink,
        schema: result.schema,
        rootSchema: result.rootSchema,
      };
    } else {
      result = resolvedLink;
    }

    nextLink = readMaybeLink(tx, result, onlyWriteRedirects);

    if (nextLink !== undefined) {
      // Add schema back if we didn't get a new one
      if (!nextLink.schema && result.schema) {
        nextLink = {
          ...nextLink,
          schema: result.schema,
          rootSchema: result.rootSchema,
        };
      }

      result = nextLink;

      // Detect cycles (at this point these are all references that point to something)
      if (visits.seen.some((r) => areNormalizedLinksSame(r, result))) {
        throw new Error(
          `Reference cycle detected ${result.id}/[${result.path.join(", ")}] ${
            visits.seen.map((r) => `${r.id}/[${r.path.join(", ")}]`).join(", ")
          }`,
        );
      }
      visits.seen.push(result);
    }
  } while (nextLink);

  // Cache the result
  visits.followLinksCache.set(cacheKey, result);
  return result;
}

// Follows aliases and returns cell reference describing the last alias.
// Only logs interim aliases, not the first one, and not the non-alias value.
export function followWriteRedirects<T = any>(
  tx: IStorageTransaction,
  writeRedirect: LegacyAlias | SigilWriteRedirectLink,
  base: Cell<T>,
): NormalizedFullLink {
  if (isWriteRedirectLink(writeRedirect)) {
    const link = parseLink(writeRedirect, base);
    return followLinks(tx, link, createVisits(), true);
  } else {
    throw new Error(
      `Write redirect expected: ${JSON.stringify(writeRedirect)}`,
    );
  }
}
