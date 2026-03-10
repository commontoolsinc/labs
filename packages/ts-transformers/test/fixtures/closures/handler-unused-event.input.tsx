/// <cts-enable />
import { Cell, pattern, UI } from "commontools";

interface State {
  counter: Cell<number>;
}

// FIXTURE: handler-unused-event
// Verifies: inline handler with an unused event param (_) still generates an event schema placeholder
//   onClick={(_) => state.counter.set(...)) → handler(event schema with detail, capture schema, (_, { state }) => ...)({ state })
// Context: Event param is named _ (unused); transformer still emits event schema with { detail: true }
export default pattern<State>((state) => {
  return {
    [UI]: (
      <button type="button" onClick={(_) => state.counter.set(state.counter.get() + 1)}>
        Increment (ignore event)
      </button>
    ),
  };
});
