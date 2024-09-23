import { isAlias, isStreamAlias } from "@commontools/common-builder";
import {
  getValueAtPath,
  setValueAtPath,
  deepEqual,
} from "@commontools/common-builder";
import {
  followCellReferences,
  followAliases,
  setNestedValue,
  pathAffected,
  transformToSimpleCells,
  makeArrayElementsAllCells,
} from "./utils.js";
import { queueEvent } from "./scheduler.js";

/**
 * This is the regular Cell interface, generated by CellImpl.asSimpleCell().
 * This abstracts away the paths behind an interface that e.g. the UX code or
 * modules that prefer cell interfaces can use.
 *
 * @method get Returns the current value of the cell.
 * @returns {T}
 *
 * @method set Alias for `send`. Sets a new value for the cell.
 * @method send Sets a new value for the cell.
 * @param {T} value - The new value to set.
 * @returns {void}
 *
 * @method key Returns a new cell for the specified key path.
 * @param {K} valueKey - The key to access in the cell's value.
 * @returns {Cell<T[K]>}
 */
export interface Cell<T> {
  get(): T;
  set(value: T): void;
  send(value: T): void;
  sink(callback: (value: T) => void): () => void;
  key<K extends keyof T>(valueKey: K): Cell<T[K]>;
  getAsProxy(path?: PropertyKey[], log?: ReactivityLog): CellProxy<T>;
}

export interface ReactiveCell<T> {
  sink(callback: (value: T) => void): () => void;
}

export type CellImpl<T> = {
  get(): T;
  getAsProxy(path?: PropertyKey[], log?: ReactivityLog): T;
  asSimpleCell<Q = T>(path?: PropertyKey[], log?: ReactivityLog): Cell<Q>;
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

export type CellProxyInternals = {
  [getCellReference]: CellReference;
};

export type CellProxy<T> = T & CellProxyInternals;

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
      createValueProxy(self, path, log),
    asSimpleCell: <Q = T>(path: PropertyKey[] = [], log?: ReactivityLog) =>
      simpleCell<Q>(self, path, log),
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
        // Changes all array elements to cells, reusing previous cells
        makeArrayElementsAllCells(newValue, self.getAtPath(path));
        changed = setValueAtPath(value, path, newValue);
      } else {
        changed = makeArrayElementsAllCells(newValue, value);
        if (changed) value = newValue;
      }
      if (changed) {
        log?.writes.push({ cell: self, path });
        for (const callback of callbacks) callback(value as T, path);
      }
      return changed;
    },
    freeze: () => {
      readOnly = true;
      /* NOTE: Can't freeze actual object, since otherwise JS throws type errors
      for the cases where the proxy returns different values than what is
      proxied, e.g. for aliases. TODO: Consider changing proxy here. */
    },
    isFrozen: () => readOnly,
    [isCellMarker]: true,
  };

  return self;
}

function simpleCell<T>(
  cell: CellImpl<any>,
  path: PropertyKey[],
  log?: ReactivityLog
): Cell<T> {
  // Follow aliases, cell references, etc. in path. Note that
  // transformToSimpleCells will follow aliases, but not cell references, so
  // this is just for setup. Arguably key() should possibly fail if it crosses a
  // cell, but right now it'll silently cross cells.
  let keys = [...path];
  let target = cell.get();
  while (keys.length) {
    const key = keys.shift()!;
    target = target instanceof Object ? target[key] : undefined;
    const seen = new Set();
    let ref: CellReference | undefined;
    do {
      if (typeof target === "object" && target !== null) {
        if (seen.has(target)) {
          throw new Error("Cyclic cell reference");
        } else {
          seen.add(target);
        }
      }

      ref = undefined;
      if (isCellProxyForDereferencing(target)) ref = target[getCellReference];
      else if (isCellReference(target)) ref = followCellReferences(target, log);
      else if (isCell(target))
        ref = { cell: target, path: [] } satisfies CellReference;
      else if (isAlias(target)) ref = followAliases(target, cell, log);

      if (ref) {
        target = ref.cell.getAtPath(ref.path);
        cell = ref.cell;
        path = [...ref.path, ...keys];
      }
    } while (ref);
  }

  const self: Cell<T> = isStreamAlias(cell.getAtPath(path))
    ? ({
        // Implementing just Sendable<T>
        send: (event: T) => {
          log?.writes.push({ cell: cell, path });
          queueEvent({ cell: cell, path }, event);
        },
      } as Cell<T>)
    : {
        get: () => transformToSimpleCells(cell, cell.getAtPath(path), log) as T,
        set: (newValue: T) => cell.setAtPath(path, newValue, log),
        send: (newValue: T) => self.set(newValue),
        sink: (callback: (value: T) => void) => {
          return cell.sink(
            (value, changedPath) =>
              pathAffected(changedPath, path) &&
              callback(
                transformToSimpleCells(cell, getValueAtPath(value, path), log)
              )
          );
        },
        key: <K extends keyof T>(key: K) =>
          cell.asSimpleCell([...path, key], log) as Cell<T[K]>,
        getAsProxy: (subPath: PropertyKey[] = [], newLog?: ReactivityLog) =>
          createValueProxy(cell, [...path, ...subPath], newLog ?? log),
      };
  return self;
}

