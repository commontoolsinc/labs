/// <cts-enable />
import { cell, NAME, recipe, UI } from "commontools";

export default recipe("Optional Chain Predicate", () => {
  const items = cell<string[]>([]);
  // Convenience pattern: transformer wraps Cell optional chain in derive()
  return {
    [NAME]: "Optional chain predicate",
    [UI]: (
      <div>
        {/* @ts-expect-error Testing convenience pattern: Cell optional chain transformed to derive */}
        {!items?.length && <span>No items</span>}
      </div>
    ),
  };
});
