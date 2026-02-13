/// <cts-enable />
import { pattern, UI } from "commontools";

interface Item {
  id: number;
  name: string;
}

interface State {
  items: Item[];
  prefix: string;
}

export default pattern<State>("ElementComputed", (state) => {
  return {
    [UI]: (
      <div>
        {/* Performs computation on element property - should wrap in computed() */}
        {state.items.map((item, index) => (
          <div>
            Item #{index}: {item.name.toUpperCase()}
          </div>
        ))}
      </div>
    ),
  };
});
