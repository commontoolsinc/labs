/// <cts-enable />
import { h, recipe, UI, derive } from "commontools";

interface State {
  items: Array<{ price: number }>;
  discount: number;
}

export default recipe<State>("ItemList", (state) => {
  return {
    [UI]: (
      <div>
        {state.items.map({
          op: recipe(({elem: item, params: {discount}}) => (
            <span>{derive(item.price, price => price * discount)}</span>
          )),
          params: {discount: state.discount}
        })}
      </div>
    ),
  };
});