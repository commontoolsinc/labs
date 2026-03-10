/// <cts-enable />
import { Writable, computed, pattern } from "commontools";

export default pattern(() => {
  const value = Writable.of(10);
  const multiplier = Writable.of(2);

  const result = computed(() => value.get() * multiplier.get());

  return result;
});
