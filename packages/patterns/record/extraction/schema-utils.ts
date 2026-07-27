/**
 * Schema utilities for LLM extraction.
 *
 * The module registry is the source of truth for a module's field shapes.
 * `getSchemaForType` looks up a module type's schema there.
 */

import type { JSONSchema } from "./schema-utils-pure.ts";

// Registry import pulls in all module patterns which require the Common Fabric
// runtime.
import { getDefinition } from "../registry.ts";

// Re-export for convenience
export type { JSONSchema };

/**
 * Get schema for a sub-piece from the module registry.
 *
 * @param type - The sub-piece type (e.g., "contact", "social")
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
