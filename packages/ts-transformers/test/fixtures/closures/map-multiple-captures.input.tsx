/// <cts-enable />
import { h, recipe, UI } from "commontools";

interface Item {
  price: number;
  quantity: number;
}

interface State {
  items: Item[];
  discount: number;
  taxRate: number;
}

const shippingCost = 5.99;

export default recipe<State>("MultipleCaptures", (state) => {
  const multiplier = 2;

  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>
            Total: {item.price * item.quantity * state.discount * state.taxRate * multiplier + shippingCost}
          </span>
        ))}
      </div>
    ),
  };
});
