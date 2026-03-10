/// <cts-enable />
import { pattern, UI } from "commontools";

interface Item {
  id: number;
  name: string;
  active: boolean;
}

interface State {
  items: Item[];
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items
          .filter((item) => item.active)
          .map((item) => (
            <div>Item #{item.id}: {item.name}</div>
          ))}
      </div>
    ),
  };
});
