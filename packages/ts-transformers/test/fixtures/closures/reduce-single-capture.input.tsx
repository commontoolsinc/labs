/// <cts-enable />
import { recipe, reduce, UI } from "commontools";

interface State {
  prices: number[];
  taxRate: number;
}

export default recipe<State>("Total Calculator", (state) => {
  const total = reduce(
    state.prices,
    0,
    (acc, price) => acc + price * state.taxRate,
  );
  return {
    [UI]: <div>Total: {total}</div>,
  };
});
