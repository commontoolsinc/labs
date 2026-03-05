/// <cts-enable />
import { pattern, UI } from "commontools";

interface Item {
  name: string;
  active: boolean;
}

interface State {
  items: Item[];
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <ul>
        {state.items.filter((item) => item.active).map((item) => (
          <li>{item.name}</li>
        ))}
      </ul>
    ),
  };
});
