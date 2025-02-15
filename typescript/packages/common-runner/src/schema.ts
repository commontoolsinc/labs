import { JSONSchema } from "@commontools/builder";
import { type DocImpl, type DocLink } from "./doc.js";
import { isCell } from "./cell.js";
import { type ReactivityLog } from "./scheduler.js";
import { followLinks } from "./utils.js";

export function resolveSchema(
  schema: JSONSchema | undefined,
  rootSchema: JSONSchema | undefined = schema,
  filterAsCell = false,
): JSONSchema | undefined {
  // Treat undefined/null/{} or any other non-object as no schema
  if (typeof schema !== "object" || schema === null || Object.keys(schema).length === 0)
    return undefined;

  let resolvedSchema = schema.$ref === "#" ? rootSchema : schema;

  // Remove asCell flag from schema, so it's describing the destination
  // schema. That means we can't describe a schema that points to top-level
  // references, but that's on purpose.
  if (schema.asCell && resolvedSchema?.asCell && filterAsCell) {
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

  const resolvedSchema = resolveSchema(schema, rootSchema, true);

  // If this should be a reference, return as a Cell of resolvedSchema
  // NOTE: Need to check on the passed schema whether it's a reference, not the
  // resolved schema. The returned reference is of type resolvedSchema though.
  // anyOf gets handled here if all options are cells, so we don't read the
  // data. Below we handle the case where some options are meant to be cells.
  if (
    typeof schema === "object" &&
    schema !== null &&
    (schema!.asCell ||
      (Array.isArray(resolvedSchema?.anyOf) &&
        resolvedSchema.anyOf.every((option) => option.asCell)))
  )
    return doc.asCell(path, log, resolvedSchema, rootSchema);

  // If there is no schema, return as raw data via query result proxy
  if (!resolvedSchema) return doc.getAsQueryResult(path, log);

  // Handle various types of references
  ({ cell: doc, path } = followLinks({ cell: doc, path }, seen, log));
  const value = doc.getAtPath(path);

  // TODO: The behavior when one of the options is very permissive (e.g. no type
  // or an object that allows any props) is not well defined.
  if (Array.isArray(resolvedSchema.anyOf)) {
    const options = resolvedSchema.anyOf
      .map((option) => {
        const resolved = resolveSchema(option, rootSchema);
        if (option.asCell) return { ...resolved, asCell: true };
        else return resolved;
      })
      .filter((option) => option !== undefined);

    if (Array.isArray(value)) {
      const arrayOptions = options.filter((option) => option.type === "array");
      if (arrayOptions.length === 0) return undefined;
      if (arrayOptions.length === 1)
        // slice: Don't include the current path in the seen array, avoiding triggering cycle detection
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
      let objectCandidates = options.filter((option) => option.type === "object");
      const numAsCells = objectCandidates.filter((option) => option.asCell).length;

      // If there are more than two asCell branches, merge them
      if (numAsCells > 2) {
        const asCellRemoved = objectCandidates
          .filter((option) => option.asCell)
          .map((option) =>
            (option.anyOf ?? [option]).map((branch) => {
              const {
                asCell: {},
                ...rest
              } = branch as any;
              return rest;
            }),
          )
          .flat();
        objectCandidates = objectCandidates.filter((option) => !option.asCell);
        objectCandidates.push({ anyOf: asCellRemoved });
      }

      // Run extraction for each union branch.
      const candidates = options
        .filter((option) => option.type === "object")
        .map((option) => ({
          schema: option,
          result: validateAndTransform(doc, path, option, log, rootSchema, seen.slice(0, -1)),
        }));

      if (candidates.length === 0) return undefined;

      // Merge all the object extractions
      let merged: Record<string, any> = {};
      for (const { result } of candidates) {
        if (isCell(result)) return result; // TODO: Complain if it's a mix of cells and non-cells?
        if (typeof result === "object" && result !== null) merged = { ...merged, ...result };
      }
      return merged;
    } else {
      const candidates = options
        .filter((option) => (option.type === "integer" ? "number" : option.type) === typeof value)
        .map((option) => ({
          schema: option,
          result: validateAndTransform(doc, path, option, log, rootSchema, seen.slice(0, -1)),
        }));

      if (candidates.length === 0) return undefined;
      if (candidates.length === 1) return candidates[0].result;

      // If we get more than one candidate, see if there is one that matches anything, and if not return the first one
      const anyTypeOption = options.find((option) => option.type === undefined);
      if (anyTypeOption)
        return validateAndTransform(doc, path, anyTypeOption, log, rootSchema, seen.slice(0, -1));
      else return candidates[0].result;
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
