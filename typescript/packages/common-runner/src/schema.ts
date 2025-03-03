import { isAlias, JSONSchema } from "@commontools/builder";
import { type DocImpl, type DocLink, getDoc, isDocLink } from "./doc.ts";
import { createCell, isCell } from "./cell.ts";
import { type ReactivityLog } from "./scheduler.ts";
import { followLinks, resolvePath } from "./utils.ts";

/**
 * Schemas are mostly a subset of JSONSchema.
 *
 * One addition is `asCell`. When true, the `.get()` returns an instance of
 * `Cell`, i.e. a reactive reference to the value underneath. Some implications
 * this has:
 *  - If `log` is passed, it will be passed on to new cells, and unless that
 *    cell is read, no further reads are logged down this branch.
 *  - The cell reflects as closely as possible the current value. So it doesn't
 *    change when the underlying reference changes. This is useful to e.g. to
 *    read the current value of "currently selected item" and keep that constant
 *    even if in the future another item is selected. NOTE:
 *    - For this to work, the underlying value should be a reference itself.
 *      Otherwise the closest parent document is used, so that e.g. reading
 *      current.name tracks changes on current.
 *    - If the value is an alias, aliases are followed first and the cell is
 *      based on the first non-alias value. This is because writes will follow
 *      aliases as well.
 *
 *  Calling `effect` on returned cells within a higher-level `effect` works as
 *  expected. Be sure to track the cancels, though. (Tracking cancels isn't
 *  necessary when using the schedueler directly)
 */

export function resolveSchema(
  schema: JSONSchema | undefined,
  rootSchema: JSONSchema | undefined = schema,
  filterAsCell = false,
): JSONSchema | undefined {
  // Treat undefined/null/{} or any other non-object as no schema
  if (
    typeof schema !== "object" || schema === null ||
    Object.keys(schema).length === 0
  ) {
    return undefined;
  }

  let resolvedSchema = schema.$ref === "#" ? rootSchema : schema;

  // Remove asCell flag from schema, so it's describing the destination
  // schema. That means we can't describe a schema that points to top-level
  // references, but that's on purpose.
  if (schema.asCell && resolvedSchema?.asCell && filterAsCell) {
    resolvedSchema = { ...resolvedSchema };
    delete (resolvedSchema as any).asCell;
  }

  // Return no schema if all it said is that this was a reference or an
  // object without properties.
  if (
    resolvedSchema === undefined ||
    Object.keys(resolvedSchema).length === 0 ||
    (resolvedSchema.type === "object" &&
      !resolvedSchema.additionalProperties &&
      !resolvedSchema.properties)
  ) {
    return undefined;
  }

  return resolvedSchema;
}

/**
 * Process a default value from a schema, transforming it based on the schema
 * structure to account for asCell and other schema features.
 *
 * For `required` objects and arrays assume {} and [] as default value.
 */
