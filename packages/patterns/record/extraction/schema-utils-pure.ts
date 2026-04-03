/**
 * Pure schema utilities - no external dependencies.
 *
 * These functions only use stored schema and don't fall back to registry.
 * This module can be imported in tests without pulling in the commontools runtime.
 */

import type { SubPieceEntry } from "../types.ts";

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

/**
 * Set of internal module types that don't have extractable data.
 * These are controller/system modules that should be skipped during extraction.
 */
export const INTERNAL_MODULE_TYPES = new Set(["type-picker", "extractor"]);

/**
 * Check if a module type is an internal/controller module.
 *
 * @param type - The module type to check
 * @returns true if the type is internal and should be skipped
 */
export function isInternalModule(type: string): boolean {
  return INTERNAL_MODULE_TYPES.has(type);
}

/**
 * Type-safe helper to extract resultSchema from a pattern/piece.
 *
 * Pattern outputs implement the Pattern interface which includes resultSchema.
 * This helper safely extracts it with proper type checking.
 *
 * @param piece - The piece/pattern instance (usually stored as `unknown`)
 * @returns The resultSchema if available, undefined otherwise
 */
export function getResultSchema(piece: unknown): JSONSchema | undefined {
  if (
    piece &&
    typeof piece === "object" &&
    "resultSchema" in piece &&
    piece.resultSchema &&
    typeof piece.resultSchema === "object"
  ) {
    return piece.resultSchema as JSONSchema;
  }
  return undefined;
}

/**
 * Build a combined extraction schema from all sub-pieces using stored schemas only.
 *
 * This pure version only uses entry.schema - no registry fallback.
 * For production use with fallback, use buildExtractionSchema from schema-utils.ts.
 *
 * @param subPieces - Array of sub-piece entries from the Record
 * @returns Combined JSON Schema with properties from all sub-pieces
 */
export function buildExtractionSchemaPure(
  subPieces: readonly SubPieceEntry[],
): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const fieldOwners: Record<string, string> = {}; // Track which module defines each field

  for (const entry of subPieces) {
    // Skip internal/controller modules that don't have extractable data
    if (isInternalModule(entry.type)) continue;

    // Only use stored schema (captured at creation time)
    const storedSchema = entry.schema as JSONSchema | undefined;
    if (storedSchema?.properties) {
      // Check for conflicts before assigning
      for (
        const [fieldName, fieldSchema] of Object.entries(
          storedSchema.properties,
        )
      ) {
        if (properties[fieldName]) {
          console.warn(
            `[Schema] Field "${fieldName}" defined by both "${
              fieldOwners[fieldName]
            }" and "${entry.type}" - using ${entry.type}`,
          );
        }
        properties[fieldName] = fieldSchema;
        fieldOwners[fieldName] = entry.type;
      }
    }
  }

  return {
    type: "object",
    properties,
  };
}

/**
 * Build extraction schema from a Cell-like object using stored schemas only.
 *
 * This pure version only uses entry.schema - no registry fallback.
 *
 * @param parentSubPieces - Object with get() method returning sub-piece entries
 * @returns Combined JSON Schema with properties from all sub-pieces
 */
export function buildExtractionSchemaFromCellPure(
  // deno-lint-ignore no-explicit-any
  parentSubPieces: { get?: () => SubPieceEntry[] | null | undefined } | any,
): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const fieldOwners: Record<string, string> = {}; // Track which module defines each field
  const subPieces = parentSubPieces.get?.() ?? [];

  for (const entry of subPieces) {
    // Skip internal/controller modules
    if (isInternalModule(entry.type)) continue;

    // Only use stored schema (captured at creation time)
    const storedSchema = entry.schema as JSONSchema | undefined;
    if (storedSchema?.properties) {
      // Check for conflicts before assigning
      for (
        const [fieldName, fieldSchema] of Object.entries(
          storedSchema.properties,
        )
      ) {
        if (properties[fieldName]) {
          console.warn(
            `[Schema] Field "${fieldName}" defined by both "${
              fieldOwners[fieldName]
            }" and "${entry.type}" - using ${entry.type}`,
          );
        }
        properties[fieldName] = fieldSchema;
        fieldOwners[fieldName] = entry.type;
      }
    }
  }

  return {
    type: "object",
    properties,
  };
}

/**
 * Get the field-to-type mapping from sub-piece schemas (stored schemas only).
 *
 * Creates a reverse mapping from field names to their owning module types.
 * This pure version only uses entry.schema - no registry fallback.
 *
 * @param subPieces - Array of sub-piece entries from the Record
 * @returns Map of field names to module types
 */
export function getFieldToTypeMappingPure(
  subPieces: readonly SubPieceEntry[],
): Record<string, string> {
  const fieldToType: Record<string, string> = {};

  for (const entry of subPieces) {
    // Skip internal modules
    if (isInternalModule(entry.type)) continue;

    // Only use stored schema
    const storedSchema = entry.schema as JSONSchema | undefined;
    if (storedSchema?.properties) {
      for (const field of Object.keys(storedSchema.properties)) {
        if (fieldToType[field]) {
          console.warn(
            `[Schema] Field "${field}" defined by both "${
              fieldToType[field]
            }" and "${entry.type}" - using ${entry.type}`,
          );
        }
        fieldToType[field] = entry.type;
      }
    }
  }

  return fieldToType;
}
