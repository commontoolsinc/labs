/// <cts-enable />
/**
 * PROTOTYPE: Indexed arrays with numeric sequence
 * 
 * The test runner would iterate through sequence, 
 * negative = assertion index, positive = action index
 */
import { pattern, Cell, action, computed } from "commontools";

export default pattern(() => {
  const count = Cell.of(0);
  
  const inc = action(() => count.set(count.get() + 1));
  const dec = action(() => count.set(count.get() - 1));
  
  const isZero = computed(() => count.get() === 0);
  const isOne = computed(() => count.get() === 1);
  
  return {
    tests: {
      // Arrays are homogeneous
      assertions: [isZero, isOne],  // index 0, 1
      actions: [inc, dec],          // index 0, 1
      // Sequence: 'a0' = assertion[0], 'x0' = action[0], etc.
      sequence: ['a0', 'x0', 'a1', 'x1', 'a0'],
    },
    count,
  };
});
