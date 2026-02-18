/// <cts-enable />
import { cell, NAME, pattern, UI } from "commontools";

export default pattern(() => {
  const items = cell<string[]>([]);
  return {
    [NAME]: "Conditional empty check",
    [UI]: (
      <div>
        {!items.get().length && <span>No items</span>}
      </div>
    ),
  };
});
