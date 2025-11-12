/// <cts-enable />
import { cell, computed, recipe } from "commontools";

export default recipe((config: { base: number; multiplier: number }) => {
  const value = cell(10);
  const offset = 5; // non-cell local
  const threshold = cell(15); // cell local

  const result = computed(() =>
    (value.get() + config.base + offset) * config.multiplier + threshold.get()
  );

  return result;
});
