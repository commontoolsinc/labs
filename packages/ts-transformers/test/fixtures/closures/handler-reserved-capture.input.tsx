/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  label: string;
}

export default pattern<State>("Reserved", (state) => {
  const __ct_handler_event = state.label;
  return {
    [UI]: (
      <button type="button" onClick={() => __ct_handler_event}>
        Echo
      </button>
    ),
  };
});
