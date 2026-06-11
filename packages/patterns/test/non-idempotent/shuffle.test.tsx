/**
 * Test that exercises a non-idempotent nonPrivateRandom() shuffle computation.
 * expectNonIdempotent asserts the idempotency check detects it; the test
 * FAILS if no violation is reported.
 *
 * The permutation alone is not a reliable detection signal: a 5-element
 * shuffle repeats the previous order 1 in 120 times, which is a real flake
 * rate once a missed detection fails the test. Recording the raw random
 * draw alongside makes consecutive runs differ with certainty (two equal
 * float64 draws are a ~2^-52 event) while keeping the shuffle as the
 * demonstrated anti-pattern.
 *
 * Run: deno task cf test packages/patterns/test/non-idempotent/shuffle.test.tsx --verbose
 */
import { computed, nonPrivateRandom, pattern, Writable } from "commonfabric";

export default pattern(() => {
  const items = new Writable(["alpha", "bravo", "charlie", "delta", "echo"]);
  const shuffled = new Writable<string[]>([]);
  const lastDraw = new Writable(0);

  // Non-idempotent: nonPrivateRandom() produces different permutations (and
  // a different recorded draw) each run
  computed(() => {
    const arr = [...items.get()];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(nonPrivateRandom() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    shuffled.set(arr);
    lastDraw.set(nonPrivateRandom());
  });

  const hasItems = computed(() => shuffled.get().length > 0);

  return {
    tests: [{ assertion: hasItems }],
    expectNonIdempotent: true,
  };
});
