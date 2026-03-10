/// <cts-enable />
import { Writable, computed, pattern } from "commontools";

export default pattern((config: { base: number; multiplier: number }) => {
  const value = Writable.of(10);
  const offset = 5; // non-cell local
  const threshold = Writable.of(15); // cell local

  const result = computed(() =>
    (value.get() + config.base + offset) * config.multiplier + threshold.get()
  );

  return result;
});
