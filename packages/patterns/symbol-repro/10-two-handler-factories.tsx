/// <cts-enable />
/**
 * REPRO 10: Two uncalled handlers (both HandlerFactory)
 * TESTING: Is it mixing HandlerFactory with non-HandlerFactory that causes issues?
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
  
  // Both are HandlerFactory (not called)
  return {
    tests: [inc, dec],
    count,
  };
});
