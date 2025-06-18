import { assertEquals } from "@std/assert";
import { AssertionError } from "@std/assert";
import { isAlias } from "../src/builder/types.ts";
import { isCellLink } from "../src/cell.ts";

/**
 * Normalizes CellLinks by keeping only cell and path properties
 */
function normalizeCellLink(link: any): any {
  return { cell: link.cell, path: link.path };
}

/**
 * Deep normalizes an object, handling CellLinks and aliases
 * Strips out extra properties like space, schema, rootSchema from CellLinks
 */
function deepNormalizeCellLinks(obj: any): any {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }
  
  // Handle bare CellLinks
  if (isCellLink(obj)) {
    return normalizeCellLink(obj);
  }
  
  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(deepNormalizeCellLinks);
  }
  
  // Handle objects
  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isAlias(value)) {
      // Normalize CellLinks within aliases
      result[key] = {
        $alias: normalizeCellLink(value.$alias)
      };
    } else {
      result[key] = deepNormalizeCellLinks(value);
    }
  }
  return result;
}

/**
 * Custom expect-style matcher for CellLink equality
 * Usage: expectCellLinksEqual(actual).toEqual(expected)
 * Works with bare CellLinks, CellLinks in aliases, and nested structures
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
          throw new AssertionError(
            `CellLinks are not equal (after normalization).\n${error.message}`
          );
        }
        throw error;
      }
    }
  };
}