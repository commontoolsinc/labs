/// <cts-enable />
/**
 * computed() result used as derive capture should use .key("count"),
 * not plain property access. The computed() return value is an
 * OpaqueRef, so rewritePatternBody correctly treats it as opaque.
 */
import { computed, pattern, UI } from "commonfabric";

interface State {
  items: Array<{ name: string; done: boolean }>;
}

// FIXTURE: computed-result-in-derive-captures
// Verifies: computed() result properties captured in a subsequent derive use .key() access
//   computed(() => `${stats.count} of ${stats.total} done`) → derive(..., { stats: { count: stats.key("count"), total: stats.key("total") } }, ({ stats }) => ...)
// Context: The first computed() returns an OpaqueRef with { count, total }.
//   When the second computed() captures stats.count and stats.total, the
//   transform rewrites them to stats.key("count") and stats.key("total") in
//   the captures object because stats is an OpaqueRef.
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
