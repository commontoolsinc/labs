/// <cts-enable />
/**
 * REPRO 04: Array with bound handler() + computed()
 * EXPECTED: Compiles successfully
 */
import { pattern, Cell, handler, computed } from "commontools";

const inc = handler<void, { count: Cell<number> }>(
  (_, { count }) => count.set(count.get() + 1)
);

export default pattern(() => {
  const count = Cell.of(0);
  const isZero = computed(() => count.get() === 0);
  
  return {
    tests: [isZero, inc({ count })],
    count,
  };
});
