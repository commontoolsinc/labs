/// <cts-enable />
import {
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
} from "commontools";
import { decrement, increment, nth, previous } from "./counter-handlers.ts";

interface RecipeState {
  value: Default<number, 0>;
}

/** The output of a #counter */
interface RecipeOutput {
  [NAME]?: string;
  [UI]: VNode;
  value: Default<number, 0>;
  increment: Stream<void>;
  decrement: Stream<void>;
}

export default pattern<RecipeState, RecipeOutput>((state) => {
  return {
    [NAME]: computed(() => `Simple counter: ${state.value}`),
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
    increment: increment(state),
    decrement: decrement(state),
  };
});
