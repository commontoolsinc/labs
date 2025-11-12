/// <cts-enable />
import { computed, recipe } from "commontools";

export default recipe<number[]>((items) => {
  // items is OpaqueRef<number[]> as a recipe parameter
  // Inside the computed callback (which becomes derive), items.map should NOT be transformed
  const doubled = computed(() => items.map((n) => n * 2));
  return doubled;
});
