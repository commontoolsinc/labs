import { CharmManager } from "../manager.ts";
import { Cell } from "@commontools/runner";

export type CellPath = readonly (string | number)[];

/**
 * Path parsing utilities moved from CLI
 */

/**
 * Standardized path segment parsing - converts string segments to string/number values.
 * Handles numeric conversion consistently across all path parsing functions.
 * 
 * @param segments - Array of string segments to convert
 * @returns Array of string/number elements where numeric strings become numbers
 */
function parsePathSegments(segments: string[]): (string | number)[] {
  return segments.map((segment) => {
    if (!segment) return segment; // Preserve empty strings
    const num = Number(segment);
    return Number.isInteger(num) ? num : segment;
  });
}

/**
 * Converts a path string to an array of string/number elements.
 * Uses slash-notation as the standard path format.
 * 
 * @param path - Path string (e.g., "user/profile/name", "items/0/title")
 * @returns Array of string/number elements where numeric strings are converted to numbers
 * 
 * @example
 * parsePath("user/profile/name") // ["user", "profile", "name"]
 * parsePath("items/0/title") // ["items", 0, "title"]
 * parsePath("data/users/1/email") // ["data", "users", 1, "email"]
 */
export function parsePath(path: string): (string | number)[] {
  if (!path || path.trim() === "") {
    return [];
  }
  return parsePathSegments(path.split("/"));
}

/**
 * Generic cell-level operations - foundation for all higher-level operations
 */

/**
 * Read a value from any cell at a specific path.
 * This is the foundational cell read operation.
 * 
 * @param cell - The cell to read from
 * @param path - The path within the cell value
 * @returns The value at the specified path
 */
export function getCellValue(
  cell: Cell<any>,
  path: CellPath,
): unknown {
  let currentValue = cell.get();
  for (const segment of path) {
    if (currentValue == null) {
      throw new Error(`Cannot access path "${path.join("/")}" - encountered null/undefined at "${segment}"`);
    }
    if (typeof currentValue !== "object") {
      throw new Error(`Cannot access path "${path.join("/")}" - encountered non-object at "${segment}"`);
    }
    currentValue = (currentValue as any)[segment];
  }
  
  return currentValue;
}

/**
 * Write a value to any cell at a specific path.
 * This is the foundational cell write operation.
 * 
 * @param cell - The cell to write to
 * @param path - The path within the cell
 * @param value - The value to write
 */
export function setCellValue(
  cell: Cell<any>,
  path: CellPath,
  value: unknown,
): void {
  let targetCell = cell;
  for (const segment of path) {
    targetCell = targetCell.key(segment);
  }
  
  targetCell.set(value as any);
}

/**
 * Charm-specific operations that build on the generic cell operations
 */

/**
 * Get the result value from a charm at a specific path.
 * This is the default behavior for charm get operations.
 * 
 * @param manager - The charm manager
 * @param charmId - The charm ID
 * @param path - The path within the charm result
 * @returns The value at the specified path
 */
export async function getCharmResult(
  manager: CharmManager,
  charmId: string,
  path: CellPath,
): Promise<unknown> {
  const charmCell = await manager.get(charmId);
  if (!charmCell) {
    throw new Error(`Charm with ID "${charmId}" not found`);
  }
  
  return getCellValue(charmCell, path);
}

/**
 * Get the input value from a charm at a specific path.
 * 
 * @param manager - The charm manager
 * @param charmId - The charm ID
 * @param path - The path within the charm input
 * @returns The value at the specified path
 */
export async function getCharmInput(
  manager: CharmManager,
  charmId: string,
  path: CellPath,
): Promise<unknown> {
  const charmCell = await manager.get(charmId);
  if (!charmCell) {
    throw new Error(`Charm with ID "${charmId}" not found`);
  }
  
  const inputCell = manager.getArgument(charmCell);
  return getCellValue(inputCell, path);
}

/**
 * Set the input value for a charm at a specific path.
 * This is the default behavior for charm set operations.
 * 
 * @param manager - The charm manager
 * @param charmId - The charm ID
 * @param path - The path within the charm input
 * @param value - The value to set
 */
export async function setCharmInput(
  manager: CharmManager,
  charmId: string,
  path: CellPath,
  value: unknown,
): Promise<void> {
  const charmCell = await manager.get(charmId);
  if (!charmCell) {
    throw new Error(`Charm with ID "${charmId}" not found`);
  }
  
  const inputCell = manager.getArgument(charmCell);
  setCellValue(inputCell, path, value);
  
  await manager.runtime.idle();
  await manager.synced();
}

/**
 * Set the result value for a charm at a specific path.
 * This is used when the --input flag is NOT provided to set command.
 * 
 * @param manager - The charm manager
 * @param charmId - The charm ID
 * @param path - The path within the charm result
 * @param value - The value to set
 */
export async function setCharmResult(
  manager: CharmManager,
  charmId: string,
  path: CellPath,
  value: unknown,
): Promise<void> {
  const charmCell = await manager.get(charmId);
  if (!charmCell) {
    throw new Error(`Charm with ID "${charmId}" not found`);
  }
  
  setCellValue(charmCell, path, value);
  
  await manager.runtime.idle();
  await manager.synced();
}
