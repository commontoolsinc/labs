/// <cts-enable />
import { mapByKey, recipe, UI } from "commontools";

interface State {
  items: { id: number; name: string }[];
  prefix: string;
}

export default recipe<State>("Template Literal Test", (state) => {
  // Template literal with captured value - should be wrapped with str tag
  const formatted = mapByKey(state.items, "id", (item) => ({
    id: item.id,
    label: `${state.prefix}-${item.name}`,
  }));
  return {
    [UI]: <div>Items: {JSON.stringify(formatted)}</div>,
  };
});
