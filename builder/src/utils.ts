import { createShadowRef } from "./opaque-ref.ts";
import {
  type Alias,
  canBeOpaqueRef,
  isAlias,
  isOpaqueRef,
  isRecipe,
  isShadowRef,
  isStatic,
  type JSONSchema,
  type JSONSchemaWritable,
  type JSONValue,
  makeOpaqueRef,
  markAsStatic,
  type Module,
  type NodeRef,
  type Opaque,
  type OpaqueRef,
  type Recipe,
  unsafe_originalRecipe,
} from "./types.ts";
import { getTopFrame } from "./recipe.ts";
import { type CellLink, isCell, isCellLink, isDoc } from "@commontools/runner";

/**
 * Traverse a value, _not_ entering cells
 *
 * @param value - The value to traverse
 * @param fn - The function to apply to each value, which can return a new value
 * @returns Transformed value
 */
export function traverseValue(
  value: Opaque<any>,
  fn: (value: any) => any,
): any {
  const staticWrap = isStatic(value) ? markAsStatic : (v: any) => v;

  // Perform operation, replaces value if non-undefined is returned
  const result = fn(value);
  if (result !== undefined) value = result;

  // Traverse value
  if (Array.isArray(value)) {
    return staticWrap(value.map((v) => traverseValue(v, fn)));
  } else if (
    (!isOpaqueRef(value) &&
      !canBeOpaqueRef(value) &&
      !isShadowRef(value) &&
      typeof value === "object" &&
      value !== null) ||
    isRecipe(value)
  ) {
    return staticWrap(
      Object.fromEntries(
        Object.entries(value).map(([key, v]) => [key, traverseValue(v, fn)]),
      ),
    );
  } else return staticWrap(value);
}

export function setValueAtPath(
  obj: any,
  path: PropertyKey[],
  value: any,
): boolean {
  let parent = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (typeof parent[key] !== "object") {
      parent[key] = typeof path[i + 1] === "number" ? [] : {};
    }
    parent = parent[key];
  }

  if (deepEqual(parent[path[path.length - 1]], value)) return false;

  if (value === undefined) {
    delete parent[path[path.length - 1]];
    // Truncate array from the end for undefined values
    if (Array.isArray(parent)) {
      while (parent.length > 0 && parent[parent.length - 1] === undefined) {
        parent.pop();
      }
    }
  } else parent[path[path.length - 1]] = value;

  return true;
}

export function getValueAtPath(obj: any, path: PropertyKey[]): any {
  let current = obj;
  for (const key of path) {
    if (current === undefined || current === null) return undefined;
    current = current[key];
  }
  return current;
}

export function hasValueAtPath(obj: any, path: PropertyKey[]): boolean {
  let current = obj;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return false;
    }
    current = current[key];
  }
  return current !== undefined;
}

export const deepEqual = (a: any, b: any): boolean => {
  if (a === b) return true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (a.constructor !== b.constructor) return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!keysB.includes(key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return a !== a && b !== b; // NaN check
};

export function toJSONWithAliases(
  value: Opaque<any>,
  paths: Map<OpaqueRef<any>, PropertyKey[]>,
  ignoreSelfAliases: boolean = false,
  path: PropertyKey[] = [],
  processStatic = false,
): JSONValue | undefined {
  if (isStatic(value) && !processStatic) {
    return markAsStatic(
      toJSONWithAliases(value, paths, ignoreSelfAliases, path, true),
    );
  } // Convert regular cells to opaque refs
  else if (canBeOpaqueRef(value)) value = makeOpaqueRef(value);
  // Convert parent opaque refs to shadow refs
  else if (isOpaqueRef(value) && value.export().frame !== getTopFrame()) {
    value = createShadowRef(value);
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
          cell: (alias.cell ?? 0) + 1,
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

  if (typeof value === "object" || isRecipe(value)) {
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
): JSONSchemaWritable {
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
      if (isDoc(value.$alias.cell)) {
        value = value.$alias.cell.getAtPath(value.$alias.path);
      } else {
        value = getValueAtPath(example, value.$alias.path);
      }
      return analyzeType(value);
    }

    const type = typeof value;
    const schema: JSONSchemaWritable = {};

    switch (type) {
      case "object":
        if (Array.isArray(value)) {
          schema.type = "array";
          if (value.length > 0) {
            const properties: { [key: string]: any } = {};
            for (let i = 0; i < value.length; i++) {
              const item = value?.[i];
              if (typeof item === "object" && item !== null) {
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
        schema.type = type as JSONSchema["type"];
        break;
    }

    // Put the defaults on the leaves
    if (addDefaults && value !== undefined && schema.type !== "object") {
      schema.default = value;
    }

    return schema;
  }

  return analyzeType(example);
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

export function connectInputAndOutputs(node: NodeRef) {
  function connect(value: any): any {
    if (canBeOpaqueRef(value)) value = makeOpaqueRef(value);
    if (isOpaqueRef(value)) {
      // Return shadow ref it this is a parent opaque ref. Note: No need to
      // connect to the cell. The connection is there to traverse the graph to
      // find all other nodes, but this points to the parent graph instead.
      if (value.export().frame !== node.frame) return createShadowRef(value);
      value.connect(node);
    }
    return undefined;
  }

  node.inputs = traverseValue(node.inputs, connect);
  node.outputs = traverseValue(node.outputs, connect);
}
