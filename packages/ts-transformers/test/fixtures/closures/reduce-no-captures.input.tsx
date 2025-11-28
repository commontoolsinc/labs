/// <cts-enable />
import { recipe, reduce, UI } from "commontools";

interface State {
  numbers: number[];
}

export default recipe<State>("Sum Calculator", (state) => {
  // No captures - should not transform
  const sum = reduce(state.numbers, 0, (acc, n) => acc + n);
  return {
    [UI]: <div>Sum: {sum}</div>,
  };
});
