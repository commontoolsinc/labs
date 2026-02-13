/// <cts-enable />
import { cell, computed, pattern } from "commontools";

export default pattern(() => {
  const a = cell(10);
  const b = cell(20);

  const sum = computed(() => a.get() + b.get());
  const doubled = computed(() => sum * 2);

  return doubled;
});
