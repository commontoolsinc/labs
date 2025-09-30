import { JSONSchemaObj } from "@commontools/api";
import { getLogger } from "@commontools/utils/logger";
import { isObject, isRecord } from "@commontools/utils/types";
import { JSONSchemaMutable } from "@commontools/runner";
import { ContextualFlowControl } from "./cfc.ts";
import { type JSONSchema, type JSONValue } from "./builder/types.ts";
import { createCell, isCell, isStream } from "./cell.ts";
import { readMaybeLink, resolveLink } from "./link-resolution.ts";
import { type IExtendedStorageTransaction } from "./storage/interface.ts";
import { type IRuntime } from "./runtime.ts";
import { type NormalizedFullLink } from "./link-utils.ts";
import { type IMemorySpaceAddress } from "./storage/interface.ts";
import {
  createQueryResultProxy,
  isQueryResultForDereferencing,
  makeOpaqueRef,
} from "./query-result-proxy.ts";
import { toCell, toOpaqueRef } from "./back-to-cell.ts";

const logger = getLogger("validateAndTransform", {
  enabled: true,
  level: "debug",
});

/**
 * Schemas are mostly a subset of JSONSchema.
 *
 * One addition is `asCell`. When true, the `.get()` returns an instance of
 * `Cell`, i.e. a reactive reference to the value underneath. Some implications
 * this has:
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

  let resolvedSchema = schema;
  let refSiteDefault: JSONValue | undefined = undefined;
  let refSiteAsCell = false;
  let refSiteAsStream = false;

  if (typeof schema.$ref === "string" && rootSchema !== undefined) {
    // Capture ref site siblings BEFORE resolution (for precedence)
    if (isObject(schema)) {
      if ("default" in schema) {
        refSiteDefault = schema.default;
      }
      if (schema.asCell) {
        refSiteAsCell = true;
      }
      if (schema.asStream) {
        refSiteAsStream = true;
      }
    }

    const resolved = ContextualFlowControl.resolveSchemaRef(
      rootSchema,
      schema.$ref,
    );
    if (!isObject(resolved)) {
      // For boolean true schema, convert to object if ref site has siblings
      if (
        resolved === true &&
        (refSiteDefault !== undefined || refSiteAsCell || refSiteAsStream)
      ) {
        const result: any = {};
        if (refSiteDefault !== undefined) result.default = refSiteDefault;
        if (refSiteAsCell) result.asCell = true;
        if (refSiteAsStream) result.asStream = true;
        return result;
      }
      // For boolean false schema or the default `{}` schema, we don't have any
      // meaningful information in the schema, so just return undefined.
      return undefined;
    }
    resolvedSchema = resolved;

    // Apply ref site siblings (override target per JSON Schema spec)
    if (refSiteDefault !== undefined || refSiteAsCell || refSiteAsStream) {
      const updates: any = {};
      if (refSiteDefault !== undefined) {
        updates.default = refSiteDefault;
      }
      if (refSiteAsCell) {
        updates.asCell = true;
      }
      if (refSiteAsStream) {
        updates.asStream = true;
      }
      resolvedSchema = { ...resolvedSchema, ...updates };
    }
  }

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
  runtime: IRuntime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  defaultValue: any,
): any {
  const schema = link.schema;
  const rootSchema = link.rootSchema ?? schema;
  if (!schema) return defaultValue;

  const resolvedSchema = resolveSchema(schema, rootSchema, true);

  // If schema indicates this should be a cell
  if (isObject(schema) && schema.asCell) {
    // If the cell itself has a default value, make it its own (immutable)
    // doc, to emulate the behavior of .get() returning a different underlying
    // document when the value is changed. A classic example is
    // `currentlySelected` with a default of `null`.
    if (
      !defaultValue && isObject(resolvedSchema) &&
      resolvedSchema.default !== undefined
    ) {
      return runtime.getImmutableCell(
        link.space,
        resolvedSchema.default,
        resolvedSchema,
        tx,
      );
    } else {
      return createCell(
        runtime,
        {
          ...link,
          schema: mergeDefaults(resolvedSchema, defaultValue),
          rootSchema,
        },
        tx,
      );
    }
  }

  if (isObject(schema) && schema.asStream) {
    console.warn(
      "Created asStream as a default value, but this is likely unintentional",
    );
    // This can receive events, but at first nothing will be bound to it.
    // Normally these get created by a handler call.
    return runtime.getImmutableCell(
      link.space,
      { $stream: true },
      resolvedSchema,
      tx,
    );
  }

  // Handle object type defaults
  if (
    isObject(resolvedSchema) && resolvedSchema?.type === "object" &&
    isObject(defaultValue)
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
            runtime,
            tx,
            { ...link, schema: propSchema, path: [...link.path, key] },
            defaultValue[key as keyof typeof defaultValue],
          );
          processedKeys.add(key);
        } else if (isObject(propSchema)) {
          if (propSchema.asCell) {
            // asCell are always created, it's their value that can be `undefined`
            result[key] = processDefaultValue(
              runtime,
              tx,
              { ...link, schema: propSchema, path: [...link.path, key] },
              undefined,
            );
          } else if (propSchema.default !== undefined) {
            result[key] = processDefaultValue(
              runtime,
              tx,
              { ...link, schema: propSchema, path: [...link.path, key] },
              propSchema.default,
            );
          } else if (
            resolvedSchema?.required?.includes(key) &&
            (propSchema.type === "object" || propSchema.type === "array")
          ) {
            result[key] = processDefaultValue(
              runtime,
              tx,
              { ...link, schema: propSchema, path: [...link.path, key] },
              propSchema.type === "object" ? {} : [],
            );
          }
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
            runtime,
            tx,
            {
              ...link,
              schema: additionalPropertiesSchema,
              path: [...link.path, key],
            },
            defaultValue[key as keyof typeof defaultValue],
          );
        }
      }
    }

    return annotateWithBackToCellSymbols(result, runtime, link, tx);
  }

  // Handle array type defaults
  if (
    isObject(resolvedSchema) && resolvedSchema?.type === "array" &&
    Array.isArray(defaultValue) &&
    resolvedSchema.items
  ) {
    // Handle boolean items values
    let itemSchema: JSONSchema;
    if (resolvedSchema.items === true) {
      // items: true means allow any item type
      itemSchema = {};
    } else if ((resolvedSchema.items as any) === false) {
      // items: false means no additional items allowed (empty arrays only)
      // For default value processing, we'll treat this as an error
      throw new Error(
        "Cannot process default values for array with items: false - no items are allowed",
      );
    } else {
      // items is a JSONSchema object
      itemSchema = resolvedSchema.items as JSONSchema;
    }

    const result = defaultValue.map((item, i) =>
      processDefaultValue(
        runtime,
        tx,
        {
          ...link,
          schema: itemSchema,
          path: [...link.path, String(i)],
        },
        item,
      )
    );
    return annotateWithBackToCellSymbols(result, runtime, link, tx);
  }

  // For primitive types, return as is
  return annotateWithBackToCellSymbols(defaultValue, runtime, link, tx);
}

function mergeDefaults(
  schema: JSONSchema | undefined,
  defaultValue: Readonly<JSONValue>,
): JSONSchema {
  const result: JSONSchemaMutable = {
    ...(isObject(schema) ? structuredClone(schema) as JSONSchemaMutable : {}),
  };

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

function annotateWithBackToCellSymbols(
  value: any,
  runtime: IRuntime,
  link: NormalizedFullLink,
  tx: IExtendedStorageTransaction | undefined,
) {
  if (
    isRecord(value) && !isCell(value) && !isStream(value) &&
    !isQueryResultForDereferencing(value)
  ) {
    value[toCell] = () => createCell(runtime, link, tx);
    value[toOpaqueRef] = () => makeOpaqueRef(link);
    Object.freeze(value);
  }
  return value;
}

export function validateAndTransform(
  runtime: IRuntime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  synced: boolean = false,
  seen: Array<[string, any]> = [],
): any {
  // If the transaction is no longer open, just treat it as no transaction, i.e.
  // create temporary transactions to read. The main reason we use transactions
  // here is so that this operation can see open reads, that are only accessible
  // from the tx. Once tx.commit() is called, all that data is either available
  // via other transactions or has been rolled back. Either way, we want to
  // reflect that reality.
  if (tx?.status().status !== "ready") tx = undefined;

  // Reconstruct doc, path, schema, rootSchema from link and runtime
  const schema = link.schema;
  let rootSchema = link.rootSchema ?? schema;
  let resolvedSchema = resolveSchema(schema, rootSchema, true);

  // Follow aliases, etc. to last element on path + just aliases on that last one
  // When we generate cells below, we want them to be based off this value, as that
  // is what a setter would change when they update a value or reference.
  const resolvedLink = resolveLink(tx ?? runtime.edit(), link, "writeRedirect");

  // Use schema from alias if provided and no explicit schema was set
  if (resolvedSchema === undefined && resolvedLink.schema) {
    // Call resolveSchema to strip asCell/asStream here as well. It's still the
    // initial `schema` that says whether this should be a cell, not the
    // resolved schema.
    resolvedSchema = resolveSchema(
      resolvedLink.schema,
      resolvedLink.rootSchema,
      true,
    );
    rootSchema = resolvedLink.rootSchema || resolvedLink.schema;
  }

  link = {
    ...resolvedLink,
    schema: resolvedSchema,
    rootSchema,
  };

  // Check if we've seen this exact cell/path/schema combination before
  const seenKey = JSON.stringify(link);
  const seenEntry = seen.find((entry) => entry[0] === seenKey);
  if (seenEntry) {
    return seenEntry[1];
  }

  // If this should be a reference, return as a Cell of resolvedSchema
  // NOTE: Need to check on the passed schema whether it's a reference, not the
  // resolved schema. The returned reference is of type resolvedSchema though.
  // anyOf gets handled here if all options are cells, so we don't read the
  // data. Below we handle the case where some options are meant to be cells.
  if (
    isObject(schema) &&
    ((schema.asCell || schema.asStream) ||
      (isObject(resolvedSchema) && (
        (Array.isArray(resolvedSchema?.anyOf) &&
          resolvedSchema.anyOf.every((
            option,
          ) => (option.asCell || option.asStream))) ||
        (Array.isArray(resolvedSchema?.oneOf) &&
          resolvedSchema.oneOf.every((
            option,
          ) => (option.asCell || option.asStream)))
      )))
  ) {
    // The reference should reflect the current _value_. So if it's a reference,
    // read the reference and return a cell based on it.
    //
    // But references can be paths beyond the current doc, so we create a
    // new reference based on the next doc in the chain and the remaining path.

    // Start with empty path, iterate to full path (hence <= and not <)
    for (let i = 0; i <= link.path.length; i++) {
      const parsedLink = readMaybeLink(
        tx ?? runtime.edit(),
        {
          ...link,
          path: link.path.slice(0, i),
        },
      );

      if (parsedLink?.overwrite === "redirect") {
        throw new Error(
          "Unexpected write redirect in path, should have been handled by resolvePath",
        );
      }
      if (parsedLink) {
        const extraPath = [...link.path.slice(i)];
        const newPath = [...parsedLink.path, ...extraPath];
        const cfc = runtime.cfc;
        let newSchema;
        if (parsedLink.schema !== undefined) {
          newSchema = cfc.getSchemaAtPath(
            parsedLink.schema,
            extraPath.map((key) => key.toString()),
            rootSchema,
          );
        } else if (i === link.path.length) {
          // we don't have a schema provided directly for this cell link,
          // but we can apply the one from our parent, since we are at
          // the end of the path.
          newSchema = cfc.getSchemaAtPath(resolvedSchema, []);
        }
        return createCell(
          runtime,
          {
            ...parsedLink,
            path: newPath,
            schema: newSchema,
            rootSchema,
          },
          tx,
        );
      }
    }
    return createCell(runtime, link, tx);
  }

  // If there is no schema, return as raw data via query result proxy
  if (resolvedSchema === undefined) {
    return createQueryResultProxy(runtime, tx, link);
  }

  // Now resolve further links until we get the actual value. Note that `doc`
  // and `path` will still point to the parent, as in e.g. the `anyOf` case
  // below we might still create a new Cell and it should point to the top of
  // this set of links.
  const ref = resolveLink(tx ?? runtime.edit(), link);
  const value = (tx ?? runtime.edit()).readValueOrThrow(ref);

  // Check for undefined value and return processed default if available
  if (
    value === undefined && isObject(resolvedSchema) &&
    resolvedSchema.default !== undefined
  ) {
    const result = processDefaultValue(
      runtime,
      tx,
      { ...link, schema: resolvedSchema },
      resolvedSchema.default,
    );
    seen.push([seenKey, result]);
    return result; // processDefaultValue already annotates with back to cell
  }

  // TODO(seefeld): The behavior when one of the options is very permissive (e.g. no type
  // or an object that allows any props) is not well defined.
  if (
    isObject(resolvedSchema) &&
    (Array.isArray(resolvedSchema.anyOf) || Array.isArray(resolvedSchema.oneOf))
  ) {
    const options = ((resolvedSchema.anyOf ?? resolvedSchema.oneOf)!)
      .map((option) => {
        const resolved = resolveSchema(option, rootSchema);
        // Copy `asCell` and `asStream` over, necessary for $ref case.
        if (isObject(option) && (option.asCell || option.asStream)) {
          return {
            ...ContextualFlowControl.toSchemaObj(resolved),
            ...(option.asCell ? { asCell: true } : {}),
            ...(option.asStream ? { asStream: true } : {}),
          };
        }
        return resolved;
      })
      .filter((option) => option !== undefined);

    // TODO(@ubik2): We should support boolean and empty entries in the anyOf
    const objOptions: JSONSchemaObj[] = options.filter(isObject);
    if (Array.isArray(value)) {
      const arrayOptions = objOptions.filter((option) =>
        option.type === "array"
      );
      if (arrayOptions.length === 0) return undefined;
      if (arrayOptions.length === 1) {
        return validateAndTransform(
          runtime,
          tx,
          { ...link, schema: arrayOptions[0] },
          synced,
          seen,
        );
      }

      // TODO(seefeld): Handle more corner cases like empty anyOf, etc.
      const merged: JSONSchema[] = [];
      for (const option of arrayOptions) {
        if (
          isObject(option.items) && (
            (option.items?.anyOf && Array.isArray(option.items.anyOf)) ||
            (option.items?.oneOf && Array.isArray(option.items.oneOf))
          )
        ) {
          merged.push(
            ...((option.items.anyOf ?? option.items.oneOf)!),
          );
        } else if (option.items) merged.push(option.items);
      }
      return validateAndTransform(
        runtime,
        tx,
        { ...link, schema: { type: "array", items: { anyOf: merged } } },
        synced,
        seen,
      );
    } else if (isObject(value)) {
      let objectCandidates = objOptions.filter((option) =>
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
            (option.anyOf ?? option.oneOf ?? [option]).map((branch) => {
              const { asCell: _filteredOut, asStream: _filteredOut2, ...rest } =
                branch as any;
              return rest;
            })
          )
          .flat();
        objectCandidates = objectCandidates.filter((option) => !option.asCell);
        objectCandidates.push({ anyOf: asCellRemoved });
      }

      // Run extraction for each union branch.
      const candidates = objOptions
        .filter((option) => option.type === "object")
        .map((option) => {
          const candidateSeen = [...seen];
          return {
            schema: option,
            result: validateAndTransform(
              runtime,
              tx,
              { ...link, schema: option },
              synced,
              candidateSeen,
            ),
          };
        });
      if (candidates.length === 0) {
        seen.push([seenKey, undefined]);
        return undefined;
      }

      // Merge all the object extractions
      let merged: Record<string, any> = {};
      const extraReads: IMemorySpaceAddress[] = [];
      for (const { result } of candidates) {
        if (isCell(result)) {
          merged = result;
          break; // TODO(seefeld): Complain if it's a mix of cells and non-cells?
        } else if (isRecord(result)) {
          merged = { ...merged, ...result };
        } else {
          console.warn(
            "validateAndTransform: unexpected non-object result",
            result,
          );
        }
      }
      seen.push([seenKey, merged]);
      return annotateWithBackToCellSymbols(merged, runtime, link, tx);
    } else {
      // For primitive types, try each option that matches the type
      const candidates = objOptions
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
              runtime,
              tx,
              { ...link, schema: option },
              synced,
              candidateSeen,
            ),
          };
        });
      if (candidates.length === 0) return undefined;
      if (candidates.length === 1) return candidates[0].result;

      // If we get more than one candidate, see if there is one that matches anything, and if not return the first one
      const anyTypeOption = objOptions.find((option) =>
        option.type === undefined
      );
      if (anyTypeOption) {
        return validateAndTransform(
          runtime,
          tx,
          { ...link, schema: anyTypeOption },
          synced,
          seen,
        );
      } else {
        return annotateWithBackToCellSymbols(
          candidates[0].result,
          runtime,
          link,
          tx,
        );
      }
    }
  }

  if (isObject(resolvedSchema) && resolvedSchema.type === "object") {
    const keys = isRecord(value) ? Object.keys(value) : [];

    const result: Record<string, any> = {};

    // Add to seen before processing children to handle self-referential structures
    seen.push([seenKey, result]);

    // Handle explicitly defined properties
    if (resolvedSchema.properties) {
      for (const key of Object.keys(resolvedSchema.properties)) {
        const childSchema = runtime.cfc.getSchemaAtPath(
          resolvedSchema,
          [key],
          rootSchema,
        );
        if (childSchema === undefined) {
          continue;
        }
        if (
          (keys.includes(key) ||
            (isObject(childSchema) &&
              (childSchema.asCell || childSchema.asStream))) &&
          (isRecord(value) ||
            (isObject(childSchema) && childSchema.default !== undefined))
        ) {
          result[key] = validateAndTransform(
            runtime,
            tx,
            { ...link, path: [...link.path, key], schema: childSchema },
            synced,
            seen,
          );
        } else if (isObject(childSchema) && childSchema.default !== undefined) {
          // Process default value for missing properties that have defaults
          result[key] = processDefaultValue(
            runtime,
            tx,
            { ...link, path: [...link.path, key], schema: childSchema },
            childSchema.default,
          );
        }
      }
    }

    // Handle additional properties if defined
    if (resolvedSchema.additionalProperties || !resolvedSchema.properties) {
      for (const key of keys) {
        // Skip properties that were already processed above:
        if (!resolvedSchema.properties || !(key in resolvedSchema.properties)) {
          // Will use additionalProperties if present
          const childSchema = runtime.cfc.getSchemaAtPath(
            resolvedSchema,
            [key],
            rootSchema,
          );
          if (childSchema === undefined) {
            // This should never happen
            logger.warn(() => [
              "validateAndTransform: unexpected undefined schema for additional property",
              key,
              resolvedSchema,
              rootSchema,
              link,
            ]);
            continue;
          }
          result[key] = validateAndTransform(
            runtime,
            tx,
            { ...link, path: [...link.path, key], schema: childSchema },
            synced,
            seen,
          );
        }
      }
    }

    if (!isRecord(value) && Object.keys(result).length === 0) {
      return undefined;
    }
    return annotateWithBackToCellSymbols(result, runtime, link, tx);
  }

  if (isObject(resolvedSchema) && resolvedSchema.type === "array") {
    if (!Array.isArray(value)) {
      const result: any[] = [];
      seen.push([seenKey, result]);
      return annotateWithBackToCellSymbols(result, runtime, link, tx);
    }
    const result: any[] = [];
    seen.push([seenKey, result]);

    // Now process elements after adding the array to seen
    for (let i = 0; i < value.length; i++) {
      // If the element on the array is a link, we follow that link so the
      // returned object is the current item at that location (otherwise the
      // link would refer to "Nth element"). This is important when turning
      // returned objects back into cells: We want to then refer to the actual
      // object by default, not the array location.
      //
      // This makes
      // ```ts
      // const array = [...cell.get()];
      // array.splice(index, 1);
      // cell.set(array);
      // ```
      // work as expected.
      // Handle boolean items values for element schema
      let elementSchema: JSONSchema;
      if (resolvedSchema.items === true) {
        // items: true means allow any item type
        elementSchema = {};
      } else if (resolvedSchema.items === false) {
        // items: false means no additional items allowed
        // This should technically be an error, but for compatibility we'll use empty schema
        elementSchema = {};
      } else if (resolvedSchema.items) {
        // items is a JSONSchema object
        elementSchema = resolvedSchema.items;
      } else {
        // No items schema specified, default to empty schema
        elementSchema = {};
      }

      let elementLink: NormalizedFullLink = {
        ...link,
        path: [...link.path, String(i)],
        schema: elementSchema,
      };
      const maybeLink = readMaybeLink(tx ?? runtime.edit(), elementLink);
      if (maybeLink) {
        elementLink = {
          ...maybeLink,
          schema: elementLink.schema,
          rootSchema: elementLink.rootSchema,
        };
      }

      result[i] = validateAndTransform(
        runtime,
        tx,
        elementLink,
        synced,
        seen,
      );
    }
    return annotateWithBackToCellSymbols(result, runtime, link, tx);
  }

  // For primitive types, return as is
  if (
    value === undefined && isObject(resolvedSchema) &&
    resolvedSchema.default !== undefined
  ) {
    const result = processDefaultValue(
      runtime,
      tx,
      { ...link, schema: resolvedSchema },
      resolvedSchema.default,
    );
    seen.push([seenKey, result]);
    return result; // processDefaultValue already annotates with back to cell
  }

  // Add the current value to seen before returning
  seen.push([seenKey, value]);
  return annotateWithBackToCellSymbols(value, runtime, link, tx);
}

/**
 * This assumes that there will not be a conflict in definitions between the
 * eventSchema and the stateSchema.
 */
