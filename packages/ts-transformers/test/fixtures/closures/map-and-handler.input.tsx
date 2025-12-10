/// <cts-enable />
import { Cell, pattern, UI } from "commontools";

interface State {
  items: Array<{ price: number }>;
  discount: number;
  selectedIndex: Cell<number>;
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.map((item, index) => (
          <div>
            <span>{item.price * state.discount}</span>
            <button type="button" onClick={() => state.selectedIndex.set(index)}>
              Select
            </button>
          </div>
        ))}
        <div>
          Selected: {state.items[state.selectedIndex.get()]?.price ?? 0} x {state.discount} ={" "}
          {(state.items[state.selectedIndex.get()]?.price ?? 0) * state.discount}
        </div>
      </div>
    ),
  };
});
