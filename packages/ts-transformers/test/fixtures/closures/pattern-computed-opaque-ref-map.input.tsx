import { computed, pattern } from "commonfabric";

// FIXTURE: pattern-computed-opaque-ref-map
// Verifies: .map() on an OpaqueRef inside computed() is NOT transformed to mapWithPattern
//   computed(() => items.map((n) => n * 2)) → lift(({ items }) => items.map((n) => n * 2))({ items })
// Context: Inside the lift-applied computation, OpaqueRef auto-unwraps to a plain array, so
//   .map() is a standard Array.prototype.map — it must remain untransformed.
//   This is a negative test for reactive method detection.
export default pattern<number[]>((items) => {
  // items is OpaqueRef<number[]> as a pattern parameter
  // Inside the computed callback (which becomes a lift-applied computation), items.map should NOT be transformed
  const doubled = computed(() => items.map((n) => n * 2));
  return doubled;
});
