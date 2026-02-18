/// <cts-enable />
import { cell, pattern, UI } from "commontools";

// Tests triple || chain: a || b || c
// Should produce nested unless calls
export default pattern((_state) => {
  const primary = cell("");
  const secondary = cell("");
  const items = cell<string[]>([]);

  return {
    [UI]: (
      <div>
        {/* Triple || chain - first truthy wins */}
        <span>{primary.get().length || secondary.get().length || "no content"}</span>

        {/* Triple || with mixed types */}
        <span>{items.get()[0]?.length || items.get()[1]?.length || 0}</span>
      </div>
    ),
  };
});
