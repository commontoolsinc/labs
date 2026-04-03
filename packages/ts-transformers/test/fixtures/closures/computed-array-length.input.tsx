/// <cts-enable />
/**
 * Regression test for array.length access inside computed().
 *
 * This mimics the pattern from default-app.tsx where:
 * - allCharms comes from wish<{ allCharms: MentionableCharm[] }>
 * - computed(() => allCharms.length) accesses .length on an array from wish
 *
 * The fix ensures the schema is { type: "array", items: { not: true } }
 * rather than { type: "object", properties: { length: { type: "number" } } }
 */
import { computed, NAME, pattern, UI, wish } from "commontools";

interface Charm {
  id: string;
  name: string;
}

// FIXTURE: computed-array-length
// Verifies: computed(() => expr) with .length access on an OpaqueRef<T[]> is closure-extracted
//   computed(() => allCharms.length) → derive(captureSchema, resultSchema, { allCharms: { length: allCharms.length } }, ({ allCharms }) => allCharms.length)
//   allCharms.map(fn) → allCharms.mapWithPattern(pattern(fn, ...schemas), {})
// Context: Regression test ensuring array .length produces the correct schema
//   shape rather than an object schema with a length property.
export default pattern(() => {
  const { allCharms } = wish<{ allCharms: Charm[] }>({ query: "/" }).result!;

  return {
    [NAME]: computed(() => `Charms (${allCharms.length})`),
    [UI]: (
      <div>
        <span>Count: {computed(() => allCharms.length)}</span>
        <ul>
          {allCharms.map((charm) => (
            <li>{charm.name}</li>
          ))}
        </ul>
      </div>
    ),
  };
});
