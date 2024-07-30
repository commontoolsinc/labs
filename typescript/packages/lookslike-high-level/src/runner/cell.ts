import { getValueAtPath, setValueAtPath } from "../builder/utils.js";

export type Cell<T> = {
  get(): T;
  getAsProxy(path?: PropertyKey[]): CellValueProxy<T> | T;
  send(value: T): void;
  sink(callback: (value: T) => void): () => void;
  getAtPath(path: PropertyKey[]): T;
  setAtPath(path: PropertyKey[], newValue: any): void;
  [isCellMarker]: true;
};

export type CellReference = {
  cell: Cell<any>;
  path: PropertyKey[];
};

export type CellValueProxy<T> = T & {
  set(value: T): void;
  [getCellReference]: [Cell<any>, PropertyKey[]];
};

export function cell<T>(value?: T): Cell<T> {
  const callbacks = new Set<(value: T) => void>();

  const self: Cell<T> = {
    get: () => value as T,
    getAsProxy: (path: PropertyKey[] = []) => createProxy(self, path),
    send: (newValue: T) => {
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
    [isCellMarker]: true,
  };

  return self;
}

export function createProxy<T>(
  cell: Cell<T>,
  path: PropertyKey[]
): CellValueProxy<T> | T {
  const target = cell.getAtPath(path);
  if (typeof target !== "object" || target === null) return target;

  return new Proxy(target as object, {
    get: (_target, prop) => {
      if (prop === getCellReference)
        return { cell, path } satisfies CellReference;
      const value = cell.getAtPath([...path, prop]);
      if (typeof value !== "object" || value === null) return value;
      // TODO: Follow multiple references
      if ("$ref" in value && Array.isArray(value.$ref))
        return createProxy(cell, value.$ref);
      if (isCell(value)) return createProxy(value, []);
      if (isCellReference(value)) return createProxy(value.cell, value.path);
      else return createProxy(cell, [...path, prop]);
    },
    set: (_target, prop, value) => {
      if (isCellProxy(value)) value = value[getCellReference];
      cell.setAtPath([...path, prop], value);
      return true;
    },
  }) as CellValueProxy<T>;
}

const isCellMarker = Symbol("isCell");
export function isCell(value: any): value is Cell<any> {
  return typeof value === "object" && value[isCellMarker] === true;
}

export function isCellReference(value: any): value is CellReference {
  return (
    typeof value === "object" && isCell(value.cell) && Array.isArray(value.path)
  );
}

const getCellReference = Symbol("isCellProxy");
export function isCellProxy(value: any): value is CellValueProxy<any> {
  return typeof value === "object" && value[getCellReference] !== undefined;
}
