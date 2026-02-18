/// <cts-enable />
import { cell, pattern, UI } from "commontools";

// Tests triple && chain: a && b && c
// Should produce nested when calls or derive the entire chain
export default pattern((_state) => {
  const user = cell<{ active: boolean; verified: boolean; name: string }>({ active: false, verified: false, name: "" });

  return {
    [UI]: (
      <div>
        {/* Triple && chain with complex conditions */}
        {user.get().active && user.get().verified && <span>Welcome, {user.get().name}!</span>}
      </div>
    ),
  };
});
