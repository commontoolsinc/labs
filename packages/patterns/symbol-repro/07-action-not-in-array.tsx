/// <cts-enable />
/**
 * REPRO 07: action() exists but NOT in the array with other types
 * TESTING: Is the issue about action() being in a mixed array?
 */
import { pattern, Cell, action, computed } from "commontools";

export default pattern(() => {
  const count = Cell.of(0);
  
  const inc = action(() => count.set(count.get() + 1));
  const isZero = computed(() => count.get() === 0);
  
  return {
    actions: [inc],       // action in its own array
    assertions: [isZero], // computed in its own array
    count,
  };
});
