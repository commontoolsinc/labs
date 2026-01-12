/// <cts-enable />
/**
 * REPRO 02: Array with only computed() results
 * EXPECTED: Compiles successfully
 */
import { pattern, Cell, computed } from "commontools";

export default pattern(() => {
  const count = Cell.of(0);
  
  const isZero = computed(() => count.get() === 0);
  const isPositive = computed(() => count.get() > 0);
  
  return {
    tests: [isZero, isPositive],
    count,
  };
});
