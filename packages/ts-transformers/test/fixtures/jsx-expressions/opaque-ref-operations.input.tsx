/// <cts-enable />
import { cell, pattern, UI } from "commontools";

// FIXTURE: opaque-ref-operations
// Verifies: arithmetic on cell-backed OpaqueRefs in JSX is wrapped in derive() with asCell schema
//   {count}           → {count}  (bare ref, no transform)
//   {count.get() + 1} → derive({count: asCell}, ({count}) => count.get() + 1)
//   {price.get() * 1.1} → derive({price: asCell}, ...)
export default pattern((_state) => {
  const count = cell(10);
  const price = cell(10);

  return {
    [UI]: (
      <div>
        <p>Count: {count}</p>
        <p>Next: {count.get() + 1}</p>
        <p>Double: {count.get() * 2}</p>
        <p>Total: {price.get() * 1.1}</p>
      </div>
    ),
  };
});
