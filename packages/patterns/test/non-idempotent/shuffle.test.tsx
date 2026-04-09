/**
 * Test that exercises a non-idempotent nonPrivateRandom() shuffle computation.
 * The idempotency check in cf test should warn about it.
 *
 * Run: deno task cf test packages/patterns/test/non-idempotent/shuffle.test.tsx --verbose
 */
import { computed, nonPrivateRandom, pattern, Writable } from "commonfabric";

export default pattern(() => {
  const items = Writable.of(["alpha", "bravo", "charlie", "delta", "echo"]);
  const shuffled = Writable.of<string[]>([]);

  // Non-idempotent: nonPrivateRandom() produces different permutations each run
  computed(() => {
    const arr = [...items.get()];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(nonPrivateRandom() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    shuffled.set(arr);
  });

  const hasItems = computed(() => shuffled.get().length > 0);

  return {
    tests: [{ assertion: hasItems }],
    expectNonIdempotent: true,
  };
});
