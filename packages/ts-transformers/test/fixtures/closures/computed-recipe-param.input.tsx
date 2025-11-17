/// <cts-enable />
import { cell, computed, recipe } from "commontools";

export default recipe((config: { multiplier: number }) => {
  const value = cell(10);
  const result = computed(() => value.get() * config.multiplier);
  return result;
});
