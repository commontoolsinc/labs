import {
  type CellImpl,
  isCell,
  type CellReference,
  isCellReference,
  type ReactivityLog,
} from "./cell.js";
import { isAlias, JSONSchema } from "@commontools/common-builder";
import { followAliases, followCellReferences, arrayEqual } from "./utils.js";

export function resolveSchema(
  schema: JSONSchema | undefined,
  rootSchema: JSONSchema | undefined = schema,
): JSONSchema | undefined {
  if (
    typeof schema === "object" &&
    schema !== null &&
    Object.keys(schema).length > 0
  ) {
    let resolvedSchema = schema.$ref === "#" ? rootSchema ?? schema : schema;
    if (schema.asCell)
      // Remove reference flag from schema, so it's describing the destination
      // schema. That means we can't describe a schema that points to top-level
      // references, but that's on purpose.
      ({
        asCell: {},
        ...resolvedSchema
      } = schema);

    // Return no schema if all it said is that this was a reference or an
    // object without properties.
    if (Object.keys(resolvedSchema).length === 0) return undefined;
    if (
      resolvedSchema.type === "object" &&
      !resolvedSchema.additionalProperties &&
      !resolvedSchema.properties
    )
      return undefined;

    return resolvedSchema;
  } else return undefined;
}

export function validateAndTransform(
  cell: CellImpl<any>,
  path: PropertyKey[] = [],
  schema?: JSONSchema,
  log?: ReactivityLog,
  rootSchema: JSONSchema | undefined = schema,
): any {
  const resolvedSchema = resolveSchema(schema, rootSchema);

  // If this should be a reference, return as a RendererCell of resolvedSchema
  // NOTE: Need to check on the passed schema whether it's a reference, not the
  // resolved schema. The returned reference is of type resolvedSchema though.
  if (typeof schema === "object" && schema !== null && schema!.asCell)
    return cell.asRendererCell(path, log, resolvedSchema);

  // If there is no schema, return as raw data via query result proxy
  if (!resolvedSchema) return cell.getAsQueryResult(path, log);

  // Handle various types of references
  const seen: CellReference[] = [];

  let value;
  while (true) {
    log?.reads.push({ cell, path });
    value = cell.getAtPath(path);

    // Follow references and aliases until we hit a value
    if (isCellReference(value))
      ({ cell, path } = followCellReferences(value, log));
    else if (isAlias(value)) ({ cell, path } = followAliases(value, cell, log));
    else if (isCell(value)) [cell, path] = [value, []];
    else break;

    if (seen.some(ref => ref.cell === cell && arrayEqual(ref.path, path)))
      throw new Error(`Reference cycle detected ${path.join(".")}`);
    seen.push({ cell, path });
  }

  if (resolvedSchema.type === "object") {
    const result: Record<string, any> = {};

    // Handle explicitly defined properties
    if (resolvedSchema.properties) {
      for (const [key, propSchema] of Object.entries(
        resolvedSchema.properties,
      )) {
        result[key] = validateAndTransform(
          cell,
          [...path, key],
          propSchema,
          log,
          rootSchema,
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
      const keys =
        typeof value === "object" && value !== null ? Object.keys(value) : [];
      for (const key of keys) {
        if (!resolvedSchema.properties || !(key in resolvedSchema.properties)) {
          result[key] = validateAndTransform(
            cell,
            [...path, key],
            additionalPropertiesSchema,
            log,
            rootSchema,
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
      validateAndTransform(
        cell,
        [...path, i],
        resolvedSchema.items!,
        log,
        rootSchema,
      ),
    );
  }

  // For primitive types, just return the value
  // TODO: Should we validate/coerce types here?
  return value;
}
