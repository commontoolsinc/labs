/// <cts-enable />
import { pattern, UI } from "commonfabric";

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
//   expression → derive() combining item + state reactively while closing over local multiplier
// Context: state.discount and state.taxRate are explicit derive inputs; multiplier stays callback-local via params; module-level shippingCost is not captured
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
