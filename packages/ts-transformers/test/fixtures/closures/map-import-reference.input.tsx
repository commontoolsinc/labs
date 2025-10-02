/// <cts-enable />
import { h, recipe, UI } from "commontools";

// Module-level constant
const TAX_RATE = 0.08;

// Imported utility function (simulated)
function formatPrice(price: number): string {
  return `$${price.toFixed(2)}`;
}

interface Item {
  id: number;
  price: number;
}

interface State {
  items: Item[];
}

export default recipe<State>("ImportReference", (state) => {
  return {
    [UI]: (
      <div>
        {/* Captures module-level constant and function */}
        {state.items.map((item) => (
          <div>
            Item: {formatPrice(item.price * (1 + TAX_RATE))}
          </div>
        ))}
      </div>
    ),
  };
});
