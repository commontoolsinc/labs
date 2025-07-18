/// <cts-enable />
import { recipe, UI, NAME, str, handler, h, Cell } from "commontools";

interface RecipeState {
  value: number;
}

const increment = handler((e, state: { value: Cell<number> }) => {
  state.value.set(state.value.get() + 1);
});

const decrement = handler((e, state: { value: Cell<number> }) => {
  state.value.set(state.value.get() - 1);
});

export default recipe<RecipeState>("Counter", (state) => {
  // These should NOT be transformed (statement context)
  const next = state.value + 1;
  const previous = state.value - 1;
  const doubled = state.value * 2;
  const isHigh = state.value > 10;
  
  // This should NOT be transformed (statement context)
  if (state.value > 100) {
    console.log("Too high!");
  }
  
  return {
    // This template literal SHOULD be transformed (builder function context)
    [NAME]: str`Simple counter: ${state.value}`,
    
    [UI]: (
      <div>
        <ct-button onClick={decrement(state)}>-</ct-button>
        <p>
          {/* These SHOULD be transformed (JSX expression context) */}
          Current: {state.value}
          <br />
          Next number: {state.value + 1}
          <br />
          Previous: {state.value - 1}
          <br />
          Doubled: {state.value * 2}
          <br />
          Status: {state.value > 10 ? "High" : "Low"}
        </p>
        <ct-button onClick={increment({ value: state.value })}>+</ct-button>
      </div>
    ),
    
    // Direct property access - no transformation needed
    value: state.value,
    
    // These should NOT be transformed (object literal in statement context)
    metadata: {
      next: next,
      previous: previous,
      doubled: doubled
    }
  };
});