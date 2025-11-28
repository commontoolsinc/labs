/// <cts-enable />
import { recipe, UI, Cell } from "commontools";

interface State {
  items: Cell<{ id: number; price: number }[]>;
  discount: number;
}

export default recipe<State>("Keyed Map", (state) => {
  // Using the new .map(fn, { key }) syntax instead of mapByKey()
  const discounted = state.items.map(
    (item) => ({ discountedPrice: item.price * state.discount }),
    { key: "id" },
  );
  return {
    [UI]: <div>Items: {JSON.stringify(discounted)}</div>,
  };
});
