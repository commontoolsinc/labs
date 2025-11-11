/// <cts-enable />
import { cell, computed } from "commontools";

export default function TestComputeOptionalChaining() {
  const config = cell<{ multiplier?: number } | null>({ multiplier: 2 });
  const value = cell(10);

  const result = computed(() => value.get() * (config.get()?.multiplier ?? 1));

  return result;
}
