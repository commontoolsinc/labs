/// <cts-enable />
import { h, recipe, UI } from "commontools";

interface Item {
  id: number;
  url: string;
}

interface State {
  items: Item[];
  apiKey: string;
}

export default recipe<State>("AsyncCallback", (state) => {
  return {
    [UI]: (
      <div>
        {/* Async callback with capture - should still transform */}
        {state.items.map(async (item) => (
          <div>
            Fetching {item.url} with key: {state.apiKey}
          </div>
        ))}
      </div>
    ),
  };
});
