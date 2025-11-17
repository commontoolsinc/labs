/// <cts-enable />
import { cell, computed } from "commontools";

export default function TestComputeNestedProperty() {
  const counter = cell({ count: 0 });

  const doubled = computed(() => {
    const current = counter.get();
    return current.count * 2;
  });

  return doubled;
}
