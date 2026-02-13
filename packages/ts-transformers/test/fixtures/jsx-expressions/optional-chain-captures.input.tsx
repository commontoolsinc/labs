/// <cts-enable />
import { pattern, UI } from "commontools";

interface Item {
  maybe?: { value: number };
}

interface State {
  maybe?: { value: number };
  items: Item[];
}

export default pattern<State>("OptionalChainCaptures", (state) => {
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
