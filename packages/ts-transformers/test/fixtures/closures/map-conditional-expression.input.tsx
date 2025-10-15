/// <cts-enable />
import { recipe, UI } from "commontools";

interface Item {
  id: number;
  price: number;
}

interface State {
  items: Item[];
  discount: number;
  threshold: number;
}

export default recipe<State>("ConditionalExpression", (state) => {
  return {
    [UI]: (
      <div>
        {/* Ternary with captures in map callback */}
        {state.items.map((item) => (
          <div>
            Price: ${item.price > state.threshold
              ? item.price * (1 - state.discount)
              : item.price}
          </div>
        ))}
      </div>
    ),
  };
});
