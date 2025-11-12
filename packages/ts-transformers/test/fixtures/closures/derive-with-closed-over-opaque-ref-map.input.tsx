/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDeriveWithClosedOverOpaqueRefMap() {
  const items = cell([1, 2, 3]);

  // Explicit derive with closed-over OpaqueRef
  // .map on a closed-over OpaqueRef should NOT be transformed to mapWithPattern
  const doubled = derive({}, () => items.map(n => n * 2));

  return doubled;
}
