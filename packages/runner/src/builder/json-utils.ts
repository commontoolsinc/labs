import { isRecord } from "@commontools/utils/types";
import {
  emptySchemaObject,
  schemaForValueType,
  schemaWithProperties,
} from "@commontools/data-model/schema-utils";
import { internSchema } from "@commontools/data-model/schema-hash";
import { type LegacyAlias } from "../sigil-types.ts";
import {
  isPattern,
  type JSONSchema,
  type JSONValue,
  type Module,
  type Opaque,
  type OpaqueRef,
  type Pattern,
  type toJSON,
  unsafe_originalPattern,
} from "./types.ts";
import { getTopFrame } from "./pattern.ts";
import { deepEqual } from "@commontools/utils/deep-equal";
import { Runtime } from "../runtime.ts";
import {
  isCellLink,
  isLegacyAlias,
  parseLink,
  sanitizeSchemaForLinks,
} from "../link-utils.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";
import { isCell } from "../cell.ts";

export function toJSONWithLegacyAliases(
  value: Opaque<any>,
  paths: Map<OpaqueRef<any>, PropertyKey[]>,
  ignoreSelfAliases: boolean = false,
  path: PropertyKey[] = [],
  seen?: WeakMap<object, number>,
): JSONValue | undefined {
  // Turn strongly typed builder values into legacy JSON structures while
  // preserving alias metadata for consumers that still rely on it.

  // Convert regular cells and results from Cell.get() to opaque refs
  if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);

  if (isCell(value)) {
    const { external, frame, schema } = value.export();

    // If this is an external reference, just copy the reference as is.
    if (external) return external as JSONValue;

    // Verify that opaque refs are not in a parent frame
    if (frame !== getTopFrame()) {
      throw new Error(
        `Cell with parent cell not found in current frame. Likely a closure that should have been transformed.`,
      );
    }

    // Otherwise it's an internal reference. Extract the schema and output a link.
    const pathToCell = paths.get(value);
    if (pathToCell) {
      if (ignoreSelfAliases && deepEqual(path, pathToCell)) return undefined;

      return {
        $alias: {
          path: pathToCell as (string | number)[],
          ...(schema !== undefined &&
            { schema: sanitizeSchemaForLinks(schema) }),
        },
      } satisfies LegacyAlias;
    } else throw new Error(`Cell not found in paths`);
  }

  // If we encounter a link, it's from a nested pattern.
  if (isLegacyAlias(value)) {
    const alias = (value as LegacyAlias).$alias;
    // If this was a shadow ref, i.e. a nested pattern, see whether we're now at
    // the level that it should be resolved to the actual cell.
    if (!("cell" in alias) || typeof alias.cell === "number") {
      // If we encounter an existing alias and it isn't an absolute reference
      // with a cell id, then increase the nesting level.
      return {
        $alias: {
          ...alias, // Preserve existing metadata.
          cell: ((alias.cell as number) ?? 0) + 1, // Increase nesting level.
          path: alias.path as (string | number)[],
        },
      } satisfies LegacyAlias;
    } else {
      throw new Error(`Invalid alias cell`);
    }
  }

  // If this is an array, process each element recursively.
  if (Array.isArray(value)) {
    return (value as Opaque<any>).map((v: Opaque<any>, i: number) =>
      toJSONWithLegacyAliases(v, paths, ignoreSelfAliases, [...path, i], seen)
    );
  }

  // If this is an object or a pattern, process each key recursively.
  if (isRecord(value) || isPattern(value)) {
    // Guard against circular object references (e.g. schema objects with
    // shared identity between $defs and sibling properties).
    if (!seen) seen = new WeakMap();
    const depth = seen.get(value as object) ?? 0;
    if (depth > 0) return {}; // Actually circular
    seen.set(value as object, depth + 1);

    // If this is a pattern, call its toJSON method to get the properly
    // serialized version.
    const valueToProcess = (isPattern(value) &&
        typeof (value as unknown as toJSON).toJSON === "function")
      ? (value as unknown as toJSON).toJSON() as Record<string, any>
      : (value as Record<string, any>);

    const result: any = {};
    for (const key in valueToProcess as any) {
      const jsonValue = toJSONWithLegacyAliases(
        valueToProcess[key],
        paths,
        ignoreSelfAliases,
        [...path, key],
        seen,
      );
      if (jsonValue !== undefined) {
        result[key] = jsonValue;
      }
    }

    // Restore depth so shared references can be re-serialized
    seen.set(value as object, depth);

    // Retain the original pattern reference for downstream processing.
    if (isPattern(value)) result[unsafe_originalPattern] = value;

    return result;
  }

  return value;
}

/**
 * Creates a schema based on an `example` piece of data. The result is always an
 * interned schema. Note that interned schemas are necessarily frozen.
 *
 * **Note:** Though the intention is to treat `undefined` as an acceptable
 * value, this function doesn't in fact represent it as a proper schema.
 */
export function createJsonSchema(
  example: any,
  addDefaults: boolean = false,
  runtime?: Runtime,
): JSONSchema {
  const state = {
    addDefaults,
    runtime,
    seen: new Map<string, JSONSchema>(),
  };

  return analyzeType(example, state);
}

type AnalyzeTypeState = {
  addDefaults: boolean;
  runtime: Runtime | undefined;
  seen: Map<string, JSONSchema>;
};

/**
 * Helper for `createJsonSchema()` which analyzes a value, calling itself
 * recursively on subcomponents of the value (if any). The return value is
 * always an interned schema.
 */
