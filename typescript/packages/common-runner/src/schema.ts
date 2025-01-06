import { CellImpl } from "./cell.js";

export interface JsonSchema {
  type?: "string" | "number" | "boolean" | "object" | "array";
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  $ref?: string;
  reference?: boolean;
  additionalProperties?: JsonSchema;
}

export function resolveSchema(schema: JsonSchema, rootSchema: JsonSchema = schema): JsonSchema {
  if (schema.$ref === "#") {
    return rootSchema;
  }
  return schema;
}

export function validateAndTransform(
  cell: CellImpl<any>,
  value: any,
  schema: JsonSchema,
  rootSchema: JsonSchema = schema,
  path: PropertyKey[] = []
): any {
  const resolvedSchema = resolveSchema(schema, rootSchema);
  
  if (resolvedSchema.reference) {
    // For reference properties, return a RendererCell that preserves the schema
    return cell.asRendererCell(path, undefined, resolvedSchema);
  }

  if (resolvedSchema.type === "object") {
    const result: Record<string, any> = {};
    
    // Handle explicitly defined properties
    if (resolvedSchema.properties) {
      for (const [key, propSchema] of Object.entries(resolvedSchema.properties)) {
        const propValue = value?.[key];
        result[key] = validateAndTransform(
          cell,
          propValue,
          propSchema,
          rootSchema,
          [...path, key]
        );
      }
    }
    
    // Handle additional properties if defined
    if (resolvedSchema.additionalProperties && value) {
      for (const key of Object.keys(value)) {
        if (!resolvedSchema.properties?.[key]) {
          const propValue = value[key];
          result[key] = validateAndTransform(
            cell,
            propValue,
            resolvedSchema.additionalProperties,
            rootSchema,
            [...path, key]
          );
        }
      }
    }
    
    return result;
  }

  if (resolvedSchema.type === "array" && resolvedSchema.items) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.map((item, i) =>
      validateAndTransform(cell, item, resolvedSchema.items!, rootSchema, [...path, i])
    );
  }

  // For primitive types, just return the value
  return value;
}
