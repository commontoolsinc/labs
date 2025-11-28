/// <cts-enable />
import { mapByKey, recipe, UI } from "commontools";

interface State {
  products: { id: number; basePrice: number }[];
  taxRate: number;
  discount: number;
}

export default recipe<State>("Product Pricing", (state) => {
  const priced = mapByKey(state.products, "id", (product) => ({
    id: product.id,
    finalPrice: product.basePrice * (1 + state.taxRate) * state.discount,
  }));
  return {
    [UI]: <div>Products: {JSON.stringify(priced)}</div>,
  };
});
