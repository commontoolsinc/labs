/// <cts-enable />
import { cell, recipe, UI } from "commontools";

// Tests triple && chain: a && b && c
// Should produce nested when calls or derive the entire chain
export default recipe("LogicalTripleAndChain", (_state) => {
  const user = cell<{ active: boolean; verified: boolean; name: string } | null>(null);

  return {
    [UI]: (
      <div>
        {/* Triple && chain with complex conditions */}
        {user.active && user.verified && <span>Welcome, {user.name}!</span>}
      </div>
    ),
  };
});
