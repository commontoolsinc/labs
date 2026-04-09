/**
 * computed() result property access in derive captures should use
 * .key("length"). The computed() return is an OpaqueRef, so
 * rewritePatternBody correctly rewrites summary.length to
 * summary.key("length").
 */
import { computed, pattern } from "commonfabric";

interface State {
  items: string[];
}

// FIXTURE: computed-result-property-in-return
// Verifies: .length on a computed() string result is captured via .key("length") in a subsequent derive
//   computed(() => summary.length) → derive(..., { summary: { length: summary.key("length") } }, ({ summary }) => summary.length)
// Context: The first computed() returns a string OpaqueRef (from .join()).
//   When the second computed() accesses summary.length, the capture is rewritten
//   to summary.key("length") because summary is an OpaqueRef, not a plain value.
export default pattern<State>((state) => {
  const summary = computed(() =>
    state.items.join(", ")
  );

  return {
    summary,
    charCount: computed(() => summary.length),
  };
});
