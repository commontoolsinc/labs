import { assertEquals } from "@std/assert";
import { AssertionError } from "@std/assert";
import { isLegacyAlias, isLegacyCellLink } from "../src/link-utils.ts";
import type { EntityId } from "../src/doc-map.ts";

/**
 * Normalizes LegacyCellLinks by keeping only cell and path properties
 * Also normalizes path elements so numeric strings and numbers are equivalent
 */
export function normalizeCellLink(link: any): any {
  // Normalize path elements: convert numeric strings to numbers for comparison
  const normalizedPath = link.path.map((element: any) => {
    // If it's a string that represents a valid array index, convert to number
    if (typeof element === "string" && /^\d+$/.test(element)) {
      return parseInt(element, 10);
    }
    return element;
  });

  return { cell: link.cell, path: normalizedPath };
}

/**
 * Deep normalizes an object, handling LegacyCellLinks and aliases
 * Strips out extra properties like space, schema, rootSchema from LegacyCellLinks
 */
function deepNormalizeCellLinks(obj: any): any {
  if (!obj || typeof obj !== "object") {
    return obj;
  }

  // Handle bare LegacyCellLinks
  if (isLegacyCellLink(obj)) {
    return normalizeCellLink(obj);
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(deepNormalizeCellLinks);
  }

  // Handle objects
  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isLegacyAlias(value)) {
      // Normalize CellLinks within aliases
      result[key] = {
        $alias: normalizeCellLink(value.$alias),
      };
    } else {
      result[key] = deepNormalizeCellLinks(value);
    }
  }
  return result;
}

/**
 * Custom expect-style matcher for LegacyCellLink equality
 * Usage: expectCellLinksEqual(actual).toEqual(expected)
 * Works with bare LegacyCellLinks, LegacyCellLinks in aliases, and nested structures
 */
export function expectCellLinksEqual(actual: unknown) {
  return {
    toEqual(expected: unknown, msg?: string) {
      const normalizedActual = deepNormalizeCellLinks(actual);
      const normalizedExpected = deepNormalizeCellLinks(expected);

      try {
        assertEquals(normalizedActual, normalizedExpected, msg);
      } catch (error) {
        if (error instanceof AssertionError) {
          error.message = `LegacyCellLinks are not equal (after normalization).
${error.message}`;
          throw error;
        }
        throw error;
      }
    },
  };
}

/**
 * Helper to convert objects with toJSON methods to plain objects
 * Useful for test expectations that need to compare serialized forms
 */
export function toPlainObject<T>(obj: T): any {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Helper to convert EntityId to JSON representation
 * Handles EntityId objects that may or may not have toJSON method
 */
export function entityIdToJSON(entityId: EntityId): { "/": string } {
  if (entityId.toJSON) {
    return entityId.toJSON();
  }
  // Fallback: construct the object manually
  return { "/": entityId["/"].toString() };
}
