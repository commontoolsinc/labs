/// <cts-enable />
/**
 * Test that exercises a non-idempotent accumulator computation.
 * The idempotency check in ct test should warn about it.
 *
 * Run: deno task ct test packages/patterns/test/non-idempotent/accumulator.test.tsx --verbose
 */
import { computed, pattern, Writable } from "commontools";

export default pattern(() => {
  const value = Writable.of("hello");
  const log = Writable.of<string[]>([]);

  // Non-idempotent: appends to log on every re-execution
  computed(() => {
    const current = log.get();
    log.set([...current, `${value.get()} at run #${current.length + 1}`]);
  });

  // Trivial assertion: log should have at least one entry after initial run
  const hasEntries = computed(() => log.get().length > 0);

  return {
    tests: [{ assertion: hasEntries }],
    expectNonIdempotent: true,
  };
});
