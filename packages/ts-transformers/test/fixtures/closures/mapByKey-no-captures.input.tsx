/// <cts-enable />
import { mapByKey, recipe, UI } from "commontools";

interface State {
  items: { id: number; name: string }[];
}

export default recipe<State>("Item Names", (state) => {
  // No captures - should still transform to ensure element becomes opaque
  const names = mapByKey(state.items, "id", (item) => item.name);
  return {
    [UI]: <div>Names: {JSON.stringify(names)}</div>,
  };
});
