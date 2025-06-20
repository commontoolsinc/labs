import { isObject, isRecord, type Mutable } from "@commontools/utils/types";
import { ContextualFlowControl } from "./cfc.ts";
import { type JSONSchema, type JSONValue } from "./builder/types.ts";
import { isWriteRedirectLink } from "./link-utils.ts";
import { type DocImpl } from "./doc.ts";
import { createCell, isCell, isCellLink } from "./cell.ts";
import { type CellLink } from "./sigil-types.ts";
import { type ReactivityLog } from "./scheduler.ts";
import { resolveLinks, resolveLinkToAlias } from "./link-resolution.ts";

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
    ContextualFlowControl.isTrueSchema(schema)
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

  // Same for asStream
  if (schema.asStream && resolvedSchema?.asStream && filterAsCell) {
    resolvedSchema = { ...resolvedSchema };
    delete (resolvedSchema as any).asStream;
  }

  // Return no schema if all it said is that this was a reference or an
  // object without properties.
  if (
    resolvedSchema === undefined ||
    ContextualFlowControl.isTrueSchema(resolvedSchema)
  ) {
    return undefined;
  }

  return resolvedSchema;
}

/**
 * Process a default value from a schema, transforming it based on the schema
 * structure to account for asCell/asStream and other schema features.
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
    // If the cell itself has a default value, make it it's own (immutable)
    // doc, to emulate the behavior of .get() returning a different underlying
    // document when the value is changed. A classic example is
    // `currentlySelected` with a default of `null`.
    if (!defaultValue && resolvedSchema?.default !== undefined) {
      const newDoc = doc.runtime.documentMap.getDoc(resolvedSchema.default, {
        immutable: resolvedSchema.default,
      }, doc.space);
      newDoc.freeze("schema asCell immutable");
      return createCell(
        newDoc,
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

  if (schema.asStream) {
    console.warn(
      "Created asStream as a default value, but this is likely unintentional",
    );
    // This can receive events, but at first nothing will be bound to it.
    // Normally these get created by a handler call.
    return doc.runtime.getImmutableCell(
      doc.space,
      { $stream: true },
      resolvedSchema,
      log,
    );
  }

  // Handle object type defaults
  if (
    resolvedSchema?.type === "object" && isObject(defaultValue)
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
            defaultValue[key as keyof typeof defaultValue],
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
            defaultValue[key as keyof typeof defaultValue],
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
  defaultValue: Readonly<JSONValue>,
): JSONSchema {
  const result: Mutable<JSONSchema> = { ...(schema as Mutable<JSONSchema>) };

  // TODO(seefeld): What's the right thing to do for arrays?
  if (
    result.type === "object" &&
    isRecord(result.default) &&
    isRecord(defaultValue)
  ) {
    result.default = {
      ...result.default,
      ...defaultValue,
    } as Readonly<JSONValue>;
  } else result.default = defaultValue;

  return result;
}

export function validateAndTransform(
  doc: DocImpl<any>,
  path: PropertyKey[] = [],
  schema?: JSONSchema,
  log?: ReactivityLog,
  rootSchema: JSONSchema | undefined = schema,
  seen: Array<
    {
      cell: DocImpl<any>;
      path: PropertyKey[];
      schema?: JSONSchema;
      rootSchema?: JSONSchema;
      value: any;
    }
  > = [],
): any {
  let resolvedSchema = resolveSchema(schema, rootSchema, true);

  // Follow aliases, etc. to last element on path + just aliases on that last one
  // When we generate cells below, we want them to be based off this value, as that
  // is what a setter would change when they update a value or reference.
  const resolvedRef = resolveLinkToAlias(
    doc,
    path,
    log,
    resolvedSchema,
    rootSchema,
  );
  doc = resolvedRef.cell;
  path = resolvedRef.path;

  // Use schema from alias if provided and no explicit schema was set
  if (!resolvedSchema && resolvedRef.schema) {
    resolvedSchema = resolvedRef.schema;
    rootSchema = resolvedRef.rootSchema || resolvedRef.schema;
  }

  // Check if we've seen this exact cell/path/schema combination before
  const seenEntry = seen.find(
    (entry) =>
      JSON.stringify(entry.cell) === JSON.stringify(doc) &&
      entry.path.length === path.length &&
      entry.path.every((p, i) => p === path[i]) &&
      JSON.stringify(entry.schema) === JSON.stringify(resolvedSchema) &&
      JSON.stringify(entry.rootSchema) === JSON.stringify(rootSchema),
  );
  if (seenEntry) {
    return seenEntry.value;
  }

  // If this should be a reference, return as a Cell of resolvedSchema
  // NOTE: Need to check on the passed schema whether it's a reference, not the
  // resolved schema. The returned reference is of type resolvedSchema though.
  // anyOf gets handled here if all options are cells, so we don't read the
  // data. Below we handle the case where some options are meant to be cells.
  if (
    isRecord(schema) &&
    ((schema!.asCell || schema!.asStream) ||
      (Array.isArray(resolvedSchema?.anyOf) &&
        resolvedSchema.anyOf.every((
          option,
        ) => (option.asCell || option.asStream))))
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
      if (isWriteRedirectLink(value)) {
        throw new Error(
          "Unexpected write redirect in path, should have been handled by resolvePath",
        );
      }
      if (isCellLink(value)) {
        log?.reads.push({ cell: doc, path: path.slice(0, i + 1) });
        const extraPath = [...path.slice(i + 1)];
        const newPath = [...value.path, ...extraPath];
        const cfc = doc.runtime.cfc;
        let newSchema;
        if (value.schema !== undefined) {
          newSchema = cfc.getSchemaAtPath(
            value.schema,
            extraPath.map((key) => key.toString()),
            rootSchema,
          );
        } else if (i === path.length - 1) {
          // we don't have a schema provided directly for this cell link,
          // but we can apply the one from our parent, since we are at
          // the end of the path.
          newSchema = cfc.getSchemaAtPath(resolvedSchema, []);
        }
        return createCell(
          value.cell,
          newPath,
          log,
          newSchema,
          rootSchema,
        );
      }
    }
    return createCell(doc, path, log, resolvedSchema, rootSchema);
  }

  // If there is no schema, return as raw data via query result proxy
  if (resolvedSchema === undefined) {
    return doc.getAsQueryResult(path, log);
  }

  // Now resolve further links until we get the actual value. Note that `doc`
  // and `path` will still point to the parent, as in e.g. the `anyOf` case
  // below we might still create a new Cell and it should point to the top of
  // this set of links.
  const ref = resolveLinks({
    cell: doc,
    path,
    schema: resolvedSchema,
    rootSchema,
  }, log);
  let value = ref.cell.getAtPath(ref.path);
  log?.reads.push({ ...ref });

  // Check for undefined value and return processed default if available
  if (value === undefined && resolvedSchema?.default !== undefined) {
    const result = processDefaultValue(
      doc,
      path,
      resolvedSchema.default,
      resolvedSchema,
      log,
      rootSchema,
    );
    seen.push({
      cell: doc,
      path,
      schema: resolvedSchema,
      rootSchema,
      value: result,
    });
    return result;
  }

  // TODO(seefeld): The behavior when one of the options is very permissive (e.g. no type
  // or an object that allows any props) is not well defined.
  if (Array.isArray(resolvedSchema.anyOf)) {
    const options = resolvedSchema.anyOf
      .map((option) => {
        const resolved = resolveSchema(option, rootSchema);
        // Copy `asCell` over, necessary for $ref case.
        if (option.asCell) return { ...resolved, asCell: true };
        if (option.asStream) return { ...resolved, asStream: true };
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
    } else if (isRecord(value)) {
      let objectCandidates = options.filter((option) =>
        option.type === "object"
      );
      const numAsCells = objectCandidates.filter((option) =>
        option.asCell || option.asStream
      ).length;

      // If there are more than two asCell branches, merge them
      if (numAsCells > 2) {
        const asCellRemoved = objectCandidates
          .filter((option) => option.asCell)
          .map((option) =>
            (option.anyOf ?? [option]).map((branch) => {
              const {
                asCell: _filteredOut,
                asStream: _filteredOut2,
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
          const candidateSeen = [...seen];
          return {
            schema: option,
            result: validateAndTransform(
              doc,
              path,
              option,
              extraLog,
              rootSchema,
              candidateSeen,
            ),
            extraLog,
          };
        });

      if (candidates.length === 0) {
        seen.push({
          cell: doc,
          path,
          schema: resolvedSchema,
          rootSchema,
          value: undefined,
        });
        return undefined;
      }

      // Merge all the object extractions
      let merged: Record<string, any> = {};
      const extraReads: CellLink[] = [];
      for (const { result, extraLog } of candidates) {
        if (isCell(result)) {
          merged = result;
          break; // TODO(seefeld): Complain if it's a mix of cells and non-cells?
        } else if (isRecord(result)) {
          merged = { ...merged, ...result };
          extraReads.push(...extraLog.reads);
        } else {
          console.warn(
            "validateAndTransform: unexpected non-object result",
            result,
          );
        }
      }
      log?.reads.push(...extraReads);
      seen.push({
        cell: doc,
        path,
        schema: resolvedSchema,
        rootSchema,
        value: merged,
      });
      return merged;
    } else {
      // For primitive types, try each option that matches the type
      const candidates = options
        .filter((option) =>
          (option.type === "integer" ? "number" : option.type) ===
            typeof value as string
        )
        .map((option) => {
          // Create a new seen array for each candidate to avoid false positives
          const candidateSeen = [...seen];
          return {
            schema: option,
            result: validateAndTransform(
              doc,
              path,
              option,
              log,
              rootSchema,
              candidateSeen,
            ),
          };
        });

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
    if (!isRecord(value)) value = {};

    const result: Record<string, any> = {};
    // Add to seen before processing children to handle self-referential structures
    seen.push({
      cell: doc,
      path,
      schema: resolvedSchema,
      rootSchema,
      value: result,
    });

    // Handle explicitly defined properties
    const cfc = new ContextualFlowControl();
    if (resolvedSchema.properties) {
      for (const key of Object.keys(resolvedSchema.properties)) {
        const childSchema = cfc.getSchemaAtPath(
          resolvedSchema,
          [key],
          rootSchema,
        );
        if (childSchema === undefined) {
          continue;
        }
        if (childSchema.asCell || childSchema.asStream || key in value) {
          result[key] = validateAndTransform(
            doc,
            [...path, key],
            childSchema,
            log,
            rootSchema,
            seen,
          );
        } else if (childSchema.default !== undefined) {
          // Process default value for missing properties that have defaults
          result[key] = processDefaultValue(
            doc,
            [...path, key],
            childSchema.default,
            childSchema,
            log,
            rootSchema,
          );
        }
      }
    }

    // Handle additional properties if defined
    const keys = Object.keys(value);
    for (const key of keys) {
      if (!resolvedSchema.properties || !(key in resolvedSchema.properties)) {
        const childSchema = cfc.getSchemaAtPath(
          resolvedSchema,
          [key],
          rootSchema,
        );
        if (childSchema === undefined) {
          continue;
        }
        result[key] = validateAndTransform(
          doc,
          [...path, key],
          childSchema,
          log,
          rootSchema,
          seen,
        );
      }
    }

    return result;
  }

  if (resolvedSchema.type === "array" && resolvedSchema.items) {
    if (!Array.isArray(value)) {
      const result: any[] = [];
      seen.push({
        cell: doc,
        path,
        schema: resolvedSchema,
        rootSchema,
        value: result,
      });
      return result;
    }
    const result: any[] = [];
    seen.push({
      cell: doc,
      path,
      schema: resolvedSchema,
      rootSchema,
      value: result,
    });
    // Now process elements after adding the array to seen
    for (let i = 0; i < value.length; i++) {
      result[i] = validateAndTransform(
        doc,
        [...path, i],
        resolvedSchema.items!,
        log,
        rootSchema,
        seen,
      );
    }
    return result;
  }

  // For primitive types, return as is
  if (value === undefined && resolvedSchema.default !== undefined) {
    const result = processDefaultValue(
      doc,
      path,
      resolvedSchema.default,
      resolvedSchema,
      log,
      rootSchema,
    );
    seen.push({
      cell: doc,
      path,
      schema: resolvedSchema,
      rootSchema,
      value: result,
    });
    return result;
  }

  // Add the current value to seen before returning
  seen.push({ cell: doc, path, schema: resolvedSchema, rootSchema, value });
  return value;
}
