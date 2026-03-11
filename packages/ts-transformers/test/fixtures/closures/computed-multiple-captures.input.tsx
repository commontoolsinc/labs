/// <cts-enable />
import { Writable, computed, pattern } from "commontools";

export default pattern(() => {
  const a = Writable.of(10);
  const b = Writable.of(20);
  const c = Writable.of(30);

  const result = computed(() => {
    const sum = a.get() + b.get();
    return sum * c.get();
  });

  return result;
});
