import * as __ctHelpers from "commontools";
import { cell, NAME, recipe, UI } from "commontools";
export default recipe("Optional Chain Predicate", () => {
    const items = cell<string[]>([]);
    return {
        [NAME]: "Optional chain predicate",
        [UI]: (<div>
        {__ctHelpers.derive({ items: items }, ({ items }) => !items?.length && <span>No items</span>)}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
