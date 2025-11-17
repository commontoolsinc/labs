/// <cts-enable />
import { cell, computed } from "commontools";

export default function TestCompute() {
  const value = cell(10);
  const multiplier = cell(2);

  const result = computed(() => value.get() * multiplier.get());

  return result;
}
