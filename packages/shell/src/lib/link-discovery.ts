/**
 * Link discovery utilities for finding cell links in values.
 *
 * This module is browser-safe and works with serialized values from CellHandle.get().
 */

import { isSigilLink, LINK_V1_TAG } from "@commontools/runtime-client";
import type {
  NormalizedFullLink,
  SigilLink,
} from "@commontools/runtime-client";
import type { DID } from "@commontools/identity";

/**
 * A discovered link found during traversal of a cell's value.
 */
export type DiscoveredLink = {
  link: NormalizedFullLink;
  path: string[]; // where the link was found in the source
};

/**
 * Check if a value is a record (plain object).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract a NormalizedFullLink from a sigil link value.
 * Returns undefined if the link cannot be fully resolved (missing id or space).
 */
function sigilLinkToNormalizedLink(
  sigilLink: SigilLink,
  contextSpace?: DID,
): NormalizedFullLink | undefined {
  const linkData = sigilLink["/"][LINK_V1_TAG];
  const id = linkData.id;
  const space = linkData.space ?? contextSpace;

  // Need both id and space to create a full link
  if (!id || !space) return undefined;

  return {
    id,
    space,
    type: "application/json",
    path: linkData.path ?? [],
    ...(linkData.schema !== undefined && { schema: linkData.schema }),
    ...(linkData.rootSchema !== undefined &&
      { rootSchema: linkData.rootSchema }),
  };
}

/**
 * Recursively traverse a value and invoke a visitor callback for each sigil link found.
 *
 * This is a browser-safe traversal utility that:
 * - Detects links using isSigilLink()
 * - Handles cycles using a Set of already-seen values
 * - Stops at link boundaries (doesn't traverse INTO linked cells)
 * - Skips data: URI links (they're not useful as external links)
 */
export function traverseCellLinks(
  value: unknown,
  visitor: (link: NormalizedFullLink, path: string[]) => void,
  contextSpace?: DID,
  seen: Set<unknown> = new Set(),
  path: string[] = [],
): void {
  if (!isRecord(value)) return;

  // Check if this value is a sigil link
  if (isSigilLink(value)) {
    const normalizedLink = sigilLinkToNormalizedLink(
      value as SigilLink,
      contextSpace,
    );
    if (normalizedLink && !normalizedLink.id.startsWith("data:")) {
      // Found a link - invoke visitor and stop traversing (don't go into linked cells)
      visitor(normalizedLink, path);
    }
    return;
  }

  // Cycle detection
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((v, index) => {
      traverseCellLinks(
        v,
        visitor,
        contextSpace,
        seen,
        [...path, index.toString()],
      );
    });
  } else {
    Object.entries(value as Record<string, unknown>)
      // Skip $-prefixed properties ($UI, $TYPE, etc.) - these are internal/VDOM
      .filter(([key]) => !key.startsWith("$"))
      .forEach(([key, childValue]) => {
        traverseCellLinks(
          childValue,
          visitor,
          contextSpace,
          seen,
          [...path, key],
        );
      });
  }
}

/**
 * Encodes a path as a JSON Pointer string according to RFC 6901.
 */
function encodeJsonPointer(path: readonly string[]): string {
  return path
    .map((token) => token.replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/");
}

/**
 * Creates an LLM-friendly link string from a normalized link.
 * Format: /of:bafy.../path or /@did:.../of:bafy.../path for cross-space links.
 */
export function createLLMFriendlyLink(
  link: NormalizedFullLink,
  contextSpace?: DID,
): string {
  // If contextSpace provided and differs, include space in link
  if (contextSpace && link.space && link.space !== contextSpace) {
    return encodeJsonPointer(["", `@${link.space}`, link.id, ...link.path]);
  }
  return encodeJsonPointer(["", link.id, ...link.path]);
}

/**
 * Discover all sigil links in a value.
 *
 * This function:
 * - Traverses the value recursively to find all sigil link references
 * - Deduplicates links by (space, id) identity
 * - Returns links with the path where they were found
 *
 * @param value - The value to discover links from (e.g., from CellHandle.get())
 * @param contextSpace - The current execution space (for cross-space link detection)
 * @returns Array of discovered links with their paths
 */
export function discoverLinksFromValue(
  value: unknown,
  contextSpace?: DID,
): DiscoveredLink[] {
  const discovered: DiscoveredLink[] = [];

  // Use a Map to deduplicate by (space, id) combination
  const linkKey = (link: NormalizedFullLink) => `${link.space}:${link.id}`;
  const seen = new Map<string, DiscoveredLink>();

  traverseCellLinks(
    value,
    (link, path) => {
      const key = linkKey(link);

      // Only keep the first occurrence of each unique link
      if (!seen.has(key)) {
        const discoveredLink: DiscoveredLink = { link, path };
        seen.set(key, discoveredLink);
        discovered.push(discoveredLink);
      }
    },
    contextSpace,
  );

  return discovered;
}
