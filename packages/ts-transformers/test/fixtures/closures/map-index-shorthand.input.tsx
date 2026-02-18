/// <cts-enable />
import { pattern, UI } from "commontools";

interface Item {
  id: number;
  name: string;
}

interface State {
  items: Item[];
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* Map with common shorthand index parameter names */}
        {state.items.map((item, i) => (
          <div key={i}>
            Item #{i}: {item.name}
          </div>
        ))}

        {/* Map with idx as index parameter */}
        {state.items.map((item, idx) => (
          <div key={idx}>
            Position {idx}: {item.name}
          </div>
        ))}
      </div>
    ),
  };
});
