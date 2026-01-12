/// <cts-enable />
/**
 * REPRO 06: Array with action() + bound handler()
 * TESTING: Is it action() specifically or just mixing different Stream types?
 */
import { pattern, Cell, action, handler } from "commontools";

const dec = handler<void, { count: Cell<number> }>(
  (_, { count }) => count.set(count.get() - 1)
);

export default pattern(() => {
  const count = Cell.of(0);
  
  const inc = action(() => count.set(count.get() + 1));
  
  return {
    tests: [inc, dec({ count })],
    count,
  };
});
