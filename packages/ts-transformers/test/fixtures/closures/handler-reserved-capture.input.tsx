/// <cts-enable />
import { recipe, UI } from "commontools";

interface State {
  label: string;
}

export default recipe<State>("Reserved", (state) => {
  const __ct_handler_event = state.label;
  return {
    [UI]: (
      <button type="button" onClick={() => __ct_handler_event}>
        Echo
      </button>
    ),
  };
});
