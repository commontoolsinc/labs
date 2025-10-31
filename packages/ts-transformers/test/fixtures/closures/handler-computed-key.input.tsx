/// <cts-enable />
import { Cell, recipe, UI } from "commontools";

interface State {
  records: Record<string, Cell<number>>;
}

let counter = 0;
function nextKey(): string {
  counter += 1;
  return `key-${counter}`;
}

export default recipe<State>("Records", (state) => {
  const recordMap = state.records;
  return {
    [UI]: (
      <button type="button" onClick={() => recordMap[nextKey()].set(counter)}>
        Step
      </button>
    ),
  };
});
