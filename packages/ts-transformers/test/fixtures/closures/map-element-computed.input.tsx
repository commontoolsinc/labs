/// <cts-enable />
import { recipe, UI } from "commontools";

interface Item {
  id: number;
  name: string;
}

interface State {
  items: Item[];
  prefix: string;
}

export default recipe<State>("ElementComputed", (state) => {
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
