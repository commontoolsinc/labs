/// <cts-enable />
import { cell, computed, Cell } from "commontools";

export default function TestComputedMapClosedOver() {
  const items: Cell<number[]> = cell([1, 2, 3]);
  const multiplier = cell(2);

  // This should NOT transform items.map to items.mapWithPattern
  // because items is a closed-over OpaqueRef that will be unwrapped by the derive
  const result = computed(() => items.map(x => x * multiplier.get()));

  return result;
}
