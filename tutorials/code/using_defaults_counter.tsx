/// <cts-enable />
import { type Cell, Default, handler, recipe, UI } from "commontools";

interface CounterState {
  count: Default<number, 100>;
}

const increment = handler<unknown, { count: Cell<number> }>(
  (_, { count }) => {
    count.set(count.get() + 1);
  },
);

export default recipe<CounterState>("Counter with Default", (state) => {
  return {
    [UI]: (
      <div>
        <h2>Count: {state.count}</h2>
        <button type="button" onclick={increment({ count: state.count })}>
          Increment
        </button>
      </div>
    ),
    count: state.count,
  };
});
