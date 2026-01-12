/// <cts-enable />
/**
 * REPRO 09: Uncalled handler() (HandlerFactory) mixed with computed
 * TESTING: Is it HandlerFactory specifically that causes issues?
 */
import { pattern, Cell, handler, computed } from "commontools";

const inc = handler<void, { count: Cell<number> }>(
  (_, { count }) => count.set(count.get() + 1)
);

export default pattern(() => {
  const count = Cell.of(0);
  const isZero = computed(() => count.get() === 0);
  
  // inc is HandlerFactory (not called), isZero is OpaqueCell
  return {
    tests: [isZero, inc],  // HandlerFactory mixed with OpaqueCell
    count,
  };
});