function analyzeType(value: any, state: AnalyzeTypeState): JSONSchema {
  if (isCellLink(value)) {
    const seen = state.seen;
    const link = parseLink(value);
    const linkAsStr = JSON.stringify(link);

    const found = seen.get(linkAsStr);
    if (found !== undefined) {
      return found;
    }

    const cell = state.runtime?.getCellFromLink(link);
    if (!cell) {
      // Shouldn't happen: We have a cell link but its link doesn't correspond
      // to a cell.

      // TODO(danfuzz): I think the `TODO(seefeld)` below reflects the old state
      // of `createJsonSchema()` which was defined to return a
      // `JSONSchemaObjMutable` (which had to be an `object`) and not a
      // `JSONSchema` (which includes `boolean`), and not some other problem
      // with returning `true`. That said, maybe it's more appropriate to
      // `throw` in this case? Figure out what's what, and take action as
      // appropriate.

      // TODO(seefeld): Should be `true`.
      return emptySchemaObject();
    }

    let schema = cell.schema;
    if (schema === undefined) {
      // The `seen.set()` here provides a safe default which prevents the call
      // to `analyzeType()` (immediately below) from ending up recursing back
      // into this block (i.e., runaway recursion). Typically, `analyzeType()`
      // promptly overwrites the backstop.
      // TODO(seefeld): This should create `$ref: "#/.."`.
      seen.set(linkAsStr, emptySchemaObject());
      schema = analyzeType(cell.getRaw(), state);
    } else {
      // This needs to be interned for deduping during array analysis. (See
      // comments below.)
      schema = internSchema(schema);
    }
    seen.set(linkAsStr, schema);
    return schema;
  }

  // Adds the `default` when appropriate and does the necessary final result
  // processing. The result needs to be interned for deduping during array
  // analysis. (See comment below.)
  const finishResult = (schema: JSONSchema, addDefault = true): JSONSchema => {
    const result = (addDefault && state.addDefaults)
      ? schemaWithProperties(schema, { default: value })
      : schema;
    return internSchema(result);
  };

  const basicSchema = schemaForValueType(value);
  if (basicSchema === undefined) {
    // TODO(danfuzz): I think it's safe to return `true` here. (See longer
    // related comment above.)

    // Unrecognized type. Treat it as "any."
    return finishResult(emptySchemaObject());
  }

  switch (basicSchema.type) {
    case "array": {
      // The call here deduplicates the individual array element schemas using
      // object-identity-based uniquing. In order for it to work, all of the
      // schemas have to be interned. See comments above on the `internSchema()`
      // use sites that enable this.
      const items = itemsSchemaFromArray(value, state);
      const result = schemaWithProperties(basicSchema, { items });
      return finishResult(result);
    }

    case "object": {
      const entries: [string, JSONSchema][] = Object.entries(value).map(
        ([key, subValue]) => {
          return [key, analyzeType(subValue, state)];
        },
      );
      const properties = Object.fromEntries(entries);
      const result = schemaWithProperties(basicSchema, { properties });
      // `addDefault = false` because sub-properties will get defaults, if
      // any.
      return finishResult(result, false);
    }

    default: {
      return finishResult(basicSchema);
    }
  }
}

/**
 * Helper for `analyzeType()` which derives an `items` schema property from an
 * array value. The result is always an interned schema.
 */
function itemsSchemaFromArray(
  value: JSONValue[],
  state: AnalyzeTypeState,
): JSONSchema {
  // No need for any fanciness for empty or single-element arrays.
  switch (value.length) {
    case 0: {
      // TODO(danfuzz): I think it's safe to return `true` here. (See longer
      // related comment above.)
      // TODO(seefeld): should be `true` in this case.
      return emptySchemaObject();
    }
    case 1: {
      return analyzeType(value[0], state);
    }
  }

  // This `Set` constructor call achieves schema uniquing, exactly because all
  // the `schemas` are guaranteed to be interned. That is if `schema1 !==
  // schema2` (not the same actual object), then we know that they also aren't
  // equivalent (same-content objects).
  const schemas = value.map((v) => analyzeType(v, state));
  const uniqueSchemas = [...new Set(schemas)];
  return (uniqueSchemas.length === 1)
    ? uniqueSchemas[0]
    : internSchema({ anyOf: uniqueSchemas });
}

export function moduleToJSON(module: Module) {
  const { toJSON: _, ...rest } = module as Module & { toJSON: () => any };
  let implementation = module.implementation;

  // CT-1230 WORKAROUND: Preserve pattern structure when serializing pattern modules.
  //
  // Problem: When a subpattern is passed to .map(), the pattern's implementation
  // was being stringified (e.g., "(inputs2) => { ... }") instead of preserving
  // the actual pattern structure. This caused "Invalid pattern" errors at runtime
  // because isPattern() check failed on the string.
  //
  // Why this helps: Using toJSONWithLegacyAliases ensures nested $alias bindings
  // get their nesting level incremented properly. Without this, aliases could be
  // bound to a specific doc too early, causing handlers to point at stale docs
  // when the pattern is later executed in a different context.
  //
  // We don't fully understand why the original code stringified pattern functions,
  // but this defensive change ensures patterns passed as values (like to map())
  // retain their structure and alias metadata.
  if (
    module.type === "pattern" && implementation && isPattern(implementation)
  ) {
    implementation = toJSONWithLegacyAliases(
      implementation as unknown as Opaque<any>,
      new Map(),
      false,
    ) as unknown as Pattern;
  } else if (typeof implementation === "function") {
    implementation = implementation.toString();
  }

  return {
    ...rest,
    implementation,
  };
}

export function patternToJSON(pattern: Pattern) {
  return {
    argumentSchema: pattern.argumentSchema,
    resultSchema: pattern.resultSchema,
    ...(pattern.initial ? { initial: pattern.initial } : {}),
    result: pattern.result,
    nodes: pattern.nodes,
    program: pattern.program,
  };
}
