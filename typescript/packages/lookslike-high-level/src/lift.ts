import { Sendable } from "@commontools/common-frp";
import { cell, Cell, toValue, isCell } from "./cell.js";

type CellsFor<T extends any[]> = {
  [K in keyof T]: Cell<T[K]>;
};

// Creates a node factory for the given function.
export function lift<T extends any[], R>(
  fn: (...args: T) => R
): {
  (...args: [...CellsFor<T>]): Cell<R>;
  apply: (...args: [...CellsFor<T>, Cell<R>]) => void;
} {
  const apply = (
    ...args: [...CellsFor<T>, Cell<R> | undefined]
  ): Cell<R> | void => {
    const lastArg = args.pop() as Cell<R> | undefined;
    const inputCells = args as CellsFor<T>;

    // Function to compute the result
    const computeResult = (): R => {
      const values = inputCells.map((arg) => toValue(arg)) as T;
      return fn(...values);
    };

    // Compute initial value
    let returnCell: Cell<R>;
    if (lastArg === undefined) {
      returnCell = cell<R>(computeResult());
    } else {
      returnCell = lastArg;
      returnCell.send(computeResult());
    }

    // Subscribe to updates of all input cells
    inputCells.forEach((arg) => {
      if (isCell(arg))
        arg.updates({ send: () => returnCell.send(computeResult()) });
    });

    if (lastArg === undefined) {
      return returnCell;
    }
  };

  const lifted = (...args: [...CellsFor<T>]) =>
    apply(...args, undefined) as Cell<R>;
  lifted.apply = apply as (...args: [...CellsFor<T>, Cell<R>]) => void;

  return lifted;
}

// Creates a node factory with some cells already bound.
export function curry<T extends any[], U extends any[], V>(
  values: CellsFor<T>,
  fn: (...args: [...T, ...U]) => V
): {
  (...args: CellsFor<U>): Cell<V>;
  apply: (...args: [...CellsFor<U>, Cell<V>]) => void;
} {
  const lifted = lift(fn);

  const curried = (...remainingArgs: CellsFor<U>) => {
    return lifted(...values, ...remainingArgs);
  };
  curried.apply = (...args: [...CellsFor<U>, Cell<V>]) =>
    lifted.apply(...values, ...args);

  return curried;
}

// Creates a handler factory. Call it with cells to bind.
export function asHandler<E, T extends any[]>(
  fn: (e: E, ...args: T) => void
): (...args: [...CellsFor<T>]) => Sendable<E> {
  return (...args: [...CellsFor<T>]) => ({
    send: (e: E) => fn(e, ...(args.map((arg) => toValue(arg)) as T)),
  });
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
    const computeResult = () => {
      return fn(...argsAsCells);
    };

    computeResult();

    // TODO: This will immediately call the function again. This is merely
    // inefficient if the function is idempotent, but could be problematic if it
    // isn't.
    argsAsCells.forEach((arg) => arg.updates({ send: computeResult }));
  };
}
