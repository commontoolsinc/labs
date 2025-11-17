/// <cts-enable />
import { cell, computed, pattern } from "commontools";

export default pattern((config: { multiplier: number }) => {
  const value = cell(10);
  const result = computed(() => value.get() * config.multiplier);
  return result;
});
