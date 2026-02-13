/// <cts-enable />
import { pattern, UI } from "commontools";

interface Item {
  price: number;
}

interface State {
  items: Item[];
  discount: number;
}

export default pattern<State>("ManualMapTest", (state) => {
  return {
    [UI]: (
      <div>
        {state.items.mapWithPattern(
          pattern<{ element: Item; params: { discount: number } }>("MapItemPattern", ({ element, params }) => (
            <span>{element.price * params.discount}</span>
          )),
          { discount: state.discount }
        )}
      </div>
    ),
  };
});
