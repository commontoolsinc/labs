/// <cts-enable />
import { recipe, UI, Cell } from "commontools";

interface State {
  items: Cell<{ price: number }[]>;
  taxRate: number;
}

export default recipe<State>("Cell Reduce", (state) => {
  // Using the new Cell.reduce() method syntax
  const total = state.items.reduce(0, (acc, item) => acc + item.price * state.taxRate);
  return {
    [UI]: <div>Total: {total}</div>,
  };
});
