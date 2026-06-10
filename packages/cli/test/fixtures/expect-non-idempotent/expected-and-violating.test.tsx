/**
 * expectNonIdempotent: true on a genuinely non-idempotent accumulator
 * (same shape as packages/patterns/test/non-idempotent/accumulator.test.tsx).
 * The detected violation satisfies the expectation, so this test must PASS.
 */
import { computed, pattern, Writable } from "commonfabric";

export default pattern(() => {
  const value = new Writable("hello");
  const log = new Writable<string[]>([]);

  // Non-idempotent: appends to log on every re-execution
  computed(() => {
    const current = log.get();
    log.set([...current, `${value.get()} at run #${current.length + 1}`]);
  });

  const hasEntries = computed(() => log.get().length > 0);

  return {
    tests: [{ assertion: hasEntries }],
    expectNonIdempotent: true,
  };
});
