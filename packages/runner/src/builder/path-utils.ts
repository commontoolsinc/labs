import { isRecord } from "@commontools/utils/types";
import { deepEqual } from "./traverse-utils.ts";

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
    if (!isRecord(current) || !(key in current)) {
      return false;
    }
    current = current[key];
  }
  return current !== undefined;
}