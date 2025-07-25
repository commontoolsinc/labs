import { isRecord } from "@commontools/utils/types";
import { getLogger } from "@commontools/utils/logger";
import type { JSONSchema } from "./builder/types.ts";
import { LINK_V1_TAG } from "./sigil-types.ts";
import {
  type CellLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import type {
  IExtendedStorageTransaction,
  MemoryAddressPathComponent,
} from "./storage/interface.ts";
import { ContextualFlowControl } from "./cfc.ts";

const logger = getLogger("link-resolution");

export type LastNode = "value" | "writeRedirect" | "top";

/**
 * A resolved link is a link that has been resolved to a document that no longer
 * has any links between the top and the value at `link.path`.
 */
declare const resolvedFullLinkBrand: unique symbol;
export type ResolvedFullLink = NormalizedFullLink & {
  // type-script only marker, doesn't appear in actual data
  [resolvedFullLinkBrand]: true;
};

const MAX_PATH_RESOLUTION_LENGTH = 1000;

/**
 * Resolves a document path with support for links inside documents.
 *
 * It returns a `ResolvedFullLink` that points to a document that no longer has
 * any links between the top and the value at `link.path`. When a cycle is
 * detected, a warning is logged and a static link to `undefined` returned.
 *
 * `lastNode` controls whether to follow links on the last path segment. By
 * default all links are followed, but if `lastNode` is `LastNode.WriteRedirect`
 * only write redirects are followed and if `lastNode` is `LastNode.Top` no
 * links are followed at all.
 *
 * Links can point to another (document, path) pair, and may appear either at
 * leaf nodes or in the middle of a document. This resolver transparently
 * follows such links and detects cycles.
 *
 * A cycle is detected if the exact (document, path) pair is visited more than
 * once. This detects cycles like:
 * - A/foo → A/foo
 * - A → B → C → A
 *
 * But there are cycles that can lead to growing paths, e.g.
 * - A → A/foo
 * - A → B, B → A/foo
 *
 * These are difficult to detect, since there are many legitimate cases for the
 * same link to be followed several times, so instead we just have an upper
 * bound of 1000 iterations, and log a warning.
 *
 * @param tx - The storage transaction to read from.
 * @param link - The link to read.
 * @param lastNode - The last node in the path.
 * @returns The resolved link.
 */
export function resolveLink(
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  lastNode: LastNode = "value",
): ResolvedFullLink {
  const seen = new Set<string>();

  const remainingPath = [...link.path];
  const traversedPath: MemoryAddressPathComponent[] = [];
  let last: NormalizedFullLink = link;

  let iteration = 0;

  while (true) {
    if (iteration++ > MAX_PATH_RESOLUTION_LENGTH) {
      logger.warn(`Link resolution iteration limit reached`);
      return emptyResolvedFullLink; // = return link to empty document
    }

    if (lastNode === "top" && remainingPath.length === 0) {
      break; // = return before following links on last path segment
    }

    // Detect cycles. Only have to do this at top of path, since link folloowing
    // will always go through this at least once.
    if (traversedPath.length === 0) {
      const key = JSON.stringify([last.space, last.id, remainingPath]);
      if (seen.has(key)) {
        logger.warn(`Link cycle detected ${key}`);
        return emptyResolvedFullLink; // = return link to empty document
      }
      seen.add(key);
    }

    const onlyRedirects = remainingPath.length === 0 &&
      lastNode === "writeRedirect"; // For "value", follow all
    const nextLink = readMaybeLink(
      tx,
      { ...last, path: traversedPath },
      onlyRedirects,
    );
    if (nextLink !== undefined) {
      // Schemas on link overwrite the current schema. We have to adjust it for
      // the deeper remaining path we're accessing. If after that, the schema is
      // empty (or more specifically "any"), we keep the current schema.
      // TODO(ubik2,seefeld): This should really be a schema intersection.
      let linkSchema = nextLink.schema;
      if (linkSchema !== undefined && remainingPath.length > 0) {
        const cfc = new ContextualFlowControl();
        linkSchema = cfc.getSchemaAtPath(
          linkSchema,
          remainingPath,
          nextLink.rootSchema,
        );
      }
      if (linkSchema !== undefined) {
        last = { ...nextLink, schema: linkSchema };
      } else if (last.schema !== undefined) {
        last = {
          ...nextLink,
          schema: last.schema,
          rootSchema: last.rootSchema,
        };
      } else {
        last = nextLink;
      }

      // We have to start walking the the destination from the top, as it might
      // contain links in the middle, so we prepend it's path to the remaining
      // path and reset the current path to empty.
      remainingPath.unshift(...nextLink.path);
      traversedPath.length = 0;
      // Note: we already updated 'last' above with the proper schema handling
      continue; // = continue following links at same remainingPath
    }

    if (remainingPath.length === 0) {
      break; // = both the "value" and "writeRedirect" cases
    }

    traversedPath.push(remainingPath.shift()!);
  }

  const result = { ...last, path: traversedPath } satisfies NormalizedFullLink;

  // The casting is a workaround for the branding, we don't actually want to add
  // the symbol to the result.
  return result as unknown as ResolvedFullLink;
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
  tx: IExtendedStorageTransaction,
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

const emptyResolvedFullLink: ResolvedFullLink = {
  space: "did:null:null",
  id: "data:application/json,",
  path: [],
  type: "application/json",
} satisfies NormalizedFullLink as unknown as ResolvedFullLink;
