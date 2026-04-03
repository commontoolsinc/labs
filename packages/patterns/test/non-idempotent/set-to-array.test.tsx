/// <cts-enable />
/**
 * Test that exercises a non-idempotent Set-to-Array computation.
 * Random sort before Set insertion changes iteration order each run.
 * The idempotency check in ct test should warn about it.
 *
 * Run: deno task ct test packages/patterns/test/non-idempotent/set-to-array.test.tsx --verbose
 */
import { computed, pattern, Writable } from "commontools";

export default pattern(() => {
  const items = Writable.of([
    { title: "Apples", tag: "fruit" },
    { title: "Carrots", tag: "vegetable" },
    { title: "Bananas", tag: "fruit" },
    { title: "Broccoli", tag: "vegetable" },
  ]);
  const uniqueTags = Writable.of<string[]>([]);

  // Non-idempotent: random sort before Set changes iteration order
  computed(() => {
    const tags = items.get().map((i) => i.tag);
    const shuffled = tags.sort(() => Math.random() - 0.5);
    const set = new Set(shuffled);
    uniqueTags.set([...set]);
  });

  const hasTags = computed(() => uniqueTags.get().length > 0);

  return {
    tests: [{ assertion: hasTags }],
    expectNonIdempotent: true,
  };
});
