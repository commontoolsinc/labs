import { AnyCellWrapping } from "@commontools/api";
import { getLogger } from "@commontools/utils/logger";
import { Immutable, isObject, isRecord } from "@commontools/utils/types";
import { JSONSchemaMutable } from "@commontools/runner";
import { ContextualFlowControl } from "./cfc.ts";
import { type JSONSchema } from "./builder/types.ts";
import { type StorableDatum } from "@commontools/memory/interface";
import { createCell, isCell } from "./cell.ts";
import { readMaybeLink, resolveLink } from "./link-resolution.ts";
import { type IExtendedStorageTransaction } from "./storage/interface.ts";
import { getTransactionForChildCells } from "./storage/extended-storage-transaction.ts";
import { type Runtime } from "./runtime.ts";
import { type NormalizedFullLink } from "./link-utils.ts";
import {
  createQueryResultProxy,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import { toCell } from "./back-to-cell.ts";
import { recordTaintedRead } from "./cfc/taint-tracking.ts";
import {
  joinLabel,
  labelFromSchemaIfc,
  labelFromStoredLabels,
} from "./cfc/labels.ts";
import {
  combineSchema,
  IObjectCreator,
  mergeAnyOfMatches,
  mergeSchemaFlags,
  SchemaObjectTraverser,
} from "@commontools/runner/traverse";

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
  filterAsCell = false,
): JSONSchema | undefined {
  // Treat undefined/null/{} or any other non-object as no schema
  // We don't use ContextualFlowControl.isTrueSchema here, since we want to
  // handle flags like default or ifc
  if (
    typeof schema !== "object" || schema === null ||
    Object.keys(schema).length === 0
  ) {
    return undefined;
  }

  let resolvedSchema = schema;
  if (typeof schema.$ref === "string") {
    const resolved = ContextualFlowControl.resolveSchemaRefs(schema);
    if (!isObject(resolved)) {
      // For boolean schema or the default `{}` schema, we don't have any
      // meaningful information in the schema, so just return undefined.
      return undefined;
    }
    resolvedSchema = resolved;
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
    resolvedSchema === undefined || Object.keys(resolvedSchema).length === 0
  ) {
    return undefined;
  }

  return resolvedSchema;
}

function filterAsCell(schema: JSONSchema | undefined): JSONSchema | undefined {
  if (typeof schema !== "object") {
    return schema;
  }
  const { asCell: _asCell, asStream: _asStream, ...restSchema } = schema;
  if (restSchema === undefined || Object.keys(restSchema).length === 0) {
    return undefined;
  }
  return restSchema;
}

/**
 * Process a default value from a schema, transforming it based on the schema
 * structure to account for asCell/asStream and other schema features.
 *
 * For `required` objects and arrays assume {} and [] as default value.
 */
export function processDefaultValue(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  defaultValue: any,
): any {
  const schema = link.schema;
  if (!schema) return defaultValue;

  const resolvedSchema = resolveSchema(schema, true);

  // If schema indicates this should be a cell
  if (isObject(schema) && schema.asCell) {
    // If the cell itself has a default value, make it its own (immutable)
    // doc, to emulate the behavior of .get() returning a different underlying
    // document when the value is changed. A classic example is
    // `currentlySelected` with a default of `null`.
    if (
      defaultValue === undefined && isObject(resolvedSchema) &&
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
        },
        getTransactionForChildCells(tx),
      );
    }
  }

  if (isObject(schema) && schema.asStream) {
    logger.warn(
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
        "Array schema error: items: false conflicts with non-empty default\n" +
          "help: either allow items with valid schema, or use empty array default",
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
  defaultValue: Readonly<StorableDatum>,
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
    } as Readonly<StorableDatum>;
  } else result.default = defaultValue;

  return result;
}

function annotateWithBackToCellSymbols(
  value: any,
  runtime: Runtime,
  link: NormalizedFullLink,
  tx: IExtendedStorageTransaction | undefined,
) {
  if (
    isRecord(value) && !isCell(value) && !isCellResultForDereferencing(value)
  ) {
    // Non-enumerable, so that {...obj} won't copy these symbols
    Object.defineProperty(value, toCell, {
      // Use getTransactionForChildCells so that if this was called from sample(),
      // the resulting cell is still reactive
      value: () => createCell(runtime, link, getTransactionForChildCells(tx)),
      enumerable: false,
    });
    Object.freeze(value);
  }
  return value;
}

export interface ValidateAndTransformOptions {
  /** When true, also read into each Cell created for asCell fields to capture dependencies */
  traverseCells?: boolean;
}

