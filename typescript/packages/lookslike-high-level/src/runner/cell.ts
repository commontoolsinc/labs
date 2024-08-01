import { isReference } from "../builder/types.js";
import { getValueAtPath, setValueAtPath } from "../builder/utils.js";

export type CellImpl<T> = {
  get(): T;
  getAsProxy(path?: PropertyKey[]): Cell<T> | T;
  send(value: T): void;
  sink(callback: (value: T) => void): () => void;
  getAtPath(path: PropertyKey[]): T;
  setAtPath(path: PropertyKey[], newValue: any): void;
  freeze(): void;
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
  reads: Set<CellImpl<any>>;
  writes: Set<CellImpl<any>>;
};

export function cell<T>(value?: T): CellImpl<T> {
  const callbacks = new Set<(value: T) => void>();
  let readOnly = false;

  const self: CellImpl<T> = {
    get: () => value as T,
    getAsProxy: (path: PropertyKey[] = [], log?: ReactivityLog) =>
      createProxy(self, path, log),
    send: (newValue: T) => {
      if (readOnly) throw new Error("Cell is read-only");
      value = newValue;
      for (const callback of callbacks) callback(value as T);
    },
    sink: (callback: (value: T) => void) => {
      callback(value as T);
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    getAtPath: (path: PropertyKey[]) => getValueAtPath(value, path),
    setAtPath: (path: PropertyKey[], newValue: any) => {
      setValueAtPath(value, path, newValue);
      for (const callback of callbacks) callback(value as T);
    },
    freeze: () => {
      readOnly = true;
      value = Object.freeze(value);
    },
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
  if (typeof target !== "object" || target === null) return target;

  return new Proxy(target as object, {
    apply: (_target, _thisArg, argumentsList) => {
      if (!path.length || path[path.length - 1] !== "set")
        throw new Error("only calls to set are supported");
      log?.writes.add(cell);
      cell.setAtPath(path, argumentsList[0]);
    },
    get: (_target, prop) => {
      if (prop === getCellReference)
        return { cell, path } satisfies CellReference;
      else if (typeof prop === "symbol") return; // TODO: iterators, etc.

      log?.reads.add(cell);

      const value = cell.getAtPath([...path, prop]);
      if (typeof value !== "object" || value === null) return value;
      if (isReference(value))
        return createProxy(value.$ref.cell ?? cell, value.$ref.path);
      if (isCell(value)) return createProxy(value, []);
      if (isCellReference(value)) {
        console.log("isCellReference", value);
        let nextValue: CellReference = value;
        let nextCell = nextValue.cell ?? cell;
        const seen = new Set<CellReference>([nextValue]);
        while (isCellReference(nextCell.getAtPath(nextValue.path))) {
          nextValue = nextValue.cell.getAtPath(nextValue.path);
          if (seen.has(value))
            throw `Infinite cell reference with ${value.path.join(".")}`;
          seen.add(value);
          if (nextValue.cell) {
            nextCell = nextValue.cell;
            log?.reads.add(nextCell);
          } // else: It's a cell-local
        }
        return createProxy(nextCell, nextValue.path);
      } else return createProxy(cell, [...path, prop]);
    },
    set: (_target, prop, value) => {
      if (isCellProxy(value)) value = value[getCellReference];
      log?.writes.add(cell);
      cell.setAtPath([...path, prop], value);
      return true;
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
