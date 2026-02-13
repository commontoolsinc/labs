/// <cts-enable />
import { cell, pattern, UI } from "commontools";

export default pattern("LogicalComplexExpressions", (_state) => {
  const items = cell<string[]>([]);
  const isEnabled = cell(false);
  const count = cell(0);

  return {
    [UI]: (
      <div>
        {/* Nested && - both conditions reference opaque refs */}
        {items.get().length > 0 && isEnabled.get() && <div>Enabled with items</div>}

        {/* Mixed || and && */}
        {(count.get() > 10 || items.get().length > 5) && <div>Threshold met</div>}
      </div>
    ),
  };
});
