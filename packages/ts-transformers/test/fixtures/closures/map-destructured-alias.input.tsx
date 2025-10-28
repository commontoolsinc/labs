/// <cts-enable />
import { recipe, UI } from "commontools";

interface State {
  items: Array<{ price: number }>;
  discount: number;
}

export default recipe<State>("MapDestructuredAlias", (state) => {
  return {
    [UI]: (
      <div>
        {state.items.map(({ price: cost }) => (
          <span>{cost * state.discount}</span>
        ))}
      </div>
    ),
  };
});
