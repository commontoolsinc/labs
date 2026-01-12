/// <cts-enable />
/**
 * REPRO 08: Calling action() result to get Stream
 * TESTING: Does calling the HandlerFactory fix the issue?
 */
import { pattern, Cell, action, computed } from "commontools";

export default pattern(() => {
  const count = Cell.of(0);
  
  // action() returns HandlerFactory, calling it with {} returns Stream
  const incFactory = action(() => count.set(count.get() + 1));
  const inc = incFactory({});  // Now it's a Stream<void>
  
  const isZero = computed(() => count.get() === 0);
  
  return {
    tests: [isZero, inc],
    count,
  };
});
