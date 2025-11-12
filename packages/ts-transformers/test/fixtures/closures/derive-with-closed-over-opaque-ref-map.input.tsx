/// <cts-enable />
import { derive, OpaqueRef } from "commontools";

export default function TestDeriveWithClosedOverOpaqueRefMap() {
  const items = [1, 2, 3] as OpaqueRef<number[]>;

  // Explicit derive with closed-over OpaqueRef
  // .map on a closed-over OpaqueRef should NOT be transformed to mapWithPattern
  const doubled = derive({}, () => items.map(n => n * 2));

  return doubled;
}
