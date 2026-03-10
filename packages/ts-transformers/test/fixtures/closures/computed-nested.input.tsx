/// <cts-enable />
import { Writable, computed, pattern } from "commontools";

export default pattern(() => {
  const a = Writable.of(10);
  const b = Writable.of(20);

  const sum = computed(() => a.get() + b.get());
  const doubled = computed(() => sum * 2);

  return doubled;
});