export function validateAndTransform(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  _seen?: Array<[string, any]>,
  options?: ValidateAndTransformOptions,
): any {
  // If the transaction is no longer open, just treat it as no transaction, i.e.
  // create temporary transactions to read. The main reason we use transactions
  // here is so that this operation can see open reads, that are only accessible
  // from the tx. Once tx.commit() is called, all that data is either available
  // via other transactions or has been rolled back. Either way, we want to
  // reflect that reality.
  if (tx?.status().status !== "ready") tx = undefined;

  // Reconstruct doc, path, schema from link and runtime
  const schema = link.schema;
  let resolvedSchema = resolveSchema(schema);
  let filteredSchema = filterAsCell(resolvedSchema);

  // Follow aliases, etc. to last element on path + just aliases on that last one
  // When we generate cells below, we want them to be based off this value, as that
  // is what a setter would change when they update a value or reference.
  tx = tx ?? runtime.edit();
  const resolvedLink = resolveLink(runtime, tx, link, "writeRedirect");

  // Use schema from alias if provided and no explicit schema was set
  if (filteredSchema === undefined && resolvedLink.schema) {
    resolvedSchema = resolveSchema(resolvedLink.schema);
    // Call resolveSchema to strip asCell/asStream here as well. It's still the
    // initial `schema` that says whether this should be a cell, not the
    // resolved schema.
    filteredSchema = filterAsCell(resolvedSchema);
  }

  // Unlike the original, we have kept the asCell markers in the schema
  link = {
    ...resolvedLink,
    schema: resolvedSchema,
  };

  // If we don't have a schema, and we aren't asCell/asStream, use a proxy
  if (
    (schema === undefined || !SchemaObjectTraverser.asCellOrStream(schema)) &&
    filteredSchema === undefined
  ) {
    return createQueryResultProxy(runtime, tx, link);
  }

  // Update our link to match the potentially merged schema
  link.schema = filteredSchema !== undefined
    ? schema != undefined
      ? combineSchema(schema, filteredSchema)
      : filteredSchema
    : schema;

  // Now resolve further links until we get the actual value.
  // We'll use this for the value, and potentially merge the schema
  // This gets me the result of following all the links, so I can get the value
  const ref = resolveLink(runtime, tx, link);
  const objectCreator = new TransformObjectCreator(runtime, tx!);

  // If our link is asCell/asStream, and we don't have any path portions, we
  // can just create the cell and mostly skip reading the value and traversal.
  if (SchemaObjectTraverser.asCellOrStream(schema)) {
    // We check for a link value, since we will follow links one step in get
    // We've already followed all the writeRedirect links above.
    const next = readMaybeLink(tx, link);
    // FIXME(@ubik2): this is a simple approach, but we should really
    // resolve the path. For example, if we have link to x.foo.bar,
    // but x.foo is link to y.baz, we really want y.baz.bar.
    // I'm not currently handling this, because it doesn't come up.
    if (next !== undefined) {
      // We leave the asCell/asStream in the schema, so that createObject
      // knows to create a cell
      const mergedSchema = (next.schema !== undefined)
        ? combineSchema(schema!, next.schema)
        : schema!;
      link = { ...next, schema: mergedSchema };
    }
    // If our ref has a schema, merge our schema flags into that schema
    // This will overwrite any schema that we got from the first non-redirect
    // link, but this one should be more accurate
    // Otherwise, we won't return a cell like we are supposed to.
    if (ref.schema !== undefined) {
      link.schema = mergeSchemaFlags(schema!, ref.schema);
    }
    return objectCreator.createObject(link, undefined);
  }

  // Link paths don't include value, but doc address should
  const { space, id, type, path } = ref;
  const address = { space, id, type, path: ["value", ...path] };
  const doc = { address, value: tx!.readValueOrThrow(ref) };

  // CFC: record read taint from merged schema + stored labels
  if (tx) {
    const readSchema = ref.schema ?? link.schema;
    const schemaLabel =
      (readSchema && typeof readSchema === "object" && readSchema.ifc)
        ? labelFromSchemaIfc(readSchema.ifc)
        : undefined;
    // Only read stored labels when schema has ifc — avoids registering
    // phantom reactive dependencies on the label/ path for every read.
    const storedLabels = schemaLabel ? tx.readLabelOrUndefined(ref) : undefined;
    const storedLabel = storedLabels
      ? labelFromStoredLabels(storedLabels)
      : undefined;

    if (schemaLabel || storedLabel) {
      const effectiveLabel = schemaLabel && storedLabel
        ? joinLabel(schemaLabel, storedLabel)
        : (schemaLabel ?? storedLabel)!;
      recordTaintedRead(tx, effectiveLabel);
    }
  }

  // If we have a ref with a schema, use that; otherwise, use the link's schema
  const selector = {
    path: doc.address.path,
    schema: ref.schema ?? link.schema!,
  };
  // TODO(@ubik2): these constructor parameters are complex enough that we should
  // use an options struct
  const traverser = new SchemaObjectTraverser<any>(
    tx!,
    selector,
    undefined,
    undefined,
    undefined,
    objectCreator,
    options?.traverseCells ?? false,
  );
  return traverser.traverse(doc, link);
}

