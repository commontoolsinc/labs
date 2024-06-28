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

      // If no returnCell was passed, create a new cell with the result of the
      // function as initial value
      returnCell ??= cell<R>(call());

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
