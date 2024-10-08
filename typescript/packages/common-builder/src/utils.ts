import {
  Value,
  Module,
  Recipe,
  CellProxy,
  NodeProxy,
  isCellProxy,
  JSONValue,
  JSON,
  Alias,
  isAlias,
  canBeCellProxy,
  makeCellProxy,
} from "./types.js";

/** traverse a value, _not_ entering cells */
export function traverseValue(value: Value<any>, fn: (value: any) => any) {
  fn(value);
  if (Array.isArray(value)) value.forEach((v) => traverseValue(v, fn));
  else if (
    !isCellProxy(value) &&
    !canBeCellProxy(value) &&
    typeof value === "object" &&
    value !== null
  )
    for (const key in value as any) traverseValue(value[key], fn);
}

export function setValueAtPath(
  obj: any,
  path: PropertyKey[],
  value: any
): boolean {
  let parent = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (typeof parent[key] !== "object")
      parent[key] = typeof path[i + 1] === "number" ? [] : {};
    parent = parent[key];
  }

  if (deepEqual(parent[path[path.length - 1]], value)) return false;

  if (value === undefined) {
    delete parent[path[path.length - 1]];
    // Truncate array from the end for undefined values
    if (Array.isArray(parent)) {
      while (parent.length > 0 && parent[parent.length - 1] === undefined)
        parent.pop();
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
    if (!current || typeof current !== "object" || !(key in current))
      return false;
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
  value: Value<any>,
  paths: Map<CellProxy<any>, PropertyKey[]>,
  ignoreSelfAliases: boolean = false,
  path: PropertyKey[] = []
): JSONValue | undefined {
  if (canBeCellProxy(value)) value = makeCellProxy(value);
  if (isCellProxy(value)) {
    const pathToCell = paths.get(value);
    if (pathToCell) {
      if (ignoreSelfAliases && deepEqual(path, pathToCell)) return undefined;

      return {
        $alias: { path: pathToCell as (string | number)[] },
      } satisfies Alias;
    } else throw new Error(`Cell not found in paths`);
  }

  if (Array.isArray(value))
    return (value as Value<any>).map((v: Value<any>, i: number) =>
      toJSONWithAliases(v, paths, ignoreSelfAliases, [...path, i])
    );

  if (typeof value === "object") {
    const result: any = {};
    let hasValue = false;
    for (const key in value as any) {
      const jsonValue = toJSONWithAliases(
        value[key],
        paths,
        ignoreSelfAliases,
        [...path, key]
      );
      if (jsonValue !== undefined) {
        result[key] = jsonValue;
        hasValue = true;
      }
    }

    return hasValue || Object.keys(result).length === 0 ? result : undefined;
  }

  return value;
}

export function createJsonSchema(
  defaultValues: any,
  referenceValues: any
): JSON {
  function analyzeType(value: any, defaultValue: any): JSON {
    if (isAlias(value)) {
      const path = value.$alias.path;
      return analyzeType(
        getValueAtPath(defaultValues, path),
        getValueAtPath(referenceValues, path)
      );
    }

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
      case "undefined":
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

export function connectInputAndOutputs(node: NodeProxy) {
  traverseValue(node.inputs, (value) => {
    if (canBeCellProxy(value)) value = makeCellProxy(value);
    if (isCellProxy(value)) value.connect(node);
  });
}
