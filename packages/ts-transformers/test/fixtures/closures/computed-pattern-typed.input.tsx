/// <cts-enable />
import { Writable, computed, pattern } from "commontools";

export default pattern<{ multiplier: number }, number>(({ multiplier }) => {
  const value = Writable.of(10);
  const result = computed(() => value.get() * multiplier);
  return result;
});
