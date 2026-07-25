/**
 * Pure schema utilities - no external dependencies.
 *
 * This module can be imported in tests without pulling in the Common Fabric
 * runtime.
 */

/**
 * Safely extract a value from a Cell-like object or return the value directly.
 *
 * This handles the common pattern where a value might be:
 * - A Cell (object with .get() method) - returns the dereferenced value
 * - A raw value - returns as-is
 *
 * @param cellOrValue - Either a Cell-like object or a raw value
 * @returns The dereferenced value from a Cell, or the raw value
 *
 * @example
 * // With a Cell
 * const cell = { get: () => "hello" };
 * getCellValue(cell); // returns "hello"
 *
 * // With a raw value
 * getCellValue("world"); // returns "world"
 *
 * // With null/undefined
 * getCellValue(null); // returns null
 */
export function getCellValue<T = unknown>(cellOrValue: unknown): T {
  if (
    typeof cellOrValue === "object" &&
    cellOrValue !== null &&
    "get" in cellOrValue &&
    typeof (cellOrValue as { get: unknown }).get === "function"
  ) {
    return (cellOrValue as { get: () => T }).get();
  }
  return cellOrValue as T;
}

// JSON Schema type (simplified for our use case)
// Uses readonly arrays to be compatible with runtime-returned schemas
export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  enum?: readonly unknown[];
  description?: string;
  readonly [key: string]: unknown;
}
