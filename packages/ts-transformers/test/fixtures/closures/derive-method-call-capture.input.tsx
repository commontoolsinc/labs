/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

interface State {
  counter: { value: number };
}

export default pattern((state: State) => {
  const value = Writable.of(10);

  // Capture property before method call
  const result = derive(value, (v) => v.get() + state.counter.value);

  return result;
});
