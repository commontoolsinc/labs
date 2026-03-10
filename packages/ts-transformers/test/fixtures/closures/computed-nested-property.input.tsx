/// <cts-enable />
import { Writable, computed, pattern } from "commontools";

export default pattern(() => {
  const counter = Writable.of({ count: 0 });

  const doubled = computed(() => {
    const current = counter.get();
    return current.count * 2;
  });

  return doubled;
});
