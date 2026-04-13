/**
 * Schema formatting utilities for LLM consumption.
 *
 * Provides TypeScript-like string representations of JSON schemas that are
 * more compact and readable than raw JSON Schema, making them ideal for
 * including in LLM context/prompts.
 */

import type { JSONSchema } from "commonfabric";
import { ContextualFlowControl } from "./cfc.ts";
import { AsCellType } from "@commonfabric/api";

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
 * // Stream handlers (asCell: ["stream"])
 * schemaToTypeString({
 *   asCell: ["stream"],
 *   properties: { value: { type: "string" } }
 * })
 * // → "({ value?: string }) => void"
 *
 * @example
 * // Cell wrappers (asCell: ["cell"])
 * schemaToTypeString({
 *   asCell: ["cell"],
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
 * // PatternToolResult schemas (from patternTool())
 * schemaToTypeString({
 *   type: "object",
 *   properties: {
 *     pattern: { type: "object" },
 *     extraParams: { properties: { content: { type: "string" } } }
 *   }
 * })
 * // → "(e: { content?: string }) => void"
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
  const { defs = {}, depth = 0, maxDepth = 4, indent = 0 } = options;
  const nextOpts = { defs, depth: depth + 1, maxDepth, indent };

  if (typeof schema !== "object" || schema === null) {
    return "unknown";
  }

  const s = schema as Record<string, unknown>;

  // Handle $ref - resolve from definitions
  if (schema.$ref && typeof schema.$ref === "string") {
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

  // Normalize asCell/asStream into a single asCellValues array for easier handling
  const asCellValues = ContextualFlowControl.getAsCellValues(schema);

  // At max depth, return simplified representation
  if (depth >= maxDepth) {
    if (asCellValues.length > 0) {
      let innerType = "...";
      for (let i = asCellValues.length - 1; i >= 0; i--) {
        innerType = getWrappedTypeString(asCellValues[i], innerType);
      }
      return innerType;
    } else {
      if (schema.type === "object") return "{...}";
      if (schema.type === "array") return "[...]";
      return String(schema.type || "unknown");
    }
  }

  // Normalize asCell/asStream into a single asCellValue array for easier handling
  if (asCellValues.length > 0) {
    const { asCell: _c, asStream: _s, ...restSchema } = schema;
    // Wrapper arrays are ordered outermost-first, so apply them from the end.
    let innerType = schemaToTypeString(restSchema, nextOpts);
    for (let i = asCellValues.length - 1; i >= 0; i--) {
      innerType = getWrappedTypeString(asCellValues[i], innerType);
    }
    return innerType;
  }

  // Handle PatternToolResult - objects with { pattern, extraParams } structure
  // These represent callable handlers created via patternTool()
  // Format as (e: ExtraParamsType) => void for LLM readability
  if (s.type === "object" || s.properties) {
    const props = s.properties as Record<string, JSONSchema> | undefined;
    if (props && "pattern" in props && "extraParams" in props) {
      // This is a PatternToolResult schema - format as a handler
      const extraParamsSchema = props.extraParams;
      if (depth >= maxDepth) return "(e: {...}) => void";
      const paramType = schemaToTypeString(extraParamsSchema, nextOpts);
      return `(e: ${paramType}) => void`;
    }
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

function getWrappedTypeString(
  wrapper: AsCellType,
  innerType: string,
): string {
  switch (wrapper) {
    case "cell":
      return `Cell<${innerType}>`;
    case "readonly":
      return `ReadonlyCell<${innerType}>`;
    case "writeonly":
      return `WriteonlyCell<${innerType}>`;
    case "comparable":
      return `ComparableCell<${innerType}>`;
    case "stream":
      return `(${innerType}) => void`;
    case "opaque":
      return "Opaque";
    default:
      return "UnknownWrapper";
  }
}
