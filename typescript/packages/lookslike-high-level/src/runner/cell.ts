import { isAlias } from "../builder/types.js";
import { getValueAtPath, setValueAtPath } from "../builder/utils.js";
import {
  followCellReferences,
  followAliases,
  setNestedValue,
} from "./utils.js";

export type CellImpl<T> = {
  get(): T;
  getAsProxy(path?: PropertyKey[], log?: ReactivityLog): Cell<T> | T;
  send(value: T, log?: ReactivityLog): boolean;
  updates(callback: (value: T, path: PropertyKey[]) => void): () => void;
  sink(callback: (value: T, path: PropertyKey[]) => void): () => void;
  getAtPath(path: PropertyKey[]): T;
  setAtPath(path: PropertyKey[], newValue: any, log?: ReactivityLog): boolean;
  freeze(): void;
  isFrozen(): boolean;
  [isCellMarker]: true;
};

export type CellReference = {
  cell: CellImpl<any>;
  path: PropertyKey[];
};

export type Cell<T> = T & {
  set(value: T): void;
  [getCellReference]: [CellImpl<any>, PropertyKey[]];
};

export type ReactivityLog = {
  reads: CellReference[];
  writes: CellReference[];
};

export function cell<T>(value?: T): CellImpl<T> {
  const callbacks = new Set<(value: T, path: PropertyKey[]) => void>();
  let readOnly = false;

  const self: CellImpl<T> = {
    get: () => value as T,
    getAsProxy: (path: PropertyKey[] = [], log?: ReactivityLog) =>
      createProxy(self, path, log),
    send: (newValue: T, log?: ReactivityLog) =>
      self.setAtPath([], newValue, log),
    updates: (callback: (value: T, path: PropertyKey[]) => void) => {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    sink: (callback: (value: T, path: PropertyKey[]) => void) => {
      callback(value as T, []);
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    getAtPath: (path: PropertyKey[]) => getValueAtPath(value, path),
    setAtPath: (path: PropertyKey[], newValue: any, log?: ReactivityLog) => {
      if (readOnly) throw new Error("Cell is read-only");
      let changed = false;
      if (path.length > 0) {
        changed = setValueAtPath(value, path, newValue);
      } else if (value !== newValue) {
        changed = true;
        value = newValue;
      }
      if (changed) {
        log?.writes.push({ cell: self, path });
        for (const callback of callbacks) callback(value as T, path);
      }
      return changed;
    },
    freeze: () => {
      readOnly = true;
      value = Object.freeze(value);
    },
    isFrozen: () => readOnly,
    [isCellMarker]: true,
  };

  return self;
}

export function createProxy<T>(
  cell: CellImpl<T>,
  path: PropertyKey[],
  log?: ReactivityLog
): Cell<T> | T {
  const target = cell.getAtPath(path);
  if (isCell(target)) return createProxy(target, []);
  else if (isAlias(target)) {
    const ref = followAliases(target, cell, log);
    return createProxy(ref.cell, ref.path);
  } else if (isCellReference(target)) {
    const ref = followCellReferences(target, log);
    return createProxy(ref.cell, ref.path);
  } else if (typeof target !== "object" || target === null) return target;

  return new Proxy(target as object, {
    get: (_target, prop) => {
      if (prop === getCellReference)
        return { cell, path } satisfies CellReference;
      else if (typeof prop === "symbol") return; // TODO: iterators, etc.

      log?.reads.push({ cell, path: [...path, prop] });
      return createProxy(cell, [...path, prop]);
    },
    set: (_target, prop, value) => {
      if (isCellProxy(value)) value = value[getCellReference];

      return setNestedValue(cell, [...path, prop], value, log);
    },
  }) as Cell<T>;
}

const isCellMarker = Symbol("isCell");
export function isCell(value: any): value is CellImpl<any> {
  return typeof value === "object" && value[isCellMarker] === true;
}

export function isCellReference(value: any): value is CellReference {
  return (
    typeof value === "object" && isCell(value.cell) && Array.isArray(value.path)
  );
}

const getCellReference = Symbol("isCellProxy");
export function isCellProxy(value: any): value is Cell<any> {
  return typeof value === "object" && value[getCellReference] !== undefined;
}
