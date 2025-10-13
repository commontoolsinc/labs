/// <cts-enable />
import { Default, NAME, recipe, str, Stream, UI } from "commontools";
import { decrement, increment, nth, previous } from "./counter-handlers.ts";

interface RecipeState {
  value: Default<number, 0>;
}

interface RecipeOutput {
  value: Default<number, 0>;
  increment: Stream<void>;
  decrement: Stream<void>;
}

export default recipe<RecipeState, RecipeOutput>("Counter", (state) => {
  return {
    [NAME]: str`Simple counter: ${state.value}`,
    [UI]: (
      <div>
        <ct-button onClick={decrement(state)}>
          dec to {previous(state.value)}
        </ct-button>
        <span id="counter-result">
          Counter is the {nth(state.value)} number
        </span>
        <ct-button onClick={increment({ value: state.value })}>
          inc to {state.value + 1}
        </ct-button>
      </div>
    ),
    value: state.value,
    increment: increment(state) as unknown as Stream<void>,
    decrement: decrement(state) as unknown as Stream<void>,
  };
});
