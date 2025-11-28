/// <cts-enable />
import { recipe, UI, Cell } from "commontools";

interface Item {
  id: number;
  price: number;
  category: { name: string };
}

interface State {
  items: Cell<Item[]>;
  discount: number;
}

export default recipe<State>("Keyed Map with Function", (state) => {
  // Using key function syntax: .map(fn, { key: item => item.id })
  // This gets compiled to { key: "id" } at build time
  const discounted = state.items.map(
    (item) => ({ discountedPrice: item.price * state.discount }),
    { key: (item) => item.id },
  );

  // Also test nested property access: { key: item => item.category.name }
  // This gets compiled to { key: ["category", "name"] }
  const byCategory = state.items.map(
    (item) => ({ price: item.price }),
    { key: (item) => item.category.name },
  );

  return {
    [UI]: (
      <div>
        Discounted: {JSON.stringify(discounted)}
        By Category: {JSON.stringify(byCategory)}
      </div>
    ),
  };
});
