/// <cts-enable />
/**
 * REPRO 01: Array with only action() results
 * EXPECTED: Compiles successfully
 */
import { pattern, Cell, action } from "commontools";

export default pattern(() => {
  const count = Cell.of(0);
  
  const inc = action(() => count.set(count.get() + 1));
  const dec = action(() => count.set(count.get() - 1));
  
  return {
    tests: [inc, dec],
    count,
  };
});
