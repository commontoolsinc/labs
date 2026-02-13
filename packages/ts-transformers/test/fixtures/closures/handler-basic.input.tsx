/// <cts-enable />
import { Cell, pattern, UI } from "commontools";

interface State {
  counter: Cell<number>;
}

export default pattern<State>("Counter", (state) => {
  return {
    [UI]: (
      <button type="button" onClick={() => state.counter.set(state.counter.get() + 1)}>
        Increment
      </button>
    ),
  };
});
