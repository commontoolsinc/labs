/// <cts-enable />
import { cell, recipe, UI } from "commontools";

export default recipe("LogicalAndSimpleRef", (_state) => {
  const showPanel = cell(true);
  const userName = cell("Alice");

  return {
    [UI]: (
      <div>
        {/* Simple opaque ref - should NOT use when, just derive the whole expression */}
        {showPanel && <div>Panel content</div>}

        {/* Another simple ref */}
        {userName && <span>Hello {userName}</span>}
      </div>
    ),
  };
});
