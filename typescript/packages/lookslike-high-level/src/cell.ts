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
      value = newValue;
      for (const subscriber of subscribers) {
        subscriber.send();
      }
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
  path = [...path];
  const last = path.pop() as string;
  const parent = path.reduce((acc, prop) => acc[prop], target);
  parent[last] = value;
  return target;
}

function createCellProxy(
  target: object | Function,
  state: WriteableSignal<any>,
  path: Path
): Cell<any> {
  const methods: { [key: string | symbol]: any } = {
    get: () => getProp(state.get(), path),
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
