import { WriteableSignal, isSignal } from "@commontools/common-frp/signal";
import { Sendable, Cancel } from "@commontools/common-frp";

/**
 * A cell is a container for updatable state.
 *
 * Cell<T> is a proxy that allows direct access to members of T, returning
 * scoped Cell<subset of T> instances, while still allowing .get(), .send() and
 * .updates() on every element. Even foo.get.bar.get() works.
 *
 * Cell<T> is compatible with WriteableSignal<T>, i.e. a signal from common-frp.
 */
export type Cell<T> = T extends (infer U)[]
  ? Array<Cell<U>> & CellMethods<T>
  : T extends object
  ? {
      [K in keyof T]: Cell<T[K]>;
    } & CellMethods<T>
  : T extends number | string | boolean | symbol
  ? T & CellMethods<T>
  : CellMethods<T>;

// For use on values to get a reference to self, so you can set it:
// const array = asValue(cell([1])); array[self] = [2];
// Useful when passed as parameter to a function.
export const self = Symbol("self");

export type CellMethods<T> = {
  get: (() => T & { [self]: T }) & Cell<T>;
  send: ((value: T | UnwrapCell<T> | MaybeCellFor<T>, path?: Path) => void) &
    Cell<T>;
  updates: ((subscriber: Sendable<void>) => Cancel) & Cell<T>;
  withLog: (log?: ReactivityLog) => Cell<T>;
};

// This makes it so that we can set a new value on a cell, even if the original
// value was given as a cell. e.g. so that cell(cell(2)).send(3) works.
type UnwrapCell<T> = T extends Cell<infer U> ? U : T;

type MaybeCellFor<T extends any> =
  | {
      [K in keyof T]: Cell<T[K]> | MaybeCellFor<T[K]>;
    }
  | T;

// Create a cell with default value of value. If value is already a cell, it
// just returns it, making sure it's a proxied cell.
export function cell<T>(value: T): Cell<T> {
  if (isValueProxy<T>(value)) return value[getCellProxy]();
  if (isCell<T>(value))
    return isProxy<T>(value) ? value : createCellProxy({}, value, []);

  const subscribers = new Set<Sendable<void>>();

  const state = {
    get: () => value as T,
    send: (newValue: T) => {
      if (deepEqualOfCells(value, newValue)) return;
      value = newValue;
      for (const subscriber of subscribers) subscriber.send();
    },
    updates: (subscriber: Sendable<void>): Cancel => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  } satisfies WriteableSignal<T>;

  return createCellProxy({}, state, []) as Cell<T>;
}

export const isCell = <T>(value: any): value is Cell<T> => isSignal<T>(value);

const isProxy = <T>(value: any): value is Cell<T> & CellProxyMethods<T> =>
  value &&
  typeof (value as unknown as CellProxyMethods<T>)[getCell] === "function";

const isValueProxy = <T>(value: any): value is T & CellValueProxyMethods<T> =>
  value &&
  typeof (value as unknown as CellValueProxyMethods<T>)[getCellProxy] ===
    "function";

// Convert a nested object of cells to a nested object of values.
// As opposed to cell.get(), which does it only one level deep.
export const toValue = <T>(
  cell: MaybeCellFor<T>,
  log?: ReactivityLog
): UnwrapCell<T> => {
  if (isCell<T>(cell)) return cell.withLog(log).get() as UnwrapCell<T>;
  if (Array.isArray(cell))
    return cell.map((cell) => toValue(cell, log)) as UnwrapCell<T>;
  if (typeof cell === "object")
    return Object.fromEntries(
      Object.entries(cell as object).map(([key, value]) => [
        key,
        toValue(value, log) as T,
      ])
    ) as UnwrapCell<T>;
  return cell as UnwrapCell<T>;
};

export interface ReactivityLog {
  reads: Set<Cell<any>>;
  writes: Set<Cell<any>>;
}

type Path = (string | number | symbol)[];

