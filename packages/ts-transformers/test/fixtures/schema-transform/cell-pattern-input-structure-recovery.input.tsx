/// <cts-enable />
import { cell, pattern } from "commontools";

// FIXTURE: cell-pattern-input-structure-recovery
// Verifies: `cell(state.values)` preserves array/item structure when the source
// comes from a typed pattern input.
export default pattern<{ values: number[] }>((state) => {
  const typedValues = cell(state.values);
  return { typedValues };
});
