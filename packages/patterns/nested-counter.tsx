/// <cts-enable />
import { Default, derive, h, NAME, recipe, str, UI } from "commontools";
import { decrement, increment, nth, previous } from "./counter-handlers.ts";

interface RecipeState {
  value: Default<number, 0>;
}

export const Counter = recipe<RecipeState>("Counter", (state) => {
  return {
    // str is used so we can directly interpolate the OpaqueRef<number> into the string
    [NAME]: str`Simple counter: ${state.value}`,
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
This demonstrates a pattern of passing a Cell to a sub-recipe and keeping the value in sync between all locations.
It also demonstrates that any recipe can be invoked using JSX syntax.
*/
export default recipe<RecipeState>("Counter", (state) => {
  // A recipe can be 'invoked' directly
  const counter = Counter({ value: state.value });

  return {
    [NAME]: str`Double counter: ${state.value}`,
    [UI]: (
      <div>
        {/* Recipes can also be 'invoked' via JSX*/}
        {/* These methods of rendering are functionally equivalent, you may prefer the explicit case for non-UI recipes */}
        <Counter value={state.value} />
        {counter}
      </div>
    ),
    value: state.value,
  };
});
