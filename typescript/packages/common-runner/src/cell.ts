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
  normalizeToCells,
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

export interface GettableCell<T> {
  get(): T;
}

export interface SendableCell<T> {
  send(value: T): void;
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
  value: T;
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
        changed = setValueAtPath(value, path, newValue);
      } else if (!deepEqual(value, newValue)) {
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
      /* NOTE: Can't freeze actual object, since otherwise JS throws type errors
      for the cases where the proxy returns different values than what is
      proxied, e.g. for aliases. TODO: Consider changing proxy here. */
    },
    isFrozen: () => readOnly,
    get value(): T {
      return value as T;
    },
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
  valueCell: CellImpl<T>,
  valuePath: PropertyKey[],
  log?: ReactivityLog
): T {
  log?.reads.push({ cell: valueCell, path: valuePath });

  // Follow path, following aliases and cells, so might end up on different cell
  let target = valueCell.get() as any;
  const keys = [...valuePath];
  valuePath = [];
  while (keys.length) {
    const key = keys.shift()!;
    if (isCellProxyForDereferencing(target)) {
      const ref = target[getCellReference];
      valueCell = ref.cell;
      valuePath = ref.path;
    } else if (isAlias(target)) {
      const ref = followAliases(target, valueCell, log);
      valueCell = ref.cell;
      valuePath = ref.path;
    } else if (isCell(target)) {
      valueCell = target;
      valuePath = [];
      log?.reads.push({ cell: valueCell, path: valuePath });
      target = target.get();
    } else if (isCellReference(target)) {
      const ref = followCellReferences(target, log);
      valueCell = ref.cell;
      valuePath = ref.path;
    }
    valuePath.push(key);
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
    const ref = followAliases(target, valueCell, log);
    return createValueProxy(ref.cell, ref.path, log);
  } else if (isCellReference(target)) {
    const ref = followCellReferences(target, log);
    return createValueProxy(ref.cell, ref.path, log);
  } else if (typeof target !== "object" || target === null) return target;

  return new Proxy(target as object, {
    get: (target, prop, receiver) => {
      if (typeof prop === "symbol") {
        if (prop === getCellReference)
          return { cell: valueCell, path: valuePath } satisfies CellReference;

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
                createValueProxy(valueCell, [...valuePath, index], log)
              );

              return method.apply(copy, args);
            }
          : (...args: any[]) => {
              // Operate on a copy so we can diff. For write-only methods like
              // push, don't proxy the other members so we don't log reads.
              // Wraps values in a proxy that remembers the original index and
              // creates cell value proxies on demand.
              let copy: any;
              if (isReadWrite === ArrayMethodType.WriteOnly) copy = [...target];
              else
                copy = target.map((_, index) =>
                  createProxyForArrayValue(
                    index,
                    valueCell,
                    [...valuePath, index],
                    log
                  )
                );

              let result = method.apply(copy, args);

              // Unwrap results and return as value proxies
              if (isProxyForArrayValue(result)) result = result.valueOf();
              else if (Array.isArray(result))
                result = result.map((value) =>
                  isProxyForArrayValue(value) ? value.valueOf() : value
                );

              if (isReadWrite === ArrayMethodType.ReadWrite)
                // Undo the proxy wrapping and assign original items.
                copy = copy.map((value: any) =>
                  isProxyForArrayValue(value)
                    ? target[value[originalIndex]]
                    : value
                );

              // Turn any newly added elements into cells. And if there was a
              // change at all, update the cell.
              normalizeToCells(copy, target, log);
              setNestedValue(valueCell, valuePath, copy, log);

              return result;
            };
      }

      return createValueProxy(valueCell, [...valuePath, prop], log);
    },
    set: (target, prop, value) => {
      if (isCellProxy(value)) value = value[getCellReference];

      if (Array.isArray(target) && prop === "length") {
        const oldLength = target.length;
        const result = setNestedValue(
          valueCell,
          [...valuePath, prop],
          value,
          log
        );
        const newLength = value;
        if (result) {
          for (
            let i = Math.min(oldLength, newLength);
            i < Math.max(oldLength, newLength);
            i++
          ) {
            log?.writes.push({ cell: valueCell, path: [...valuePath, i] });
            queueEvent({ cell: valueCell, path: [...valuePath, i] }, undefined);
          }
        }
        return result;
      }

      // Make sure that any nested arrays are made of cells.
      normalizeToCells(value, undefined, log);

      if (isCell(value))
        value = { cell: value, path: [] } satisfies CellReference;

      // When setting a value in an array, make sure it's a cell reference.
      if (Array.isArray(target) && !isCellReference(value)) {
        value = { cell: cell(value), path: [] };
        log?.writes.push(value);
      }

      return setNestedValue(valueCell, [...valuePath, prop], value, log);
    },
  }) as T;
}

// Wraps a value on an array so that it can be read as literal or object,
// yet when copied will remember the original array index.
type ProxyForArrayValue = {
  valueOf: () => any;
  toString: () => string;
  [originalIndex]: number;
};
const originalIndex = Symbol("original index");

const createProxyForArrayValue = (
  source: number,
  valueCell: CellImpl<any>,
  valuePath: PropertyKey[],
  log?: ReactivityLog
): { [originalIndex]: number } => {
  const target = {
    valueOf: function () {
      return createValueProxy(valueCell, valuePath, log);
    },
    toString: function () {
      return String(createValueProxy(valueCell, valuePath, log));
    },
    [originalIndex]: source,
  };

  return target;
};

function isProxyForArrayValue(value: any): value is ProxyForArrayValue {
  return typeof value === "object" && value !== null && originalIndex in value;
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

export const isGettable = <T = any>(
  value: GettableCell<T>
): value is GettableCell<T> => {
  return (
    typeof value === "object" &&
    "get" in value &&
    typeof value.get === "function"
  );
};

export const isSendable = <T = any>(
  value: SendableCell<T>
): value is SendableCell<T> => {
  return (
    typeof value === "object" &&
    "send" in value &&
    typeof value.send === "function"
  );
};
