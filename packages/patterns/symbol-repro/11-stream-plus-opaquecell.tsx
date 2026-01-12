/// <cts-enable />
/**
 * REPRO 11: Stream + OpaqueCell in same array
 * TESTING: Is it Stream + OpaqueCell mixing that's the issue?
 */
import { pattern, Cell, handler, computed } from "commontools";

const inc = handler<void, { count: Cell<number> }>(
  (_, { count }) => count.set(count.get() + 1)
);

export default pattern(() => {
  const count = Cell.of(0);
  const stream = inc({ count });  // Stream<void>
  const isZero = computed(() => count.get() === 0);  // OpaqueCell<boolean>
  
  return {
    tests: [stream, isZero],  // Stream + OpaqueCell
    count,
  };
});
