/// <cts-enable />
import { recipe, UI } from "commontools";

interface Item {
  maybe?: { value: number };
}

interface State {
  maybe?: { value: number };
  items: Item[];
}

export default recipe<State>("OptionalChainCaptures", (state) => {
  return {
    [UI]: (
      <div>
        <span>{state.maybe?.value}</span>
        {state.items.map((item) => (
          <span>{item.maybe?.value ?? 0}</span>
        ))}
      </div>
    ),
  };
});