class TransformObjectCreator
  implements IObjectCreator<AnyCellWrapping<StorableDatum>> {
  constructor(
    private runtime: Runtime,
    private tx: IExtendedStorageTransaction,
  ) {
  }

  mergeMatches<T>(
    matches: T[],
    schema?: JSONSchema,
  ): T | Record<string, T> | undefined {
    // These value objects should be merged. While this isn't JSONSchema
    // spec, when we have an anyOf with branches where name is set in one
    // schema, but the address is ignored, and a second option where
    // address is set, and name is ignored, we want to include both.
    if (matches.length > 1) {
      // If more than one match, but we have a cell, return that
      // If we tried to combine the objects, the result would not be a cell
      // anymore.
      const cellMatch = matches.find((v) => isCell(v));
      if (cellMatch !== undefined) {
        if (typeof schema === "object") {
          const { asCell: _, ...restSchema } = schema;
          return cellMatch.asSchema(restSchema) as any;
        } else {
          return cellMatch.asSchema(schema) as any;
        }
      }
    }
    return mergeAnyOfMatches(matches);
  }

  // This controls the behavior when properties is specified, but
  // additonalProperties is not.
  addOptionalProperty(
    _obj: Record<string, Immutable<StorableDatum>>,
    _key: string,
    _value: StorableDatum,
  ) {
    // We want to exclude properties when we have a properties map provided
    // in the schema, but it doesn't include our property, and we don't have
    // additionalProperties set. So we don't do `obj[key] = value`;
  }
  applyDefault<T>(
    link: NormalizedFullLink,
    value: T | undefined,
  ): T | undefined {
    return processDefaultValue(this.runtime, this.tx, link, value);
  }

  // This is an early pass to see if we should just create a proxy or cell
  // If not, we will actually resolve our links to get to our values.
  createObject(
    link: NormalizedFullLink,
    value: AnyCellWrapping<StorableDatum> | undefined,
  ): AnyCellWrapping<StorableDatum> {
    // If we have a schema with an asCell or asStream (or if our anyOf values
    // do), we should create a cell here.
    // If we don't have a schema, or a true schema, we should create a query result proxy.
    // If we have a schema without asCell or asStream, we should annotate the
    // object so we can get back to the cell if needed.
    if (link.schema === undefined || link.schema === true) {
      return createQueryResultProxy(this.runtime, this.tx, link);
    } else if (isObject(link.schema)) {
      const { asCell, asStream, ...restSchema } = link.schema;
      if (asCell || asStream) {
        // TODO(@ubik2): deal with anyOf/oneOf with asCell/asStream
        // TODO(@ubik2): Figure out if we should purge asCell/asStream from restSchema children
        return createCell(
          this.runtime,
          { ...link, schema: restSchema },
          getTransactionForChildCells(this.tx),
        ) as AnyCellWrapping<StorableDatum>;
      }
      // If it's not a cell/stream, but the schema is true-ish, use a
      // QueryResultProxy
      if (ContextualFlowControl.isTrueSchema(link.schema)) {
        return createQueryResultProxy(this.runtime, this.tx, link);
      }
      // link.schema is not true, and not asCell/asStream
      // If we're undefined, check for a default and apply that
      if (link.schema.default !== undefined && value === undefined) {
        // processDefaultValue already annotates with back to cell
        return processDefaultValue(
          this.runtime,
          this.tx,
          link,
          link.schema.default,
        );
      }
      // If we're an object, we may be missing some properties that have a
      // default.
      if (isObject(value) && link.schema.properties !== undefined) {
        const propertyEntries = Object.entries(link.schema.properties) as [
          string,
          JSONSchema,
        ][];
        for (const [propName, propSchema] of propertyEntries) {
          if (isObject(propSchema) && propSchema.default !== undefined) {
            const valueObj = value as Record<string, any>;
            if (valueObj[propName] === undefined) {
              valueObj[propName] = processDefaultValue(this.runtime, this.tx, {
                ...link,
                path: [...link.path, propName],
                schema: propSchema,
              }, undefined);
            }
          }
        }
      }
      // TODO(@ubik2): What if we're an array? Is it possible to have undefined
      // elements in our array?
    }
    return annotateWithBackToCellSymbols(value, this.runtime, link, this.tx);
  }
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
    ...(Object.keys(mergedDefs).length && { $defs: mergedDefs }),
    ...(Object.keys(mergedDefinitions).length &&
      { definitions: mergedDefinitions }),
  };
}
