/**
 * Schema utilities for LLM extraction.
 *
 * Provides dynamic schema discovery using schema stored on SubCharmEntry at creation time.
 * When sub-charms are created, their resultSchema is captured and stored alongside the charm.
 * This enables extraction to work with any module type without a manual registry.
 *
 * Falls back to manual registry for legacy entries that don't have stored schema.
 */

import type { Cell } from "commontools";
import type { SubCharmEntry } from "../types.ts";
import type { JSONSchema } from "./schema-utils-pure.ts";

// Registry import for fallback - only used for legacy entries without stored schema.
// This import pulls in all module patterns which require commontools runtime.
// Tests that only use stored schema won't trigger the fallback path.
import { getDefinition } from "../registry.ts";

// Import helpers from pure module
import { getResultSchema, isInternalModule } from "./schema-utils-pure.ts";

// Re-export for convenience
export type { JSONSchema };
export { getResultSchema, isInternalModule };

/**
 * Get schema for a sub-charm from the manual registry.
 *
 * @param type - The sub-charm type (e.g., "contact", "social")
 * @returns The schema for this type, or undefined if not available
 */
export function getSchemaForType(type: string): JSONSchema | undefined {
  const def = getDefinition(type);
  if (def?.schema) {
    return {
      type: "object",
      properties: def.schema as Record<string, JSONSchema>,
    };
  }
  return undefined;
}

/**
 * Build a combined extraction schema from all sub-charms.
 *
 * Uses stored schema (entry.schema) first, falls back to registry.
 *
 * @param subCharms - Array of sub-charm entries from the Record
 * @returns Combined JSON Schema with properties from all sub-charms
 */
export function buildExtractionSchema(
  subCharms: readonly SubCharmEntry[],
): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const fieldOwners: Record<string, string> = {}; // Track which module defines each field

  for (const entry of subCharms) {
    // Skip internal/controller modules that don't have extractable data
    if (isInternalModule(entry.type)) continue;

    // Try stored schema first (captured at creation time)
    const storedSchema = entry.schema as JSONSchema | undefined;
    if (storedSchema?.properties) {
      // Check for conflicts before assigning
      for (const [fieldName, fieldSchema] of Object.entries(storedSchema.properties)) {
        if (properties[fieldName]) {
          console.warn(
            `[Schema] Field "${fieldName}" defined by both "${fieldOwners[fieldName]}" and "${entry.type}" - using ${entry.type}`
          );
        }
        properties[fieldName] = fieldSchema;
        fieldOwners[fieldName] = entry.type;
      }
      continue;
    }

    // Fallback to registry for legacy entries
    const registrySchema = getSchemaForType(entry.type);
    if (registrySchema?.properties) {
      console.debug(
        `[Extract] Using registry fallback for "${entry.type}" - consider re-creating this module`,
      );
      // Check for conflicts before assigning
      for (const [fieldName, fieldSchema] of Object.entries(registrySchema.properties)) {
        if (properties[fieldName]) {
          console.warn(
            `[Schema] Field "${fieldName}" defined by both "${fieldOwners[fieldName]}" and "${entry.type}" - using ${entry.type}`
          );
        }
        properties[fieldName] = fieldSchema;
        fieldOwners[fieldName] = entry.type;
      }
    } else {
      // No schema found - this module won't contribute to extraction
      console.warn(
        `[Extract] No schema found for module "${entry.type}" - fields won't be extracted`,
      );
    }
  }

  return {
    type: "object",
    properties,
  };
}

/**
 * Build extraction schema dynamically using stored schema from SubCharmEntry.
 *
 * Uses entry.schema (captured at creation time via pattern.resultSchema) for
 * dynamic discovery. Falls back to registry for legacy entries without stored schema.
 *
 * @param parentSubCharms - The Cell containing sub-charm entries
 * @returns Combined JSON Schema with properties from all sub-charms
 */
export function buildExtractionSchemaFromCell(
  // deno-lint-ignore no-explicit-any
  parentSubCharms: Cell<SubCharmEntry[]> | any,
): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const fieldOwners: Record<string, string> = {}; // Track which module defines each field
  const subCharms = parentSubCharms.get?.() ?? [];

  for (const entry of subCharms) {
    // Skip internal/controller modules
    if (isInternalModule(entry.type)) continue;

    // Try stored schema first (captured at creation time)
    const storedSchema = entry.schema as JSONSchema | undefined;
    if (storedSchema?.properties) {
      // Check for conflicts before assigning
      for (const [fieldName, fieldSchema] of Object.entries(storedSchema.properties)) {
        if (properties[fieldName]) {
          console.warn(
            `[Schema] Field "${fieldName}" defined by both "${fieldOwners[fieldName]}" and "${entry.type}" - using ${entry.type}`
          );
        }
        properties[fieldName] = fieldSchema;
        fieldOwners[fieldName] = entry.type;
      }
      continue;
    }

    // Fallback to registry for legacy entries without stored schema
    const registrySchema = getSchemaForType(entry.type);
    if (registrySchema?.properties) {
      console.debug(
        `[Extract] Using registry fallback for "${entry.type}" - consider re-creating this module`,
      );
      // Check for conflicts before assigning
      for (const [fieldName, fieldSchema] of Object.entries(registrySchema.properties)) {
        if (properties[fieldName]) {
          console.warn(
            `[Schema] Field "${fieldName}" defined by both "${fieldOwners[fieldName]}" and "${entry.type}" - using ${entry.type}`
          );
        }
        properties[fieldName] = fieldSchema;
        fieldOwners[fieldName] = entry.type;
      }
    } else {
      // No schema found - this module won't contribute to extraction
      console.warn(
        `[Extract] No schema found for module "${entry.type}" - fields won't be extracted`,
      );
    }
  }

  return {
    type: "object",
    properties,
  };
}

/**
 * Get the field-to-type mapping from sub-charm schemas.
 *
 * Creates a reverse mapping from field names to their owning module types.
 * Uses stored schema first, falls back to registry.
 *
 * @param subCharms - Array of sub-charm entries from the Record
 * @returns Map of field names to module types
 */
export function getFieldToTypeMapping(
  subCharms: readonly SubCharmEntry[],
): Record<string, string> {
  const fieldToType: Record<string, string> = {};

  for (const entry of subCharms) {
    // Skip internal modules
    if (isInternalModule(entry.type)) continue;

    // Try stored schema first
    const storedSchema = entry.schema as JSONSchema | undefined;
    if (storedSchema?.properties) {
      for (const field of Object.keys(storedSchema.properties)) {
        if (fieldToType[field]) {
          console.warn(
            `[Schema] Field "${field}" defined by both "${fieldToType[field]}" and "${entry.type}" - using ${entry.type}`
          );
        }
        fieldToType[field] = entry.type;
      }
      continue;
    }

    // Fallback to registry
    const registrySchema = getSchemaForType(entry.type);
    if (registrySchema?.properties) {
      for (const field of Object.keys(registrySchema.properties)) {
        if (fieldToType[field]) {
          console.warn(
            `[Schema] Field "${field}" defined by both "${fieldToType[field]}" and "${entry.type}" - using ${entry.type}`
          );
        }
        fieldToType[field] = entry.type;
      }
    }
  }

  return fieldToType;
}
