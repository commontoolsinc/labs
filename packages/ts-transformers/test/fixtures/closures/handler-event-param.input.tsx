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
      // Convenience pattern: handler with event param doesn't match EventHandler<unknown> signature
      // @ts-expect-error Testing convenience pattern: handler takes event param
      <button type="button" onClick={(event: MouseEvent) => state.user?.clicks.set(event.detail + state.metrics.get())}>
        Track
      </button>
    ),
  };
});
