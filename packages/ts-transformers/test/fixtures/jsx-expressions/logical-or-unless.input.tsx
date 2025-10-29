/// <cts-enable />
import { cell, recipe, UI } from "commontools";

export default recipe("LogicalOrUnless", (_state) => {
  const items = cell<string[]>([]);

  return {
    [UI]: (
      <div>
        {/* Pattern: falsy check || fallback */}
        {items.length || <span>List is empty</span>}
      </div>
    ),
  };
});
