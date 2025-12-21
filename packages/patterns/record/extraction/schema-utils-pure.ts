/**
 * Pure schema utilities - no external dependencies.
 *
 * These functions only use stored schema and don't fall back to registry.
 * This module can be imported in tests without pulling in the commontools runtime.
 */

import type { SubCharmEntry } from "../types.ts";

// JSON Schema type (simplified for our use case)
export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  enum?: unknown[];
  description?: string;
  [key: string]: unknown;
}

/**
 * Type-safe helper to extract resultSchema from a pattern/charm.
 *
 * Pattern outputs implement the Recipe interface which includes resultSchema.
 * This helper safely extracts it with proper type checking.
 *
 * @param charm - The charm/pattern instance (usually stored as `unknown`)
 * @returns The resultSchema if available, undefined otherwise
 */
export function getResultSchema(charm: unknown): JSONSchema | undefined {
  if (
    charm &&
    typeof charm === "object" &&
    "resultSchema" in charm &&
    charm.resultSchema &&
    typeof charm.resultSchema === "object"
  ) {
    return charm.resultSchema as JSONSchema;
  }
  return undefined;
}

/**
 * Build a combined extraction schema from all sub-charms using stored schemas only.
 *
 * This pure version only uses entry.schema - no registry fallback.
 * For production use with fallback, use buildExtractionSchema from schema-utils.ts.
 *
 * @param subCharms - Array of sub-charm entries from the Record
 * @returns Combined JSON Schema with properties from all sub-charms
 */
export function buildExtractionSchemaPure(
  subCharms: readonly SubCharmEntry[],
): JSONSchema {
  const properties: Record<string, JSONSchema> = {};

  for (const entry of subCharms) {
    // Skip internal/controller modules that don't have extractable data
    if (entry.type === "type-picker" || entry.type === "extractor") continue;

    // Only use stored schema (captured at creation time)
    const storedSchema = entry.schema as JSONSchema | undefined;
    if (storedSchema?.properties) {
      Object.assign(properties, storedSchema.properties);
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
 * @param parentSubCharms - Object with get() method returning sub-charm entries
 * @returns Combined JSON Schema with properties from all sub-charms
 */
export function buildExtractionSchemaFromCellPure(
  // deno-lint-ignore no-explicit-any
  parentSubCharms: { get?: () => SubCharmEntry[] | null | undefined } | any,
): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const subCharms = parentSubCharms.get?.() ?? [];

  for (const entry of subCharms) {
    // Skip internal/controller modules
    if (entry.type === "type-picker" || entry.type === "extractor") continue;

    // Only use stored schema (captured at creation time)
    const storedSchema = entry.schema as JSONSchema | undefined;
    if (storedSchema?.properties) {
      Object.assign(properties, storedSchema.properties);
    }
  }

  return {
    type: "object",
    properties,
  };
}

/**
 * Get the field-to-type mapping from sub-charm schemas (stored schemas only).
 *
 * Creates a reverse mapping from field names to their owning module types.
 * This pure version only uses entry.schema - no registry fallback.
 *
 * @param subCharms - Array of sub-charm entries from the Record
 * @returns Map of field names to module types
 */
export function getFieldToTypeMappingPure(
  subCharms: readonly SubCharmEntry[],
): Record<string, string> {
  const fieldToType: Record<string, string> = {};

  for (const entry of subCharms) {
    // Skip internal modules
    if (entry.type === "type-picker" || entry.type === "extractor") continue;

    // Only use stored schema
    const storedSchema = entry.schema as JSONSchema | undefined;
    if (storedSchema?.properties) {
      for (const field of Object.keys(storedSchema.properties)) {
        fieldToType[field] = entry.type;
      }
    }
  }

  return fieldToType;
}
