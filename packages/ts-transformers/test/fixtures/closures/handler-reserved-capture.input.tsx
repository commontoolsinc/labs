/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  label: string;
}

// FIXTURE: handler-reserved-capture
// Verifies: captured variable named __ct_handler_event is renamed to avoid collision with the synthetic event param
//   onClick={() => __ct_handler_event) → handler(false, { __ct_handler_event: ... }, (__ct_handler_event_1, { __ct_handler_event }) => ...)
// Context: Edge case -- user variable collides with internal __ct_handler_event name; event param gets suffixed
export default pattern<State>((state) => {
  const __ct_handler_event = state.label;
  return {
    [UI]: (
      <button type="button" onClick={() => __ct_handler_event}>
        Echo
      </button>
    ),
  };
});
