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
  : T & CellMethods<T>;

type CellMethods<T> = {
  get: (() => T) & Cell<T>;
  send: ((value: T, path?: Path) => void) & Cell<T>;
  updates: ((subscriber: Sendable<void>) => Cancel) & Cell<T>;
};

export function cell<T>(value: T): Cell<T> {
  const subscribers = new Set<Sendable<void>>();

  const state = {
    get: () => value,
    send: (newValue: T) => {
      if (deepEqual(value, newValue)) return;
      value = newValue;
      for (const subscriber of subscribers) subscriber.send();
    },
    updates: (subscriber: Sendable<void>) => {
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

export const toValue = <T>(cell: MaybeCellFor<T>): T => {
  if (isSignal<T>(cell)) return cell.get();
  if (Array.isArray(cell)) return cell.map(toValue) as T;
  if (typeof cell === "object")
    return Object.fromEntries(
      Object.entries(cell as object).map(([key, value]) => [
        key,
        toValue(value),
      ])
    ) as T;
  return cell as T;
};

type Path = (string | number | symbol)[];

// Set a property on a cell, given a path to the property. If there are nested
// cells on the path, call setProp with those cells for the rest of the path.
function setProp(cell: Cell<any>, path: Path, value: any) {
  let root = cell.get();
  if (isCell(root)) return root.send(value, path);

  if (path.length === 0) return cell.send(value);

  if (typeof root !== "object" && !Array.isArray(root))
    throw new Error("Can't use path on non-object or non-array.");
  root = Array.isArray(root) ? [...root] : { ...root };

  let parent = root;
  const last = path.pop()!;
  while (path.length > 0) {
    const prop = path.shift()!;
    let next = parent[prop];
    if (isCell(next)) return next.send(value, path);
    if (typeof next !== "object" && !Array.isArray(next))
      throw new Error("Can't use path on non-object or non-array.");
    parent[prop] = Array.isArray(next) ? [...next] : { ...next };
    parent = parent[prop];
  }

  if (isCell(parent[last])) return parent[last].send(value, []);

  parent[last] = value;
  return cell.send(root);
}

function createCellProxy(
  target: object | Function,
  state: WriteableSignal<any>,
  path: Path
): Cell<any> {
  const methods: { [key: string | symbol]: any } = {
    get: () => createCellValueProxy(state, path),
    send: (value: any, extraPath: Path = []) =>
      setProp(state, [...path, ...extraPath], value),
    updates: (subscriber: Sendable<void>) => state.updates(subscriber),
  } satisfies CellMethods<any>;
  return new Proxy(target, {
    get(_target, prop: string | symbol) {
      return createCellProxy(methods[prop] ?? {}, state, [...path, prop]);
    },
    set(_target, _prop: string | symbol, _value: any) {
      return false;
    },
  }) as Cell<any>;
}

function createCellValueProxy(
  state: WriteableSignal<any>,
  valuePath: Path
): any {
  let target = state.get();
  while (isCell(target)) {
    state = target;
    target = state.get();
  }
  let path: Path = [];
  target = valuePath.reduce((acc, prop) => {
    path.push(prop);
    let next = acc[prop];
    while (isCell(next)) {
      state = next;
      next = state.get();
      path = [];
    }
    return next;
  }, target);
  if (typeof target !== "object") return target;
  return new Proxy(target, {
    get(_target, prop: string | symbol) {
      return createCellValueProxy(state, [...path, prop]);
    },
    set(_target, prop: string | symbol, value: any) {
      createCellProxy({}, state, [...path, prop]).send(value);
      return true;
    },
  });
}

function deepEqual(a: any, b: any): boolean {
  return (
    a === b ||
    (a &&
      b &&
      typeof a === "object" &&
      typeof b === "object" &&
      (Array.isArray(a)
        ? Array.isArray(b) &&
          a.length === b.length &&
          a.every((v, i) => deepEqual(v, b[i]))
        : !Array.isArray(b) &&
          Object.keys(a).length === Object.keys(b).length &&
          Object.keys(a).every(
            (k) => k in b && deepEqual((a as any)[k], (b as any)[k])
          )))
  );
}
