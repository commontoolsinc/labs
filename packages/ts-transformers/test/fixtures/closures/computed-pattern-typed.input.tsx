/// <cts-enable />
import { cell, computed, pattern } from "commontools";

export default pattern<{ multiplier: number }, number>(({ multiplier }) => {
  const value = cell(10);
  const result = computed(() => value.get() * multiplier);
  return result;
});
