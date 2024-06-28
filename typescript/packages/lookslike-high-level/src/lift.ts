import { cell, Cell } from "./cell.js";

type CellsFor<T extends any[]> = {
  [K in keyof T]: Cell<T[K]>;
};

export function lift<T extends any[], R>(
  fn: (...args: T) => R
): (...args: CellsFor<T>) => Cell<R> {
  const bind = (returnCell: Cell<R> | undefined) => {
    return (...args: CellsFor<T>) => {
      // Calls function after .get()ing all values from the cells
      const call = (): R => {
        const values = args.map((arg) => arg.get()) as T;
        return fn(...values);
      };

      // Compute initial value. Create new cell if no returnCell was passed.
      if (returnCell) returnCell.send(call());
      else returnCell = cell<R>(call());

      // Subscribe to updates of all cells and call function when any updates
      args.forEach((arg) => {
        // @ts-ignore - TS can't infer here whether R is an array or not
        arg.updates({ send: () => returnCell.send(call()) });
      });

      // Return the new cell
      return returnCell;
    };
  };

  const lifted = bind(undefined);
  lifted.bind = bind;

  return lifted;
}

export function curry<T extends any[], U extends any[], V>(
  values: CellsFor<T>,
  fn: (...args: [...T, ...U]) => V
): (...args: CellsFor<U>) => Cell<V> {
  const lifted = lift(fn);

  const curried = (...remainingArgs: CellsFor<U>) => {
    return lifted(...values, ...remainingArgs);
  };
  curried.bind = (returnCell: Cell<V>) => {
    return (...remainingArgs: CellsFor<U>) => {
      return lifted.bind(returnCell)(...values, ...remainingArgs);
    };
  };

  return curried;
}
