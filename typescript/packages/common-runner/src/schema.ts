import {
  type CellImpl,
  isCell,
  isCellReference,
  isRendererCell,
  type ReactivityLog,
} from "./cell.js";
import { isAlias } from "@commontools/common-builder";
import { followAliases, followCellReferences } from "./utils.js";

export interface JsonSchema {
  type?: "string" | "number" | "boolean" | "object" | "array";
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  $ref?: string;
  reference?: boolean;
  additionalProperties?: JsonSchema;
}

export function resolveSchema(
  schema: JsonSchema,
  rootSchema: JsonSchema = schema,
): JsonSchema {
  if (schema.$ref === "#") {
    return rootSchema;
  }
  return schema;
}

export function validateAndTransform(
  cell: CellImpl<any>,
  value: any,
  schema: JsonSchema,
  log?: ReactivityLog,
  rootSchema: JsonSchema = schema,
  path: PropertyKey[] = [],
): any {
  const resolvedSchema = resolveSchema(schema, rootSchema);

  // Handle various types of references
  if (isCellReference(value)) {
    const ref = followCellReferences(value, log);
    return ref.cell.asRendererCell(ref.path, undefined, resolvedSchema);
  }

  if (isRendererCell(value)) {
    return value.asSchema(resolvedSchema);
  }

  if (isCell(value)) {
    return value.asRendererCell([], undefined, resolvedSchema);
  }

  if (isAlias(value)) {
    const ref = followAliases(value, cell, log);
    return ref.cell.asRendererCell(ref.path, undefined, resolvedSchema);
  }

  // For reference properties, return a RendererCell that preserves the schema
  if (resolvedSchema.reference) {
    return cell.asRendererCell(path, undefined, resolvedSchema);
  }

  if (resolvedSchema.type === "object") {
    const result: Record<string, any> = {};

    // Handle explicitly defined properties
    if (resolvedSchema.properties) {
      for (const [key, propSchema] of Object.entries(
        resolvedSchema.properties,
      )) {
        const propValue = value?.[key];
        result[key] = validateAndTransform(
          cell,
          propValue,
          propSchema,
          log,
          rootSchema,
          [...path, key],
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
            log,
            rootSchema,
            [...path, key],
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
      validateAndTransform(cell, item, resolvedSchema.items!, log, rootSchema, [
        ...path,
        i,
      ]),
    );
  }

  // For primitive types, just return the value
  return value;
}
