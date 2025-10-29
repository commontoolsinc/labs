import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe("LogicalOrUnless", (_state) => {
    const items = cell<string[]>([]);
    return {
        [UI]: (<div>
        {/* Pattern: falsy check || fallback */}
        {__ctHelpers.unless(__ctHelpers.derive(items, items => items.length), <span>List is empty</span>)}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
