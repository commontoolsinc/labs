/// <cts-enable />
/**
 * computed() result property access in derive captures should use
 * .key("length"). The computed() return is an OpaqueRef, so
 * rewritePatternBody correctly rewrites summary.length to
 * summary.key("length").
 */
import { computed, pattern } from "commontools";

interface State {
  items: string[];
}

export default pattern<State>((state) => {
  const summary = computed(() =>
    state.items.join(", ")
  );

  return {
    summary,
    charCount: computed(() => summary.length),
  };
});
