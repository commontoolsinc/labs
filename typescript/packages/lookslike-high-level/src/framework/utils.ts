import { Value, CellProxy, isCell, JSONValue, JSON } from "./types.js";

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
    const type = typeof value;
    const schema: any = { type };

    switch (type) {
      case "object":
        if (Array.isArray(value)) {
          schema.type = "array";
          if (value.length > 0) {
            schema.items = analyzeType(value[0], defaultValue?.[0]);
          }
        } else if (value !== null) {
          schema.type = "object";
          schema.properties = {};
          for (const key in value) {
            schema.properties[key] = analyzeType(
              value[key],
              defaultValue?.[key]
            );
          }
        } else {
          schema.type = "null";
        }
        break;
      case "number":
        if (Number.isInteger(value)) {
          schema.type = "integer";
        }
        break;
    }

    if (defaultValue !== undefined) {
      schema.default = defaultValue;
    }

    return schema;
  }

  return analyzeType(referenceValues, defaultValues);
}
