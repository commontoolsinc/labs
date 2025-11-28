/// <cts-enable />
import { mapByKey, recipe, UI } from "commontools";

interface State {
  numbers: number[];
  multiplier: number;
}

export default recipe<State>("Multiplied Numbers", (state) => {
  // Identity key (no keyPath) with capture
  const multiplied = mapByKey(state.numbers, (n) => n * state.multiplier);
  return {
    [UI]: <div>Result: {JSON.stringify(multiplied)}</div>,
  };
});
