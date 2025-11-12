/// <cts-enable />
import { cell, derive, Cell } from "commontools";

export default function TestDeriveMapClosedOver() {
  const items: Cell<number[]> = cell([1, 2, 3]);
  const multiplier = cell(2);
  const count = cell(5);

  // This should NOT transform items.map to items.mapWithPattern
  // because items is a closed-over OpaqueRef that will be unwrapped by the derive
  const result = derive(count, (c) => items.map(x => x * multiplier.get() * c));

  return result;
}