// Array.prototype's entries, and whether they modify the array
enum ArrayMethodType {
  ReadOnly,
  ReadWrite,
  WriteOnly,
}

const arrayMethods: { [key: string]: ArrayMethodType } = {
  at: ArrayMethodType.ReadOnly,
  concat: ArrayMethodType.ReadOnly,
  entries: ArrayMethodType.ReadOnly,
  every: ArrayMethodType.ReadOnly,
  fill: ArrayMethodType.WriteOnly,
  filter: ArrayMethodType.ReadOnly,
  find: ArrayMethodType.ReadOnly,
  findIndex: ArrayMethodType.ReadOnly,
  findLast: ArrayMethodType.ReadOnly,
  findLastIndex: ArrayMethodType.ReadOnly,
  includes: ArrayMethodType.ReadOnly,
  indexOf: ArrayMethodType.ReadOnly,
  join: ArrayMethodType.ReadOnly,
  keys: ArrayMethodType.ReadOnly,
  lastIndexOf: ArrayMethodType.ReadOnly,
  map: ArrayMethodType.ReadOnly,
  pop: ArrayMethodType.ReadWrite,
  push: ArrayMethodType.WriteOnly,
  reduce: ArrayMethodType.ReadOnly,
  reduceRight: ArrayMethodType.ReadOnly,
  reverse: ArrayMethodType.ReadWrite,
  shift: ArrayMethodType.ReadWrite,
  slice: ArrayMethodType.ReadOnly,
  some: ArrayMethodType.ReadOnly,
  sort: ArrayMethodType.ReadWrite,
  splice: ArrayMethodType.ReadWrite,
  toLocaleString: ArrayMethodType.ReadOnly,
  toString: ArrayMethodType.ReadOnly,
  unshift: ArrayMethodType.WriteOnly,
  values: ArrayMethodType.ReadOnly,
  with: ArrayMethodType.ReadOnly,
};

