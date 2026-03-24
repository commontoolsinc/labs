/// <cts-enable />
import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-nested
// Verifies: chained computed() calls where the second captures the result of the first
//   computed(() => a.get() + b.get()) → derive(..., { a, b }, ({ a, b }) => a.get() + b.get())
//   computed(() => sum * 2) → derive(..., { sum }, ({ sum }) => sum * 2)
// Context: The first derive captures cells (asCell: true), the second captures
//   the computed result (asOpaque: true) since it is an OpaqueRef.
export default pattern(() => {
  const a = Writable.of(10);
  const b = Writable.of(20);

  const sum = computed(() => a.get() + b.get());
  const doubled = computed(() => sum * 2);

  return doubled;
});
