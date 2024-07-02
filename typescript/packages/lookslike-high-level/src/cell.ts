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

type CellMethods<T> = {
  get: (() => T) & Cell<T>;
  send: ((value: T | UnwrapCell<T>, path?: Path) => void) & Cell<T>;
  updates: ((subscriber: Sendable<void>) => Cancel) & Cell<T>;
  withLog: (log?: ReactivityLog) => Cell<T>;
};

// This makes it so that we can set a new value on a cell, even if the original
// value was given as a cell. e.g. so that cell(cell(2)).send(3) works.
type UnwrapCell<T> = T extends Cell<infer U> ? U : T;

export function cell<T>(value: T): Cell<T> {
  const subscribers = new Set<Sendable<void>>();

  const state = {
    get: () => value,
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

type MaybeCellFor<T extends any> =
  | {
      [K in keyof T]: Cell<T[K]> | MaybeCellFor<T[K]>;
    }
  | T;

export const toValue = <T>(cell: MaybeCellFor<T>, log?: ReactivityLog): T => {
  if (isCell<T>(cell)) return cell.withLog(log).get() as T;
  if (Array.isArray(cell)) return cell.map((cell) => toValue(cell, log)) as T;
  if (typeof cell === "object")
    return Object.fromEntries(
      Object.entries(cell as object).map(([key, value]) => [
        key,
        toValue(value, log) as T,
      ])
    ) as T;
  return cell as T;
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

// Internal API for proxies only
const getCell = Symbol("getCell");

type ProxyMethods<T> = {
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
  } satisfies CellMethods<any> & ProxyMethods<any>;
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

function createCellValueProxy(
  cell: WriteableSignal<any>,
  valuePath: Path,
  log?: ReactivityLog
): any {
  log?.reads.add(cell as Cell<any>);

  let target = cell.get();
  let path: Path = [];
  for (const prop of valuePath) {
    path.push(prop);
    if (isCell(target[prop])) {
      [cell, path] = target[prop][getCell]();
      path = [...path];
      log?.reads.add(cell as Cell<any>);
      target = cell.get();
    } else {
      target = target[prop];
    }
  }

  if (typeof target !== "object") return target;

  return new Proxy(target, {
    get(_target, prop: string | symbol) {
      return createCellValueProxy(cell, [...path, prop], log);
    },
    set(_target, prop: string | symbol, value: any) {
      setProp(cell, [...path, prop], value, log);
      return true;
    },
  });
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
