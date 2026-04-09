import { pattern, UI } from "commonfabric";

interface Item {
  price: number;
}

interface State {
  items: Item[];
  discount: number;
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.mapWithPattern(
          pattern<{ element: Item; params: { discount: number } }>(({ element, params }) => (
            <span>{element.price * params.discount}</span>
          )),
          { discount: state.discount }
        )}
      </div>
    ),
  };
});
