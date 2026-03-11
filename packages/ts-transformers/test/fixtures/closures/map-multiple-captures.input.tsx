/// <cts-enable />
import { pattern, UI } from "commontools";

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

// FIXTURE: map-multiple-captures
// Verifies: .map() on reactive array captures multiple outer variables (state + local)
//   .map(fn) → .mapWithPattern(pattern(...), {state: {discount, taxRate}, multiplier})
//   expression → derive() combining element props, state props, and local variable
// Context: Captures state.discount, state.taxRate, and local const multiplier; module-level shippingCost is not captured
export default pattern<State>((state) => {
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
