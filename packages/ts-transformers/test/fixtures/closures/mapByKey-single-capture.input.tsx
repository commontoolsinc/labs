/// <cts-enable />
import { mapByKey, recipe, UI } from "commontools";

interface State {
  items: { id: number; price: number }[];
  discount: number;
}

export default recipe<State>("Discounted Items", (state) => {
  const discounted = mapByKey(
    state.items,
    "id",
    (item) => ({ discountedPrice: item.price * state.discount }),
  );
  return {
    [UI]: <div>Items: {JSON.stringify(discounted)}</div>,
  };
});
