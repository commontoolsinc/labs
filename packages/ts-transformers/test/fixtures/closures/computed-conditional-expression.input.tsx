/// <cts-enable />
import { Writable, computed, pattern } from "commontools";

export default pattern(() => {
  const value = Writable.of(10);
  const threshold = Writable.of(5);
  const a = Writable.of(100);
  const b = Writable.of(200);

  const result = computed(() =>
    value.get() > threshold.get() ? a.get() : b.get()
  );

  return result;
});