function processDefaultValue(
  doc: DocImpl<any>,
  path: PropertyKey[] = [],
  defaultValue: any,
  schema?: JSONSchema,
  log?: ReactivityLog,
  rootSchema: JSONSchema | undefined = schema,
): any {
  if (!schema) return defaultValue;

  const resolvedSchema = resolveSchema(schema, rootSchema, true);

  // If schema indicates this should be a cell
  if (schema.asCell) {
    // If the cell itself has a default value, make it it's own (immutablle)
    // doc, to emulate the behavior of .get() returning a different underlying
    // document when the value is changed. A classic example is
    // `currentlySelected` with a default of `null`.
    if (!defaultValue && resolvedSchema?.default !== undefined) {
      const doc = getDoc(resolvedSchema.default);
      doc.freeze();
      return createCell(
        doc,
        [],
        log,
        resolvedSchema,
        rootSchema,
      );
    } else {
      return createCell(
        doc,
        path,
        log,
        mergeDefaults(resolvedSchema, defaultValue),
        rootSchema,
      );
    }
  }

  // Handle object type defaults
  if (
    resolvedSchema?.type === "object" && typeof defaultValue === "object" &&
    defaultValue !== null
  ) {
    const result: Record<string, any> = {};
    const processedKeys = new Set<string>();

    // Process properties defined in both the schema and default value
    if (resolvedSchema?.properties) {
      for (
        const [key, propSchema] of Object.entries(resolvedSchema.properties)
      ) {
        if (key in defaultValue) {
          result[key] = processDefaultValue(
            doc,
            [...path, key],
            defaultValue[key],
            propSchema,
            log,
            rootSchema,
          );
          processedKeys.add(key);
        } else if (propSchema.asCell) {
          // asCell are always created, it's their value that can be `undefined`
          result[key] = processDefaultValue(
            doc,
            [...path, key],
            undefined,
            propSchema,
            log,
            rootSchema,
          );
        } else if (propSchema.default !== undefined) {
          result[key] = processDefaultValue(
            doc,
            [...path, key],
            propSchema.default,
            propSchema,
            log,
            rootSchema,
          );
        } else if (
          resolvedSchema?.required?.includes(key) &&
          (propSchema.type === "object" || propSchema.type === "array")
        ) {
          result[key] = processDefaultValue(
            doc,
            [...path, key],
            propSchema.type === "object" ? {} : [],
            propSchema,
            log,
            rootSchema,
          );
        }
      }
    }

    // Handle additional properties in the default value with additionalProperties schema
    if (resolvedSchema.additionalProperties) {
      const additionalPropertiesSchema =
        typeof resolvedSchema.additionalProperties === "object"
          ? resolvedSchema.additionalProperties
          : undefined;

      for (const key in defaultValue) {
        if (!processedKeys.has(key)) {
          processedKeys.add(key);
          result[key] = processDefaultValue(
            doc,
            [...path, key],
            defaultValue[key],
            additionalPropertiesSchema,
            log,
            rootSchema,
          );
        }
      }
    }

    return result;
  }

  // Handle array type defaults
  if (
    resolvedSchema?.type === "array" && Array.isArray(defaultValue) &&
    resolvedSchema.items
  ) {
    return defaultValue.map((item, i) =>
      processDefaultValue(
        doc,
        [...path, i],
        item,
        resolvedSchema.items,
        log,
        rootSchema,
      )
    );
  }

  // For primitive types, return as is
  return defaultValue;
}

function mergeDefaults(
  schema: JSONSchema | undefined,
  defaultValue: any,
): any {
  const result = { ...schema };

  // TODO(seefeld): What's the right thing to do for arrays?
  if (
    result.type === "object" &&
    typeof result.default === "object" &&
    typeof defaultValue === "object"
  ) result.default = { ...result.default, ...defaultValue };
  else result.default = defaultValue;

  return result;
}

