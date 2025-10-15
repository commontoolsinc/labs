/// <cts-enable />
import { recipe, UI } from "commontools";

interface Item {
  id: number;
  price: number;
}

interface State {
  items: Item[];
}

export default recipe<State>("NoCaptures", (state) => {
  return {
    [UI]: (
      <div>
        {/* No captures - just uses the callback parameter */}
        {state.items.map((item) => (
          <div>Item #{item.id}: ${item.price}</div>
        ))}
      </div>
    ),
  };
});
