/**
 * A failing `computed(...)` assertion, so the runner's fallback rendering can
 * be checked alongside the `assert(...)` one. Run by assert-diagnostics.test.ts,
 * which expects the failure; it is not a pattern under test.
 */
import { cell, computed, pattern } from "commonfabric";

export default pattern(() => {
  const a = cell<number>(1);
  const b = cell<number>(2);
  const c = cell<number>(2);

  return {
    tests: [
      { assertion: computed(() => a.get() + b.get() <= c.get()) },
    ],
    a,
    b,
    c,
  };
});
