/// <cts-enable />
/**
 * PROTOTYPE: Tuple-based sequence with type discriminator
 * 
 * sequence: [['assert', 'isZero'], ['action', 'inc'], ['assert', 'isOne'], ...]
 */
import { pattern, Cell, action, computed } from "commontools";

export default pattern(() => {
  const count = Cell.of(0);
  
  const inc = action(() => count.set(count.get() + 1));
  const isZero = computed(() => count.get() === 0);
  const isOne = computed(() => count.get() === 1);
  
  return {
    tests: {
      assertions: { isZero, isOne },
      actions: { inc },
      sequence: [
        ['assert', 'isZero'],
        ['action', 'inc'],
        ['assert', 'isOne'],
      ] as const,
    },
    count,
  };
});
