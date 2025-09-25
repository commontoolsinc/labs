/// <cts-enable />
import { cell, h, recipe, NAME, UI } from "commontools";

export default recipe("Optional Chain Predicate", () => {
  const items = cell<string[]>([]);
  return {
    [NAME]: "Optional chain predicate",
    [UI]: (
      <div>
        {!items?.length && <span>No items</span>}
      </div>
    ),
  };
});
