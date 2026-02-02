/**
 * Link discovery utilities for finding cell links in values.
 *
 * This module is browser-safe and works with values from CellHandle.get(),
 * which contain CellHandle instances where there are cell references.
 */

import { type CellHandle, isCellHandle } from "@commontools/runtime-client";
import type { NormalizedFullLink } from "@commontools/runtime-client";
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
 * Convert a CellHandle to a NormalizedFullLink.
 */
function cellHandleToLink(cell: CellHandle<unknown>): NormalizedFullLink {
  const ref = cell.ref();
  return {
    id: ref.id,
    space: ref.space,
    type: ref.type ?? "application/json",
    path: ref.path,
    ...(ref.schema !== undefined && { schema: ref.schema }),
    ...(ref.rootSchema !== undefined && { rootSchema: ref.rootSchema }),
  };
}

/**
 * Recursively traverse a value and invoke a visitor callback for each CellHandle found.
 *
 * This traversal utility:
 * - Detects CellHandle instances using isCellHandle()
 * - Handles cycles using a Set of already-seen values
 * - Stops at link boundaries (doesn't traverse INTO linked cells)
 * - Skips data: URI links (they're not useful as external links)
 */
export function traverseCellLinks(
  value: unknown,
  visitor: (link: NormalizedFullLink, path: string[]) => void,
  seen: Set<unknown> = new Set(),
  path: string[] = [],
): void {
  // Check if this value is a CellHandle (a cell reference)
  if (isCellHandle(value)) {
    const link = cellHandleToLink(value);
    if (!link.id.startsWith("data:")) {
      // Found a cell reference - invoke visitor and stop traversing
      visitor(link, path);
    }
    return;
  }

  // Skip primitives
  if (!isRecord(value) && !Array.isArray(value)) {
    return;
  }

  // Cycle detection
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((v, index) => {
      traverseCellLinks(v, visitor, seen, [...path, index.toString()]);
    });
  } else if (isRecord(value)) {
    Object.entries(value)
      // Skip $-prefixed properties ($UI, $TYPE, etc.) - these are internal/VDOM
      .filter(([key]) => !key.startsWith("$"))
      .forEach(([key, childValue]) => {
        traverseCellLinks(childValue, visitor, seen, [...path, key]);
      });
  }
}

/**
 * Discover all cell links in a value.
 *
 * This function:
 * - Traverses the value recursively to find all CellHandle references
 * - Deduplicates links by (space, id) identity
 * - Returns links with the path where they were found
 *
 * @param value - The value to discover links from (from CellHandle.get())
 * @returns Array of discovered links with their paths
 */
export function discoverLinksFromValue(value: unknown): DiscoveredLink[] {
  const discovered: DiscoveredLink[] = [];

  // Use a Map to deduplicate by (space, id) combination
  const linkKey = (link: NormalizedFullLink) => `${link.space}:${link.id}`;
  const seen = new Map<string, DiscoveredLink>();

  traverseCellLinks(value, (link, path) => {
    const key = linkKey(link);

    // Only keep the first occurrence of each unique link
    if (!seen.has(key)) {
      const discoveredLink: DiscoveredLink = { link, path };
      seen.set(key, discoveredLink);
      discovered.push(discoveredLink);
    }
  });

  return discovered;
}