export function createValueProxy<T>(
  cell: CellImpl<T>,
  path: PropertyKey[],
  log?: ReactivityLog
): T {
  log?.reads.push({ cell, path });

  // Follow path, following aliases and cells, so might end up on different cell
  let target = cell.get() as any;
  const keys = [...path];
  path = [];
  while (keys.length) {
    const key = keys.shift()!;
    if (isCellProxyForDereferencing(target)) {
      const ref = target[getCellReference];
      cell = ref.cell;
      path = ref.path;
    } else if (isAlias(target)) {
      const ref = followAliases(target, cell, log);
      cell = ref.cell;
      path = ref.path;
    } else if (isCell(target)) {
      cell = target;
      path = [];
      log?.reads.push({ cell, path });
      target = target.get();
    } else if (isCellReference(target)) {
      const ref = followCellReferences(target, log);
      cell = ref.cell;
      path = ref.path;
    }
    path.push(key);
    if (typeof target === "object" && target !== null) {
      target = target[key as keyof typeof target];
    } else {
      target = undefined;
    }
  }

  // Now target is the end of the path. It might still be a cell, alias or cell
  // reference, so we follow these as well.
  if (isCellProxy(target)) {
    const ref = target[getCellReference];
    return createValueProxy(ref.cell, ref.path, log);
  } else if (isCell(target)) {
    return createValueProxy(target, [], log);
  } else if (isAlias(target)) {
    const ref = followAliases(target, cell, log);
    return createValueProxy(ref.cell, ref.path, log);
  } else if (isCellReference(target)) {
    const ref = followCellReferences(target, log);
    return createValueProxy(ref.cell, ref.path, log);
  } else if (typeof target !== "object" || target === null) return target;

  return new Proxy(target as object, {
    get: (target, prop, receiver) => {
      if (typeof prop === "symbol") {
        if (prop === getCellReference)
          return { cell, path } satisfies CellReference;

        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function") return value.bind(receiver);
        else return value;
      }

      if (Array.isArray(target) && prop in arrayMethods) {
        const method = Array.prototype[prop as keyof typeof Array.prototype];
        const isReadWrite = arrayMethods[prop as keyof typeof arrayMethods];

        return isReadWrite === ArrayMethodType.ReadOnly
          ? (...args: any[]) => {
              // This will also mark each element read in the log. Almost all
              // methods implicitly read all elements. TODO: Deal with
              // exceptions like at().
              const copy = target.map((_, index) =>
                createValueProxy(cell, [...path, index], log)
              );

              return method.apply(copy, args);
            }
          : (...args: any[]) => {
              // Operate on a copy so we can diff. For write-only methods like
              // push, don't proxy the other members so we don't log reads.
              // TODO: Some methods like pop() and shift() don't read the whole
              // array, so we could optimize that.
              const copy =
                isReadWrite === ArrayMethodType.WriteOnly
                  ? [...target]
                  : target.map((_, index) =>
                      createValueProxy(cell, [...path, index], log)
                    );

              const result = method.apply(copy, args);
              setNestedValue(cell, path, copy, log);
              return result;
            };
      }

      return createValueProxy(cell, [...path, prop], log);
    },
    set: (target, prop, value) => {
      if (isCellProxy(value)) value = value[getCellReference];

      if (Array.isArray(target) && prop === "length") {
        const oldLength = target.length;
        const result = setNestedValue(cell, [...path, prop], value, log);
        const newLength = value;
        if (result) {
          for (
            let i = Math.min(oldLength, newLength);
            i < Math.max(oldLength, newLength);
            i++
          ) {
            log?.writes.push({ cell, path: [...path, i] });
            queueEvent({ cell, path: [...path, i] }, undefined);
          }
        }
        return result;
      }

      return setNestedValue(cell, [...path, prop], value, log);
    },
  }) as T;
}

export function getCellReferenceOrValue(value: any): CellReference {
  if (isCellProxy(value)) return value[getCellReference];
  else return value;
}

export function getCellReferenceOrThrow(value: any): CellReference {
  if (isCellProxy(value)) return value[getCellReference];
  else throw new Error("Value is not a cell reference");
}

const isCellMarker = Symbol("isCell");
export function isCell(value: any): value is CellImpl<any> {
  return (
    typeof value === "object" && value !== null && value[isCellMarker] === true
  );
}

export function isCellReference(value: any): value is CellReference {
  return (
    typeof value === "object" &&
    value !== null &&
    isCell(value.cell) &&
    Array.isArray(value.path)
  );
}

const getCellReference = Symbol("isCellProxy");
export function isCellProxy(value: any): value is CellProxy<any> {
  return (
    typeof value === "object" &&
    value !== null &&
    value[getCellReference] !== undefined
  );
}

export function isCellProxyForDereferencing(
  value: any
): value is CellProxyInternals {
  return isCellProxy(value);
}

export const isReactive = <T = any>(
  value: ReactiveCell<T>
): value is ReactiveCell<T> => {
  return (
    typeof value === "object" &&
    "sink" in value &&
    typeof value.sink === "function"
  );
};