export function validateAndTransform(
  doc: DocImpl<any>,
  path: PropertyKey[] = [],
  schema?: JSONSchema,
  log?: ReactivityLog,
  rootSchema: JSONSchema | undefined = schema,
  seen: DocLink[] = [],
): any {
  // Follow aliases, etc. to last element on path + just aliases on that last one
  // When we generate cells below, we want them to be based of this value, as that
  // is what a setter would change when they update a value or reference.
  ({ cell: doc, path } = resolvePath(doc, path, log));

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
  ) {
    // The reference should reflect the current _value_. So if it's a reference,
    // read the reference and return a cell based on it.
    //
    // But references can be paths beyond the current doc, so we create a
    // new reference based on the next doc in the chain and the remaining path.

    // Start with -1 so that the first iteration is for the empty path, i.e.
    // the top of the current doc is already a reference.
    for (let i = -1; i < path.length; i++) {
      const value = doc.getAtPath(path.slice(0, i + 1));
      if (isAlias(value)) {
        throw new Error(
          "Unexpected alias in path, should have been handled by resolvePath",
        );
      }
      if (isDocLink(value)) {
        log?.reads.push({ cell: doc, path: path.slice(0, i + 1) });
        return createCell(
          value.cell,
          [...value.path, ...path.slice(i + 1)],
          log,
          resolvedSchema,
          rootSchema,
        );
      }
    }

    return createCell(doc, path, log, resolvedSchema, rootSchema);
  }

  // If there is no schema, return as raw data via query result proxy
  if (!resolvedSchema) return doc.getAsQueryResult(path, log);

  // Now resolve further links until we get the actual value. Note that `doc`
  // and `path` will still point to the parent, as in e.g. the `anyOf` case
  // below we might still create a new Cell and it should point to the top of
  // this set of links.
  const ref = followLinks({ cell: doc, path }, [], log);
  let value = ref.cell.getAtPath(ref.path);
  log?.reads.push({ cell: ref.cell, path: ref.path });

  // Check for undefined value and return processed default if available
  if (value === undefined && resolvedSchema?.default !== undefined) {
    return processDefaultValue(
      doc,
      path,
      resolvedSchema.default,
      resolvedSchema,
      log,
      rootSchema,
    );
  }

  // TODO(seefeld): The behavior when one of the options is very permissive (e.g. no type
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
      if (arrayOptions.length === 1) {
        return validateAndTransform(
          doc,
          path,
          arrayOptions[0],
          log,
          rootSchema,
          seen,
        );
      }

      // TODO(seefeld): Handle more corner cases like empty anyOf, etc.
      const merged: JSONSchema[] = [];
      for (const option of arrayOptions) {
        if (option.items?.anyOf && Array.isArray(option.items.anyOf)) {
          merged.push(...option.items.anyOf);
        } else if (option.items) merged.push(option.items);
      }

      return validateAndTransform(
        doc,
        path,
        { type: "array", items: { anyOf: merged } },
        log,
        rootSchema,
        seen,
      );
    } else if (typeof value === "object" && value !== null) {
      let objectCandidates = options.filter((option) =>
        option.type === "object"
      );
      const numAsCells = objectCandidates.filter((option) =>
        option.asCell
      ).length;

      // If there are more than two asCell branches, merge them
      if (numAsCells > 2) {
        const asCellRemoved = objectCandidates
          .filter((option) => option.asCell)
          .map((option) =>
            (option.anyOf ?? [option]).map((branch) => {
              const {
                asCell: _filteredOut,
                ...rest
              } = branch as any;
              return rest;
            })
          )
          .flat();
        objectCandidates = objectCandidates.filter((option) => !option.asCell);
        objectCandidates.push({ anyOf: asCellRemoved });
      }

      // Run extraction for each union branch.
      const candidates = options
        .filter((option) => option.type === "object")
        .map((option) => {
          const extraLog = { reads: [], writes: [] } satisfies ReactivityLog;
          return {
            schema: option,
            result: validateAndTransform(
              doc,
              path,
              option,
              extraLog,
              rootSchema,
              seen,
            ),
            extraLog,
          };
        });

      if (candidates.length === 0) return undefined;

      // Merge all the object extractions
      let merged: Record<string, any> = {};
      const extraReads: DocLink[] = [];
      for (const { result, extraLog } of candidates) {
        if (isCell(result)) {
          log?.reads.push(...extraLog.reads);
          return result; // TODO(seefeld): Complain if it's a mix of cells and non-cells?
        } else if (typeof result === "object" && result !== null) {
          merged = { ...merged, ...result };
          extraReads.push(...extraLog.reads);
        } else {
          console.warn(
            "validateAndTransform: unexpected non-object result",
            result,
          );
        }
      }
      return merged;
    } else {
      const candidates = options
        .filter((option) =>
          (option.type === "integer" ? "number" : option.type) ===
            typeof value as string
        )
        .map((option) => ({
          schema: option,
          result: validateAndTransform(
            doc,
            path,
            option,
            log,
            rootSchema,
            seen,
          ),
        }));

      if (candidates.length === 0) return undefined;
      if (candidates.length === 1) return candidates[0].result;

      // If we get more than one candidate, see if there is one that matches anything, and if not return the first one
      const anyTypeOption = options.find((option) => option.type === undefined);
      if (anyTypeOption) {
        return validateAndTransform(
          doc,
          path,
          anyTypeOption,
          log,
          rootSchema,
          seen,
        );
      } else return candidates[0].result;
    }
  }

  if (resolvedSchema.type === "object") {
    if (typeof value !== "object" || value === null) value = {};

    const result: Record<string, any> = {};

    // Handle explicitly defined properties
    if (resolvedSchema.properties) {
      for (
        const [key, propSchema] of Object.entries(resolvedSchema.properties)
      ) {
        if (propSchema.asCell || key in value) {
          result[key] = validateAndTransform(
            doc,
            [...path, key],
            propSchema,
            log,
            rootSchema,
            seen,
          );
        } else if (propSchema.default !== undefined) {
          // Process default value for missing properties that have defaults
          result[key] = processDefaultValue(
            doc,
            [...path, key],
            propSchema.default,
            propSchema,
            log,
            rootSchema,
          );
        }
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
      validateAndTransform(
        doc,
        [...path, i],
        resolvedSchema.items!,
        log,
        rootSchema,
        seen,
      )
    );
  }

  // For primitive types, return as is
  if (value === undefined && resolvedSchema.default !== undefined) {
    return processDefaultValue(
      doc,
      path,
      resolvedSchema.default,
      resolvedSchema,
      log,
      rootSchema,
    );
  }
  return value;
}
