/// <cts-enable />
import { cell, recipe, UI } from "commontools";

export default recipe("LogicalComplexExpressions", (_state) => {
  const items = cell<string[]>([]);
  const isEnabled = cell(false);
  const count = cell(0);

  return {
    [UI]: (
      <div>
        {/* Nested && - both conditions reference opaque refs */}
        {items.length > 0 && isEnabled && <div>Enabled with items</div>}

        {/* Mixed || and && */}
        {(count > 10 || items.length > 5) && <div>Threshold met</div>}
      </div>
    ),
  };
});
