/**
 * Link discovery utilities for finding cell links in values.
 *
 * This module is browser-safe and works with values from CellHandle.get(),
 * which contain CellHandle instances where there are cell references.
 */

import {
  type CellHandle,
  isCellHandle,
  NAME,
} from "@commontools/runtime-client";
import type { NormalizedFullLink } from "@commontools/runtime-client";
import type { DID } from "@commontools/identity";

/**
 * A discovered link found during traversal of a cell's value.
 */
export type DiscoveredLink = {
  link: NormalizedFullLink;
  path: string[]; // where the link was found in the source
  /** The CellHandle for this link (used for checking if it's a navigable piece) */
  cellHandle: CellHandle<unknown>;
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
  visitor: (
    link: NormalizedFullLink,
    path: string[],
    cellHandle: CellHandle<unknown>,
  ) => void,
  seen: Set<unknown> = new Set(),
  path: string[] = [],
): void {
  // Check if this value is a CellHandle (a cell reference)
  if (isCellHandle(value)) {
    const link = cellHandleToLink(value);
    console.log(
      `[traverseCellLinks] Found CellHandle at path "${
        path.join(".")
      }" -> ref.id: ${link.id.slice(0, 40)}..., ref.path: [${
        link.path.join(",")
      }]`,
    );
    if (!link.id.startsWith("data:")) {
      // Found a cell reference - invoke visitor and stop traversing
      visitor(link, path, value);
    }
    return;
  }

  // Skip primitives
  if (!isRecord(value) && !Array.isArray(value)) {
    return;
  }

  // Debug: Log when traversing arrays to see what types we find
  if (Array.isArray(value) && value.length > 0 && path.length <= 2) {
    console.log(
      `[traverseCellLinks] Array at path "${
        path.join(".")
      }" has ${value.length} items:`,
    );
    value.slice(0, 3).forEach((item, i) => {
      console.log(
        `  [${i}] isCellHandle: ${
          isCellHandle(item)
        }, type: ${typeof item}, constructor: ${item?.constructor?.name}, keys: ${
          item && typeof item === "object"
            ? Object.keys(item).slice(0, 5).join(",")
            : "N/A"
        }`,
      );
    });
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

  traverseCellLinks(value, (link, path, cellHandle) => {
    const key = linkKey(link);

    // Only keep the first occurrence of each unique link
    if (!seen.has(key)) {
      const discoveredLink: DiscoveredLink = { link, path, cellHandle };
      seen.set(key, discoveredLink);
      discovered.push(discoveredLink);
    }
  });

  return discovered;
}

/**
 * Result of resolving and checking a cell link.
 */
export type ResolvedLink = {
  /** Whether the resolved cell is navigable (has $NAME) */
  isNavigable: boolean;
  /** The resolved CellHandle pointing to the actual cell (not a path reference) */
  resolvedCell: CellHandle<unknown>;
  /** The NormalizedFullLink for the resolved cell */
  resolvedLink: NormalizedFullLink;
};

/**
 * Resolve a CellHandle and check if it points to a navigable piece.
 *
 * This function:
 * - Resolves path-based references to get the actual cell
 * - Checks if the resolved cell has $NAME (making it navigable)
 * - Returns the resolved cell info for use in the UI
 *
 * @param cellHandle - The cell handle to resolve and check
 * @returns Promise with resolved cell info and navigability status
 */
export async function resolveAndCheckNavigable(
  cellHandle: CellHandle<unknown>,
): Promise<ResolvedLink> {
  const ref = cellHandle.ref();
  console.log(
    `[resolveAndCheckNavigable] Checking ${ref.id.slice(0, 30)}... path: [${
      ref.path.join(",")
    }]`,
  );

  // Resolve to get the actual cell (follows links if this is a path reference)
  let resolvedCell = cellHandle;
  try {
    resolvedCell = await cellHandle.resolveAsCell();
    const resolvedRef = resolvedCell.ref();
    console.log(
      `[resolveAndCheckNavigable]   Resolved to: ${
        resolvedRef.id.slice(0, 30)
      }... path: [${resolvedRef.path.join(",")}]`,
    );
  } catch (e) {
    console.log(`[resolveAndCheckNavigable]   Failed to resolve: ${e}`);
    // Keep original cell
  }

  const resolvedLink = cellHandleToLink(resolvedCell);

  // Use a broad schema to get all properties
  const fullCell = resolvedCell.asSchema<Record<string, unknown>>(true as any);
  await fullCell.sync();
  const value = fullCell.get();

  console.log(
    `[resolveAndCheckNavigable]   value type: ${typeof value}, keys: ${
      value && typeof value === "object"
        ? Object.keys(value).slice(0, 10).join(",")
        : "N/A"
    }`,
  );

  if (!value || typeof value !== "object") {
    console.log(`[resolveAndCheckNavigable]   FAIL: not an object`);
    return { isNavigable: false, resolvedCell, resolvedLink };
  }

  // Check for $NAME - if it has a name, it's a navigable piece
  const hasName = NAME in value;
  console.log(`[resolveAndCheckNavigable]   has $NAME: ${hasName}`);
  return { isNavigable: hasName, resolvedCell, resolvedLink };
}

/**
 * @deprecated Use resolveAndCheckNavigable instead
 */
export async function isNavigablePiece(
  cellHandle: CellHandle<unknown>,
): Promise<boolean> {
  const result = await resolveAndCheckNavigable(cellHandle);
  return result.isNavigable;
}
