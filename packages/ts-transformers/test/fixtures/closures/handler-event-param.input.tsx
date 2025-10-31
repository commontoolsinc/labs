/// <cts-enable />
import { Cell, recipe, UI } from "commontools";

declare global {
  interface MouseEvent {
    detail: number;
  }
}

interface State {
  metrics: Cell<number>;
  user?: {
    clicks: Cell<number>;
  };
}

export default recipe<State>("Analytics", (state) => {
  return {
    [UI]: (
      <button type="button" onClick={(event) => state.user?.clicks.set(event.detail + state.metrics.get())}>
        Track
      </button>
    ),
  };
});
