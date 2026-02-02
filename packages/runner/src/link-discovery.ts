import { isRecord } from "@commontools/utils/types";
import type { Cell, MemorySpace } from "./cell.ts";
import { isCell } from "./cell.ts";
import type { JSONSchema } from "./builder/types.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import { ContextualFlowControl } from "./cfc.ts";
import type { NormalizedFullLink } from "./link-types.ts";

/**
 * A discovered link found during traversal of a cell's value.
 */
export type DiscoveredLink = {
  link: NormalizedFullLink;
  path: string[]; // where the link was found in the source
};

/**
 * Recursively traverse a value and invoke a visitor callback for each cell link found.
 *
 * This is a generic traversal utility that:
 * - Detects cells using isCell() and isCellResultForDereferencing()
 * - Handles cycles using a Set of already-seen values
 * - Uses ContextualFlowControl for schema-aware path navigation
 * - Stops at link boundaries (doesn't traverse INTO linked cells)
 * - Skips data: URI links (they're not useful as external links)
 *
 * @param value - The value to traverse
 * @param visitor - Callback invoked for each cell found (not data: URIs)
 * @param options - Optional configuration
 * @param options.schema - The schema for the current value
 * @param options.rootSchema - The root schema for reference resolution
 * @param options.contextSpace - The current execution space
 * @param seen - Set of already-visited values for cycle detection (internal)
 * @param path - Current path in the traversal (internal)
 */
export function traverseCellLinks(
  value: unknown,
  visitor: (cell: Cell<any>, path: string[]) => void,
  options?: {
    schema?: JSONSchema;
    rootSchema?: JSONSchema;
    contextSpace?: MemorySpace;
  },
  seen: Set<unknown> = new Set(),
  path: string[] = [],
): void {
  const schema = options?.schema;
  const rootSchema = options?.rootSchema ?? schema;
  const contextSpace = options?.contextSpace;

  if (!isRecord(value)) return;

  // If we encounter an `any` schema, turn value into a cell link
  if (
    seen.size > 0 && schema !== undefined &&
    ContextualFlowControl.isTrueSchema(schema) &&
    isCellResultForDereferencing(value)
  ) {
    // Next step will turn this into a link
    value = getCellOrThrow(value);
  }

  // Turn cells into a link, unless they are data: URIs
  if (isCell(value)) {
    const link = value.resolveAsCell().getAsNormalizedFullLink();
    if (link.id.startsWith("data:")) {
      // For data: URIs, traverse into them instead of treating as link
      return traverseCellLinks(
        value.get(),
        visitor,
        { schema, rootSchema, contextSpace },
        seen,
        path,
      );
    } else {
      // Found a cell link - invoke visitor and stop traversing
      visitor(value, path);
      return;
    }
  }

  // If we've already seen this and it can be mapped to a cell, handle it
  if (seen.has(value)) {
    if (isCellResultForDereferencing(value)) {
      return traverseCellLinks(
        getCellOrThrow(value),
        visitor,
        { schema, rootSchema, contextSpace },
        seen,
        path,
      );
    } else {
      // Cycle detected - stop traversing
      return;
    }
  }
  seen.add(value);

  const cfc = new ContextualFlowControl();

  if (Array.isArray(value)) {
    value.forEach((v, index) => {
      const itemSchema = schema !== undefined
        ? cfc.schemaAtPath(schema, [index.toString()], rootSchema)
        : undefined;

      traverseCellLinks(
        v,
        visitor,
        { schema: itemSchema, rootSchema, contextSpace },
        seen,
        [...path, index.toString()],
      );

      // Also check if array entry itself is a cell result proxy
      if (isCellResultForDereferencing(v)) {
        const cell = getCellOrThrow(v);
        const link = cell.resolveAsCell().getAsNormalizedFullLink();
        if (!link.id.startsWith("data:")) {
          visitor(cell, [...path, index.toString()]);
        }
      }
    });
  } else {
    Object.entries(value as Record<string, unknown>)
      // Skip $-prefixed properties ($UI, $TYPE, etc.) - these are internal/VDOM
      .filter(([key]) => !key.startsWith("$"))
      .forEach(([key, childValue]) => {
        const propertySchema = schema !== undefined
          ? cfc.schemaAtPath(schema, [key], rootSchema)
          : undefined;

        traverseCellLinks(
          childValue,
          visitor,
          { schema: propertySchema, rootSchema, contextSpace },
          seen,
          [...path, key],
        );
      });
  }
}

/**
 * Discover all cell links referenced from a given cell's value.
 *
 * This function:
 * - Reads the cell's current value
 * - Traverses the value recursively to find all cell references
 * - Deduplicates links by (space, id) identity
 * - Returns links with the path where they were found
 *
 * @param cell - The cell to discover links from
 * @param contextSpace - The current execution space (for cross-space link detection)
 * @returns Array of discovered links with their paths
 */
export function discoverLinksFrom(
  cell: Cell<any>,
  contextSpace?: MemorySpace,
): DiscoveredLink[] {
  const value = cell.get();
  const schema = cell.schema;
  const discovered: DiscoveredLink[] = [];

  // Use a Map to deduplicate by (space, id) combination
  const linkKey = (link: NormalizedFullLink) => `${link.space}:${link.id}`;
  const seen = new Map<string, DiscoveredLink>();

  traverseCellLinks(
    value,
    (linkedCell, path) => {
      const link = linkedCell.resolveAsCell().getAsNormalizedFullLink();
      const key = linkKey(link);

      // Only keep the first occurrence of each unique link
      if (!seen.has(key)) {
        const discoveredLink: DiscoveredLink = { link, path };
        seen.set(key, discoveredLink);
        discovered.push(discoveredLink);
      }
    },
    { schema, rootSchema: schema, contextSpace },
  );

  return discovered;
}
