/// <cts-enable />
import { Cell, pattern, UI } from "commontools";

interface State {
  items: Array<{ name: string }>;
}

export default pattern<State>((state) => {
  const counter = Cell.of(0);
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>{item.name} #{counter}</span>
        ))}
      </div>
    ),
  };
});
