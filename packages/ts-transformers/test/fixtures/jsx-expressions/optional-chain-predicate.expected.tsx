import * as __ctHelpers from "commontools";
import { cell, h, recipe, NAME, UI } from "commontools";
export default recipe("Optional Chain Predicate", () => {
    const items = cell<string[]>([]);
    return {
        [NAME]: "Optional chain predicate",
        [UI]: (<div>
        {__ctHelpers.derive(items, items => !items?.length && <span>No items</span>)}
      </div>),
    };
});
__ctHelpers.NAME; // <internals>
