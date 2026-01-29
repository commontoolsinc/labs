/// <cts-enable />
/**
 * Regression test: computed() inside ifElse branch should not double-wrap .get()
 *
 * When a computed() callback is inside an ifElse branch, the OpaqueRefJSX
 * transformer's rewriteChildExpressions should NOT wrap expressions like
 * `toggle.get()` in an extra derive, since the computed callback is already
 * a safe reactive context.
 *
 * Bug: secondToggle.get() was returning CellImpl instead of boolean
 * Fix: Added isInsideSafeCallbackWrapper check in rewriteChildExpressions
 */
import { computed, ifElse, pattern, UI, Writable } from "commontools";

export default pattern<Record<PropertyKey, never>>(() => {
  const showOuter = Writable.of(false);
  const secondToggle = Writable.of(false);

  return {
    [UI]: (
      <div>
        {/* Case A: Top-level computed - always worked */}
        <div style={computed(() => {
          const val = secondToggle.get();
          return { background: val ? "green" : "red" };
        })}>Case A</div>

        {/* Case B: Computed inside ifElse - this was the bug */}
        {ifElse(
          showOuter,
          <div style={computed(() => {
            // This .get() should NOT be wrapped in extra derive
            const val = secondToggle.get();
            return { background: val ? "green" : "red" };
          })}>Case B</div>,
          <div>Hidden</div>
        )}
      </div>
    ),
  };
});
