/// <cts-enable />
import { Cell, pattern, UI } from "commontools";

interface State {
  counter: Cell<number>;
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <button type="button" onClick={(_) => state.counter.set(state.counter.get() + 1)}>
        Increment (ignore event)
      </button>
    ),
  };
});
