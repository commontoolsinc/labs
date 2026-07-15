import { cell, pattern } from "commonfabric";

// FIXTURE: cell-pattern-input-structure-recovery
// Verifies: a typed local cell fed from a pattern input via `.set(...)`
// preserves array/item structure in its injected schema.
// Cell initials are schema defaults and must be compile-time static
// (CT-1880); the former `cell(state.values)` spelling is now a diagnostic —
// runtime values arrive via `.set(...)`.
export default pattern<{ values: number[] }>((state) => {
  const typedValues = cell<number[]>([]);
  typedValues.set(state.values);
  return { typedValues };
});