// TODO(@ubik2): We also need to re-write any relative refs
export function generateHandlerSchema(
  eventSchema?: JSONSchema,
  stateSchema?: JSONSchema,
): JSONSchema | undefined {
  if (eventSchema === undefined && stateSchema === undefined) {
    return undefined;
  }
  const mergedDefs: Record<string, JSONSchema> = {};
  const mergedDefinitions: Record<string, JSONSchema> = {};
  if (isObject(eventSchema)) {
    // extract $defs and definitions and remove them from eventSchema
    const { $defs, definitions, ...rest } = eventSchema;
    eventSchema = rest;
    Object.assign(mergedDefs, $defs);
    Object.assign(mergedDefinitions, definitions);
  }
  if (isObject(stateSchema)) {
    // extract $defs and definitions and remove them from stateSchema
    const { $defs, definitions, ...rest } = stateSchema;
    stateSchema = rest;
    Object.assign(mergedDefs, $defs);
    Object.assign(mergedDefinitions, definitions);
  }
  // TODO(@ubik2): Defaults here should be true, but I haven't changed the JSONSchema type
  // to allow that yet
  return {
    type: "object",
    properties: {
      "$event": eventSchema ?? true,
      "$ctx": stateSchema ?? true,
    },
    ...(Object.keys(mergedDefs).length ? { $defs: mergedDefs } : {}),
    ...(Object.keys(mergedDefinitions).length
      ? { definitions: mergedDefinitions }
      : {}),
  };
}
