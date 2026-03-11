/// <cts-enable />
import { Cell, handler, NAME, pattern, str, UI } from "commontools";

interface PatternState {
  value: number;
}

const increment = handler((_e, state: { value: Cell<number> }) => {
  state.value.set(state.value.get() + 1);
});

const decrement = handler((_e, state: { value: Cell<number> }) => {
  state.value.set(state.value.get() - 1);
});

// FIXTURE: pattern-statements-vs-jsx
// Verifies: only JSX-context expressions are transformed; statement-context expressions are left alone
//   const next = state.value + 1    → NOT transformed (statement context)
//   <p>{state.value + 1}</p>        → derive({value}, ({state}) => state.value + 1) (JSX context)
//   state.value > 10 ? "High":"Low" → ifElse(derive(...), "High", "Low") (JSX context)
// Context: Ensures the transformer distinguishes between statement and JSX expression contexts
export default pattern<PatternState>((state) => {
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
  };
});
