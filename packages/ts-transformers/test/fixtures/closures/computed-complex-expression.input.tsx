/// <cts-enable />
import { Writable, computed, pattern } from "commontools";

export default pattern(() => {
  const a = Writable.of(10);
  const b = Writable.of(20);
  const c = Writable.of(5);

  const result = computed(() => (a.get() * b.get() + c.get()) / 2);

  return result;
});
