import { Sendable } from "@commontools/common-frp";
import { cell, Cell, isCell } from "./cell.js";
import { Action, run } from "./scheduler.js";

type CellsFor<T extends any[]> = {
  [K in keyof T]: Cell<T[K]>;
};

// Creates a node factory for the given function.
export function lift<T extends any[], R>(
  fn: (...args: T) => R
): (...args: CellsFor<T>) => Cell<R> {
  const lifted = (...args: CellsFor<T>[]): Cell<R> => {
    const returnCell = cell<R>(undefined as R);

    const cells = args.map((arg) =>
      isCell(arg) ? arg : cell(arg)
    ) as Cell<any>[];

    const action: Action = (log) => {
      const values = cells.map((arg) => arg.withLog(log).get()) as T;
      const result = fn(...values);
      returnCell.withLog(log).send(result);
    };

    // Compute initial value
    run(action);

    return returnCell;
  };

  return (...args: CellsFor<T>[]) => lifted(...args);
}

export function apply<T extends any[], R>(
  args: CellsFor<T>,
  fn: (...args: T) => R
): Cell<R> {
  return lift(fn)(...args);
}

// Creates a node factory with some cells already bound.
export function curry<T extends any[], U extends any[], R>(
  values: CellsFor<T>,
  fn: (...args: [...T, ...U]) => R
): (...args: CellsFor<U>) => Cell<R> {
  const lifted = lift(fn);

  const curried = (...remainingArgs: CellsFor<U>) =>
    lifted(...values, ...remainingArgs);

  return curried;
}

// Creates a handler factory. Call it with cells to bind.
export function asHandler<E, T extends any[]>(
  fn: (e: E, ...args: T) => void
): (...args: [...CellsFor<T>]) => Sendable<E> {
  return (...args: [...CellsFor<T>]) => {
    const cells = args.map((arg) =>
      isCell(arg) ? arg : cell(arg)
    ) as Cell<any>[];

    return {
      send: (e: E) => fn(e, ...(cells.map((arg) => arg.get()) as T)),
      sink: () => {
        throw "Not actually a stream";
      },
    };
  };
}

// Shorthand for the common case of directly creating an event handler.
export function handler<E, T extends any[]>(
  args: [...CellsFor<T>],
  fn: (e: E, ...args: T) => void
): Sendable<E> {
  return asHandler(fn)(...args);
}

// Creates a propagator factory. Call with cells to bind.
export function propagator<T extends any[]>(
  fn: (...args: [...CellsFor<T>]) => void
): (...args: [...CellsFor<T>]) => void {
  return (...args: [...CellsFor<T>]) => {
    const argsAsCells = args.map((arg) =>
      isCell(arg) ? arg : cell(arg)
    ) as CellsFor<T>;

    const action: Action = (log) => {
      fn(...(argsAsCells.map((cell) => cell.withLog(log)) as CellsFor<T>));
    };

    run(action);
  };
}
