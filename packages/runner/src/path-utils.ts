import { valueEqual } from "@commonfabric/data-model/fabric-value";
import { isRecord } from "@commonfabric/utils/types";

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

  // Note: `valueEqual()` throws on a function or a non-`Fabric` class
  // instance; both operands here are `FabricValue`s by contract.
  if (valueEqual(parent[path[path.length - 1]], value)) return false;

  // We just set the values here. If you need to delete elements from an
  // array or object, set it to another array or object without those elements.
  // We can set value to undefined here without issue
  parent[path[path.length - 1]] = value;

  return true;
}

export function getValueAtPath(obj: any, path: readonly PropertyKey[]): any {
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
  return true;
}

export function arrayEqual(
  a?: readonly PropertyKey[],
  b?: readonly PropertyKey[],
): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
