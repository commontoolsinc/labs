/// <cts-enable />
import { cell, computed } from "commontools";

export default function TestComputeMultipleCaptures() {
  const a = cell(10);
  const b = cell(20);
  const c = cell(30);

  const result = computed(() => {
    const sum = a.get() + b.get();
    return sum * c.get();
  });

  return result;
}
