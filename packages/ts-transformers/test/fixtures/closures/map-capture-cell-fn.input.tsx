/// <cts-enable />
import { cell, pattern, UI } from "commontools";

interface State {
  items: Array<{ name: string }>;
}

export default pattern<State>((state) => {
  const count = cell(0);
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>{item.name} #{count}</span>
        ))}
      </div>
    ),
  };
});
