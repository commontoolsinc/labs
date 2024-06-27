import { state, WriteableSignal } from "@commontools/common-frp/signal";
import { Sendable, Cancel } from "@commontools/common-frp";

/**
 * A cell is a container for updatable state.
 *
 * Cell<T> is a proxy that allows direct access to members of T, returning
 * scoped Cell<subset of T> instances, while still allowing .get(), .send() and
 * .updates() on every element. Even foo.get.bar.get() works.
 */
export type Cell<T> = T extends (infer U)[]
  ? CellArray<U>
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

interface CellArray<T> extends Array<Cell<T>>, CellMethods<T[]> {}

export type Path = (string | number | symbol)[];

export const cell = <T>(initialValue: T): Cell<T> => {
  const signal = state(initialValue);

  return createCellProxy({}, signal, []) as Cell<T>;
};

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
  signal: WriteableSignal<any>,
  path: Path
): Cell<any> {
  return new Proxy(target, {
    get(_target, prop: string | symbol) {
      const newPath = [...path, prop];
      switch (prop) {
        case "get":
          return createCellProxy(
            () => getProp(signal.get(), path),
            signal,
            newPath
          );
        case "send":
          return createCellProxy(
            (value: any) => signal.send(setProp(signal.get(), path, value)),
            signal,
            newPath
          );
        case "updates":
          return createCellProxy(
            (subscriber: Sendable<void>) => signal.updates(subscriber),
            signal,
            newPath
          );
        default:
          return createCellProxy({}, signal, newPath);
      }
    },
    set(_target, _prop: string | symbol, _value: any) {
      return false;
    },
  }) as Cell<any>;
}
