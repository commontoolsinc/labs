import { isRecord } from "@commontools/utils/types";
import { type LegacyAlias } from "../sigil-types.ts";
import {
  isRecipe,
  type JSONSchema,
  type JSONSchemaMutable,
  type JSONSchemaTypes,
  type JSONValue,
  type Module,
  type Opaque,
  type OpaqueRef,
  type Recipe,
  type toJSON,
  unsafe_originalRecipe,
} from "./types.ts";
import { getTopFrame } from "./recipe.ts";
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

  // If we encounter a link, it's from a nested recipe.
  if (isLegacyAlias(value)) {
    const alias = (value as LegacyAlias).$alias;
    // If this was a shadow ref, i.e. a nested recipe, see whether we're now at
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
      toJSONWithLegacyAliases(v, paths, ignoreSelfAliases, [...path, i])
    );
  }

  // If this is an object or a recipe, process each key recursively.
  if (isRecord(value) || isRecipe(value)) {
    // If this is a recipe, call its toJSON method to get the properly
    // serialized version.
    const valueToProcess = (isRecipe(value) &&
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
      );
      if (jsonValue !== undefined) {
        result[key] = jsonValue;
      }
    }

    // Retain the original recipe reference for downstream processing.
    if (isRecipe(value)) result[unsafe_originalRecipe] = value;

    return result;
  }

  return value;
}

export function createJsonSchema(
  example: any,
  addDefaults = false,
  runtime?: Runtime,
): JSONSchemaMutable {
  const seen = new Map<string, JSONSchemaMutable>();

  function analyzeType(value: any): JSONSchema {
    if (isCellLink(value)) {
      const link = parseLink(value);
      const linkAsStr = JSON.stringify(link);
      if (seen.has(linkAsStr)) {
        // Return a copy of the schema to avoid mutating the original.
        return JSON.parse(JSON.stringify(seen.get(linkAsStr)!));
      }

      const cell = runtime?.getCellFromLink(link);
      if (!cell) return {}; // TODO(seefeld): Should be `true`

      let schema = cell.schema;
      if (schema === undefined) {
        // If we find pointing back here, assume an empty schema. This is
        // overwritten below. (TODO(seefeld): This should create `$ref: "#/.."`)
        seen.set(linkAsStr, {} as JSONSchemaMutable);
        schema = analyzeType(cell.getRaw());
      }
      seen.set(linkAsStr, schema as JSONSchemaMutable);
      return schema;
    }

    const type = typeof value;
    const schema: JSONSchemaMutable = {};

    switch (type) {
      case "object":
        if (Array.isArray(value)) {
          schema.type = "array";
          if (value.length === 0) {
            schema.items = {}; // TODO(seefeld): Should be `true`
          } else {
            const schemas = value.map((v) => analyzeType(v)).map((s) =>
              JSON.stringify(s)
            );
            const uniqueSchemas = [...new Set(schemas)].map((s) =>
              JSON.parse(s)
            );
            if (uniqueSchemas.length === 1) {
              schema.items = uniqueSchemas[0];
            } else {
              schema.items = { anyOf: uniqueSchemas };
            }
          }
        } else if (value !== null) {
          schema.type = "object";
          schema.properties = {};
          for (
            const key of new Set([...Object.keys(value ?? {})])
          ) {
            (schema.properties as any)[key] = analyzeType(value?.[key]);
          }
        } else {
          schema.type = "null";
        }
        break;
      case "number":
        schema.type = Number.isInteger(value) ? "integer" : "number";
        break;
      case "undefined":
        break;
      default:
        schema.type = type as JSONSchemaTypes;
        break;
    }

    // Put the defaults on the leaves
    if (addDefaults && value !== undefined && schema.type !== "object") {
      schema.default = value;
    }

    return schema;
  }

  return analyzeType(example) as JSONSchemaMutable;
}

export function moduleToJSON(module: Module) {
  const { toJSON: _, ...rest } = module as Module & { toJSON: () => any };
  return {
    ...rest,
    implementation: typeof module.implementation === "function"
      ? module.implementation.toString()
      : module.implementation,
  };
}

export function recipeToJSON(recipe: Recipe) {
  return {
    argumentSchema: recipe.argumentSchema,
    resultSchema: recipe.resultSchema,
    ...(recipe.initial ? { initial: recipe.initial } : {}),
    result: recipe.result,
    nodes: recipe.nodes,
    program: recipe.program,
  };
}
