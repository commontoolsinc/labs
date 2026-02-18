/// <cts-enable />
import { Cell, pattern, UI } from "commontools";

interface State {
  records: Record<string, Cell<number>>;
}

let counter = 0;
function nextKey(): string {
  counter += 1;
  return `key-${counter}`;
}

export default pattern<State>((state) => {
  const recordMap = state.records;
  return {
    [UI]: (
      <button type="button" onClick={() => recordMap[nextKey()]!.set(counter)}>
        Step
      </button>
    ),
  };
});
