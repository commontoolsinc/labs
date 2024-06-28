import { cell, Cell } from "./cell.js";

type CellsFor<T extends any[]> = {
  [K in keyof T]: Cell<T[K]>;
};

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
      const values = inputCells.map((arg) => arg.get()) as T;
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
