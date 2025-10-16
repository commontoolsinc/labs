/// <cts-enable />
import { recipe, UI } from "commontools";

interface Item {
  id: number;
  price: number;
  active: boolean;
}

interface State {
  items: Item[];
  taxRate: number;
}

export default recipe<State>("FilterMapChain", (state) => {
  return {
    [UI]: (
      <div>
        {/* Method chain: filter then map, both with captures */}
        {state.items
          .filter((item) => item.active)
          .map((item) => (
            <div>
              Total: {item.price * (1 + state.taxRate)}
            </div>
          ))}
      </div>
    ),
  };
});
