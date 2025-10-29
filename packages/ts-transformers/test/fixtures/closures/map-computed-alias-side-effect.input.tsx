/// <cts-enable />
import { recipe, UI } from "commontools";

let keyCounter = 0;
function nextKey() {
  return `value-${keyCounter++}`;
}

interface State {
  items: Array<Record<string, number>>;
}

export default recipe<State>("ComputedAliasSideEffect", (state) => {
  return {
    [UI]: (
      <div>
        {state.items.map(({ [nextKey()]: amount }) => (
          <span>{amount}</span>
        ))}
      </div>
    ),
  };
});
