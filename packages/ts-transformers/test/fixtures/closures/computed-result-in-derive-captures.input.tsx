/// <cts-enable />
/**
 * computed() result used as derive capture should use .key("count"),
 * not plain property access. The computed() return value is an
 * OpaqueRef, so rewritePatternBody correctly treats it as opaque.
 */
import { computed, pattern, UI } from "commontools";

interface State {
  items: Array<{ name: string; done: boolean }>;
}

export default pattern<State>((state) => {
  const stats = computed(() => ({
    count: state.items.filter((i) => i.done).length,
    total: state.items.length,
  }));

  return {
    [UI]: (
      <div>
        {computed(() => `${stats.count} of ${stats.total} done`)}
      </div>
    ),
  };
});
