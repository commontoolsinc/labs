/// <cts-enable />
import { cell, h, recipe, NAME, UI, derive } from "commontools";
export default recipe("Optional Chain Predicate", () => {
    const items = cell<string[]>([]);
    return {
        [NAME]: "Optional chain predicate",
        [UI]: (<div>
        {derive(items, items => !items?.length && <span>No items</span>)}
      </div>),
    };
});
