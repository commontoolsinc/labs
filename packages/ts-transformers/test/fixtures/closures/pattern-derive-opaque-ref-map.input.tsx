import { derive, pattern } from "commonfabric";

// FIXTURE: pattern-derive-opaque-ref-map
// Verifies: .map() on an OpaqueRef inside derive() is NOT transformed to mapWithPattern
//   derive({}, () => items.map((n) => n * 2)) → derive({ items }, ({ items }) => items.map((n) => n * 2))
// Context: Inside derive, OpaqueRef auto-unwraps to a plain array, so .map()
//   is a standard Array.prototype.map — it must remain untransformed. Parallel
//   negative test to pattern-computed-opaque-ref-map but using derive() directly.
export default pattern<number[]>((items) => {
  // items is OpaqueRef<number[]> as a pattern parameter
  // Inside the derive callback, items.map should NOT be transformed
  const doubled = derive({}, () => items.map((n) => n * 2));
  return doubled;
});
