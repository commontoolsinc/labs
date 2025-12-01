/// <cts-enable />
import { cell, NAME, recipe, UI } from "commontools";

export default recipe("Optional Element Access", () => {
  const list = cell<string[] | undefined>(undefined);
  // Convenience pattern: transformer wraps Cell optional element access in derive()
  return {
    [NAME]: "Optional element access",
    [UI]: (
      <div>
        {/* @ts-expect-error Testing convenience pattern: Cell element access transformed to derive */}
        {!list?.[0] && <span>No first entry</span>}
      </div>
    ),
  };
});
