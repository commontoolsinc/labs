/// <cts-enable />
import { Cell, recipe, UI } from "commontools";

interface State {
  counter: Cell<number>;
}

export default recipe<State>("UnusedEvent", (state) => {
  return {
    [UI]: (
      <button type="button" onClick={(_) => state.counter.set(state.counter.get() + 1)}>
        Increment (ignore event)
      </button>
    ),
  };
});
