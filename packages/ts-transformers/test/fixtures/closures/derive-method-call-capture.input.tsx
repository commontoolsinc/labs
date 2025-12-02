/// <cts-enable />
import { cell, derive } from "commontools";

interface State {
  counter: { value: number };
}

export default function TestDerive(state: State) {
  const value = cell(10);

  // Capture property before method call
  const result = derive(value, (v) => v.get() + state.counter.value);

  return result;
}
