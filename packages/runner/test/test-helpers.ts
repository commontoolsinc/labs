import { assertEquals } from "@std/assert";
import { AssertionError } from "@std/assert";
import { isAlias } from "../src/builder/types.ts";
import { isCellLink } from "../src/cell.ts";

/**
 * Normalizes CellLinks by keeping only cell and path properties
 * Also normalizes path elements so numeric strings and numbers are equivalent
 */
export function normalizeCellLink(link: any): any {
  // Normalize path elements: convert numeric strings to numbers for comparison
  const normalizedPath = link.path.map((element: any) => {
    // If it's a string that represents a valid array index, convert to number
    if (typeof element === 'string' && /^\d+$/.test(element)) {
      return parseInt(element, 10);
    }
    return element;
  });
  
  return { cell: link.cell, path: normalizedPath };
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
          error.message = `CellLinks are not equal (after normalization).\n${error.message}`;
          throw error;
        }
        throw error;
      }
    }
  };
}