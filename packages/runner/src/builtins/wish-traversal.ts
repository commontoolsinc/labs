/**
 * Traversal utilities for wish() scoped searches.
 *
 * This module provides pure functions for traversing cell hierarchies
 * to find cells matching a given tag (based on schema).
 */

import type { Cell } from "../cell.ts";
import type { JSONSchema } from "../builder/types.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { URI } from "../sigil-types.ts";
import { isCellLink, parseLink } from "../link-utils.ts";

/**
 * A match found during traversal.
 */
export type TraversalMatch = {
  cell: Cell<unknown>;
  path: readonly string[];
  schema?: JSONSchema;
};

/**
 * Options for traversal operations.
 */
export type TraversalOptions = {
  /** Tag to search for (without # prefix) */
  tag: string;
  /** Maximum depth to traverse (0 = only root, 10 = default) */
  maxDepth: number;
  /** Maximum results to collect (0 = unlimited) */
  limit: number;
  /** Runtime instance for cell operations */
  runtime: Runtime;
  /** Transaction context */
  tx: IExtendedStorageTransaction;
};

/**
 * Check if a schema contains the specified tag.
 *
 * Tags are identified by:
 * - Hashtags in title/description (e.g., "#person")
 * - The schema $ref name (e.g., "person" in "#/$defs/Person")
 *
 * @param schema - The JSON schema to check
 * @param tag - The tag to search for (without # prefix)
 * @returns true if the schema contains the tag
 */
export function schemaMatchesTag(
  schema: JSONSchema | undefined,
  tag: string,
): boolean {
  if (schema === undefined || schema === null || typeof schema === "boolean") {
    return false;
  }

  const normalizedTag = tag.toLowerCase();

  // Check title for hashtag or exact match
  if (typeof schema.title === "string") {
    const title = schema.title.toLowerCase();
    if (title === normalizedTag || title.includes(`#${normalizedTag}`)) {
      return true;
    }
  }

  // Check description for hashtag
  if (typeof schema.description === "string") {
    const desc = schema.description.toLowerCase();
    if (desc.includes(`#${normalizedTag}`)) {
      return true;
    }
  }

  // Check $ref for type name (e.g., "#/$defs/Person")
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref.toLowerCase();
    // Extract the definition name from $ref like "#/$defs/Person"
    const match = ref.match(/#\/\$defs\/([^/]+)$/i);
    if (match && match[1].toLowerCase() === normalizedTag) {
      return true;
    }
  }

  return false;
}

/**
 * Get the schema for a cell, if available.
 * Uses asSchemaFromLinks to properly resolve the schema through links.
 */
function getCellSchema(cell: Cell<unknown>): JSONSchema | undefined {
  try {
    // First try to get schema directly from the cell
    const directSchema = cell.schema;
    if (directSchema !== undefined) {
      return directSchema;
    }

    // Fall back to resolving through links (like favorites search does)
    const { schema } = cell.asSchemaFromLinks().getAsNormalizedFullLink();
    return schema;
  } catch {
    return undefined;
  }
}

/**
 * Get child keys for a cell value.
 * Returns the keys that can be used with cell.key() to access children.
 */
function getChildKeys(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((_, i) => i.toString());
  }

  if (typeof value === "object") {
    // Filter out internal properties that start with special characters
    return Object.keys(value).filter(
      (k) => !k.startsWith("/") && k !== "cell" && k !== "$",
    );
  }

  return [];
}

/**
 * Generator that yields matches during traversal of a cell hierarchy.
 *
 * Key behaviors:
 * - For arrays: yields each element cell (not the array itself)
 * - Uses cycle detection via cell.sourceURI
 * - Respects maxDepth limit
 * - Follows links to traverse into linked cells
 *
 * @param cell - The cell to start traversal from
 * @param options - Traversal options
 * @param currentPath - Current path in the traversal (for tracking)
 * @param depth - Current depth (starts at 0)
 * @param seen - Set of visited sourceURIs for cycle detection
 */
export function* traverseForTag(
  cell: Cell<unknown>,
  options: TraversalOptions,
  currentPath: string[] = [],
  depth: number = 0,
  seen: Set<URI> = new Set(),
): Generator<TraversalMatch> {
  // Cycle detection: check if we've visited this cell+path combination before
  // We use sourceURI + path because child cells from .key() share the same sourceURI
  try {
    const sourceURI = cell.sourceURI;
    // Create unique key combining sourceURI and path
    const cellId = `${sourceURI}:${currentPath.join("/")}`;
    if (seen.has(cellId as URI)) {
      return;
    }
    seen.add(cellId as URI);
  } catch {
    // Cell may not have a valid sourceURI yet
  }

  // Get the cell's value and schema
  const value = cell.get();
  const schema = getCellSchema(cell);

  // Check if this cell matches the tag
  if (schemaMatchesTag(schema, options.tag)) {
    yield { cell, path: currentPath, schema };
  }

  // Stop recursion if we've hit max depth
  if (depth >= options.maxDepth) {
    return;
  }

  // Handle arrays specially: traverse each element
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const elementCell = cell.key(i) as Cell<unknown>;
      yield* traverseForTag(
        elementCell,
        options,
        [...currentPath, i.toString()],
        depth + 1,
        seen,
      );
    }
    return;
  }

  // Handle objects: traverse each property
  if (value !== null && typeof value === "object") {
    const keys = getChildKeys(value);
    for (const key of keys) {
      const childValue = (value as Record<string, unknown>)[key];

      // If the child value is a link, resolve it and traverse
      if (isCellLink(childValue)) {
        try {
          const link = parseLink(childValue, cell);
          if (link && link.id && link.space) {
            const linkedCell = options.runtime.getCellFromLink(
              link,
              undefined, // schema
              options.tx,
            );
            if (linkedCell) {
              yield* traverseForTag(
                linkedCell,
                options,
                [...currentPath, key],
                depth + 1,
                seen,
              );
            }
          }
        } catch {
          // Link resolution failed, skip
        }
      } else {
        // Not a link, just traverse into the child cell
        const childCell = cell.key(key) as Cell<unknown>;
        yield* traverseForTag(
          childCell,
          options,
          [...currentPath, key],
          depth + 1,
          seen,
        );
      }
    }
  }
}

/**
 * Collect matches from a generator, respecting the limit.
 *
 * @param generator - Generator yielding TraversalMatch items
 * @param limit - Maximum items to collect (0 = unlimited)
 * @returns Array of collected matches
 */
export function collectMatches(
  generator: Generator<TraversalMatch>,
  limit: number,
): TraversalMatch[] {
  const results: TraversalMatch[] = [];

  for (const match of generator) {
    results.push(match);
    // If limit is non-zero and we've hit it, stop
    if (limit > 0 && results.length >= limit) {
      break;
    }
  }

  return results;
}

/**
 * Find all cells matching a tag within the given cells.
 *
 * This is the main entry point for scoped traversal.
 *
 * @param cells - Cells to search within
 * @param options - Traversal options
 * @returns Array of matching cells
 */
export function findMatchingCells(
  cells: Cell<unknown>[],
  options: TraversalOptions,
): TraversalMatch[] {
  const allMatches: TraversalMatch[] = [];
  const seen = new Set<URI>();

  for (const cell of cells) {
    const generator = traverseForTag(cell, options, [], 0, seen);
    const matches = collectMatches(
      generator,
      options.limit > 0 ? options.limit - allMatches.length : 0,
    );
    allMatches.push(...matches);

    // Early termination if we've hit the limit
    if (options.limit > 0 && allMatches.length >= options.limit) {
      break;
    }
  }

  return allMatches;
}
