/// <cts-enable />
import { Writable, computed, pattern } from "commontools";

export default pattern(() => {
  const config = Writable.of<{ multiplier?: number } | null>({ multiplier: 2 });
  const value = Writable.of(10);

  const result = computed(() => value.get() * (config.get()?.multiplier ?? 1));

  return result;
});
