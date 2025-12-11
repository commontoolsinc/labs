/// <cts-enable />
import { Default, NAME, recipe, str, Stream, UI } from "commontools";
import { decrement, increment, nth, previous } from "./counter-handlers.ts";

interface RecipeState {
  value: Default<number, 0>;
}

/** The output of a #counter */
interface RecipeOutput {
  value: Default<number, 0>;
  increment: Stream<void>;
  decrement: Stream<void>;
}

export default recipe<RecipeState, RecipeOutput>((state) => {
  return {
    [NAME]: str`Simple counter: ${state.value}`,
    [UI]: (
      <div>
        <ct-button id="counter-decrement" onClick={decrement(state)}>
          dec to {previous(state.value)}
        </ct-button>
        <ct-cell-context $cell={state.value} inline>
          <span id="counter-result">
            Counter is the {nth(state.value)} number
          </span>
        </ct-cell-context>
        <ct-button
          id="counter-increment"
          onClick={increment({ value: state.value })}
        >
          inc to {(state.value ?? 0) + 1}
        </ct-button>
      </div>
    ),
    value: state.value,
    increment: increment(state) as unknown as Stream<void>,
    decrement: decrement(state) as unknown as Stream<void>,
  };
});
