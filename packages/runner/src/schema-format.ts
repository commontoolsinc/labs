/**
 * Schema formatting utilities for LLM consumption.
 *
 * Provides TypeScript-like string representations of JSON schemas that are
 * more compact and readable than raw JSON Schema, making them ideal for
 * including in LLM context/prompts.
 */

import type { JSONSchema } from "commontools";

export interface SchemaFormatOptions {
  /** Definitions map for resolving $ref references */
  defs?: Record<string, JSONSchema>;
  /** Current recursion depth (internal use) */
  depth?: number;
  /** Maximum recursion depth before abbreviating (default: 3) */
  maxDepth?: number;
  /** Current indentation level (internal use) */
  indent?: number;
}

/**
 * Converts a JSON Schema to a TypeScript-like string representation.
 *
 * Much more compact and readable than JSON Schema, naturally expresses
 * wrapper types like Stream and Cell using familiar TypeScript syntax.
 *
 * @example
 * // Basic types
 * schemaToTypeString({ type: "string" }) // → "string"
 * schemaToTypeString({ type: "number" }) // → "number"
 *
 * @example
 * // Objects
 * schemaToTypeString({
 *   type: "object",
 *   properties: { name: { type: "string" } }
 * })
 * // → "{ name?: string }"
 *
 * @example
 * // Stream handlers (asStream: true)
 * schemaToTypeString({
 *   asStream: true,
 *   properties: { value: { type: "string" } }
 * })
 * // → "({ value?: string }) => void"
 *
 * @example
 * // Cell wrappers (asCell: true)
 * schemaToTypeString({
 *   asCell: true,
 *   properties: { count: { type: "number" } }
 * })
 * // → "Cell<{ count?: number }>"
 *
 * @example
 * // Arrays
 * schemaToTypeString({ type: "array", items: { type: "string" } })
 * // → "string[]"
 *
 * @example
 * // Enums as union literals
 * schemaToTypeString({ enum: ["open", "closed"] })
 * // → '"open" | "closed"'
 *
 * @example
 * // With $defs resolution
 * schemaToTypeString(
 *   { $ref: "#/$defs/User" },
 *   { defs: { User: { type: "string" } } }
 * )
 * // → "string" (inlined because small)
 */
export function schemaToTypeString(
  schema: JSONSchema,
  options: SchemaFormatOptions = {},
): string {
  const { defs = {}, depth = 0, maxDepth = 3, indent = 0 } = options;
  const nextOpts = { defs, depth: depth + 1, maxDepth, indent };

  if (typeof schema !== "object" || schema === null) {
    return "unknown";
  }

  const s = schema as Record<string, unknown>;

  // Handle $ref - resolve from definitions
  if (s.$ref && typeof s.$ref === "string") {
    const refPath = s.$ref as string;
    const match = refPath.match(/^#\/\$defs\/(.+)$/);
    if (match) {
      const defName = match[1];
      const def = defs[defName];
      if (def) {
        // For small definitions, inline them; otherwise use the type name
        const defStr = schemaToTypeString(def, { ...nextOpts, indent: 0 });
        if (defStr.length < 50) {
          return defStr;
        }
        return defName;
      }
      return defName; // Reference to unknown def - just use the name
    }
    return "unknown"; // Can't resolve ref
  }

  // At max depth, return simplified representation
  if (depth >= maxDepth) {
    if (s.asStream) return "(...) => void";
    if (s.asCell) return "Cell<...>";
    if (s.type === "object") return "{...}";
    if (s.type === "array") return "[...]";
    return String(s.type || "unknown");
  }

  // Handle wrapper types first
  if (s.asStream) {
    // Stream handler: ({ props }) => void
    const innerType = schemaToTypeString(
      { ...s, asStream: undefined } as JSONSchema,
      nextOpts,
    );
    return `(${innerType}) => void`;
  }

  if (s.asCell) {
    // Cell wrapper: Cell<T>
    const innerType = schemaToTypeString(
      { ...s, asCell: undefined } as JSONSchema,
      nextOpts,
    );
    return `Cell<${innerType}>`;
  }

  if (s.asOpaque) {
    // Opaque wrapper - just note it's opaque
    return "Opaque";
  }

  // Handle enum - show as union of literals
  if (Array.isArray(s.enum)) {
    const values = s.enum.slice(0, 5).map((v) =>
      typeof v === "string" ? `"${v}"` : String(v)
    );
    if (s.enum.length > 5) values.push("...");
    return values.join(" | ");
  }

  // Handle anyOf/oneOf as union types
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const variants = (s.anyOf || s.oneOf) as JSONSchema[];
    const types = variants
      .slice(0, 4)
      .map((v) => schemaToTypeString(v, nextOpts));
    if (variants.length > 4) types.push("...");
    return types.join(" | ");
  }

  // Handle basic types
  const type = s.type;

  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";

  // Handle arrays
  if (type === "array") {
    if (s.items && typeof s.items === "object") {
      const itemType = schemaToTypeString(s.items as JSONSchema, nextOpts);
      return `${itemType}[]`;
    }
    return "unknown[]";
  }

  // Handle objects
  if (type === "object" || s.properties) {
    const props = s.properties as Record<string, JSONSchema> | undefined;
    if (!props || Object.keys(props).length === 0) {
      if (s.additionalProperties) return "Record<string, unknown>";
      return "{}";
    }

    const required = new Set(
      Array.isArray(s.required) ? (s.required as string[]) : [],
    );
    const lines: string[] = [];
    const padding = "  ".repeat(indent + 1);

    for (const [key, propSchema] of Object.entries(props)) {
      // Skip $-prefixed internal properties
      if (key.startsWith("$")) continue;

      const optional = required.has(key) ? "" : "?";
      const propType = schemaToTypeString(propSchema, {
        ...nextOpts,
        indent: indent + 1,
      });
      lines.push(`${padding}${key}${optional}: ${propType}`);
    }

    if (lines.length === 0) return "{}";

    const closePadding = "  ".repeat(indent);
    return `{\n${lines.join(",\n")}\n${closePadding}}`;
  }

  // Fallback
  return type ? String(type) : "unknown";
}
