/// <cts-enable />
import { cell, computed, recipe } from "commontools";

export default recipe<{ multiplier: number }, number>(({ multiplier }) => {
  const value = cell(10);
  const result = computed(() => value.get() * multiplier);
  return result;
});
