/// <cts-enable />
import { h, recipe, UI } from "commontools";

interface State {
  items: Array<{ price: number }>;
  discount: number;
}

export default recipe<State>("ItemList", (state) => {
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>{item.price * state.discount}</span>
        ))}
      </div>
    ),
  };
});