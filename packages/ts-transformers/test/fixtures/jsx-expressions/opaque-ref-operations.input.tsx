/// <cts-enable />
import { cell, recipe, UI } from "commontools";

export default recipe("OpaqueRefOperations", (_state) => {
  const count = cell(10);
  const price = cell(10);

  // Convenience pattern: transformer wraps Cell arithmetic in derive()
  return {
    [UI]: (
      <div>
        <p>Count: {count}</p>
        {/* @ts-expect-error Testing convenience pattern: Cell arithmetic transformed to derive */}
        <p>Next: {count + 1}</p>
        {/* @ts-expect-error Testing convenience pattern: Cell arithmetic transformed to derive */}
        <p>Double: {count * 2}</p>
        {/* @ts-expect-error Testing convenience pattern: Cell arithmetic transformed to derive */}
        <p>Total: {price * 1.1}</p>
      </div>
    ),
  };
});
