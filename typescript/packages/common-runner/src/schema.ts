import { type DocImpl, type DocLink, type ReactivityLog } from "./cell.js";
import { JSONSchema } from "@commontools/builder";
import { followLinks } from "./utils.js";

export function resolveSchema(
  schema: JSONSchema | undefined,
  rootSchema: JSONSchema | undefined = schema,
): JSONSchema | undefined {
  // Treat undefined/null/{} or any other non-object as no schema
  if (typeof schema !== "object" || schema === null || Object.keys(schema).length === 0)
    return undefined;

  let resolvedSchema = schema.$ref === "#" ? rootSchema : schema;

  // Remove asCell flag from schema, so it's describing the destination
  // schema. That means we can't describe a schema that points to top-level
  // references, but that's on purpose.
  if (schema.asCell && resolvedSchema?.asCell) {
    resolvedSchema = { ...resolvedSchema };
    delete resolvedSchema.asCell;
  }

  // Return no schema if all it said is that this was a reference or an
  // object without properties.
  if (
    resolvedSchema === undefined ||
    Object.keys(resolvedSchema).length === 0 ||
    (resolvedSchema.type === "object" &&
      !resolvedSchema.additionalProperties &&
      !resolvedSchema.properties)
  )
    return undefined;

  return resolvedSchema;
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

  if (resolvedSchema.anyOf && Array.isArray(resolvedSchema.anyOf)) {
    // If the value is an object (but not an array), only consider branches with type "object"
    if (Array.isArray(value)) {
      const arrayOptions = resolvedSchema.anyOf.filter((option) => option.type === "array");
      if (arrayOptions.length === 0) return undefined;
      if (arrayOptions.length === 1)
        return validateAndTransform(doc, path, arrayOptions[0], log, rootSchema, seen.slice(0, -1));

      // TODO: Handle more corner cases like empty anyOf, etc.
      const merged: JSONSchema[] = [];
      for (const option of arrayOptions) {
        if (option.items?.anyOf && Array.isArray(option.items.anyOf))
          merged.push(...option.items.anyOf);
        else if (option.items) merged.push(option.items);
      }

      return validateAndTransform(
        doc,
        path,
        { type: "array", items: { anyOf: merged } },
        log,
        rootSchema,
        seen.slice(0, -1),
      );
    } else if (typeof value === "object" && value !== null) {
      // Run extraction for each union branch.
      const candidates = resolvedSchema.anyOf
        .filter((option) => option.type === "object")
        .map((option) => ({
          schema: option,
          // Don't include the current path in the seen array, avoiding triggering cycle detection
          result: validateAndTransform(doc, path, option, log, rootSchema, seen.slice(0, -1)),
        }));

      const objectCandidates = candidates.filter((candidate) => {
        const optionResolved = resolveSchema(candidate.schema, rootSchema);
        return optionResolved?.type === "object";
      });

      if (objectCandidates.length === 0) return undefined;

      // Merge all the object extractions
      let merged: Record<string, any> = {};
      for (const { result } of objectCandidates) {
        if (typeof result === "object" && result !== null) {
          merged = { ...merged, ...result };
        }
      }
      return merged;
    } else {
      const candidates = resolvedSchema.anyOf
        .filter((option) => option.type !== "object")
        .map((option) => ({
          schema: option,
          result: validateAndTransform(doc, path, option, log, rootSchema, seen.slice(0, -1)),
        }));

      // Otherwise, for non-object or mixed values, select the candidate whose
      // result's type best matches the expected type.
      for (const { schema: option, result } of candidates) {
        const optionResolved = resolveSchema(option, rootSchema);
        if (
          optionResolved?.type &&
          (optionResolved.type === "array"
            ? Array.isArray(result)
            : typeof result === optionResolved.type)
        ) {
          return result;
        }
      }

      // If we get here, we have no candidates that match the expected type.
      return undefined;
    }
  }

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
