/// <cts-enable />
/**
 * PROPOSAL: Ergonomic structured tests
 * 
 * Key insight: The sequence array just needs string references.
 * We can make this readable by using descriptive names.
 * 
 * The test runner would:
 * 1. Look up each key in sequence
 * 2. Find it in either assertions or actions
 * 3. Execute accordingly (check boolean for assertion, call .send() for action)
 */
import { pattern, Cell, action, computed } from "commontools";

export default pattern(() => {
  const count = Cell.of(0);
  
  // Define all test components with descriptive names
  const inc = action(() => count.set(count.get() + 1));
  const dec = action(() => count.set(count.get() - 1));
  const reset = action(() => count.set(0));
  
  const initiallyZero = computed(() => count.get() === 0);
  const isOne = computed(() => count.get() === 1);
  const isTwo = computed(() => count.get() === 2);
  
  return {
    tests: {
      // Homogeneous by type
      assertions: { initiallyZero, isOne, isTwo },
      actions: { inc, dec, reset },
      
      // Sequence reads almost like prose
      sequence: [
        'initiallyZero',  // ✓ count starts at 0
        'inc',            // → increment
        'isOne',          // ✓ count is now 1
        'inc',            // → increment again  
        'isTwo',          // ✓ count is now 2
        'reset',          // → reset to 0
        'initiallyZero',  // ✓ back to 0
      ],
    },
    count,
  };
});
