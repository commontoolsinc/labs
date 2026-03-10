/// <cts-enable />
import { Writable, computed, pattern } from "commontools";

export default pattern((config: { multiplier: number }) => {
  const value = Writable.of(10);
  const result = computed(() => value.get() * config.multiplier);
  return result;
});
