/// <cts-enable />
import { cell, computed, recipe } from "commontools";

export default recipe(() => {
  const a = cell(10);
  const b = cell(20);

  const sum = computed(() => a.get() + b.get());
  const doubled = computed(() => sum * 2);

  return doubled;
});
