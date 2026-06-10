/**
 * Test that exercises a non-idempotent safeDateNow() computation.
 * expectNonIdempotent asserts the idempotency check detects it; the test
 * FAILS if no violation is reported.
 *
 * safeDateNow() has millisecond resolution, and the detector's recheck
 * re-runs the computation immediately — on a fast enough runtime both runs
 * could land in the same millisecond and write identical timestamps. The
 * computation spins until the clock ticks so consecutive runs are
 * GUARANTEED to observe different values; detection must not depend on how
 * slow the re-run happens to be.
 *
 * Run: deno task cf test packages/patterns/test/non-idempotent/timestamp.test.tsx --verbose
 */
import { computed, pattern, safeDateNow, Writable } from "commonfabric";

export default pattern(() => {
  const items = new Writable([{ title: "Task A" }, { title: "Task B" }]);
  const processed = new Writable<{ title: string; processedAt: number }[]>([]);

  // Non-idempotent: safeDateNow() produces different values each run
  computed(() => {
    const entered = safeDateNow();
    let stamp = entered;
    while (stamp === entered) stamp = safeDateNow();
    processed.set(
      items.get().map((i) => ({
        title: i.title,
        processedAt: stamp,
      })),
    );
  });

  const hasItems = computed(() => processed.get().length > 0);

  return {
    tests: [{ assertion: hasItems }],
    expectNonIdempotent: true,
  };
});
