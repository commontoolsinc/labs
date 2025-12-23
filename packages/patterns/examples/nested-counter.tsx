/// <cts-enable />
import { computed, Default, NAME, pattern, UI } from "commontools";
import { decrement, increment, nth, previous } from "./counter-handlers.ts";

interface RecipeState {
  value: Default<number, 0>;
}

export const Counter = pattern<RecipeState>((state) => {
  return {
    // computed() is used to create reactive derived values
    [NAME]: computed(() => `Simple counter: ${state.value}`),
    [UI]: (
      <div>
        {
          /* Even though we could end up passing extra data to decrement, our schema prevents that actually reaching the handler.
          In fact, we are passing `value` as an OpaqueRef<number> here but it becomes a Cell<number> at invocation time */
        }
        <ct-button onClick={decrement(state)}>
          dec to {previous(state.value)}
        </ct-button>
        <span id="counter-result">
          {/* <cts-enable /> transforms pure functions (like nth) into the `derive(c, nth)` equivalent */}
          Counter is the {nth(state.value)} number
        </span>
        <ct-button onClick={increment({ value: state.value })}>
          inc to {state.value + 1}
        </ct-button>
      </div>
    ),
    value: state.value,
  };
});

/*
This demonstrates a pattern of passing a Cell to a sub-pattern and keeping the value in sync between all locations.
It also demonstrates that any pattern can be invoked using JSX syntax.
*/
export default pattern<RecipeState>((state) => {
  // A pattern can be 'invoked' directly
  const counter = Counter({ value: state.value });

  return {
    [NAME]: computed(() => `Double counter: ${state.value}`),
    [UI]: (
      <div>
        {/* Patterns can also be 'invoked' via JSX*/}
        {/* These methods of rendering are functionally equivalent, you may prefer the explicit case for non-UI patterns */}
        <Counter value={state.value} />
        {counter}
      </div>
    ),
    value: state.value,
  };
});
