/// <cts-enable />
import { OpaqueRef, computed, pattern } from "commontools";

export default pattern(() => {
  const items = [1, 2, 3] as OpaqueRef<number[]>;

  // Inside computed, we close over items (an OpaqueRef)
  // The computed gets transformed to derive({}, () => items.map(...))
  // Inside a derive, .map on a closed-over OpaqueRef should NOT be transformed to mapWithPattern
  // because items is already an OpaqueRef and will be passed through as-is
  const doubled = computed(() => items.map(n => n * 2));

  return doubled;
});
