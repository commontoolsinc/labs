/// <cts-enable />
import { cell, NAME, recipe, UI } from "commontools";

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
