/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  items: Array<{ price: number }>;
  checkout: { discount: number };
  upsell: { discount: number };
}

export default pattern<State>("MultipleSimilarCaptures", (state) => {
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>
            {item.price * state.checkout.discount * state.upsell.discount}
          </span>
        ))}
      </div>
    ),
  };
});
