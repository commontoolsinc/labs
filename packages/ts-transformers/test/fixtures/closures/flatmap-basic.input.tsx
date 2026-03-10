/// <cts-enable />
import { pattern, UI } from "commontools";

interface Item {
  id: number;
  tags: string[];
}

interface State {
  items: Item[];
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.flatMap((item) => (
          <div>Item #{item.id}</div>
        ))}
      </div>
    ),
  };
});
