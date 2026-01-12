/// <cts-enable />
/**
 * REPRO 03: Array with only bound handler() results (Streams)
 * EXPECTED: Compiles successfully
 */
import { pattern, Cell, handler } from "commontools";

const inc = handler<void, { count: Cell<number> }>(
  (_, { count }) => count.set(count.get() + 1)
);

const dec = handler<void, { count: Cell<number> }>(
  (_, { count }) => count.set(count.get() - 1)
);

export default pattern(() => {
  const count = Cell.of(0);
  
  return {
    tests: [inc({ count }), dec({ count })],
    count,
  };
});
