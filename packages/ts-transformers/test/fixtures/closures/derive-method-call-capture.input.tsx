/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

interface State {
  counter: { value: number };
}

// FIXTURE: derive-method-call-capture
// Verifies: a deep property access on a captured object is restructured into a nested capture object
//   derive(value, fn) → derive(schema, schema, { value, state: { counter: { value: state.counter.value } } }, fn)
// Context: `state.counter.value` is captured as a nested object structure, not a flat binding
export default pattern((state: State) => {
  const value = Writable.of(10);

  // Capture property before method call
  const result = derive(value, (v) => v.get() + state.counter.value);

  return result;
});
