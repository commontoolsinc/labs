/// <cts-enable />
/**
 * REPRO: Inline handler with captured value gets asOpaque instead of asCell
 *
 * When an inline arrow function captures a pattern input and tries to mutate it,
 * the transformer generates asOpaque: true instead of asCell: true, which
 * prevents mutation.
 */
import { Default, pattern, UI } from "commontools";

interface State {
  count: Default<number, 0>;
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        <span>{state.count}</span>
        {/* Inline handler that captures and mutates state.count */}
        <button onClick={() => state.count.set(state.count.get() + 1)}>
          Increment
        </button>
      </div>
    ),
  };
});
