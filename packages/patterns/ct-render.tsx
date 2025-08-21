/// <cts-enable />
import {
  Cell,
  Default,
  derive,
  h,
  handler,
  NAME,
  Opaque,
  OpaqueRef,
  recipe,
  str,
  UI,
} from "commontools";

interface RecipeState {
  value: Default<number, 0>;
}

// In this case we do not have to type our event parameter because it is not used in the body.
// By requesting a Cell<number> we get a mutable handle when our handler is invoked.
const increment = handler<unknown, { value: Cell<number> }>((_, state) => {
  state.value.set(state.value.get() + 1);
});

// This can also be done with inline types + inference
const decrement = handler((_, state: { value: Cell<number> }) => {
  state.value.set(state.value.get() - 1);
});

function previous(value: number) {
  return value - 1;
}

function nth(value: number) {
  if (value === 1) {
    return "1st";
  }
  if (value === 2) {
    return "2nd";
  }
  if (value === 3) {
    return "3rd";
  }
  return `${value}th`;
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

export default recipe<RecipeState>("Counter", (state) => {
  const counter = Counter({ value: state.value });

  return {
    [NAME]: str`Counters: ${state.value}`,
    // These three methods are all functionally equivalent
    [UI]: (
      <div>
        <div>{counter}</div>
        <Counter value={state.value} />
        {/* ct-render will NOT usually appear in a recipe, rather, it's used within other ct- component internals */}
        <div><ct-render $cell={counter} /></div>
      </div>
    ),
    value: state.value,
  };
});
