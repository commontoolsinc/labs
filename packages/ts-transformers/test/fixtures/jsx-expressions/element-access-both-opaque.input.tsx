/// <cts-enable />
import { cell, pattern, UI } from "commontools";

export default pattern((_state) => {
  const items = cell(["apple", "banana", "cherry"]);
  const index = cell(1);

  return {
    [UI]: (
      <div>
        <h3>Element Access with Both OpaqueRefs</h3>
        {/* Both items and index are OpaqueRefs */}
        <p>Selected item: {items.get()[index.get()]}</p>
      </div>
    ),
  };
});
