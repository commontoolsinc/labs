/**
 * Test that exercises a non-idempotent safeDateNow() computation.
 * The idempotency check in cf test should warn about it.
 *
 * Run: deno task cf test packages/patterns/test/non-idempotent/timestamp.test.tsx --verbose
 */
import { computed, pattern, safeDateNow, Writable } from "commonfabric";

export default pattern(() => {
  const items = Writable.of([{ title: "Task A" }, { title: "Task B" }]);
  const processed = Writable.of<{ title: string; processedAt: number }[]>([]);

  // Non-idempotent: safeDateNow() produces different values each run
  computed(() => {
    processed.set(
      items.get().map((i) => ({
        title: i.title,
        processedAt: safeDateNow(),
      })),
    );
  });

  const hasItems = computed(() => processed.get().length > 0);

  return {
    tests: [{ assertion: hasItems }],
    expectNonIdempotent: true,
  };
});
