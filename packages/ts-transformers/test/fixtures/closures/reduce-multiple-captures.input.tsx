/// <cts-enable />
import { recipe, reduce, UI } from "commontools";

interface State {
  items: { price: number; quantity: number }[];
  discount: number;
  taxRate: number;
}

export default recipe<State>("Cart Total", (state) => {
  const total = reduce(
    state.items,
    0,
    (acc, item) => acc + item.price * item.quantity * state.discount * state.taxRate,
  );
  return {
    [UI]: <div>Cart Total: {total}</div>,
  };
});
