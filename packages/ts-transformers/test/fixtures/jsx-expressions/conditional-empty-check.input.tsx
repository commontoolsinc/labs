/// <cts-enable />
import { cell, NAME, recipe, UI } from "commontools";

export default recipe("Conditional Empty Check", () => {
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
