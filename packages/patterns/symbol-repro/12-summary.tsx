/// <cts-enable />
/**
 * FINAL SUMMARY: The CELL_BRAND/CELL_INNER_TYPE Declaration Emit Issue
 * 
 * ROOT CAUSE:
 * - TypeScript's declaration emit runs on PRE-transformation code
 * - action() has type `ActionFunction` which returns `HandlerFactory<T, void>`
 * - At runtime, the CTS transformer rewrites action(() => ...) to handler(...)({...})
 * - But declaration emit sees the untransformed types
 * 
 * THE BUG:
 * - When an array contains HandlerFactory mixed with OpaqueCell/Stream
 * - TypeScript tries to emit a union type for the array
 * - This requires expanding HandlerFactory's type which includes:
 *   - Handler<T, R> → Module & { with: (inputs: Opaque<StripCell<T>>) => Stream<R> }
 *   - StripCell uses AnyBrandedCell<infer U> pattern
 *   - AnyBrandedCell has [CELL_BRAND] and [CELL_INNER_TYPE] computed property keys
 *   - These are `unique symbol` types = "private names" in declaration emit
 * 
 * WHY action() + computed() FAILS but handler() + computed() WORKS:
 * - action() returns HandlerFactory (uncalled)
 * - handler()({...}) returns Stream (called)
 * - Array of [HandlerFactory, OpaqueCell] triggers expansion
 * - Array of [Stream, OpaqueCell] does NOT trigger expansion
 * 
 * WORKAROUNDS:
 * 1. Always call action results: action(() => ...)({}) instead of action(() => ...)
 * 2. Use bound handlers at module scope instead of action()
 * 3. Keep HandlerFactory in separate arrays from other cell types
 */
import { pattern, Cell, action, computed } from "commontools";

export default pattern(() => {
  const count = Cell.of(0);
  
  // This FAILS: action() returns HandlerFactory
  // const inc = action(() => count.set(count.get() + 1));
  
  // This WORKS: calling the action converts HandlerFactory to Stream
  const incFactory = action(() => count.set(count.get() + 1));
  const inc = incFactory({});  // Now it's Stream<void>
  
  const isZero = computed(() => count.get() === 0);
  
  return {
    tests: [isZero, inc],  // Stream + OpaqueCell = OK
    count,
  };
});
