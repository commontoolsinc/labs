/// <cts-enable />
import { pattern, UI } from "commontools";

// Module-level constant - should NOT be captured
const TAX_RATE = 0.08;

// Module-level function - should NOT be captured
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

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* Should NOT capture module-level constant or function */}
        {state.items.map((item) => (
          <div>
            Item: {formatPrice(item.price * (1 + TAX_RATE))}
          </div>
        ))}
      </div>
    ),
  };
});
