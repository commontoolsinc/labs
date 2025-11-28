/// <cts-enable />
import { reduce, recipe, UI } from "commontools";

interface State {
  items: { name: string }[];
  separator: string;
}

export default recipe<State>("Reduce Template Literal Test", (state) => {
  // Template literal with captured value in reduce - should be wrapped with str
  const joined = reduce(
    state.items,
    "",
    (acc, item) => acc ? `${acc}${state.separator}${item.name}` : item.name,
  );
  return {
    [UI]: <div>Joined: {joined}</div>,
  };
});
