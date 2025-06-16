import { isObject, isRecord } from "@commontools/utils/types";
import { type CellLink, isCell, isCellLink, isDoc } from "../index.ts";
import { type CellLink, isCell, isCellLink, isDoc } from "../index.ts";
import { createShadowRef } from "./opaque-ref.ts";
import {
  type Alias,
  canBeOpaqueRef,
  isAlias,
  isOpaqueRef,
  isRecipe,
  isShadowRef,
  type JSONSchema,
  type JSONSchemaMutable,
  type JSONSchemaTypes,
  type JSONValue,
  makeOpaqueRef,
  type Module,
  type Opaque,
  type OpaqueRef,
  type Recipe,
  unsafe_originalRecipe,
} from "./types.ts";
import { getTopFrame } from "./recipe.ts";
import { deepEqual, getValueAtPath } from "../path-utils.ts";

export function toJSONWithAliases(
  value: Opaque<any>,
  paths: Map<OpaqueRef<any>, PropertyKey[]>,
  ignoreSelfAliases: boolean = false,
  path: PropertyKey[] = [],
): JSONValue | undefined {
  // Convert regular cells to opaque refs
  if (canBeOpaqueRef(value)) value = makeOpaqueRef(value);

  // Verify that opaque refs are not in a parent frame
  if (isOpaqueRef(value) && value.export().frame !== getTopFrame()) {
    throw new Error(
      `Opaque ref with parent cell not found in current frame. Should have been converted to a shadow ref.`,
    );
  }

  // If this is an external reference, just copy the reference as is.
  if (isOpaqueRef(value)) {
    const { external } = value.export();
    if (external) return external;
  }

  if (isOpaqueRef(value) || isShadowRef(value)) {
    const pathToCell = paths.get(value);
    if (pathToCell) {
      if (ignoreSelfAliases && deepEqual(path, pathToCell)) return undefined;

      // Get schema from exported value if available
      const exported = isOpaqueRef(value) ? value.export() : undefined;
      return {
        $alias: {
          ...(isShadowRef(value) ? { cell: value } : {}),
          path: pathToCell as (string | number)[],
          ...(exported?.schema ? { schema: exported.schema } : {}),
          ...(exported?.rootSchema ? { rootSchema: exported.rootSchema } : {}),
        },
      } satisfies Alias;
    } else throw new Error(`Cell not found in paths`);
  }

  if (isAlias(value)) {
    const alias = (value as Alias).$alias;
    if (isShadowRef(alias.cell)) {
      const cell = alias.cell.shadowOf;
      if (cell.export().frame !== getTopFrame()) {
        let frame = getTopFrame();
        while (frame && frame.parent !== cell.export().frame) {
          frame = frame.parent;
        }
        if (!frame) {
          throw new Error(
            `Shadow ref alias with parent cell not found in current frame`,
          );
        }
        return value;
      }
      if (!paths.has(cell)) throw new Error(`Cell not found in paths`);
      return {
        $alias: {
          path: [...paths.get(cell)!, ...alias.path] as (string | number)[],
        },
      } satisfies Alias;
    } else if (!("cell" in alias) || typeof alias.cell === "number") {
      return {
        $alias: {
          cell: ((alias.cell as number) ?? 0) + 1,
          path: alias.path as (string | number)[],
        },
      } satisfies Alias;
    } else {
      throw new Error(`Invalid alias cell`);
    }
  }

  if (Array.isArray(value)) {
    return (value as Opaque<any>).map((v: Opaque<any>, i: number) =>
      toJSONWithAliases(v, paths, ignoreSelfAliases, [...path, i])
    );
  }

  if (isRecord(value) || isRecipe(value)) {
    const result: any = {};
    let hasValue = false;
    for (const key in value as any) {
      const jsonValue = toJSONWithAliases(
        value[key],
        paths,
        ignoreSelfAliases,
        [...path, key],
      );
      if (jsonValue !== undefined) {
        result[key] = jsonValue;
        hasValue = true;
      }
    }

    if (isRecipe(value)) result[unsafe_originalRecipe] = value;

    return hasValue || Object.keys(result).length === 0 ? result : undefined;
  }

  return value;
}

export function createJsonSchema(
  example: any,
  addDefaults = false,
): JSONSchemaMutable {
  function analyzeType(value: any): JSONSchema {
    if (isCell(value)) {
      if (value.schema) {
        return value.schema;
      } else {
        value = value.get();
      }
    }

    if (isDoc(value)) value = { cell: value, path: [] } satisfies CellLink;

    if (isCellLink(value)) {
      value = value.cell.getAtPath(value.path);
      return analyzeType(value);
    }

    if (isAlias(value)) {
      // Use maybeGetCellLink to handle all alias formats
      const aliasLink = maybeGetCellLink(value.$alias);
      if (aliasLink && isDoc(aliasLink.cell)) {
        value = aliasLink.cell.getAtPath(aliasLink.path);
      } else if (value.$alias && Array.isArray(value.$alias.path)) {
        value = getValueAtPath(example, value.$alias.path);
      }
      return analyzeType(value);
    }

    const type = typeof value;
    const schema: JSONSchemaMutable = {};

    switch (type) {
      case "object":
        if (Array.isArray(value)) {
          schema.type = "array";
          // Check the array type. The array type is determined by the first element
          // of the array, or if objects, a superset of all properties of the object elements.
          // If array is empty, `items` is `{}`.
          if (value.length === 0) {
            schema.items = {};
          } else {
            const first = value[0];
            if (isObject(first)) {
              const properties: { [key: string]: any } = {};
              for (let i = 0; i < value.length; i++) {
                const item = value?.[i];
                if (isRecord(item)) {
                  Object.keys(item).forEach((key) => {
                    if (!(key in properties)) {
                      properties[key] = analyzeType(
                        value?.[i]?.[key],
                      );
                    }
                  });
                }
              }
              schema.items = {
                type: "object",
                properties,
              };
            } else {
              schema.items = analyzeType(first) as JSONSchemaMutable;
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
  return {
    ...module,
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
  };
}
