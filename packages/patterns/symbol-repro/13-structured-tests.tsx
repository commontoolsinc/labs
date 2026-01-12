/// <cts-enable />
/**
 * PROTOTYPE: Structured test object to avoid mixed arrays
 * 
 * Instead of: tests: [assert, action, assert, action, ...]
 * Use: tests: { assertions: [...], actions: [...], sequence: [...] }
 */
import { pattern, Cell, action, computed } from "commontools";

export default pattern(() => {
  const count = Cell.of(0);
  
  // Actions (HandlerFactory)
  const inc = action(() => count.set(count.get() + 1));
  const dec = action(() => count.set(count.get() - 1));
  const reset = action(() => count.set(0));
  
  // Assertions (OpaqueCell<boolean>)
  const isZero = computed(() => count.get() === 0);
  const isOne = computed(() => count.get() === 1);
  const isNegative = computed(() => count.get() < 0);
  
  return {
    tests: {
      // Homogeneous arrays - no mixing!
      assertions: { isZero, isOne, isNegative },
      actions: { inc, dec, reset },
      // Sequence uses string keys to reference items
      sequence: [
        'isZero',      // assert count === 0
        'inc',         // increment
        'isOne',       // assert count === 1
        'dec',         // decrement
        'isZero',      // assert count === 0 again
        'dec',         // decrement
        'isNegative',  // assert count < 0
        'reset',       // reset to 0
        'isZero',      // assert count === 0
      ],
    },
    count,
  };
});
