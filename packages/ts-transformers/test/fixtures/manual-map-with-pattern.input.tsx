/// <cts-enable />
import { recipe, UI } from "commontools";

interface Item {
  price: number;
}

interface State {
  items: Item[];
  discount: number;
}

export default recipe<State>("ManualMapTest", (state) => {
  return {
    [UI]: (
      <div>
        {state.items.mapWithPattern(
          recipe<{ element: Item; params: { discount: number } }>("MapItemRecipe", ({ element, params }) => (
            <span>{element.price * params.discount}</span>
          )),
          { discount: state.discount }
        )}
      </div>
    ),
  };
});
