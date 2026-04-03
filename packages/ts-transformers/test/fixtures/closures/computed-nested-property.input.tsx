/// <cts-enable />
import { Writable, computed, pattern } from "commontools";

// FIXTURE: computed-nested-property
// Verifies: computed() capturing a cell with an object value and accessing a nested property
//   computed(() => { const current = counter.get(); return current.count * 2 }) → derive(..., { counter }, ({ counter }) => { ... })
//   The cell schema preserves the nested object shape { count: number } with asCell: true.
export default pattern(() => {
  const counter = Writable.of({ count: 0 });

  const doubled = computed(() => {
    const current = counter.get();
    return current.count * 2;
  });

  return doubled;
});
