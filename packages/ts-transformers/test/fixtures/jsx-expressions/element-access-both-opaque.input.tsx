/// <cts-enable />
import { cell, recipe, UI } from "commontools";

export default recipe("ElementAccessBothOpaque", (_state) => {
  const items = cell(["apple", "banana", "cherry"]);
  const index = cell(1);

  return {
    [UI]: (
      <div>
        <h3>Element Access with Both OpaqueRefs</h3>
        {/* Both items and index are OpaqueRefs */}
        <p>Selected item: {items[index]}</p>
      </div>
    ),
  };
});
