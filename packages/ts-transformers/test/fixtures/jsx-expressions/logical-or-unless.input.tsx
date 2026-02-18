/// <cts-enable />
import { cell, pattern, UI } from "commontools";

export default pattern((_state) => {
  const items = cell<string[]>([]);

  return {
    [UI]: (
      <div>
        {/* Pattern: falsy check || fallback */}
        {items.get().length || <span>List is empty</span>}
      </div>
    ),
  };
});
