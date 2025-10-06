import { getLogger } from "@commontools/utils/logger";
import { isBoolean, isObject, isRecord } from "@commontools/utils/types";
import { JSONSchemaMutable } from "@commontools/runner";
import { ContextualFlowControl } from "./cfc.ts";
import { type JSONSchema, type JSONValue } from "./builder/types.ts";
import { createCell, isCell, isStream } from "./cell.ts";
import { createAllOf, readMaybeLink, resolveLink } from "./link-resolution.ts";
import { type IExtendedStorageTransaction } from "./storage/interface.ts";
import { type IRuntime } from "./runtime.ts";
import { type NormalizedFullLink } from "./link-utils.ts";
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
  if (typeof schema === "boolean" || schema === undefined || schema === null) {
    return schema;
  } else if (!isObject(schema)) {
    return undefined;
  }

  let finalSchema = schema;
  if (typeof schema.$ref === "string" && rootSchema !== undefined) {
    const resolved = ContextualFlowControl.resolveSchemaRefs(
      rootSchema,
      schema,
    );
    if (!isObject(resolved)) {
      // Return boolean or undefined if the schema is not an object
      return typeof schema === "boolean" ? schema : undefined;
    }
    finalSchema = resolved;
  }

  // Remove asCell flag from schema, so it's describing the destination
  // schema. That means we can't describe a schema that points to top-level
  // references, but that's on purpose.
  if (schema.asCell && finalSchema?.asCell && filterAsCell) {
    finalSchema = { ...finalSchema };
    delete (finalSchema as any).asCell;
  }

  // Same for asStream
  if (schema.asStream && finalSchema?.asStream && filterAsCell) {
    finalSchema = { ...finalSchema };
    delete (finalSchema as any).asStream;
  }

  return finalSchema;
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

  // Follow aliases, etc. to last element on path + just aliases on that last one
  // When we generate cells below, we want them to be based off this value, as that
  // is what a setter would change when they update a value or reference.
  const resolvedLink = resolveLink(tx ?? runtime.edit(), link, "writeRedirect");

  const postRedirectSchema = resolveSchema(
    resolvedLink.schema,
    resolvedLink.rootSchema,
  );

  // If this should be a reference, return as a Cell of finalSchema
  // NOTE: Need to check on the passed schema whether it's a reference, not the
  // resolved schema. The returned reference is of type finalSchema though.
  // anyOf gets handled here if all options are cells, so we don't read the
  // data. Below we handle the case where some options are meant to be cells.
  if (
    isObject(postRedirectSchema) &&
    (postRedirectSchema.asCell || postRedirectSchema.asStream)
  ) {
    // The reference should reflect the current _value_. So if it's a link, read
    // the link and return a cell based on it.
    //
    // resolveLink above made sure that the value at the path is either the
    // current value or a link.

    // See if the current value is a link:
    const parsedLink = readMaybeLink(tx ?? runtime.edit(), resolvedLink);

    if (parsedLink?.overwrite === "redirect") {
      throw new Error(
        "Unexpected write redirect in path, should have been handled by resolvePath",
      );
    }

    // Then use either the link or otherwise the resolved link (the value)
    const link = parsedLink ?? resolvedLink;

    // Remove asCell and asStream from the link schema
    const linkSchema = resolveSchema(link.schema, link.rootSchema, true);

    return createCell(runtime, {
      ...link,
      schema: linkSchema,
    }, tx);
  }

  // Now resolve further links until we get the actual value. Note that `doc`
  // and `path` will still point to the parent, as in e.g. the `anyOf` case
  // below we might still create a new Cell and it should point to the top of
  // this set of links.
  const ref = resolveLink(tx ?? runtime.edit(), link);

  // Reconstruct doc, path, schema, rootSchema from link and runtime
  let schema = resolveSchema(ref.schema, ref.rootSchema);
  const rootSchema = ref.rootSchema ?? schema;

  // Return undefined if the schema is false, i.e. nothing matches
  if (schema === false) return undefined;

  // If there is no schema, or the schema is `any`, create a query result proxy
  // so we don't crawl everything.
  if (
    schema === undefined || !isObject(schema) ||
    ContextualFlowControl.isTrueSchema(schema)
  ) {
    return createQueryResultProxy(runtime, tx, ref);
  }

  // Check if we've seen this exact cell/path/schema combination before
  const seenKey = JSON.stringify(ref);
  const seenEntry = seen.find((entry) => entry[0] === seenKey);
  if (seenEntry) return seenEntry[1];

  const value = (tx ?? runtime.edit()).readValueOrThrow(ref);

  // Check for undefined value and return processed default if available
  if (
    value === undefined &&
    schema.default !== undefined
  ) {
    const result = processDefaultValue(
      runtime,
      tx,
      { ...ref, schema },
      schema.default,
    );
    seen.push([seenKey, result]);
    return result; // processDefaultValue already annotates with back to cell
  }

  // Handle allOf - must satisfy ALL schemas (intersection)
  if (Array.isArray(schema.allOf)) {
    let allBranches: JSONSchema[] = [];

    let parentDefault = schema.default;
    let parentAsCell = schema.asCell;
    let parentAsStream = schema.asStream;

    const stack = schema.allOf.filter((b) => b !== undefined);

    while (stack.length > 0) {
      const candidate = resolveSchema(stack.pop()!, rootSchema);

      // If any subschema is invalid, the whole allOf is invalid
      if (candidate === undefined) return undefined;

      // If the subschema is an allOf, we need to merge it with the parent
      if (isObject(candidate) && Array.isArray(candidate.allOf)) {
        if (!parentDefault && candidate.default) {
          parentDefault = candidate.default;
        }
        if (!parentAsCell && !parentAsStream) {
          if (candidate.asCell) parentAsCell = true;
          if (candidate.asStream) parentAsStream = true;
        }
        for (let i = candidate.allOf.length - 1; i >= 0; i--) {
          stack.push(candidate.allOf[i]);
        }
      } else {
        // Otherwise, it's a regular schema, so we can add it to the branches
        allBranches.push(candidate);
      }
    }

    allBranches.reverse();

    // Empty allOf or any false branches means nothing will match
    if (allBranches.length === 0 || allBranches.some((b) => b === false)) {
      return undefined;
    }

    // Filter out true branches
    allBranches = allBranches.filter((b) =>
      b !== true || ContextualFlowControl.isTrueSchema(b)
    );

    if (allBranches.some((b) => !isObject(b))) {
      return undefined;
    }

    const branches = allBranches as (JSONSchema & object)[];

    const baseSchema = {
      ...(parentDefault !== undefined && { default: parentDefault }),
      ...(parentAsCell && { asCell: true }),
      ...(parentAsStream && { asStream: true }),
    };

    if (branches.length === 0) {
      // We caught the `never` case above, so if we have an empty allOf array
      // now, it means we match everything.
      schema = baseSchema;
    } else if (branches.length === 1) {
      schema = { ...branches[0], ...baseSchema };
    } else {
      const types = new Set(
        branches.map((b) => b.type).filter((t) => t !== undefined),
      );
      if (types.size > 1) {
        // If there are more than one type, we can't merge them
        return undefined;
      }
      if (!types.has("object")) {
        // TODO(seefeld): Properly intersect the types, handle enum, const, etc.
        schema = { ...branches[0], ...baseSchema };
      } else {
        // Merge all properties from branches for the schema
        const allProperties: Record<string, JSONSchema> = {};
        const allRequired: Set<string> = new Set();
        let mergedAdditionalProperties: boolean | JSONSchema | undefined;
        let hasAdditionalPropertiesConstraint = false;

        for (const branch of branches) {
          if (isObject(branch) && branch.type === "object") {
            // Merge properties - union of all properties
            if (branch.properties) {
              for (
                const [key, propSchema] of Object.entries(branch.properties)
              ) {
                if (allProperties[key] === undefined) {
                  allProperties[key] = propSchema;
                } else {
                  // Property appears in multiple branches, create nested allOf
                  const existing = allProperties[key];
                  const existingSchemas = isObject(existing) &&
                      Array.isArray(existing.allOf)
                    ? existing.allOf
                    : [existing];
                  allProperties[key] = createAllOf([
                    ...existingSchemas,
                    propSchema,
                  ])!;
                }
              }
            }

            // Merge required fields - union (all required fields from all branches)
            if (Array.isArray(branch.required)) {
              for (const field of branch.required) {
                allRequired.add(field);
              }
            }

            // Merge additionalProperties - false wins (strictest constraint)
            if ("additionalProperties" in branch) {
              hasAdditionalPropertiesConstraint = true;
              const branchAdditional = branch.additionalProperties;
              if (branchAdditional === false) {
                mergedAdditionalProperties = false;
              } else if (
                mergedAdditionalProperties !== false &&
                branchAdditional !== undefined
              ) {
                mergedAdditionalProperties = branchAdditional;
              }
            }
          }
        }

        // Create merged schema with all collected properties and preserved parent values
        const mergedSchema: JSONSchema = Object.keys(allProperties).length > 0
          ? {
            type: "object" as const,
            properties: allProperties,
            ...(allRequired.size > 0 && { required: Array.from(allRequired) }),
            ...(hasAdditionalPropertiesConstraint &&
              { additionalProperties: mergedAdditionalProperties ?? true }),
          }
          : {
            // No properties to merge - keep the allOf with branches to preserve type/enum/etc
            allOf: branches,
            ...(parentDefault !== undefined && { default: parentDefault }),
            ...(parentAsCell && { asCell: true }),
            ...(parentAsStream ? { asStream: true } : {}),
          };

        // Update finalSchema to the merged schema and continue processing below
        schema = mergedSchema;
      }
    }
  }

  // TODO(seefeld): The behavior when one of the options is very permissive
  // (e.g. no type or an object that allows any props) is not well defined.
  if (
    isObject(schema) &&
    (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf))
  ) {
    const options = ((schema.anyOf ?? schema.oneOf)!)
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

    if (Array.isArray(value)) {
      const arrayOptions = options.filter((option) =>
        isObject(option) && option.type === "array"
      );
      if (arrayOptions.length === 0) return undefined;
      if (arrayOptions.length === 1) {
        return validateAndTransform(
          runtime,
          tx,
          { ...ref, schema: arrayOptions[0] },
          synced,
          seen,
        );
      }

      // TODO(seefeld): Handle more corner cases like empty anyOf, etc.
      const merged: JSONSchema[] = [];
      for (const option of arrayOptions) {
        // Flatten anyOf and oneOf arrays
        if (
          isObject(option) && isObject(option.items) && (
            Array.isArray(option.items.anyOf) ||
            Array.isArray(option.items.oneOf)
          )
        ) {
          merged.push(...((option.items.anyOf ?? option.items.oneOf)!));
        } else if (isObject(option) && option.items) {
          merged.push(option.items);
        }
      }
      return validateAndTransform(
        runtime,
        tx,
        { ...ref, schema: { type: "array", items: { anyOf: merged } } },
        synced,
        seen,
      );
    } else if (isObject(value)) {
      let objectCandidates = options.filter((option) =>
        isObject(option) && option.type === "object"
      ) as (JSONSchema & object)[];
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
      const candidates = objectCandidates
        .map((option) => {
          const candidateSeen = [...seen];
          return {
            schema: option,
            result: validateAndTransform(
              runtime,
              tx,
              { ...ref, schema: option },
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
      const candidates = options
        .filter((
          option,
        ) => (isObject(option) &&
          (option.type === "integer" ? "number" : option.type) ===
            typeof value as string)
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

      // If we get more than one candidate, see if there is one that matches
      // anything, and if not return the first one
      const anyTypeOption = options.find((option) =>
        isBoolean(option) || ContextualFlowControl.isTrueSchema(option)
      );
      if (anyTypeOption) {
        return validateAndTransform(
          runtime,
          tx,
          { ...ref, schema: anyTypeOption },
          synced,
          seen,
        );
      } else {
        return annotateWithBackToCellSymbols(
          candidates[0].result,
          runtime,
          ref,
          tx,
        );
      }
    }
  }

  if (isObject(schema) && schema.type === "object") {
    const keys = isRecord(value) ? Object.keys(value) : [];

    const result: Record<string, any> = {};

    // Add to seen before processing children to handle self-referential structures
    seen.push([seenKey, result]);

    // Handle explicitly defined properties
    if (schema.properties) {
      for (const key of Object.keys(schema.properties)) {
        const childSchema = runtime.cfc.getSchemaAtPath(
          schema,
          [key],
          rootSchema,
        );
        if (childSchema === undefined) {
          continue;
        }
        const keyExistsInValue = keys.includes(key);
        const schemaHasAsCell = isObject(childSchema) &&
          (childSchema.asCell || childSchema.asStream);
        const schemaHasDirectDefault = isObject(childSchema) &&
          childSchema.default !== undefined;
        const schemaIsObject = isObject(childSchema) &&
          (childSchema.type === "object" || childSchema.properties ||
            childSchema.allOf);

        // Process the property if:
        // 1. Key exists in value, OR
        // 2. Schema has asCell/asStream (needs to be reactive), OR
        // 3. Schema has a direct default, OR
        // 4. Schema is an object schema (might have nested defaults)
        if (
          keyExistsInValue || schemaHasAsCell || schemaHasDirectDefault ||
          (schemaIsObject && !keyExistsInValue)
        ) {
          const transformed = validateAndTransform(
            runtime,
            tx,
            { ...ref, path: [...ref.path, key], schema: childSchema },
            synced,
            seen,
          );
          // Only add to result if we got a non-undefined value
          if (transformed !== undefined) {
            result[key] = transformed;
          }
        }
      }
    }

    // Handle additional properties if defined
    if (schema.additionalProperties || !schema.properties) {
      for (const key of keys) {
        // Skip properties that were already processed above:
        if (!schema.properties || !(key in schema.properties)) {
          // Will use additionalProperties if present
          const childSchema = runtime.cfc.getSchemaAtPath(
            schema,
            [key],
            rootSchema,
          );
          if (childSchema === undefined) {
            // This should never happen
            logger.warn(() => [
              "validateAndTransform: unexpected undefined schema for additional property",
              key,
              schema,
              rootSchema,
              ref,
            ]);
            continue;
          }
          result[key] = validateAndTransform(
            runtime,
            tx,
            { ...ref, path: [...ref.path, key], schema: childSchema },
            synced,
            seen,
          );
        }
      }
    }

    // Only return undefined if value wasn't a record and we produced no properties
    // If value was a record (even empty), we should return the result (even if empty)
    // because the schema expects an object
    if (!isRecord(value) && Object.keys(result).length === 0) {
      return undefined;
    }
    const annotated = annotateWithBackToCellSymbols(result, runtime, ref, tx);
    return annotated;
  }

  if (isObject(schema) && schema.type === "array") {
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
      const elementSchema: JSONSchema = schema.items ?? true;

      let elementLink: NormalizedFullLink = {
        ...ref,
        path: [...ref.path, String(i)],
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
    return annotateWithBackToCellSymbols(result, runtime, ref, tx);
  }

  // For primitive types, return as is

  // Add the current value to seen before returning
  seen.push([seenKey, value]);
  return annotateWithBackToCellSymbols(value, runtime, ref, tx);
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