// Set a property on a cell, given a path to the property. If there are nested
// cells on the path, call send on those for the rest of the path. Note that
// this requires cells to be cell proxies underneath, but that should be the
// case if cells were created with `cell` only. There is currently no way to
// expose the underlying cell without the proxy.
function setProp(cell: Cell<any>, path: Path, value: any, log?: ReactivityLog) {
  value = unproxyCellValues(value);

  if (path.length === 0)
    if (isCell(value)) {
      throw "Can't overwrite a cell with another cell.";
    } else {
      log?.writes.add(cell);
      return cell.send(value, []);
    }

  let root = cell.get();
  if (typeof root !== "object" && !Array.isArray(root))
    throw new Error("Can't use path on non-object or non-array.");
  root = Array.isArray(root) ? [...root] : { ...root };

  let parent = root;
  const last = path.pop()!;
  while (path.length > 0) {
    const prop = path.shift()!;
    let next = parent[prop];
    if (isCell(next)) return next.withLog(log).send(value, [...path, last]);
    if (typeof next !== "object")
      throw new Error(
        `Can't access ${String(prop)} on a ${typeof next}, need object/array.`
      );
    parent[prop] = Array.isArray(next) ? [...next] : { ...next };
    parent = parent[prop];
  }

  if (isCell(parent[last]) && !isCell(value))
    return parent[last].withLog(log).send(value, []);
  parent[last] = value;
  log?.writes.add(cell);
  return cell.send(root);
}

function unproxyCellValues<T>(value: T): T {
  if (isValueProxy<T>(value)) return value[getCellProxy]() as T;
  if (isCell(value)) return value;
  if (Array.isArray(value)) return value.map((v) => unproxyCellValues(v)) as T;
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as object).map(([k, v]) => [k, unproxyCellValues(v)])
    ) as T;
  return value;
}

// Internal API for proxies only
const getCell = Symbol("getCell");

type CellProxyMethods<T> = {
  [getCell]: () => [WriteableSignal<T>, Path];
};

function createCellProxy(
  target: object | Function,
  cell: WriteableSignal<any>,
  path: Path,
  log?: ReactivityLog
): Cell<any> {
  const methods: { [key: string | symbol]: any } = {
    get: () => createCellValueProxy(cell, path, log),
    send: (value: any, extraPath: Path = []) =>
      setProp(cell, [...path, ...extraPath], value, log),
    updates: (subscriber: Sendable<void>) => cell.updates(subscriber),
    withLog: (newLog?: ReactivityLog) => {
      if (!newLog || newLog === log) return proxy;
      else if (!log) return createCellProxy(target, cell, path, newLog);
      else throw "Can't nest logging yet";
    },
    [getCell]: () => [cell, path],
  } satisfies CellMethods<any> & CellProxyMethods<any>;
  const proxy: Cell<any> = new Proxy(target, {
    get(_target, prop: string | symbol) {
      return createCellProxy(methods[prop] ?? {}, cell, [...path, prop], log);
    },
    set(_target, _prop: string | symbol, _value: any) {
      return false;
    },
  });
  return proxy;
}

// Internal API for proxies only
const getCellProxy = Symbol("getCellProxy");

type CellValueProxyMethods<T> = {
  [getCellProxy]: () => Cell<T>;
};

function createCellValueProxy(
  cell: WriteableSignal<any>,
  valuePath: Path,
  log?: ReactivityLog
): any {
  log?.reads.add(cell as Cell<any>);

  // Follow path to actual value, might be across nested cells:
  let target = cell.get();
  let path: Path = [];
  for (const prop of valuePath) {
    path.push(prop);
    const value = target[prop];
    if (isProxy(value) || isCell(value)) {
      [cell, path] = isProxy(value) ? value[getCell]() : [value, []];
      path = [...path];
      log?.reads.add(cell as Cell<any>);
      target = value.get();
    } else {
      target = value;
    }
  }

  if (typeof target !== "object") return target;

  const proxy: any = new Proxy(target, {
    get(_target, prop: string | symbol) {
      switch (prop) {
        case self:
          return proxy;
        case getCellProxy:
          return () => createCellProxy({}, cell, path, log);
        default:
          return createCellValueProxy(cell, [...path, prop], log);
      }
    },
    set(_target, prop: string | symbol, value: any) {
      if (prop === self) setProp(cell, path, value, log);
      else setProp(cell, [...path, prop], value, log);
      return true;
    },
  });

  return proxy;
}

function deepEqualOfCells(a: any, b: any): boolean {
  return (
    a === b ||
    (a &&
      b &&
      typeof a === "object" &&
      typeof b === "object" &&
      (isCell(a) && isCell(b)
        ? deepEqualOfCells(a.get(), b.get())
        : Array.isArray(a)
        ? Array.isArray(b) &&
          a.length === b.length &&
          a.every((v, i) => deepEqualOfCells(v, b[i]))
        : !Array.isArray(b) &&
          Object.keys(a).length === Object.keys(b).length &&
          Object.keys(a).every(
            (k) => k in b && deepEqualOfCells((a as any)[k], (b as any)[k])
          )))
  );
}
