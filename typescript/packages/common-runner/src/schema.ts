import { type DocImpl, type DocLink, type ReactivityLog } from "./cell.js";
import { JSONSchema } from "@commontools/common-builder";
import { followLinks } from "./utils.js";

export function resolveSchema(
  schema: JSONSchema | undefined,
  rootSchema: JSONSchema | undefined = schema,
): JSONSchema | undefined {
  if (typeof schema === "object" && schema !== null && Object.keys(schema).length > 0) {
    let resolvedSchema = schema.$ref === "#" ? (rootSchema ?? schema) : schema;
    if (schema.asCell) {
      // Remove reference flag from schema, so it's describing the destination
      // schema. That means we can't describe a schema that points to top-level
      // references, but that's on purpose.
      ({
        asCell: {},
        ...resolvedSchema
      } = schema);
    }

    // Return no schema if all it said is that this was a reference or an
    // object without properties.
    if (Object.keys(resolvedSchema).length === 0) return undefined;
    if (
      resolvedSchema.type === "object" &&
      !resolvedSchema.additionalProperties &&
      !resolvedSchema.properties
    ) {
      return undefined;
    }

    return resolvedSchema;
  } else return undefined;
}

export function validateAndTransform(
  doc: DocImpl<any>,
  path: PropertyKey[] = [],
  schema?: JSONSchema,
  log?: ReactivityLog,
  rootSchema: JSONSchema | undefined = schema,
  seen: DocLink[] = [],
): any {
  if (seen.length > 100) debugger;

  const resolvedSchema = resolveSchema(schema, rootSchema);

  // If this should be a reference, return as a Cell of resolvedSchema
  // NOTE: Need to check on the passed schema whether it's a reference, not the
  // resolved schema. The returned reference is of type resolvedSchema though.
  if (typeof schema === "object" && schema !== null && schema!.asCell)
    return doc.asCell(path, log, resolvedSchema);

  // If there is no schema, return as raw data via query result proxy
  if (!resolvedSchema) return doc.getAsQueryResult(path, log);

  // Handle various types of references
  ({ cell: doc, path } = followLinks({ cell: doc, path }, seen, log));
  const value = doc.getAtPath(path);

  if (resolvedSchema.type === "object") {
    if (typeof value !== "object" || value === null) return {};

    const result: Record<string, any> = {};

    // Handle explicitly defined properties
    if (resolvedSchema.properties) {
      for (const [key, propSchema] of Object.entries(resolvedSchema.properties)) {
        if (propSchema.asCell || key in value)
          result[key] = validateAndTransform(
            doc,
            [...path, key],
            propSchema,
            log,
            rootSchema,
            seen,
          );
      }
    }

    // Handle additional properties if defined
    if (resolvedSchema.additionalProperties) {
      // For `additionalProperties: true` we assume no schema
      const additionalPropertiesSchema =
        typeof resolvedSchema.additionalProperties === "object"
          ? resolvedSchema.additionalProperties
          : undefined;
      const keys = Object.keys(value);
      for (const key of keys) {
        if (!resolvedSchema.properties || !(key in resolvedSchema.properties)) {
          result[key] = validateAndTransform(
            doc,
            [...path, key],
            additionalPropertiesSchema,
            log,
            rootSchema,
            seen,
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
    return value.map((_, i) =>
      validateAndTransform(doc, [...path, i], resolvedSchema.items!, log, rootSchema),
    );
  }

  // For primitive types, just return the value
  // TODO: Should we validate/coerce types here?
  return value;
}
