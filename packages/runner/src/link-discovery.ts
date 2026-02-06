/**
 * Link discovery utilities for finding cell links in values.
 *
 * /!\ This module is designed to be safe for browser use.
 * /!\ It only imports from shared.ts and other browser-safe modules.
 */

import { isRecord } from "@commontools/utils/types";
import { isSigilLink, type NormalizedFullLink } from "./shared.ts";
import { LINK_V1_TAG, type SigilLink } from "./sigil-types.ts";
import type { MemorySpace } from "./storage/interface.ts";

/**
 * A discovered link found during traversal of a cell's value.
 */
export type DiscoveredLink = {
  link: NormalizedFullLink;
  path: string[]; // where the link was found in the source
};

/**
 * Extract a NormalizedFullLink from a sigil link value.
 * Returns undefined if the link cannot be fully resolved (missing id or space).
 */
function sigilLinkToNormalizedLink(
  sigilLink: SigilLink,
  contextSpace?: MemorySpace,
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
 * - Detects links using isSigilLink() from shared.ts
 * - Handles cycles using a Set of already-seen values
 * - Stops at link boundaries (doesn't traverse INTO linked cells)
 * - Skips data: URI links (they're not useful as external links)
 *
 * @param value - The value to traverse
 * @param visitor - Callback invoked for each sigil link found (not data: URIs)
 * @param contextSpace - The current execution space (for resolving links without explicit space)
 * @param seen - Set of already-visited values for cycle detection (internal)
 * @param path - Current path in the traversal (internal)
 */
export function traverseCellLinks(
  value: unknown,
  visitor: (link: NormalizedFullLink, path: string[]) => void,
  contextSpace?: MemorySpace,
  seen: Set<unknown> = new Set(),
  path: string[] = [],
): void {
  if (!isRecord(value)) return;

  // Check if this value is a sigil link
  if (isSigilLink(value)) {
    const normalizedLink = sigilLinkToNormalizedLink(value, contextSpace);
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
  contextSpace?: MemorySpace,
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

// Keep old function name as alias for backwards compatibility
export const discoverLinksFrom = discoverLinksFromValue;
