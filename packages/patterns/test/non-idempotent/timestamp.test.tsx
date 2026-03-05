/// <cts-enable />
/**
 * Test that exercises a non-idempotent Date.now() computation.
 * The idempotency check in ct test should warn about it.
 *
 * Run: deno task ct test packages/patterns/test/non-idempotent/timestamp.test.tsx --verbose
 */
import { computed, pattern, Writable } from "commontools";

export default pattern(() => {
  const items = Writable.of([{ title: "Task A" }, { title: "Task B" }]);
  const processed = Writable.of<{ title: string; processedAt: number }[]>([]);

  // Non-idempotent: Date.now() produces different values each run
  computed(() => {
    processed.set(
      items.get().map((i) => ({
        title: i.title,
        processedAt: Date.now(),
      })),
    );
  });

  const hasItems = computed(() => processed.get().length > 0);

  return {
    tests: [{ assertion: hasItems }],
    expectNonIdempotent: true,
  };
});
