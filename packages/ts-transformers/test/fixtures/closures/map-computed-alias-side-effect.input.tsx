/// <cts-enable />
import { pattern, UI } from "commontools";

let keyCounter = 0;
function nextKey() {
  return `value-${keyCounter++}`;
}

interface State {
  items: Array<Record<string, number>>;
}

export default pattern<State>((state) => {
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
