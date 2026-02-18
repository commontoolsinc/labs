/// <cts-enable />
import { cell, pattern, UI } from "commontools";

export default pattern((_state) => {
  const showPanel = cell(true);
  const userName = cell("Alice");

  return {
    [UI]: (
      <div>
        {/* Simple opaque ref with JSX on right - SHOULD use when for short-circuit optimization */}
        {showPanel && <div>Panel content</div>}

        {/* Another simple ref */}
        {userName && <span>Hello {userName}</span>}
      </div>
    ),
  };
});
