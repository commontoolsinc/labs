import {
  Value,
  Module,
  Recipe,
  CellProxy,
  isCell,
  JSONValue,
  JSON,
} from "./types.js";

/** traverse a value, _not_ entering cells */
export function traverseValue(value: Value<any>, fn: (value: any) => any) {
  if (Array.isArray(value)) value.map(fn);
  else if (!isCell(value) && typeof value === "object" && value !== null)
    for (const key in value) fn(value[key]);
  else fn(value);
}

export function setValueAtPath(obj: any, path: PropertyKey[], value: any) {
  let parent = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (typeof parent[key] !== "object")
      parent[key] = typeof path[i + 1] === "number" ? [] : {};
    parent = parent[key];
  }
  parent[path[path.length - 1]] = value;
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
    if (!current || typeof current !== "object" || !(key in current))
      return false;
    current = current[key];
  }
  return current !== undefined;
}

export function toJSONWithReferences(
  value: Value<any>,
  paths: Map<CellProxy<any>, PropertyKey[]>,
  key: string = ""
): JSONValue {
  if (isCell(value)) {
    const path = paths.get(value);
    if (path) return { $ref: path as (string | number)[] };
    else throw new Error(`Cell not found in paths`);
  }

  if (Array.isArray(value))
    // Escape `$ref` that are arrays by prefixing with an empty array
    return (key === "$ref" ? [[], ...value] : value).map((value) =>
      toJSONWithReferences(value, paths)
    );
  if (typeof value === "object") {
    const result: any = {};
    for (const key in value)
      result[key] = toJSONWithReferences(value[key], paths, key);
    return result;
  }
  return value;
}

export function createJsonSchema(
  defaultValues: any,
  referenceValues: any
): JSON {
  function analyzeType(value: any, defaultValue: any): JSON {
    const type = typeof (value ?? defaultValue);
    const schema: JSON = {};

    switch (type) {
      case "object":
        if (Array.isArray(value ?? defaultValue)) {
          schema.type = "array";
          if ((value ?? defaultValue).length > 0) {
            schema.items = analyzeType(value?.[0], defaultValue?.[0]);
          }
        } else if (value ?? defaultValue !== null) {
          schema.type = "object";
          schema.properties = {};
          for (const key of new Set([
            ...Object.keys(value ?? {}),
            ...Object.keys(defaultValue ?? {}),
          ])) {
            schema.properties[key] = analyzeType(
              value?.[key],
              defaultValue?.[key]
            );
          }
        } else {
          schema.type = "null";
        }
        break;
      case "number":
        schema.type = Number.isInteger(value ?? defaultValue)
          ? "integer"
          : "number";
        break;
      default:
        schema.type = type;
        break;
    }

    if (defaultValue !== undefined && schema.type !== "object") {
      schema.default = defaultValue;
    }

    return schema;
  }

  return analyzeType(referenceValues, defaultValues);
}

export function moduleToJSON(module: Module) {
  return {
    type: module.type,
    implementation:
      typeof module.implementation === "function"
        ? module.implementation.toString()
        : module.implementation,
  };
}

export function recipeToJSON(recipe: Recipe) {
  return {
    schema: recipe.schema,
    initial: recipe.initial,
    nodes: recipe.nodes,
  };
}
