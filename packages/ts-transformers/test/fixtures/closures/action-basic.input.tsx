/// <cts-enable />
import { Cell, pattern, action } from "commontools";

interface State {
  count: Cell<number>;
}

export default pattern<State>(({ count }) => {
  return {
    inc: action(() => count.set(count.get() + 1)),
  };
});
