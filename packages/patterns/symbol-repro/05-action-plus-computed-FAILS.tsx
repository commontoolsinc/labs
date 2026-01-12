/// <cts-enable />
/**
 * REPRO 05: Array with action() + computed()
 * EXPECTED: FAILS with "private name 'CELL_BRAND'" error
 */
import { pattern, Cell, action, computed } from "commontools";

export default pattern(() => {
  const count = Cell.of(0);
  
  const inc = action(() => count.set(count.get() + 1));
  const isZero = computed(() => count.get() === 0);
  
  return {
    tests: [isZero, inc],
    count,
  };
});
