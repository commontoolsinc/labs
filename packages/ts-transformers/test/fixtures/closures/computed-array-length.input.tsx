/// <cts-enable />
/**
 * Regression test for array.length access inside computed().
 *
 * This mimics the pattern from default-app.tsx where:
 * - allCharms comes from wish<{ allCharms: MentionableCharm[] }>
 * - computed(() => allCharms.length) accesses .length on an OpaqueRef<T[]>
 *
 * The fix ensures the schema is { type: "array", items: { not: true, asOpaque: true } }
 * rather than { type: "object", properties: { length: { type: "number" } } }
 */
import { computed, NAME, pattern, UI, wish } from "commontools";

interface Charm {
  id: string;
  name: string;
}

export default pattern(() => {
  const { allCharms } = wish<{ allCharms: Charm[] }>({ query: "/" }).result;

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
