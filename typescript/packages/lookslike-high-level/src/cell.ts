import { WriteableSignal } from "@commontools/common-frp/signal";
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
  send: ((value: T) => void) & Cell<T>;
  updates: ((subscriber: Sendable<void>) => Cancel) & Cell<T>;
};

export const cell = <T>(value: T): Cell<T> => {
  const subscribers = new Set<Sendable<void>>();

  const state = {
    get: () => value,
    send: (newValue: T) => {
      console.log("send", value, newValue);
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
};

type Path = (string | number | symbol)[];

function getProp(target: any, path: Path): any {
  return path.reduce((acc, prop) => acc[prop], target);
}

function setProp(target: any, path: Path, value: any): any {
  if (path.length === 0) return value;
  if (typeof target !== "object" && !Array.isArray(target))
    throw new Error("Can't use path on non-object or non-array.");
  path = [...path];
  const last = path.pop()!;
  const root = Array.isArray(target) ? [...target] : { ...target };
  const parent = path.reduce(
    (
      acc: { [key: string | symbol]: any } | any[],
      prop: string | number | symbol
    ) =>
      typeof acc === "object" && !Array.isArray(acc)
        ? { ...acc }[prop]
        : [...acc][Number(prop)],
    root
  );

  if (Array.isArray(parent)) parent[Number(last)] = value;
  else parent[last] = value;

  return root;
}

function createCellProxy(
  target: object | Function,
  state: WriteableSignal<any>,
  path: Path
): Cell<any> {
  const methods: { [key: string | symbol]: any } = {
    get: () => createCellValueProxy(getProp(state.get(), path), state, path),
    send: (value: any) => state.send(setProp(state.get(), path, value)),
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
  target: any,
  state: WriteableSignal<any>,
  path: Path
): any {
  if (typeof target !== "object") return target;
  return new Proxy(target, {
    get(_target, prop: string | symbol) {
      return createCellValueProxy(
        getProp(state.get(), [...path, prop]),
        state,
        [...path, prop]
      );
    },
    set(_target, prop: string | symbol, value: any) {
      state.send(setProp(state.get(), [...path, prop], value));
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
