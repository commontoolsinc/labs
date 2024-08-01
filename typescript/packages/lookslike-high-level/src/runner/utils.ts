import { isAlias } from "../builder/index.js";
import { CellImpl, ReactivityLog } from "./cell.js";

export function extractDefaultValues(schema: any): any {
  if (typeof schema !== "object" || schema === null) return undefined;

  if (schema.type === "object") {
    const obj: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties" && typeof value === "object" && value !== null) {
        for (const [propKey, propValue] of Object.entries(value)) {
          const value = extractDefaultValues(propValue);
          if (value !== undefined) obj[propKey] = value;
        }
      }
    }

    return Object.entries(obj).length > 0 ? obj : undefined;
  }

  return schema.default;
}

// Merges objects into a single object, preferring values from later objects.
// Recursively calls itself for nested objects, passing on any objects that
// matching properties.
export function mergeObjects(...objects: any[]): any {
  objects = objects.filter((obj) => obj !== undefined);
  if (objects.length === 0) return undefined;
  if (objects.length === 1) return objects[0];

  const seen = new Set<PropertyKey>();
  const result: any = {};

  for (const obj of objects) {
    // If we have a literal value, return it. Same for arrays, since we wouldn't
    // know how to merge them. Note that earlier objects take precedence, so if
    // an earlier was e.g. an object, we'll return that instead of the literal.
    if (typeof obj !== "object" || obj === null || Array.isArray(obj))
      return obj;

    // Then merge objects, only passing those on that have any values.
    for (const key of Object.keys(obj)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const merged = mergeObjects(...objects.map((obj) => obj[key]));
      if (merged !== undefined) result[key] = merged;
    }
  }

  return result;
}

// Sends a value to a binding. If the binding is an array or object, it'll
// traverse the binding and the valye in parallel accordingly. If the binding is
// an alias, it will send the value to the aliased cell. If the binding is
// a literal, we verify that it matches the value and throw an error otherwise.
export function sendValueToBinding(
  cell: CellImpl<any>,
  binding: any,
  value: any,
  log?: ReactivityLog
) {
  if (isAlias(binding)) {
    cell.setAtPath(binding.$alias.path, value);
    log?.writes.add(cell);
  } else if (Array.isArray(binding)) {
    if (Array.isArray(value))
      for (let i = 0; i < Math.min(binding.length, value.length); i++)
        sendValueToBinding(cell, binding[i], value[i], log);
  } else if (typeof binding === "object" && binding !== null) {
    for (const key of Object.keys(binding))
      if (key in value) sendValueToBinding(cell, binding[key], value[key], log);
  } else {
    if (binding !== value)
      throw new Error(`Got ${value} instead of ${binding}`);
  }
}

// Turn local aliases into explicit aliases to named cell.
export function mapBindingsToCell<T>(binding: T, cell: CellImpl<any>): T {
  function convert(binding: any): any {
    if (isAlias(binding))
      return {
        $alias: { ...binding.$alias, cell },
      };
    if (Array.isArray(binding)) return binding.map(convert);
    if (typeof binding === "object" && binding !== null)
      return Object.fromEntries(
        Object.entries(binding).map(([key, value]) => [key, convert(value)])
      );
    return binding;
  }
  return convert(binding) as T;
}

// Traverses binding and returns all cells reacheable through aliases.
export function findAllAliasedCells(binding: any): Set<CellImpl<any>> {
  const cells = new Set<CellImpl<any>>();
  function find(binding: any) {
    if (isAlias(binding)) {
      cells.add(binding.$alias.cell);
      find(binding.$alias.cell.getAtPath(binding.$alias.path));
    } else if (Array.isArray(binding)) {
      for (const value of binding) find(value);
    } else if (typeof binding === "object" && binding !== null) {
      for (const value of Object.values(binding)) find(value);
    }
  }
  find(binding);
  return cells;
}
