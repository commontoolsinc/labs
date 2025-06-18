import { assertEquals } from "@std/assert";
import { AssertionError } from "@std/assert";
import { isAlias } from "../src/builder/types.ts";

/**
 * Normalizes an object by stripping extra metadata from CellLinks within aliases
 * Strips out extra properties like space, schema, rootSchema from CellLinks
 */
function normalizeCellLinksInAliases(obj: any): any {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }
  
  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isAlias(value)) {
      result[key] = {
        $alias: { 
          cell: value.$alias.cell, 
          path: value.$alias.path 
        }
      };
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Custom expect-style matcher for CellLink equality
 * Usage: expectCellLinksEqual(actual).toEqual(expected)
 */
export function expectCellLinksEqual(actual: unknown) {
  return {
    toEqual(expected: unknown, msg?: string) {
      const normalizedActual = normalizeCellLinksInAliases(actual);
      const normalizedExpected = normalizeCellLinksInAliases(expected);
      
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