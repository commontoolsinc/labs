/// <cts-enable />
import { computed, pattern } from "commontools";

export default pattern<number[]>((items) => {
  // items is OpaqueRef<number[]> as a pattern parameter
  // Inside the computed callback (which becomes derive), items.map should NOT be transformed
  const doubled = computed(() => items.map((n) => n * 2));
  return doubled;
});
