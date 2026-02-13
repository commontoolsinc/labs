/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  items: Array<{ price: number }>;
  discount: number;
}

export default pattern<State>("MapDestructuredAlias", (state) => {
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
